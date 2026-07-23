/**
 * Eval runner: generates every canned prompt against one provider, scores
 * first-attempt results with the real pipeline judgment, then runs each
 * passing contract's scripted behavior for one end-to-end score.
 *
 *   npx tsx scripts/eval/run.ts --provider mercury
 *   npx tsx scripts/eval/run.ts --base-url http://localhost:11434/v1 --model qwen2.5-coder:7b
 *
 * --provider mercury reads the key from the app's stored credentials.
 * --only <id> runs one prompt; --static-only skips the behavior stage.
 * Results land in evals/results-<label>-<timestamp>.json plus a printed
 * table, with behavior verdicts merged into the same file.
 */

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
import {
  FRAGMENT_ELEMENTS,
  FRAGMENT_OPERATIONS,
} from '../../src/services/operations/registry';

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
  contract?: unknown;
  behavior?: 'pass' | 'fail';
  behaviorError?: string;
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
  const serialized = JSON.stringify(parsed.data.contract);
  const partNames = [...Object.keys(FRAGMENT_OPERATIONS), ...Object.keys(FRAGMENT_ELEMENTS)];
  const fragmentsUsed = partNames.filter((name) => serialized.includes(`"${name}"`));
  if (result.errors.length > 0) {
    return {
      verdict: 'manifest',
      errors: formatManifestErrors(result.errors).slice(0, 300),
      fragmentsUsed,
    };
  }
  return {
    verdict: 'pass',
    adjustments: result.warnings.length,
    fragmentsUsed,
    contract: parsed.data.contract as unknown,
  };
}

async function main() {
  const { baseUrl, model, key, label } = resolveProvider();
  await registerBuiltins(repositoryService);
  loadDistParts('fragments/dist');
  const builder = new ContractBuilder(repositoryService);
  const only = arg('--only');
  const cases = (JSON.parse(readFileSync('evals/prompts.json', 'utf8')) as { prompts: EvalCase[] })
    .prompts.filter((c) => !only || c.id === only);
  if (only && cases.length === 0) {
    throw new Error(`No prompt with id "${only}" in evals/prompts.json`);
  }

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

  if (!process.argv.includes('--static-only')) {
    process.stdout.write('\nrunning behaviors...\n');
    const outcomes = runBehaviorStage(out);
    for (const result of results) {
      const outcome = outcomes.get(result.id);
      if (!outcome || outcome.status === 'skipped') continue;
      result.behavior = outcome.status;
      if (outcome.status === 'fail') {
        result.behaviorError = outcome.message?.slice(0, 300);
      }
      process.stdout.write(
        `${result.id.padEnd(16)} ${outcome.status === 'pass' ? 'behaves' : 'BROKEN'}` +
          `${outcome.status === 'fail' ? `  ${outcome.message?.slice(0, 120) ?? ''}` : ''}\n`
      );
    }
    writeFileSync(out, JSON.stringify({ label, model, results }, null, 2) + '\n');
    const behaved = results.filter((r) => r.behavior);
    const working = behaved.filter((r) => r.behavior === 'pass').length;
    const endToEnd = results.filter(
      (r) => r.verdict === 'pass' && r.behavior !== 'fail'
    ).length;
    process.stdout.write(
      `\n${label}: ${endToEnd}/${results.length} end to end ` +
        `(${passes}/${results.length} compose, ${working}/${behaved.length} of those behave)\n`
    );
  }
}

interface BehaviorOutcome {
  status: 'pass' | 'fail' | 'skipped';
  message?: string;
}

/** Runs the behavioral suite against a results file and maps outcomes by
 * prompt id. The suite lives under vitest for its jsdom and CSS handling;
 * the JSON reporter bridges its verdicts back here. */
function runBehaviorStage(resultsPath: string): Map<string, BehaviorOutcome> {
  const reportPath = join(tmpdir(), `der-behavior-${Date.now()}.json`);
  const spawned = spawnSync(
    'npx',
    [
      'vitest',
      'run',
      '--config',
      'vitest.evals.config.ts',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    {
      env: { ...process.env, EVAL_RESULTS: resultsPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let report: {
    testResults?: Array<{
      assertionResults?: Array<{ title: string; status: string; failureMessages?: string[] }>;
    }>;
  };
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    throw new Error(
      `Behavior stage produced no report; vitest said: ${(spawned.stderr ?? '').slice(-500)}`
    );
  } finally {
    rmSync(reportPath, { force: true });
  }
  const outcomes = new Map<string, BehaviorOutcome>();
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      const status =
        test.status === 'passed' ? 'pass' : test.status === 'failed' ? 'fail' : 'skipped';
      outcomes.set(test.title, {
        status,
        message: test.failureMessages?.[0]?.split('\n')[0],
      });
    }
  }
  return outcomes;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
