/**
 * The conversational edit loop: a live experience refined by instruction,
 * regenerated through the manifest pipeline with stable ids.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { installInvokeMock, invokeMock } from '../support/tauri-invoke-mock';
import { SAMPLE_EDITED_CONTRACT } from '../../test/llm-mocks';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {})
}));

describe('Edit loop', () => {
  let service: IntegratedExperienceService;
  let handle: ReturnType<typeof installInvokeMock>;

  beforeEach(() => {
    handle = installInvokeMock();
    service = new IntegratedExperienceService();
  });

  it('refines a live experience and keeps existing ids', async () => {
    const created = await service.createExperienceFromNaturalLanguage('Create a todo list app');

    const result = await service.refineExperience(
      created.experienceId,
      'show how many items are left'
    );

    // Ids from the original contract survive the edit.
    const originalIds = created.contract.elements.map((e) => e.id);
    const editedIds = result.contract.elements.map((e) => e.id);
    for (const id of originalIds) {
      expect(editedIds).toContain(id);
    }
    // The new derived caption arrived.
    expect(editedIds).toContain('items-left');
    expect(result.contract.name).toBe(SAMPLE_EDITED_CONTRACT.name);
  });

  it('sends the current contract and the instruction to the model', async () => {
    const created = await service.createExperienceFromNaturalLanguage('Create a todo list app');

    await service.refineExperience(created.experienceId, 'show how many items are left');

    const editCalls = invokeMock.mock.calls.filter(
      ([cmd, args]: [string, any]) =>
        cmd === 'llm_chat' &&
        args?.request?.messages?.some(
          (m: { role: string; content: string }) =>
            m.role === 'user' && m.content.includes('Current contract:')
        )
    );
    expect(editCalls.length).toBeGreaterThanOrEqual(1);
    const [, args] = editCalls[editCalls.length - 1] as [string, any];
    const system = (args.request.systemBlocks ?? [])
      .map((block: { text: string }) => block.text)
      .join('\n');
    const user = args.request.messages.find((m: { role: string }) => m.role === 'user');
    expect(system).toContain('EDIT MODE');
    expect(user.content).toContain('show how many items are left');
    expect(user.content).toContain(created.contract.name);
  });

  it('re-saves a bookmarked app so the stored contract stays current', async () => {
    const created = await service.createExperienceFromNaturalLanguage('Create a todo list app');

    // Bookmark under the experience id, mirroring the app windows.
    await invokeMock('bookmark_experience', {
      experienceId: created.experienceId,
      name: created.contract.name,
      contract: created.contract.toObject()
    });
    expect(handle.bookmarks.has(created.experienceId)).toBe(true);

    await service.refineExperience(created.experienceId, 'show how many items are left');

    const stored = handle.bookmarks.get(created.experienceId);
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored!.contract)).toContain('items-left');
  });

  it('surfaces edit warnings from the manifest pass', async () => {
    const created = await service.createExperienceFromNaturalLanguage('Create a todo list app');

    const result = await service.refineExperience(
      created.experienceId,
      'show how many items are left'
    );

    // The edited fixture removes nothing, so no removal warnings; the
    // warnings array itself is always present for the caller.
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
