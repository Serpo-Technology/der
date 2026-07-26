/**
 * The webview's client to the runtime core's compose pipeline: creation,
 * edits, and blueprint regeneration run host-side (prompt, repair loop,
 * checker, finalization), with streaming partials arriving as events
 * carrying the raw accumulated text so the caller's own draft extraction
 * stays in charge. The TS ContractBuilder remains the implementation for
 * runs outside Tauri and for the eval harness.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Contract, ValidationWarning } from '../../types/contract';
import type { ComposedSpec } from '../../types/blueprint';

export interface CoreComposeResult {
  contract: Contract;
  spec: ComposedSpec;
  recipeName?: string;
  warnings: ValidationWarning[];
}

export interface CoreEditResult {
  contract: Contract;
  warnings: ValidationWarning[];
}

type PartialHandler = (accumulated: string, attempt: number) => void;

async function withPartials<T>(
  event: string,
  onPartial: PartialHandler | undefined,
  run: () => Promise<T>
): Promise<T> {
  if (!onPartial) return run();
  const unlisten = await listen<{ accumulated: string; attempt: number }>(event, (received) => {
    onPartial(received.payload.accumulated, received.payload.attempt);
  });
  try {
    return await run();
  } finally {
    unlisten();
  }
}

export async function composeViaCore(
  description: string,
  onPartial?: PartialHandler
): Promise<CoreComposeResult> {
  return withPartials('runtime-compose-partial', onPartial, () =>
    invoke<CoreComposeResult>('runtime_compose', { description })
  );
}

export async function editViaCore(
  contract: unknown,
  instruction: string,
  onPartial?: PartialHandler
): Promise<CoreEditResult> {
  const plain =
    typeof (contract as { toObject?: () => unknown })?.toObject === 'function'
      ? (contract as { toObject: () => unknown }).toObject()
      : contract;
  return withPartials('runtime-edit-partial', onPartial, () =>
    invoke<CoreEditResult>('runtime_edit_contract', { contract: plain, instruction })
  );
}

export async function generateFromBlueprintViaCore(blueprint: {
  description?: unknown;
  goal?: unknown;
  requiredCapabilities?: unknown;
  uiElements?: unknown;
  operations?: unknown;
}): Promise<CoreEditResult> {
  // The same five-field summary the TS builder sends; class instances
  // flatten to exactly what the prompt consumes.
  return invoke<CoreEditResult>('runtime_generate_from_blueprint', {
    blueprint: {
      description: blueprint.description,
      goal: blueprint.goal,
      requiredCapabilities: blueprint.requiredCapabilities,
      uiElements: blueprint.uiElements,
      operations: blueprint.operations,
    },
  });
}
