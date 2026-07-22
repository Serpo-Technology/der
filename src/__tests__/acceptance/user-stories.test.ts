/**
 * User Stories and Acceptance Criteria Tests
 * Validates the requirements against the integrated service. Generation is
 * LLM-backed through the mocked Tauri `llm_chat` command; storage commands
 * run against an in-memory store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IntegratedExperienceService } from '../../services/IntegratedExperienceService';
import { Blueprint } from '../../models/blueprint';
import { Contract } from '../../models/contract';
import { installInvokeMock } from '../support/tauri-invoke-mock';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));


describe('User Stories and Acceptance Criteria', () => {
  let integratedService: IntegratedExperienceService;

  beforeEach(() => {
    installInvokeMock();
    integratedService = new IntegratedExperienceService();
  });

  describe('Requirement 1: Natural Language to Blueprint', () => {
    it('should parse natural language and generate a structured blueprint', async () => {
      const description = 'Create a todo list app with add and complete functionality';

      const result = await integratedService.createExperienceFromNaturalLanguage(description);

      // 1.1: The system parses intent and capabilities
      expect(result.blueprint).toBeInstanceOf(Blueprint);
      expect(result.blueprint.goal).toBeTruthy();
      expect(result.blueprint.requiredCapabilities).toBeInstanceOf(Array);
      expect(result.blueprint.requiredCapabilities.length).toBeGreaterThan(0);

      // 1.2: The blueprint serializes to a consistent JSON shape
      const blueprintJson = result.blueprint.toObject();
      expect(blueprintJson).toHaveProperty('description');
      expect(blueprintJson).toHaveProperty('goal');
      expect(blueprintJson).toHaveProperty('requiredCapabilities');
      expect(blueprintJson).toHaveProperty('uiElements');
      expect(blueprintJson).toHaveProperty('operations');

      // 1.4: Ambiguities carry the material for clarifying questions
      expect(result.blueprint.ambiguities).toBeDefined();
      if (result.blueprint.ambiguities.length > 0) {
        expect(result.blueprint.ambiguities[0]).toHaveProperty('question');
        expect(result.blueprint.ambiguities[0]).toHaveProperty('options');
      }

      // 1.5: The blueprint drives contract generation
      expect(result.contract).toBeInstanceOf(Contract);
    });
  });

  describe('Requirement 2: Blueprint to Contract Generation', () => {
    it('should generate structured contracts from blueprints with manual editing capability', async () => {
      const description = 'Build a todo management system';
      const result = await integratedService.createExperienceFromNaturalLanguage(description, {
        preserveEdits: true,
      });

      // 2.1: The contract includes UI elements with configurations
      expect(result.contract.elements).toBeInstanceOf(Array);
      expect(result.contract.elements.length).toBeGreaterThan(0);
      result.contract.elements.forEach((element) => {
        expect(element).toHaveProperty('id');
        expect(element).toHaveProperty('type');
        expect(element).toHaveProperty('properties');
      });

      // 2.2: The contract binds operations to UI elements
      expect(result.contract.operations).toBeInstanceOf(Array);
      expect(result.contract.operations.length).toBeGreaterThan(0);
      result.contract.operations.forEach((operation) => {
        expect(operation).toHaveProperty('id');
        expect(operation).toHaveProperty('operationName');
        expect(operation).toHaveProperty('inputs');
        expect(operation).toHaveProperty('outputs');
      });
      const boundOperationIds = result.contract.elements.flatMap((el) =>
        el.eventBindings.map((binding) => binding.operationId)
      );
      expect(boundOperationIds.length).toBeGreaterThan(0);
      const declaredIds = new Set(result.contract.operations.map((op) => op.id));
      boundOperationIds.forEach((id) => {
        expect(declaredIds.has(id)).toBe(true);
      });

      // 2.3: The contract is valid JSON conforming to the schema
      const contractJson = result.contract.toObject();
      expect(() => JSON.stringify(contractJson)).not.toThrow();
      const validation = result.contract.validate();
      expect(validation.isValid).toBe(true);

      // 2.4: The contract is manually editable
      const editResult = await integratedService.editExperience(result.experienceId, {
        type: 'property-change',
        elementId: result.contract.elements[0].id,
        property: 'content',
        newValue: 'Modified Label',
        originalValue: 'My Todos',
        timestamp: new Date(),
      });
      expect(editResult.success).toBe(true);

      // 2.7: The edited contract remains available with feedback
      const currentContract = await integratedService['editor'].getCurrentContract(
        result.experienceId
      );
      expect(currentContract).toBeDefined();
    });
  });

  describe('Requirement 3: Dynamic Experience Rendering', () => {
    it('should render interactive experiences from contracts', async () => {
      const description = 'Create a simple todo tracker';
      const result = await integratedService.createExperienceFromNaturalLanguage(description);

      // 3.1: A renderable React component comes back
      expect(result.renderComponent).toBeTypeOf('function');
      expect(result.experience).toHaveProperty('reactComponent');

      // 3.2: The experience exposes its elements and operations
      expect(result.experience.contract.elements).toBeInstanceOf(Array);
      expect(result.experience.operations).toBeInstanceOf(Map);

      // 3.4: Runtime state seeds from the contract and tracks updates
      const experienceState = await integratedService.getExperienceState(result.experienceId);
      expect(experienceState).toHaveProperty('data');
      expect(experienceState).toHaveProperty('lastUpdated');
      expect(experienceState?.data.todos).toEqual([]);
    });
  });

  describe('Requirement 4: Experience Persistence and Sharing', () => {
    it('should save, bookmark, and share experiences', async () => {
      const description = 'Create a note-taking app';
      const result = await integratedService.createExperienceFromNaturalLanguage(description, {
        autoSave: true,
      });

      // 4.1: The experience can be bookmarked
      const bookmark = await integratedService.bookmarkExperience(
        result.experienceId,
        'test-user',
        { personalNote: 'My note app' }
      );
      expect(bookmark).toHaveProperty('id');
      expect(bookmark.name).toBe(result.contract.name);

      // 4.2: The bookmark stores the serialized contract; loading restores it
      const loaded = await integratedService.loadBookmarkedExperience(bookmark.id, 'test-user');
      expect(loaded.contract.elements).toHaveLength(result.contract.elements.length);
      expect(loaded.contract.operations).toHaveLength(result.contract.operations.length);

      // 4.5: The loaded copy is independent and editable
      expect(loaded.experienceId).not.toBe(result.experienceId);
      const editResult = await integratedService.editExperience(loaded.experienceId, {
        type: 'property-change',
        elementId: loaded.contract.elements[0].id,
        property: 'content',
        newValue: 'Independent Edit',
        originalValue: 'My Todos',
        timestamp: new Date(),
      });
      expect(editResult.success).toBe(true);

      // 4.3: The experience has a shareable representation
      const shareResult = await integratedService.shareExperience(result.experienceId, {
        title: 'Shared Note App',
        isPublic: true,
      });
      expect(shareResult).toHaveProperty('shareUrl');
      expect(shareResult).toHaveProperty('shareableExperience');
      expect(shareResult.shareableExperience.checksum).toBeDefined();
    });
  });

  describe('Requirement 5: Experience Editing with Full Control', () => {
    it('should allow editing at every step with edit preservation', async () => {
      const description = 'Create a task tracker';
      const result = await integratedService.createExperienceFromNaturalLanguage(description, {
        preserveEdits: true,
      });

      // 5.2: The contract regenerates while user modifications survive
      await integratedService.editExperience(result.experienceId, {
        type: 'property-change',
        elementId: result.contract.elements[0].id,
        property: 'content',
        newValue: 'User Modified Label',
        originalValue: 'My Todos',
        timestamp: new Date(),
      });

      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        result.experienceId,
        'Enhanced task tracker with categories'
      );
      expect(regenerationResult.success).toBe(true);
      const preserved = regenerationResult.updatedContract.getElement(
        result.contract.elements[0].id
      );
      expect(preserved?.properties?.content).toBe('User Modified Label');

      // 5.5: Edits stay tracked through subsequent generations
      const editHistory = await integratedService.getEditHistory(result.experienceId);
      expect(editHistory.length).toBeGreaterThan(0);
    });
  });

  describe('Requirement 6: Component Repository Management', () => {
    it('should generate contracts from repository-known elements and operations', async () => {
      const description = 'Create a todo dashboard';
      const result = await integratedService.createExperienceFromNaturalLanguage(description);

      // 6.1: Elements carry complete configurations
      result.contract.elements.forEach((element) => {
        expect(element).toHaveProperty('type');
        expect(element).toHaveProperty('properties');
      });

      // 6.2: Operations specify inputs and outputs
      result.contract.operations.forEach((operation) => {
        expect(operation).toHaveProperty('inputs');
        expect(operation).toHaveProperty('outputs');
      });
    });
  });

  describe('Requirement 7: Custom Component Support', () => {
    it('should produce contracts that validate against the schema', async () => {
      const description = 'Create an app with custom widgets';
      const result = await integratedService.createExperienceFromNaturalLanguage(description);

      const validation = result.contract.validate();
      expect(validation.isValid).toBe(true);
    });
  });

  describe('Requirement 8: Multi-type Operation Support', () => {
    it('should resolve generated operations to runnable execution types', async () => {
      const description = 'Create an app that manages todos';
      const result = await integratedService.createExperienceFromNaturalLanguage(description);

      expect(result.contract.operations).toBeInstanceOf(Array);
      expect(result.contract.operations.length).toBeGreaterThan(0);
      result.contract.operations.forEach((operation) => {
        expect(['builtin', 'remote', 'local', 'repository']).toContain(operation.executionType);
      });
      // The generated todo operations bind to the builtin registry
      expect(result.contract.operations.every((op) => op.executionType === 'builtin')).toBe(true);
    });
  });

  describe('Requirement 9: Real-time Rendering', () => {
    it('should render experiences dynamically without build processes', async () => {
      const description = 'Create a live preview editor';
      const result = await integratedService.createExperienceFromNaturalLanguage(description, {
        preserveEdits: true,
        enableRealTimeUpdates: true,
      });

      // 9.1: Edits apply without a build step
      const editResult = await integratedService.editExperience(
        result.experienceId,
        {
          type: 'property-change',
          elementId: result.contract.elements[0].id,
          property: 'style',
          newValue: { color: 'blue' },
          originalValue: {},
          timestamp: new Date(),
        },
        { enableRealTimeUpdates: true }
      );
      expect(editResult.success).toBe(true);

      const experienceState = await integratedService.getExperienceState(result.experienceId);
      expect(experienceState?.lastUpdated).toBeInstanceOf(Date);
    });
  });

  describe('Requirement 10: Full Control Over AI Generation', () => {
    it('should provide full control over AI generation with manual editing at every step', async () => {
      const description = 'Create a comprehensive project management tool';

      const result = await integratedService.createExperienceFromNaturalLanguage(description, {
        preserveEdits: true,
      });

      // 10.1: The blueprint has a consistent JSON form
      expect(result.blueprint).toBeInstanceOf(Blueprint);
      const blueprintJson = result.blueprint.toObject();
      expect(() => JSON.stringify(blueprintJson)).not.toThrow();

      // 10.3: The contract is manually editable before rendering updates
      const editResult = await integratedService.editExperience(result.experienceId, {
        type: 'property-change',
        elementId: result.contract.elements[0].id,
        property: 'content',
        newValue: 'Manually Edited Label',
        originalValue: 'My Todos',
        timestamp: new Date(),
      });
      expect(editResult.success).toBe(true);

      // 10.4: Manual edits persist across subsequent operations
      const editHistory = await integratedService.getEditHistory(result.experienceId);
      expect(editHistory.length).toBeGreaterThan(0);

      // 10.5: Regeneration respects previous manual edits
      const regenerationResult = await integratedService.regenerateExperienceWithPreservation(
        result.experienceId,
        'Enhanced project management with suggestions'
      );
      expect(regenerationResult.success).toBe(true);
    });
  });

  describe('Integration Health Check', () => {
    it('should verify all services are properly integrated', async () => {
      const health = await integratedService.getServiceHealth();

      expect(health.aiInterpreter).toBe(true);
      expect(health.repository).toBe(true);
      expect(health.runtime).toBe(true);
      expect(health.editor).toBe(true);
      expect(health.sharing).toBe(true);
      expect(health.bookmarks).toBe(true);
      expect(health.persistence).toBe(true);
    });
  });

  describe('Error Handling and Recovery', () => {
    it('should handle errors gracefully throughout all workflows', async () => {
      // Empty descriptions are rejected before generation
      await expect(integratedService.createExperienceFromNaturalLanguage('')).rejects.toThrow();

      const validResult = await integratedService.createExperienceFromNaturalLanguage(
        'Create a simple app',
        { preserveEdits: true }
      );

      // Invalid edits report failure without corrupting the experience
      const invalidEdit = await integratedService.editExperience(validResult.experienceId, {
        type: 'invalid-edit-type',
        elementId: 'non-existent',
        property: 'invalid',
        newValue: 'test',
        originalValue: '',
        timestamp: new Date(),
      } as any);
      expect(invalidEdit.success).toBe(false);

      const contract = await integratedService['editor'].getCurrentContract(
        validResult.experienceId
      );
      expect(contract?.elements).toHaveLength(validResult.contract.elements.length);

      // Sharing an unknown experience fails loudly
      await expect(
        integratedService.shareExperience('non-existent-id', {
          title: 'Test',
          isPublic: true,
        })
      ).rejects.toThrow();
    });
  });
});
