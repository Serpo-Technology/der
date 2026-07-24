/**
 * The import boundary for shared experiences. Pasted or uploaded bytes become
 * a hydrated ShareableContract here (dates coerced to real Date instances,
 * defaults filled), and the embedded contract passes the same gate a recipe
 * does: the composable-vocabulary schema (code-carrying operations are
 * rejected outright) plus the manifest check against the installed parts, so
 * an import either opens as a working app or fails naming its problems.
 */

import { z } from 'zod';
import {
  LlmContractSchema,
  checkAgainstManifests,
  formatZodError,
} from '../../schemas/contract';
import type { ContractShape } from '../../schemas/contract';
import { ContractBuilder } from '../ai-interpreter/contract-builder';
import { repositoryService } from '../repository/repository-service';
import type { Contract, ValidationWarning } from '../../types/contract';
import type { ShareableContract } from '../../types/persistence';

const ShareMetadataSchema = z.object({
  title: z.string().min(1).default('Shared experience'),
  description: z.string().optional(),
  author: z.string().optional(),
  createdAt: z.coerce.date().default(() => new Date()),
  sharedAt: z.coerce.date().default(() => new Date()),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
});

/** The app's own exports come from the Rust share command, where absent
 * options serialize as null and the date keys are created_at/shared_at.
 * Hydration treats null as absent and reads both date spellings, so a DER
 * export always round-trips through import. */
function normalizeMetadataWire(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (record.createdAt === undefined && record.created_at !== undefined) {
    record.createdAt = record.created_at;
  }
  if (record.sharedAt === undefined && record.shared_at !== undefined) {
    record.sharedAt = record.shared_at;
  }
  delete record.created_at;
  delete record.shared_at;
  for (const key of Object.keys(record)) {
    if (record[key] === null) delete record[key];
  }
  return record;
}

const ShareableEnvelopeSchema = z.object({
  contract: z.record(z.string(), z.unknown()),
  // The default carries every field: an absent metadata block is not parsed
  // through the inner schema, so inner defaults would not fill it.
  metadata: z.preprocess(normalizeMetadataWire, ShareMetadataSchema).default(() => ({
    title: 'Shared experience',
    createdAt: new Date(),
    sharedAt: new Date(),
  })),
  version: z.string().default('1.0.0'),
  checksum: z.string().nullish().transform((value) => value ?? ''),
});

export interface ParsedShare {
  /** Hydrated envelope; present when the text was structurally readable. */
  shareable?: ShareableContract;
  /** The contract validated against the installed vocabulary, pre-normalization. */
  shape?: ContractShape;
  /** Hard problems: the import cannot proceed while any exist. */
  problems: string[];
  /** Informational notes shown alongside the preview. */
  warnings: string[];
}

/**
 * Parses import text into a hydrated, vocabulary-checked share. A paste of a
 * bare contract (no envelope) imports with default details rather than
 * failing on missing metadata.
 */
export function parseShareableText(text: string): ParsedShare {
  const problems: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      problems: [
        `The pasted data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings,
    };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: ['The pasted data is not a shared experience'], warnings };
  }

  let candidate = raw as Record<string, unknown>;
  const looksLikeBareContract =
    !candidate.contract && Array.isArray((candidate as { elements?: unknown }).elements);
  if (looksLikeBareContract) {
    warnings.push('The data is a bare app contract; importing it with default details');
    candidate = { contract: candidate };
  }

  const envelope = ShareableEnvelopeSchema.safeParse(candidate);
  if (!envelope.success) {
    return {
      problems: [`The shared experience is malformed:\n${formatZodError(envelope.error)}`],
      warnings,
    };
  }
  if (!envelope.data.checksum) {
    warnings.push('The data carries no checksum; its origin cannot be cross-checked');
  }

  // The embedded contract goes through the composition gate: the model
  // vocabulary schema (no code, remote only via implementation) and the
  // manifest check against this machine's installed parts.
  const contractParse = LlmContractSchema.safeParse(
    JSON.parse(JSON.stringify(envelope.data.contract))
  );
  if (!contractParse.success) {
    problems.push(
      `The app inside this share is malformed:\n${formatZodError(contractParse.error)}`
    );
    return {
      shareable: envelope.data as unknown as ShareableContract,
      problems,
      warnings,
    };
  }
  const shape = contractParse.data as ContractShape;
  const manifest = checkAgainstManifests(shape);
  for (const error of manifest.errors) {
    problems.push(`${error.path}: ${error.message}`);
  }
  for (const warning of manifest.warnings as ValidationWarning[]) {
    warnings.push(warning.message);
  }

  return {
    shareable: envelope.data as unknown as ShareableContract,
    shape: problems.length === 0 ? shape : undefined,
    problems,
    warnings,
  };
}

/** Normalizes a validated share's contract exactly like generation does. */
export function finalizeSharedContract(parsed: ParsedShare): Contract {
  if (!parsed.shape || parsed.problems.length > 0) {
    throw new Error(`This share does not validate:\n${parsed.problems.join('\n')}`);
  }
  const builder = new ContractBuilder(repositoryService);
  return builder.finalizeShape(
    parsed.shape,
    parsed.shareable?.metadata.description ?? parsed.shareable?.metadata.title
  );
}
