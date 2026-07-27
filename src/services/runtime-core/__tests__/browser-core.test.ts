/**
 * The webview face with no desktop core behind it: the in-process kernel
 * hosts sessions and contract commands, and host-owned capabilities fail
 * their chain naming the desktop app. This is the same self-sufficiency
 * the native panel has, over the same protocol.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installBrowserCore, uninstallBrowserCore } from '../browser-core';
import { CoreSessionClient } from '../session-client';
import { coreInvoke } from '../core-invoke';

const KERNEL = resolve(__dirname, '../../../../runtime-wasm/dist/der_runtime_kernel.wasm');

const COUNTER_CONTRACT = {
  name: 'counter',
  version: '1.0.0',
  elements: [
    {
      id: 'count-text',
      type: 'text',
      dataBindings: [{ property: 'content', source: 'state', sourceId: 'clicks' }],
    },
    {
      id: 'click-btn',
      type: 'button',
      properties: { text: 'Click' },
      eventBindings: [{ event: 'click', operationId: 'op-add' }],
    },
  ],
  operations: [
    {
      id: 'op-add',
      operationName: 'counter.add',
      executionType: 'builtin',
      inputs: [{ name: 'key', source: 'constant', sourceId: 'clicks' }],
      outputs: [],
    },
  ],
};

beforeAll(() => {
  installBrowserCore({ bytes: readFileSync(KERNEL) });
});

afterAll(() => {
  uninstallBrowserCore();
});

describe('browser core', () => {
  it('runs a whole session over the in-process kernel', async () => {
    const client = new CoreSessionClient();
    const opened = await client.open(COUNTER_CONTRACT, {}, 'exp-browser');

    expect(opened.tree.length).toBeGreaterThan(0);

    const first = await client.dispatch(['op-add'], null);
    const second = await client.dispatch(['op-add'], null);
    expect(first?.failed).toBeNull();
    expect(second?.state.clicks).toBe(2);

    await client.close();
  });

  it('fails host-owned operations with a message naming the desktop app', async () => {
    const contract = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    contract.operations.push({
      id: 'op-fetch',
      operationName: 'http.get',
      executionType: 'builtin',
      inputs: [{ name: 'url', source: 'constant', sourceId: 'https://example.com/data' }],
      outputs: [],
    });
    contract.elements.push({
      id: 'fetch-btn',
      type: 'button',
      properties: { text: 'Fetch' },
      eventBindings: [{ event: 'click', operationId: 'op-fetch' }],
    });

    const client = new CoreSessionClient();
    await client.open(contract, {}, 'exp-hostless');
    const outcome = await client.dispatch(['op-fetch'], null);

    expect(outcome?.failed).toBe('op-fetch');
    expect(outcome?.error).toContain('needs the DER desktop app');

    await client.close();
  });

  it('serves the contract commands from the kernel', async () => {
    const verdict = await coreInvoke<{ shape: unknown; errors: string[] }>(
      'runtime_check_contract',
      { contract: COUNTER_CONTRACT }
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.shape).toBeTruthy();

    const broken = JSON.parse(JSON.stringify(COUNTER_CONTRACT));
    broken.operations[0].operationName = 'wizardry.cast';
    const rejected = await coreInvoke<{ shape: unknown; errors: string[] }>(
      'runtime_check_contract',
      { contract: broken }
    );
    expect(rejected.errors.join('\n')).toContain('wizardry.cast');

    const blueprint = await coreInvoke<{ description?: string }>(
      'runtime_derive_blueprint',
      { contract: COUNTER_CONTRACT, description: 'A click counter' }
    );
    expect(blueprint).toBeTruthy();
  });

  it('refuses commands only the desktop core can serve', async () => {
    await expect(coreInvoke('llm_chat', {})).rejects.toThrow('needs the DER desktop app');
  });
});
