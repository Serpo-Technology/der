/**
 * Operation Executor - runs a contract's operations exactly as declared:
 * builtin (registry function), local (custom code), or remote (HTTP via the
 * backend). Inputs resolve declaratively from element values, state, literals,
 * or the current list item.
 */

import { InputBinding, OperationBinding } from '../../types/contract';
import { tauriCommandService, OperationRequest } from '../../services/tauri/TauriCommandService';
import {
  BUILTIN_OPERATIONS,
  OperationContext,
  assembleStructured,
  getValueAtPath,
} from '../../services/operations/registry';
import { applyBindingTransforms } from '../../services/operations/transforms';

/** State surface the executor needs; implemented by ExperienceStateManager. */
export interface StateAccess {
  getData(key: string): unknown;
  setData(key: string, value: unknown): void;
}

/** Per-event context: the list item whose template fired the event, if any. */
export interface EventContext {
  item?: unknown;
}

export class OperationResolutionError extends Error {
  constructor(operation: OperationBinding) {
    super(
      `Unknown operation "${operation.operationName}" (${operation.id}): not a builtin and no runnable implementation`
    );
    this.name = 'OperationResolutionError';
  }
}

const LOCAL_CODE_TIMEOUT_MS = 5000;

type ExecType = 'builtin' | 'local' | 'remote';

export class OperationExecutor {
  async executeOperation(
    operation: OperationBinding,
    eventContext: EventContext,
    state: StateAccess
  ): Promise<Record<string, unknown>> {
    const inputs = this.resolveInputs(operation, eventContext, state);
    const type = this.resolveExecutionType(operation);

    switch (type) {
      case 'builtin':
        return await this.executeBuiltin(operation, inputs, state);
      case 'local':
        return await this.executeLocal(operation, inputs, state);
      case 'remote':
        return await this.executeRemote(operation, inputs);
    }
  }

  resolveExecutionType(operation: OperationBinding): ExecType {
    switch (operation.executionType) {
      case 'builtin':
        return 'builtin';
      case 'local':
        return 'local';
      case 'remote':
        return 'remote';
      case 'repository':
        // Legacy saved contracts: repository operations map onto the registry.
        if (BUILTIN_OPERATIONS[operation.operationName]) return 'builtin';
        break;
      default:
        break;
    }
    // Tolerance for omitted executionType.
    if (BUILTIN_OPERATIONS[operation.operationName]) return 'builtin';
    if (operation.implementation?.code) return 'local';
    if (operation.implementation?.endpoint) return 'remote';
    throw new OperationResolutionError(operation);
  }

  resolveInputs(
    operation: OperationBinding,
    eventContext: EventContext,
    state: StateAccess
  ): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const binding of operation.inputs) {
      inputs[binding.name] = this.resolveInput(binding, eventContext, state);
    }
    // Group item./set. style inputs into objects for structured builtins.
    const def = BUILTIN_OPERATIONS[operation.operationName];
    return assembleStructured(inputs, def?.structuredPrefixes);
  }

  private resolveInput(binding: InputBinding, eventContext: EventContext, state: StateAccess): unknown {
    let value: unknown;
    switch (binding.source) {
      case 'ui-element':
        value = state.getData(`element_${binding.sourceId}`);
        break;
      case 'state':
        value = state.getData(binding.sourceId);
        break;
      case 'constant':
        value = binding.value !== undefined ? binding.value : binding.sourceId;
        break;
      case 'item':
        value = getValueAtPath(eventContext.item, binding.sourceId);
        break;
      default:
        value = undefined;
    }
    return applyBindingTransforms(value, binding);
  }

  private operationContext(state: StateAccess): OperationContext {
    return {
      getState: (key) => state.getData(key),
      setState: (key, value) => state.setData(key, value),
    };
  }

  private async executeBuiltin(
    operation: OperationBinding,
    inputs: Record<string, unknown>,
    state: StateAccess
  ): Promise<Record<string, unknown>> {
    const def = BUILTIN_OPERATIONS[operation.operationName];
    if (!def) {
      throw new OperationResolutionError(operation);
    }
    return await def.execute(inputs, this.operationContext(state));
  }

  private async executeLocal(
    operation: OperationBinding,
    inputs: Record<string, unknown>,
    state: StateAccess
  ): Promise<Record<string, unknown>> {
    const code = operation.implementation?.code;
    if (!code) {
      throw new Error(`Local operation ${operation.id} has no code`);
    }

    let fn: (inputs: Record<string, unknown>, ctx: OperationContext) => unknown;
    try {
      fn = new Function('inputs', 'ctx', code) as typeof fn;
    } catch (error) {
      throw new Error(
        `Local operation ${operation.id} has invalid code: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Local operation ${operation.id} timed out after ${LOCAL_CODE_TIMEOUT_MS}ms`)),
        LOCAL_CODE_TIMEOUT_MS
      )
    );
    const result = await Promise.race([
      Promise.resolve().then(() => fn(inputs, this.operationContext(state))),
      timeout,
    ]);

    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(
        `Local operation ${operation.id} must return an object keyed by output names`
      );
    }
    return result as Record<string, unknown>;
  }

  private async executeRemote(
    operation: OperationBinding,
    inputs: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const implementation = operation.implementation;
    if (!implementation?.endpoint) {
      throw new Error(`Remote operation ${operation.id} has no endpoint`);
    }

    const request: OperationRequest = {
      operation_id: operation.id,
      operation_name: operation.operationName,
      operation_type: 'remote',
      inputs,
      implementation: {
        type: 'remote',
        endpoint: implementation.endpoint,
        method: implementation.method || 'GET',
        headers: implementation.headers || {},
      },
    };

    const result = await tauriCommandService.executeOperation(request);
    if (!result.success) {
      throw new Error(`Remote operation failed: ${result.error || 'Unknown error'}`);
    }
    const data = result.data;
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    // Non-object payloads land under a stable key so outputs can route them.
    return { response: data };
  }
}

export default OperationExecutor;
