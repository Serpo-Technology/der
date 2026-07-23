/**
 * Eval runner: generates every canned prompt against one provider and scores
 * first-attempt results with the real pipeline judgment.
 *
 *   npx tsx scripts/eval/run.ts --provider mercury
 *   npx tsx scripts/eval/run.ts --base-url http://localhost:11434/v1 --model qwen2.5-coder:7b
 *
 * --provider mercury reads the key from the app's stored credentials. Results
 * land in evals/results-<label>-<timestamp>.json plus a printed table.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ContractBuilder } from '../../src/services/ai-interpreter/contract-builder';
import { repositoryService } from '../../src/services/repository/repository-service';
import { registerBuiltins } from '../../src/services/repository/builtins';
import { extractJson } from '../../src/services/ai-interpreter/llm-json';
import {
  ComposedResponseSchema,
  checkAgainstManifests,
  formatManifestErrors,
  formatZodError,
} from '../../src/schemas/contract';
import type { ContractShape } from '../../src/schemas/contract';
import { loadDistParts } from '../diffusion-probe/load-parts';

console.warn = () => {};
console.error = () => {};

interface EvalCase {
  id: string;
  prompt: string;
}

interface EvalResult {
  id: string;
  verdict: 'pass' | 'schema' | 'manifest' | 'unparseable' | 'request-failed';
  wallMs: number;
  completionTokens?: number;
  adjustments?: number;
  fragmentsUsed?: string[];
  errors?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function resolveProvider(): { baseUrl: string; model: string; key?: string; label: string } {
  const provider = arg('--provider');
  if (provider === 'mercury') {
    const credentials = JSON.parse(
      readFileSync(
        join(homedir(), 'Library/Application Support/com.seyit.der/settings/credentials.json'),
        'utf8'
      )
    );
    return {
      baseUrl: 'https://api.inceptionlabs.ai/v1',
      model: arg('--model') ?? 'mercury-2',
      key: credentials.apiKeys?.mercury,
      label: 'mercury',
    };
  }
  const baseUrl = arg('--base-url');
  const model = arg('--model');
  if (!baseUrl || !model) {
    process.stdout.write('Usage: --provider mercury | --base-url <url> --model <name> [--key <env var>]\n');
    process.exit(2);
  }
  const keyEnv = arg('--key');
  return { baseUrl, model, key: keyEnv ? process.env[keyEnv] : undefined, label: model };
}

async function generate(
  baseUrl: string,
  model: string,
  key: string | undefined,
  system: string,
  user: string
): Promise<{ content: string; completionTokens?: number }> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: 8000,
    }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { completion_tokens?: number };
  };
  return {
    content: body.choices[0]?.message?.content ?? '',
    completionTokens: body.usage?.completion_tokens,
  };
}

function judge(raw: string): Omit<EvalResult, 'id' | 'wallMs' | 'completionTokens'> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJson(raw));
  } catch (error) {
    return { verdict: 'unparseable', errors: String(error).slice(0, 200) };
  }
  const parsed = ComposedResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    return { verdict: 'schema', errors: formatZodError(parsed.error).slice(0, 300) };
  }
  const result = checkAgainstManifests(parsed.data.contract as ContractShape);
  const fragmentsUsed = [
    ...new Set(
      JSON.stringify(parsed.data.contract).match(/"basics\.[a-z_]+"|"stats\.[a-z_]+"|"expr\.[a-z_]+"/g) ?? []
    ),
  ].map((s) => s.replace(/"/g, ''));
  if (result.errors.length > 0) {
    return {
      verdict: 'manifest',
      errors: formatManifestErrors(result.errors).slice(0, 300),
      fragmentsUsed,
    };
  }
  return { verdict: 'pass', adjustments: result.warnings.length, fragmentsUsed };
}

async function main() {
  const { baseUrl, model, key, label } = resolveProvider();
  await registerBuiltins(repositoryService);
  loadDistParts('fragments/dist');
  const builder = new ContractBuilder(repositoryService);
  const cases = (JSON.parse(readFileSync('evals/prompts.json', 'utf8')) as { prompts: EvalCase[] })
    .prompts;

  const results: EvalResult[] = [];
  for (const evalCase of cases) {
    const { system, user } = await builder.renderCreatePrompt(evalCase.prompt);
    const started = Date.now();
    try {
      const { content, completionTokens } = await generate(baseUrl, model, key, system, user);
      results.push({
        id: evalCase.id,
        wallMs: Date.now() - started,
        completionTokens,
        ...judge(content),
      });
    } catch (error) {
      results.push({
        id: evalCase.id,
        wallMs: Date.now() - started,
        verdict: 'request-failed',
        errors: String(error).slice(0, 200),
      });
    }
    const last = results[results.length - 1];
    process.stdout.write(
      `${last.id.padEnd(16)} ${last.verdict.padEnd(14)} ${String(last.wallMs).padStart(6)}ms` +
        `${last.fragmentsUsed?.length ? '  parts: ' + last.fragmentsUsed.join(',') : ''}\n`
    );
  }

  const passes = results.filter((r) => r.verdict === 'pass').length;
  process.stdout.write(
    `\n${label}: ${passes}/${results.length} first-attempt pass, ` +
      `median ${median(results.map((r) => r.wallMs))}ms\n`
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = `evals/results-${label}-${stamp}.json`;
  writeFileSync(out, JSON.stringify({ label, model, results }, null, 2) + '\n');
  process.stdout.write(`wrote ${out}\n`);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
