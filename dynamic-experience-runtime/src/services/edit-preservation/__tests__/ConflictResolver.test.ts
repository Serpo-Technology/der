/**
 * ConflictResolver Tests
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ConflictResolver } from '../ConflictResolver';
import { UserEdit, EditingConflict, Resolution } from '../../../interfaces/experience-editor';

describe('ConflictResolver', () => {
  let conflictResolver: ConflictResolver;

  beforeEach(() => {
    conflictResolver = new ConflictResolver();
  });

  it('detects AI-user conflicts', () => {
    const aiChanges = {
      contract: {
        name: 'AI Generated Name',
        version: '2.0.0'
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.name',
        originalValue: 'Original Name',
        newValue: 'User Modified Name',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const conflicts = conflictResolver.detectConflicts(aiChanges, userEdits);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe('ai-user-conflict');
    expect(conflicts[0].location).toBe('contract.name');
    expect(conflicts[0].aiSuggestion).toBe('AI Generated Name');
    expect(conflicts[0].userEdit).toBe('User Modified Name');
  });

  it('does not detect conflicts when values match', () => {
    const aiChanges = {
      contract: {
        name: 'Same Name',
        version: '2.0.0'
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.name',
        originalValue: 'Original Name',
        newValue: 'Same Name',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const conflicts = conflictResolver.detectConflicts(aiChanges, userEdits);
    expect(conflicts).toHaveLength(0);
  });

  it('resolves conflict with keep-user option', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.name',
      aiSuggestion: 'AI Name',
      userEdit: 'User Name',
      resolutionOptions: [
        {
          id: 'keep-user',
          description: 'Keep user changes',
          action: 'keep-user'
        },
        {
          id: 'keep-ai',
          description: 'Accept AI suggestion',
          action: 'keep-ai'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.name',
      selectedOption: 'keep-user'
    };

    const result = conflictResolver.resolveConflict(conflict, resolution);
    expect(result).toBe('User Name');
  });

  it('resolves conflict with keep-ai option', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.name',
      aiSuggestion: 'AI Name',
      userEdit: 'User Name',
      resolutionOptions: [
        {
          id: 'keep-user',
          description: 'Keep user changes',
          action: 'keep-user'
        },
        {
          id: 'keep-ai',
          description: 'Accept AI suggestion',
          action: 'keep-ai'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.name',
      selectedOption: 'keep-ai'
    };

    const result = conflictResolver.resolveConflict(conflict, resolution);
    expect(result).toBe('AI Name');
  });

  it('resolves conflict with custom option', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.name',
      aiSuggestion: 'AI Name',
      userEdit: 'User Name',
      resolutionOptions: [
        {
          id: 'custom',
          description: 'Provide custom value',
          action: 'custom'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.name',
      selectedOption: 'custom',
      customValue: 'Custom Name'
    };

    const result = conflictResolver.resolveConflict(conflict, resolution);
    expect(result).toBe('Custom Name');
  });

  it('resolves conflict with merge option for objects', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.metadata',
      aiSuggestion: { description: 'AI Description', author: 'AI' },
      userEdit: { description: 'User Description', tags: ['user'] },
      resolutionOptions: [
        {
          id: 'merge',
          description: 'Merge both changes',
          action: 'merge'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.metadata',
      selectedOption: 'merge'
    };

    const result = conflictResolver.resolveConflict(conflict, resolution);
    expect(result).toEqual({
      description: 'User Description', // User edit takes precedence
      author: 'AI',
      tags: ['user']
    });
  });

  it('merges AI changes with user edits', () => {
    const aiChanges = {
      contract: {
        name: 'AI Name',
        version: '2.0.0',
        description: 'AI Description'
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.name',
        originalValue: 'Original Name',
        newValue: 'User Name',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const merged = conflictResolver.mergeChanges(aiChanges, userEdits);
    expect(merged.contract.name).toBe('User Name');
    expect(merged.contract.version).toBe('2.0.0');
    expect(merged.contract.description).toBe('AI Description');
  });

  it('throws error for invalid resolution option', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.name',
      aiSuggestion: 'AI Name',
      userEdit: 'User Name',
      resolutionOptions: [
        {
          id: 'keep-user',
          description: 'Keep user changes',
          action: 'keep-user'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.name',
      selectedOption: 'invalid-option'
    };

    expect(() => {
      conflictResolver.resolveConflict(conflict, resolution);
    }).toThrow('Invalid resolution option: invalid-option');
  });

  it('throws error for custom resolution without custom value', () => {
    const conflict: EditingConflict = {
      type: 'ai-user-conflict',
      location: 'contract.name',
      aiSuggestion: 'AI Name',
      userEdit: 'User Name',
      resolutionOptions: [
        {
          id: 'custom',
          description: 'Provide custom value',
          action: 'custom'
        }
      ]
    };

    const resolution: Resolution = {
      conflictId: 'contract.name',
      selectedOption: 'custom'
      // Missing customValue
    };

    expect(() => {
      conflictResolver.resolveConflict(conflict, resolution);
    }).toThrow('Custom resolution requires a custom value');
  });

  it('merges arrays by combining unique elements', () => {
    const aiChanges = {
      tags: ['ai', 'generated']
    };

    const userEdits: UserEdit[] = [
      {
        location: 'tags',
        originalValue: [],
        newValue: ['user', 'generated'], // 'generated' is duplicate
        timestamp: new Date(),
        preserved: true
      }
    ];

    const merged = conflictResolver.mergeChanges(aiChanges, userEdits);
    expect(merged.tags).toEqual(['user', 'generated']); // User edit takes precedence
  });

  it('handles nested object paths', () => {
    const aiChanges = {
      contract: {
        metadata: {
          description: 'AI Description',
          author: 'AI'
        }
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.metadata.description',
        originalValue: 'Original Description',
        newValue: 'User Description',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const merged = conflictResolver.mergeChanges(aiChanges, userEdits);
    expect(merged.contract.metadata.description).toBe('User Description');
    expect(merged.contract.metadata.author).toBe('AI');
  });

  it('handles array index paths', () => {
    const aiChanges = {
      elements: [
        { id: 'element1', type: 'button', text: 'AI Button' },
        { id: 'element2', type: 'input', placeholder: 'AI Input' }
      ]
    };

    const userEdits: UserEdit[] = [
      {
        location: 'elements[0].text',
        originalValue: 'Original Button',
        newValue: 'User Button',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const merged = conflictResolver.mergeChanges(aiChanges, userEdits);
    expect(merged.elements[0].text).toBe('User Button');
    expect(merged.elements[1].placeholder).toBe('AI Input');
  });

  it('creates resolution options for conflicts', () => {
    const aiChanges = {
      contract: {
        name: 'AI Name'
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.name',
        originalValue: 'Original Name',
        newValue: 'User Name',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const conflicts = conflictResolver.detectConflicts(aiChanges, userEdits);
    expect(conflicts[0].resolutionOptions).toHaveLength(4); // keep-user, keep-ai, merge, custom
    
    const optionIds = conflicts[0].resolutionOptions.map(opt => opt.id);
    expect(optionIds).toContain('keep-user');
    expect(optionIds).toContain('keep-ai');
    expect(optionIds).toContain('custom');
  });

  it('handles null and undefined values', () => {
    const aiChanges = {
      contract: {
        name: null
      }
    };

    const userEdits: UserEdit[] = [
      {
        location: 'contract.name',
        originalValue: 'Original Name',
        newValue: 'User Name',
        timestamp: new Date(),
        preserved: true
      }
    ];

    const conflicts = conflictResolver.detectConflicts(aiChanges, userEdits);
    
    // Find the AI-user conflict specifically
    const aiUserConflict = conflicts.find(c => c.type === 'ai-user-conflict');
    expect(aiUserConflict).toBeDefined();
    expect(aiUserConflict?.aiSuggestion).toBeNull();
  });
});