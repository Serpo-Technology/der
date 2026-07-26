/**
 * Installed signed parts: syncs their operation manifests into the shared
 * part registry and executes them in the Rust wasm host. Guests are pure
 * (inputs to outputs); host errors carry a typed kind mapped to readable
 * messages, and guest-originated text is treated as untrusted (capped).
 */

import { invoke } from '@tauri-apps/api/core';
import {
  BUILTIN_OPERATIONS,
  FRAGMENT_ELEMENTS,
  FRAGMENT_OPERATIONS,
  FRAGMENT_RECIPES,
  BuiltinOperationDef,
  BuiltinIoSpec,
} from '../operations/registry';

interface FragmentIoSpec {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}

export interface RegistryPartEntry {
  id: string;
  name: string;
  version: string;
  publisher: string;
  namespace: string;
  description: string;
  operations: string[];
  recipes?: string[];
  bundleUrl: string;
  bundleSha256?: string;
  bundleBytes?: number;
}

export interface RegistryIndex {
  formatVersion: number;
  parts: RegistryPartEntry[];
}

interface FragmentUiSpec {
  name: string;
  description: string;
  howto?: string;
  params?: Array<{
    name: string;
    type: string;
    required?: boolean;
    default?: unknown;
    description?: string;
  }>;
  template: Record<string, unknown>;
  operations?: Array<Record<string, unknown>>;
}

interface FragmentOpSpec {
  name: string;
  description: string;
  inputs?: FragmentIoSpec[];
  outputs?: FragmentIoSpec[];
  howto?: string;
  example?: unknown;
  structuredPrefixes?: string[];
  remote?: { endpoint: string; method?: string };
}

export interface PartCredentialRequirement {
  name: string;
  kind: string;
  target?: string;
  label: string;
}

export interface FragmentRecipeSpec {
  name: string;
  title: string;
  description: string;
  keywords?: string[];
  spec?: { goal?: string; assumptions?: string[]; openQuestions?: string[] };
  contract: Record<string, unknown>;
}

export interface InstalledFragment {
  manifest: {
    id: string;
    name: string;
    version: string;
    publisher: string;
    description: string;
    namespace: string;
    operations: FragmentOpSpec[];
    uiFragments?: FragmentUiSpec[];
    recipes?: FragmentRecipeSpec[];
    service?: { baseUrl: string; credentials?: PartCredentialRequirement[] };
  };
  fingerprint: string;
  fingerprintGrouped: string;
}

export interface StageSummary {
  capabilities: string[];
  stagingToken: string;
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  namespace: string;
  operations: { name: string; description: string }[];
  recipes: { name: string; title: string; description: string }[];
  fingerprint: string;
  fingerprintGrouped: string;
  publisherStatus: 'new' | 'known' | 'keyMismatch';
  isDowngrade: boolean;
}


function toIoSpec(spec: FragmentIoSpec): BuiltinIoSpec {
  return {
    name: spec.name,
    type: spec.type,
    required: spec.required,
    description: spec.description,
  };
}

export class FragmentsService {
  private installed: InstalledFragment[] = [];

  /** Loads installed parts and publishes their operations to the registry. */
  async init(): Promise<void> {
    try {
      const parts = await invoke<InstalledFragment[]>('list_fragments');
      this.installed = parts ?? [];
    } catch (error) {
      // Outside Tauri (tests, plain vite) there are no installed parts.
      console.warn('Installed parts unavailable', error);
      this.installed = [];
    }
    this.publish();
  }

  getInstalled(): InstalledFragment[] {
    return this.installed;
  }

  private publish(): void {
    for (const key of Object.keys(FRAGMENT_OPERATIONS)) {
      delete FRAGMENT_OPERATIONS[key];
    }
    for (const key of Object.keys(FRAGMENT_ELEMENTS)) {
      delete FRAGMENT_ELEMENTS[key];
    }
    for (const key of Object.keys(FRAGMENT_RECIPES)) {
      delete FRAGMENT_RECIPES[key];
    }
    for (const part of this.installed) {
      const fragmentId = part.manifest.id;
      for (const op of part.manifest.operations) {
        // Builtins always win; a colliding part operation is unreachable.
        if (BUILTIN_OPERATIONS[op.name]) continue;
        FRAGMENT_OPERATIONS[op.name] = this.wrapOperation(fragmentId, op);
      }
      for (const fragment of part.manifest.uiFragments ?? []) {
        FRAGMENT_ELEMENTS[fragment.name] = {
          name: fragment.name,
          description: fragment.description,
          howto: fragment.howto,
          params: fragment.params ?? [],
          template: fragment.template as Record<string, unknown>,
          operations: fragment.operations,
        };
      }
      for (const recipe of part.manifest.recipes ?? []) {
        FRAGMENT_RECIPES[recipe.name] = {
          name: recipe.name,
          title: recipe.title,
          description: recipe.description,
          keywords: recipe.keywords ?? [],
          spec: recipe.spec,
          contract: recipe.contract,
          partId: fragmentId,
          publisher: part.manifest.publisher,
        };
      }
    }
  }

  private wrapOperation(_fragmentId: string, op: FragmentOpSpec): BuiltinOperationDef {
    // Execution happens in the runtime core (wasm sandbox or the confined
    // HTTP path); the webview publishes only the manifest surface.
    return {
      name: op.name,
      description: op.description,
      inputs: (op.inputs ?? []).map(toIoSpec),
      outputs: (op.outputs ?? []).map(toIoSpec),
      howto: op.howto,
      example: op.example as BuiltinOperationDef['example'],
      structuredPrefixes: op.structuredPrefixes,
    };
  }

  async listPartCredentials(fragmentId: string): Promise<string[]> {
    return await invoke<string[]>('list_part_credentials', { fragmentId });
  }

  async setPartCredential(fragmentId: string, name: string, secret: string): Promise<string[]> {
    return await invoke<string[]>('set_part_credential', { fragmentId, name, secret });
  }

  /** Registry entries with bundle URLs resolved to absolute http(s). */
  async fetchRegistryIndex(url: string): Promise<RegistryIndex> {
    return await invoke<RegistryIndex>('fetch_registry_index', { url });
  }

  /** Downloads a bundle from the registry and stages it for the normal
   * confirm flow; signatures and trust pinning judge it exactly like a
   * file install. */
  async stageFromRegistry(bundleUrl: string): Promise<StageSummary> {
    const bundleB64 = await invoke<string>('download_registry_bundle', { url: bundleUrl });
    return await this.stage(bundleB64);
  }

  async stage(bundleB64: string): Promise<StageSummary> {
    return await invoke<StageSummary>('stage_fragment', {
      bundleB64,
      reservedNames: Object.keys(BUILTIN_OPERATIONS),
    });
  }

  async commit(stagingToken: string, expectedFingerprint: string, forceDowngrade = false): Promise<void> {
    await invoke('commit_fragment', { stagingToken, expectedFingerprint, forceDowngrade });
    await this.init();
  }

  async remove(fragmentId: string): Promise<void> {
    await invoke('remove_fragment', { fragmentId });
    await this.init();
  }
}

export const fragmentsService = new FragmentsService();
