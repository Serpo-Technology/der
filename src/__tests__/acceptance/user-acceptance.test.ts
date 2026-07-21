/**
 * User Acceptance Tests
 * Tests that validate user stories and acceptance criteria
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIInterpreterService } from '../../services/ai-interpreter';
import { RepositoryService } from '../../services/repository/repository-service';
import { DynamicExperienceRuntimeService } from '../../components/runtime/DynamicExperienceRuntimeService';
import { ExperienceEditorService } from '../../services/edit-preservation/ExperienceEditorService';
import { SharingService } from '../../services/persistence/SharingService';
import { BookmarkManager } from '../../services/persistence/BookmarkManager';
import { Contract } from '../../models/contract';

// Import types for test interfaces

interface EditOperation {
  id: string;
  type: 'property-change' | 'operation-change';
  timestamp: Date;
  elementId?: string;
  operationId?: string;
  property: string;
  oldValue: any;
  newValue: any;
  userId: string;
}

// Mock Tauri invoke at the top level
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockImplementation((command: string, args?: any) => {
    switch (command) {
      case 'share_experience':
        return Promise.resolve({
          contract: args?.contract || {},
          metadata: {
            title: args?.title || 'Shared Experience',
            description: args?.description,
            author: args?.author,
            created_at: new Date().toISOString(),
            shared_at: new Date().toISOString(),
            tags: args?.tags,
            category: args?.category
          },
          version: '1.0.0',
          checksum: 'mock-checksum'
        });
        case 'list_bookmarked_experiences':
        case 'list_bookmarked_experiences_detailed':
          return Promise.resolve([
            {
              id: 'bookmark-1',
              name: 'Test Bookmark',
              description: 'A test bookmark',
              contract: {},
              tags: ['test'],
              collection: args?.collection || 'default',
              createdAt: new Date().toISOString(),
              lastAccessedAt: new Date().toISOString(),
              thumbnail: null
            }
          ]);
      case 'save_experience':
        return Promise.resolve();
      case 'load_experience':
        return Promise.resolve(null);
      default:
        return Promise.resolve({});
    }
  })
}));



describe('User Acceptance Tests', () => {
  let aiInterpreter: AIInterpreterService;
  let repository: RepositoryService;
  let runtime: DynamicExperienceRuntimeService;
  let editorService: ExperienceEditorService;
  let sharingService: SharingService;
  let bookmarkManager: BookmarkManager;

  beforeEach(async () => {
    repository = new RepositoryService();
    
    // Create mock LLM config
    const mockLLMConfig = {
      provider: 'local' as const,
      model: 'test-model',
      temperature: 0.7,
      baseUrl: 'http://localhost:11434' // Mock Ollama URL
    };
    
    aiInterpreter = new AIInterpreterService(mockLLMConfig, repository);
    runtime = new DynamicExperienceRuntimeService();
    editorService = new ExperienceEditorService();
    sharingService = new SharingService();
    bookmarkManager = new BookmarkManager();

    // Mock basic functionality with proper UI element manifests
    vi.spyOn(repository, 'queryUIElements').mockImplementation(async (criteria) => {
      // Return matching manifests based on criteria
      if (criteria.name === 'input') {
        return [{
          id: 'input-manifest',
          name: 'input',
          version: '1.0.0',
          type: 'ui-element' as const,
          description: 'Input field component',
          capabilities: ['form-input'],
          dependencies: [],
          schema: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              placeholder: { type: 'string' },
              type: { type: 'string' }
            }
          },
          inputs: [],
          outputs: [],
          renderFunction: 'input-component',
          styleSchema: {
            type: 'object',
            properties: {}
          }
        }];
      }
      if (criteria.name === 'button') {
        return [{
          id: 'button-manifest',
          name: 'button',
          version: '1.0.0',
          type: 'ui-element' as const,
          description: 'Button component',
          capabilities: ['clickable'],
          dependencies: [],
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            },
            required: ['text']
          },
          inputs: [],
          outputs: [],
          renderFunction: 'button-component',
          styleSchema: {
            type: 'object',
            properties: {}
          }
        }];
      }
      return [];
    });
    vi.spyOn(repository, 'queryOperations').mockResolvedValue([]);
    

    
    // Mock fetch for LLM calls
    global.fetch = vi.fn().mockImplementation((_url: string, options?: any) => {
      const body = options?.body ? JSON.parse(options.body) : {};
      // Check both system and user messages for keywords
      const allMessages = body.messages || [];
      const userMessage = allMessages.find((m: any) => m.role === 'user')?.content || '';
      
      // Debug: Log the user message
      console.log('LLM Mock - User message:', userMessage);
      
      // Handle different types of requests - only ambiguous ones
      if (userMessage.includes('unclear') || userMessage.includes('ambiguous') || 
          userMessage.includes('Create a dashboard')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{
              message: {
                content: JSON.stringify({
                  intent: 'Create something unclear',
                  goal: 'Unclear goal',
                  description: 'An unclear request that needs clarification',
                  uiElements: [],
                  operations: [],
                  requiredCapabilities: [],
                  ambiguities: [
                    { type: 'unclear-intent', message: 'The request is too vague' }
                  ],
                  confidence: 0.3,
                  feedback: 'Please be more specific about what you want to create'
                })
              }
            }]
          })
        });
      }
      
      // Default response for normal requests
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          choices: [{
            message: {
              content: JSON.stringify({
                goal: 'Create a contact form for user inquiries',
                intent: 'Create a contact form',
                uiElements: [
                  { id: 'name-input', type: 'input', properties: { label: 'Name', placeholder: 'Enter your name' } },
                  { id: 'email-input', type: 'input', properties: { label: 'Email', type: 'email', placeholder: 'Enter your email' } },
                  { id: 'submit-btn', type: 'button', properties: { text: 'Submit' } }
                ],
                operations: [],
                requiredCapabilities: ['form-handling'],
                description: 'A simple contact form with name, email, and submit functionality',
                ambiguities: [],
                confidence: 0.9
              })
            }
          }]
        })
      });
    });
  });

  describe('User Story: Natural Language to Experience Creation', () => {
    it('As a user, I want to describe what I need in plain English and get a working experience', async () => {
      // Given: A user has a natural language description
      const userInput = 'I need a contact form with name, email, and message fields, plus a submit button';

      // When: The user inputs their description
      const blueprint = await aiInterpreter.parseNaturalLanguage(userInput);
      const contract = await aiInterpreter.generateContract(blueprint);
      const component = await runtime.renderExperience(contract);
      
      // Create a mock experience for testing
      const experience = {
        experienceId: 'contact-form-1',
        contract,
        state: {},
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          version: '1.0.0'
        }
      };

      // Then: A working experience should be created
      expect(blueprint).toBeDefined();
      expect((blueprint as any).intent).toContain('contact form');
      expect(contract.elements.length).toBeGreaterThan(0);
      expect(component).toBeDefined();
      expect(experience.experienceId).toBe('contact-form-1');

      // And: The experience should contain the requested elements
      const hasNameField = contract.elements.some(el => 
        el.type === 'input' && (
          el.properties.placeholder?.toString().toLowerCase().includes('name') ||
          el.properties.label?.toString().toLowerCase().includes('name')
        )
      );
      const hasEmailField = contract.elements.some(el => 
        el.type === 'input' && el.properties.type === 'email'
      );
      const hasSubmitButton = contract.elements.some(el => 
        el.type === 'button' && el.properties.text?.toString().toLowerCase().includes('submit')
      );

      expect(hasNameField).toBe(true);
      expect(hasEmailField).toBe(true);
      expect(hasSubmitButton).toBe(true);
    });

    it('As a user, I want the system to ask clarifying questions when my request is ambiguous', async () => {
      // Given: An ambiguous user request
      const ambiguousInput = 'Create a dashboard';

      // When: The user provides minimal information
      const blueprint = await aiInterpreter.parseNaturalLanguage(ambiguousInput);

      // Then: The system should identify ambiguities
      expect(blueprint.ambiguities).toBeDefined();
      expect(blueprint.ambiguities.length).toBeGreaterThan(0);

      // And: Should provide clarifying questions
      const questions = await aiInterpreter.generateClarifyingQuestions(blueprint);
      expect(questions).toBeDefined();
      expect(questions.length).toBeGreaterThan(0);
      expect(questions[0]).toMatch(/what.*data|type.*chart|which.*metrics/i);
    });
  });

  describe('User Story: Experience Customization', () => {
    it('As a user, I want to customize the generated experience by editing properties', async () => {
      // Given: An existing experience
      const initialContract = new Contract({
        name: 'Simple Form',
        version: '1.0.0',
        elements: [
          {
            id: 'submit-btn',
            type: 'button',
            properties: { text: 'Submit', backgroundColor: '#007bff' },
            dataBindings: [],
            eventBindings: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('custom-form', initialContract);

      // When: The user customizes the button
      const customization: EditOperation = {
        id: 'custom-1',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'submit-btn',
        property: 'text',
        oldValue: 'Submit',
        newValue: 'Send Message',
        userId: 'user-123'
      };

      await editorService.applyEdit('custom-form', customization);

      // Then: The experience should reflect the changes
      const updatedContract = await editorService.getCurrentContract('custom-form');
      expect(updatedContract).not.toBeNull();
      const button = updatedContract!.elements.find(el => el.id === 'submit-btn');
      
      expect(button?.properties.text).toBe('Send Message');

      // And: The change should be tracked in history
      const history = await editorService.getEditHistory('custom-form');
      expect(history).toHaveLength(1);
      expect(history[0].newValue).toBe('Send Message');
    });

    it('As a user, I want my customizations to be preserved when I regenerate the experience', async () => {
      // Given: A customized experience
      const originalContract = new Contract({
        name: 'Dashboard',
        version: '1.0.0',
        elements: [
          {
            id: 'title',
            type: 'text',
            properties: { text: 'Dashboard', fontSize: '24px' },
            dataBindings: [],
            eventBindings: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('dashboard-1', originalContract);

      // User customizes the title
      await editorService.applyEdit('dashboard-1', {
        id: 'title-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'title',
        property: 'text',
        oldValue: 'Dashboard',
        newValue: 'My Personal Dashboard',
        userId: 'user-123'
      });

      // When: The user requests regeneration with new features
      // Note: In real implementation, this would be generated by AI service

      const preservedContract = await editorService.regenerateWithPreservation(
        'dashboard-1',
        ['elements', 'operations']
      );

      // Then: User customizations should be preserved
      const title = preservedContract.elements.find(el => el.id === 'title');
      expect(title?.properties.text).toBe('My Personal Dashboard');

      // And: New features should be added
      const chart = preservedContract.elements.find(el => el.id === 'revenue-chart');
      expect(chart).toBeDefined();
      expect(chart?.type).toBe('chart');
    });
  });

  describe('User Story: Experience Sharing and Collaboration', () => {
    it('As a user, I want to share my experience with others via a link', async () => {
      // Given: A user has created an experience
      const contract = new Contract({
        name: 'Shared Dashboard',
        version: '1.0.0',
        elements: [
          {
            id: 'welcome-text',
            type: 'text',
            properties: { text: 'Welcome to my dashboard!' },
            dataBindings: [],
            eventBindings: []
          }
        ],
        operations: []
      });

      // When: The user shares the experience
      const shareableExperience = await sharingService.createShareableExperience(
        'my-dashboard',
        contract,
        {
          title: 'My Awesome Dashboard',
          description: 'A dashboard I created for tracking metrics',
          isPublic: true,
          allowEditing: false,
          createdBy: 'user-123'
        }
      );

      const shareUrl = await sharingService.generateShareUrl(shareableExperience);

      // Then: A shareable link should be generated
      expect(shareUrl).toBeDefined();
      expect(shareUrl).toMatch(/^https?:\/\/.+\/share\/.+$/);

      // And: Others should be able to access it
      const sharedExperience = await sharingService.getSharedExperience(shareUrl);
      expect(sharedExperience).toBeDefined();
      expect(sharedExperience.metadata.title).toBe('My Awesome Dashboard');
      expect(sharedExperience.contract).toEqual(contract);
    });

    it('As a user, I want to import and customize shared experiences', async () => {
      // Given: A shared experience exists
      const originalContract = new Contract({
        name: 'Template Dashboard',
        version: '1.0.0',
        elements: [
          {
            id: 'template-title',
            type: 'text',
            properties: { text: 'Template Dashboard' },
            dataBindings: [],
            eventBindings: []
          }
        ],
        operations: []
      });

      const sharedExperience = await sharingService.createShareableExperience(
        'template-dashboard',
        originalContract,
        {
          title: 'Dashboard Template',
          isPublic: true,
          createdBy: 'template-creator'
        }
      );

      const shareUrl = await sharingService.generateShareUrl(sharedExperience);

      // When: Another user imports the experience
      const importedExperience = await sharingService.importFromUrl(shareUrl, 'importer-456');

      // Then: A new independent experience should be created
      expect(importedExperience.experienceId).not.toBe('template-dashboard');
      expect(importedExperience.contract).toEqual(originalContract);
      expect(importedExperience.metadata.importedBy).toBe('importer-456');

      // And: The user should be able to customize it independently
      await editorService.initializeExperience(importedExperience.experienceId, importedExperience.contract);
      
      await editorService.applyEdit(importedExperience.experienceId, {
        id: 'customize-import',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'template-title',
        property: 'text',
        oldValue: 'Template Dashboard',
        newValue: 'My Customized Dashboard',
        userId: 'importer-456'
      });

      const customizedContract = await editorService.getCurrentContract(importedExperience.experienceId);
      expect(customizedContract).not.toBeNull();
      const title = customizedContract!.elements.find(el => el.id === 'template-title');
      expect(title?.properties.text).toBe('My Customized Dashboard');
    });
  });

  describe('User Story: Experience Management and Organization', () => {
    it('As a user, I want to bookmark experiences I find useful', async () => {
      // Given: Useful shared experiences exist
      const experiences = [
        {
          id: 'analytics-dashboard',
          title: 'Analytics Dashboard',
          tags: ['analytics', 'business']
        },
        {
          id: 'project-tracker',
          title: 'Project Tracker',
          tags: ['project', 'management']
        }
      ];

      const userId = 'user-123';

      // When: The user bookmarks experiences
      for (const exp of experiences) {
        const shareableExperience = {
          id: exp.id,
          experienceId: exp.id,
          contract: {
            name: exp.title,
            version: '1.0.0',
            elements: [],
            operations: [],
            operationBindings: []
          },
          metadata: {
            title: exp.title,
            tags: exp.tags,
            isPublic: true,
            createdBy: 'creator',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          checksum: 'checksum'
        };

        await bookmarkManager.bookmarkExperience(userId, shareableExperience, {
          tags: exp.tags,
          collection: 'Work Tools'
        });
      }

      // Then: The bookmarks should be saved and organized
      const workBookmarks = await bookmarkManager.getBookmarksByCollection(userId, 'Work Tools');
      expect(workBookmarks).toHaveLength(2);

      // And: The user should be able to search bookmarks
      const analyticsBookmarks = await bookmarkManager.searchBookmarks('analytics');
      expect(analyticsBookmarks).toHaveLength(1);
      expect(analyticsBookmarks[0].id).toContain('analytics');
    });

    it('As a user, I want to organize my bookmarks into collections', async () => {
      const userId = 'organizer-123';
      
      // Given: Multiple bookmarks in different categories
      const bookmarkData = [
        { id: 'dashboard-1', title: 'Sales Dashboard', collection: 'Business' },
        { id: 'dashboard-2', title: 'Marketing Dashboard', collection: 'Business' },
        { id: 'form-1', title: 'Contact Form', collection: 'Forms' },
        { id: 'form-2', title: 'Survey Form', collection: 'Forms' }
      ];

      // When: The user creates bookmarks in different collections
      for (const data of bookmarkData) {
        const shareableExperience = {
          id: data.id,
          experienceId: data.id,
          contract: { name: data.title, version: '1.0.0', elements: [], operations: [], operationBindings: [] },
          metadata: {
            title: data.title,
            isPublic: true,
            createdBy: 'creator',
            createdAt: new Date(),
            updatedAt: new Date()
          },
          checksum: 'checksum'
        };

        await bookmarkManager.bookmarkExperience(userId, shareableExperience, {
          collection: data.collection
        });
      }

      // Then: Bookmarks should be organized by collection
      const businessBookmarks = await bookmarkManager.getBookmarksByCollection(userId, 'Business');
      const formBookmarks = await bookmarkManager.getBookmarksByCollection(userId, 'Forms');

      expect(businessBookmarks).toHaveLength(2);
      expect(formBookmarks).toHaveLength(2);

      // And: User should be able to get all collections
      const allBookmarks = await bookmarkManager.getAllBookmarks(userId);
      expect(allBookmarks).toHaveLength(4);
    });
  });

  describe('User Story: Error Recovery and Graceful Degradation', () => {
    it('As a user, I want the system to handle errors gracefully and provide helpful feedback', async () => {
      // Given: A scenario that might cause errors
      const problematicInput = 'Create a widget with impossible requirements that cannot be fulfilled';

      // When: The system encounters issues
      try {
        const blueprint = await aiInterpreter.parseNaturalLanguage(problematicInput);
        const contract = await aiInterpreter.generateContract(blueprint);

        // Then: The system should provide a fallback solution
        expect(contract).toBeDefined();
        expect(contract.elements.length).toBeGreaterThan(0);

        // And: Should indicate limitations or suggest alternatives
        expect((blueprint as any).limitations).toBeDefined();
        expect((blueprint as any).suggestions).toBeDefined();
      } catch (error) {
        // Or provide a meaningful error message
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/unable to fulfill|not supported|try instead/i);
      }
    });

    it('As a user, I want to recover from failed operations without losing my work', async () => {
      // Given: An experience with some work done
      const contract = new Contract({
        name: 'Work in Progress',
        version: '1.0.0',
        elements: [
          {
            id: 'important-data',
            type: 'text',
            properties: { text: 'Important user data' },
            dataBindings: [],
            eventBindings: []
          }
        ],
        operations: []
      });

      await editorService.initializeExperience('recovery-test', contract);

      // User makes important edits
      await editorService.applyEdit('recovery-test', {
        id: 'important-edit',
        type: 'property-change',
        timestamp: new Date(),
        elementId: 'important-data',
        property: 'text',
        oldValue: 'Important user data',
        newValue: 'Very important customized data',
        userId: 'user-123'
      });

      // When: An operation fails
      const mockFailingOperation = vi.fn().mockRejectedValue(new Error('Operation failed'));

      try {
        await mockFailingOperation();
      } catch (error) {
        // Then: The user's work should still be preserved
        const preservedContract = await editorService.getCurrentContract('recovery-test');
        expect(preservedContract).not.toBeNull();
        const dataElement = preservedContract!.elements.find(el => el.id === 'important-data');
        
        expect(dataElement?.properties.text).toBe('Very important customized data');

        // And: The user should be able to continue working
        await editorService.applyEdit('recovery-test', {
          id: 'continue-edit',
          type: 'property-change',
          timestamp: new Date(),
          elementId: 'important-data',
          property: 'text',
          oldValue: 'Very important customized data',
          newValue: 'Recovered and continued work',
          userId: 'user-123'
        });

        const finalContract = await editorService.getCurrentContract('recovery-test');
        expect(finalContract).not.toBeNull();
        const finalElement = finalContract!.elements.find(el => el.id === 'important-data');
        expect(finalElement?.properties.text).toBe('Recovered and continued work');
      }
    });
  });

  describe('User Story: Performance and Responsiveness', () => {
    it('As a user, I want the system to respond quickly to my interactions', async () => {
      // Given: A user interaction scenario
      const simpleRequest = 'Create a button';

      // When: The user makes a request
      const startTime = performance.now();
      
      const blueprint = await aiInterpreter.parseNaturalLanguage(simpleRequest);
      const contract = await aiInterpreter.generateContract(blueprint);
      const experience = await runtime.renderExperience(contract);
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Then: The system should respond within acceptable time limits
      expect(totalTime).toBeLessThan(1000); // Complete workflow within 1 second
      expect(experience).toBeDefined();
    });

    it('As a user, I want the system to handle multiple concurrent requests efficiently', async () => {
      // Given: Multiple users making requests simultaneously
      const requests = [
        'Create a login form',
        'Build a data table',
        'Make a chart widget',
        'Design a navigation menu'
      ];

      // When: Multiple requests are processed concurrently
      const startTime = performance.now();
      
      const results = await Promise.all(
        requests.map(async (request, _index) => {
          const blueprint = await aiInterpreter.parseNaturalLanguage(request);
          const contract = await aiInterpreter.generateContract(blueprint);
          return runtime.renderExperience(contract);
        })
      );
      
      const endTime = performance.now();
      const totalTime = endTime - startTime;

      // Then: All requests should complete efficiently
      expect(results).toHaveLength(4);
      expect(totalTime).toBeLessThan(2000); // All requests within 2 seconds
      
      results.forEach((result, _index) => {
        expect(result).toBeDefined();
      });
    });
  });

  describe('User Story: Accessibility and Usability', () => {
    it('As a user, I want generated experiences to be accessible', async () => {
      // Given: A request for a form
      const accessibilityRequest = 'Create an accessible contact form';

      // When: The system generates the experience
      const blueprint = await aiInterpreter.parseNaturalLanguage(accessibilityRequest);
      const contract = await aiInterpreter.generateContract(blueprint);

      // Then: The generated elements should include accessibility features
      const formElements = contract.elements.filter(el => el.type === 'input');
      
      formElements.forEach(element => {
        // Should have proper labels or aria-labels
        expect(
          element.properties.label || 
          element.properties['aria-label'] || 
          element.properties.placeholder
        ).toBeDefined();

        // Should have proper input types
        if (element.properties.type === 'email') {
          expect(element.properties.type).toBe('email');
        }
      });

      // Submit button should be properly labeled
      const submitButton = contract.elements.find(el => 
        el.type === 'button' && el.properties.text?.toLowerCase().includes('submit')
      );
      expect(submitButton?.properties.text).toBeDefined();
    });

    it('As a user, I want clear feedback when the system cannot understand my request', async () => {
      // Given: An unclear or invalid request
      const unclearRequest = 'Make it do the thing with the stuff';

      // When: The system processes the unclear request
      const blueprint = await aiInterpreter.parseNaturalLanguage(unclearRequest);

      // Then: The system should provide clear feedback
      expect((blueprint as any).confidence).toBeLessThan(0.5); // Low confidence
      expect((blueprint as any).feedback).toBeDefined();
      expect((blueprint as any).feedback).toMatch(/unclear|specific|clarify/i);

      // And: Should suggest improvements
      expect((blueprint as any).suggestions).toBeDefined();
      expect((blueprint as any).suggestions.length).toBeGreaterThan(0);
    });
  });
});
