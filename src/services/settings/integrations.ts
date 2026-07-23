/**
 * Integration credentials: named secrets stored on the Rust side that remote
 * operations reference via implementation.auth. The webview only ever sees
 * redacted views (name, kind, target).
 */

import { invoke } from '@tauri-apps/api/core';
import {
  IntegrationCredentialView,
  setIntegrationCredentials,
} from '../operations/registry';

export type { IntegrationCredentialView };

export async function refreshIntegrationCredentials(): Promise<IntegrationCredentialView[]> {
  try {
    const views = await invoke<IntegrationCredentialView[]>('list_integration_credentials');
    setIntegrationCredentials(views);
    return views;
  } catch {
    // Outside Tauri there is no store; the registry stays empty.
    setIntegrationCredentials([]);
    return [];
  }
}

export async function setIntegrationCredential(
  name: string,
  kind: string,
  target: string | undefined,
  secret: string
): Promise<IntegrationCredentialView[]> {
  const views = await invoke<IntegrationCredentialView[]>('set_integration_credential', {
    name,
    kind,
    target,
    secret,
  });
  setIntegrationCredentials(views);
  return views;
}

export async function deleteIntegrationCredential(
  name: string
): Promise<IntegrationCredentialView[]> {
  const views = await invoke<IntegrationCredentialView[]>('delete_integration_credential', {
    name,
  });
  setIntegrationCredentials(views);
  return views;
}
