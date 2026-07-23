/**
 * A window whose webview boots after generation finished must still get the
 * final contract and status: the service replays its latest snapshot when
 * the window announces readiness.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const emitted: Array<{ event: string; payload: unknown }> = [];
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async (event: string, payload: unknown) => {
    emitted.push({ event, payload });
  }),
  listen: vi.fn(async () => () => undefined)
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { IntegratedExperienceService } from '../IntegratedExperienceService';

describe('assembly snapshot replay', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  it('replays the latest contract and terminal status on window-ready', async () => {
    const service = new IntegratedExperienceService();
    const snapshots = (service as unknown as {
      assemblySnapshots: Map<string, { contract: unknown; status: string }>;
    }).assemblySnapshots;
    snapshots.set('exp-1', {
      contract: { name: 'final-app', elements: [{ id: 'a', type: 'text' }] },
      status: 'done'
    });

    await service.replayAssemblyState('exp-1');

    expect(emitted.map((e) => e.event)).toEqual([
      'experience-contract-updated',
      'experience-assembly-status'
    ]);
    expect(emitted[0].payload).toMatchObject({
      experienceId: 'exp-1',
      contract: { name: 'final-app' }
    });
    expect(emitted[1].payload).toMatchObject({ experienceId: 'exp-1', status: 'done' });
  });

  it('does not send a status while still assembling, and stays quiet with no snapshot', async () => {
    const service = new IntegratedExperienceService();
    const snapshots = (service as unknown as {
      assemblySnapshots: Map<string, { contract: unknown; status: string }>;
    }).assemblySnapshots;
    snapshots.set('exp-2', { contract: { name: 'partial' }, status: 'assembling' });

    await service.replayAssemblyState('exp-2');
    expect(emitted.map((e) => e.event)).toEqual(['experience-contract-updated']);

    emitted.length = 0;
    await service.replayAssemblyState('exp-unknown');
    expect(emitted).toEqual([]);
  });
});
