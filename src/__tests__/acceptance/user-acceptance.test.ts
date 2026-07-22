/**
 * User Acceptance Tests
 * Validates user stories against the LLM-backed generation pipeline and the
 * runtime, editing, sharing, and bookmarking services. Model calls run
 * against the mocked Tauri `llm_chat` command.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { RepositoryService } from '../../services/repository/repository-service';
import { registerBuiltins } from '../../services/repository/builtins';
import { DynamicExperienceRuntimeService } from '../../components/runtime/DynamicExperienceRuntimeService';
import { ExperienceEditorService } from '../../services/edit-preservation/ExperienceEditorService';
import { SharingService } from '../../services/persistence/SharingService';
import { BookmarkManager } from '../../services/persistence/BookmarkManager';
import { Contract } from '../../models/contract';
import { installInvokeMock, invokeMock } from '../support/tauri-invoke-mock';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));


// Composed fixture for a deliberately underspecified request: the spec's
// open questions become the blueprint's ambiguities.
const AMBIGUOUS_COMPOSED = {
  spec: {
    goal: 'Create a dashboard',
    assumptions: [],
    openQuestions: ['What data should the dashboard show?'],
  },
  contract: {
    name: 'dashboard',
    version: '1.0.0',
    elements: [{ id: 'body', type: 'container', properties: {} }],
    operations: [],
  },
};

function isComposeCall(args: any): boolean {
  const blocks = args?.request?.systemBlocks ?? [];
  return blocks.some((block: any) => String(block.text).includes('CREATE MODE'));
}

describe('User Acceptance Tests', () => {
  let aiInterpreter: AIInterpreterService;
  let repository: RepositoryService;
  let runtime: DynamicExperienceRuntimeService;
  let editorService: ExperienceEditorService;
  let sharingService: SharingService;
  let bookmarkManager: BookmarkManager;

  beforeEach(async () => {
    installInvokeMock();
    repository = new RepositoryService();
    await registerBuiltins(repository);
    aiInterpreter = new AIInterpreterService(repository);
    runtime = new DynamicExperienceRuntimeService();
    editorService = new ExperienceEditorService();
    sharingService = new SharingService();
    bookmarkManager = new BookmarkManager();
  });

  describe('User Story: Natural Language to Experience Creation', () => {
    it('As a user, I want to describe what I need in plain English and get a working experience', async () => {
      const userInput = 'I need a todo list where I can enter tasks and add them to a list';

      const { blueprint, contract } = await aiInterpreter.compose(userInput);
      const component = await runtime.renderExperience(contract, 'acceptance-todo');

      expect(blueprint.goal).toBe('Create a todo list app');
      expect(contract.elements.length).toBeGreaterThan(0);
      expect(component).toBeTypeOf('function');

      // The experience contains the requested elements
      const hasEntryField = contract.elements.some(
        (el) => el.type === 'input' && el.properties.placeholder
      );
      const hasAddButton = contract.elements.some(
        (el) => el.type === 'button' && typeof el.properties.text === 'string'
      );
      const hasList = contract.elements.some((el) => el.type === 'list');

      expect(hasEntryField).toBe(true);
      expect(hasAddButton).toBe(true);
      expect(hasList).toBe(true);

      // The runtime seeded the interactive state for it
      const state = runtime.getExperienceState('acceptance-todo');
      expect(state?.data.todos).toEqual([]);
    });

    it('As a user, I want the system to ask clarifying questions when my request is ambiguous', async () => {
      installInvokeMock({
        onCommand: (cmd, args) => {
          if (cmd === 'llm_chat' && isComposeCall(args)) {
            return {
              content: JSON.stringify(AMBIGUOUS_COMPOSED),
              provider: 'mock',
              model: 'mock',
            };
          }
          return undefined;
        },
      });

      const { blueprint } = await aiInterpreter.compose('Create a dashboard');

      expect(blueprint.ambiguities).toHaveLength(1);

      const clarifications = await aiInterpreter.generateClarifyingQuestions(blueprint);
      expect(clarifications).toHaveLength(1);
      expect(clarifications[0].question).toMatch(/what data/i);

      const questions = await aiInterpreter.generateQuestions(blueprint);
      expect(questions[0].text).toMatch(/what data/i);
      expect(questions[0].type).toBe('text');
    });
  });

  describe('User Story: Experience Customization', () => {
    it('As a user, I want to customize the generated experience by editing properties', async () => {
      const initialContract = new Contract({
        name: 'Simple Form',
        version: '1.0.0',
        elements: [
          {
            id: 'submit-btn',
            type: 'button',
            properties: { text: 'Submit', backgroundColor: '#007bff' },
            dataBindings: [],
            eventBindings: [],
            children: [],
          },
        ],
        operations: [],
      });

      await editorService.initializeExperience('custom-form', initialContract);

      await editorService.applyEdit('custom-form', {
        id: 'custom-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-btn',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123',
      });

      const updatedContract = await editorService.getCurrentContract('custom-form');
      expect(updatedContract).not.toBeNull();
      const button = updatedContract!.getElement('submit-btn');
      expect(button?.properties.text).toBe('Send Message');

      const history = await editorService.getEditHistory('custom-form');
      expect(history).toHaveLength(1);
      expect(history[0].newValue).toBe('Send Message');
    });

    it('As a user, I want my customizations to be preserved when the experience regenerates', async () => {
      const originalContract = new Contract({
        name: 'Dashboard',
        version: '1.0.0',
        elements: [
          {
            id: 'title',
            type: 'text',
            properties: { content: 'Dashboard', fontSize: '24px' },
            dataBindings: [],
            eventBindings: [],
            children: [],
          },
        ],
        operations: [],
      });

      await editorService.initializeExperience('dashboard-1', originalContract);

      await editorService.applyEdit('dashboard-1', {
        id: 'title-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'title',
        property: 'content',
        oldValue: 'Dashboard',
        newValue: 'My Personal Dashboard',
        userId: 'user-123',
      });

      const preservedContract = await editorService.regenerateWithPreservation('dashboard-1', [
        'elements',
      ]);

      const title = preservedContract.getElement('title');
      expect(title?.properties.content).toBe('My Personal Dashboard');
    });
  });

  describe('User Story: Experience Sharing and Collaboration', () => {
    it('As a user, I want to share my experience with others via a link', async () => {
      const shareableExperience = await sharingService.createShareableExperience(
        'my-dashboard',
        undefined,
        {
          title: 'My Awesome Dashboard',
          description: 'A dashboard I created for tracking metrics',
        }
      );

      expect(shareableExperience.metadata.title).toBe('My Awesome Dashboard');
      expect(shareableExperience.checksum).toBeDefined();

      const shareUrl = await sharingService.generateShareUrl(shareableExperience);
      expect(shareUrl).toMatch(/^https?:\/\/.+\/share\/.+$/);
    });

    it('As a user, I want to import a shared experience as my own copy', async () => {
      const importedExperience = await sharingService.importFromUrl(
        'https://app.example.com/share/some-share-id',
        'importer-456'
      );

      expect(importedExperience.experienceId).toBeDefined();
      expect(importedExperience.experienceId).not.toBe('some-share-id');
      expect(importedExperience.metadata.importedBy).toBe('importer-456');
      expect(importedExperience.metadata.importedAt).toBeInstanceOf(Date);
      expect(importedExperience.contract).toBeDefined();
    });
  });

  describe('User Story: Experience Management and Organization', () => {
    it('As a user, I want to bookmark experiences I find useful and search them later', async () => {
      const experiences = [
        { title: 'Analytics Dashboard', tags: ['analytics', 'business'] },
        { title: 'Project Tracker', tags: ['project', 'management'] },
      ];

      for (const exp of experiences) {
        await bookmarkManager.bookmarkExperience(
          'user-123',
          {
            contract: {
              name: exp.title,
              version: '1.0.0',
              elements: [],
              operations: [],
            },
          },
          { tags: exp.tags }
        );
      }

      const analyticsBookmarks = await bookmarkManager.searchBookmarks('analytics');
      expect(analyticsBookmarks).toHaveLength(1);
      expect(analyticsBookmarks[0].name).toBe('Analytics Dashboard');

      const byTag = await bookmarkManager.getBookmarksByTags(['management']);
      expect(byTag).toHaveLength(1);
      expect(byTag[0].name).toBe('Project Tracker');

      const all = await bookmarkManager.getBookmarks();
      expect(all).toHaveLength(2);
    });
  });

  describe('User Story: Error Recovery and Graceful Degradation', () => {
    it('As a user, I want clear feedback when my request cannot be processed', async () => {
      // Empty input is rejected up front without a model call
      await expect(aiInterpreter.compose('')).rejects.toThrow('Invalid description');
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'llm_chat')).toHaveLength(0);

      // A model outage surfaces as a meaningful error
      installInvokeMock({
        onCommand: (cmd) => {
          if (cmd === 'llm_chat') {
            throw new Error('model unavailable');
          }
          return undefined;
        },
      });
      await expect(
        aiInterpreter.compose('Create a todo list app')
      ).rejects.toThrow('Failed to compose experience');
    });

    it('As a user, I want to recover from failed operations without losing my work', async () => {
      const contract = new Contract({
        name: 'Work in Progress',
        version: '1.0.0',
        elements: [
          {
            id: 'important-data',
            type: 'text',
            properties: { content: 'Important user data' },
            dataBindings: [],
            eventBindings: [],
            children: [],
          },
        ],
        operations: [],
      });

      await editorService.initializeExperience('recovery-test', contract);

      await editorService.applyEdit('recovery-test', {
        id: 'important-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'important-data',
        property: 'content',
        oldValue: 'Important user data',
        newValue: 'Very important customized data',
        userId: 'user-123',
      });

      // An unrelated operation fails
      const failingOperation = vi.fn().mockRejectedValue(new Error('Operation failed'));
      await expect(failingOperation()).rejects.toThrow('Operation failed');

      // The user's work is still there
      const preservedContract = await editorService.getCurrentContract('recovery-test');
      expect(preservedContract!.getElement('important-data')?.properties.content).toBe(
        'Very important customized data'
      );

      // And the user can continue editing
      await editorService.applyEdit('recovery-test', {
        id: 'continue-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'important-data',
        property: 'content',
        oldValue: 'Very important customized data',
        newValue: 'Recovered and continued work',
        userId: 'user-123',
      });

      const finalContract = await editorService.getCurrentContract('recovery-test');
      expect(finalContract!.getElement('important-data')?.properties.content).toBe(
        'Recovered and continued work'
      );
    });
  });

  describe('User Story: Performance and Responsiveness', () => {
    it('As a user, I want the system to respond quickly to my interactions', async () => {
      const startTime = performance.now();

      const { contract } = await aiInterpreter.compose('Create a todo list app');
      const experience = await runtime.renderExperience(contract);

      const totalTime = performance.now() - startTime;

      // With the model mocked, the local pipeline overhead stays small
      expect(totalTime).toBeLessThan(1000);
      expect(experience).toBeDefined();
    });

    it('As a user, I want the system to handle multiple concurrent requests efficiently', async () => {
      const requests = [
        'Create a login form',
        'Build a data table',
        'Make a chart widget',
        'Design a navigation menu',
      ];

      const results = await Promise.all(
        requests.map(async (request, index) => {
          const { contract } = await aiInterpreter.compose(request);
          return runtime.renderExperience(contract, `concurrent-${index}`);
        })
      );

      expect(results).toHaveLength(4);
      results.forEach((result) => {
        expect(result).toBeTypeOf('function');
      });
    });
  });

  describe('User Story: Usability of Generated Experiences', () => {
    it('As a user, I want generated inputs and buttons to carry usable labels', async () => {
      const { contract } = await aiInterpreter.compose('Create an accessible todo list');

      const inputs = contract.elements.filter((el) => el.type === 'input');
      expect(inputs.length).toBeGreaterThan(0);
      inputs.forEach((element) => {
        expect(
          element.properties.label ||
            element.properties['aria-label'] ||
            element.properties.placeholder
        ).toBeDefined();
      });

      const collectButtons = (elements: typeof contract.elements): any[] =>
        elements.flatMap((el) => [
          ...(el.type === 'button' ? [el] : []),
          ...collectButtons((el.children as any) ?? []),
        ]);
      const buttons = collectButtons(contract.elements);
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach((button) => {
        expect(typeof button.properties.text).toBe('string');
        expect(button.properties.text.length).toBeGreaterThan(0);
      });
    });
  });
});
