/**
 * Tests for PersistenceService
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PersistenceService } from '../PersistenceService';
import { Experience } from '../../../types/experience';
import { Contract } from '../../../types/contract';
import { ShareableContract } from '../../../types/persistence';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('PersistenceService', () => {
  let persistenceService: PersistenceService;
  let mockExperience: Experience;
  let mockContract: Contract;
  let mockInvoke: any;

  beforeEach(() => {
    persistenceService = new PersistenceService();
    mockInvoke = vi.mocked(invoke);
    vi.clearAllMocks();

    mockContract = {
      name: 'Test Experience',
      version: '1.0.0',
      elements: [
        {
          id: 'title',
          type: 'text',
          properties: { content: 'Test' },
          dataBindings: [],
          eventBindings: []
        }
      ],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        version: '1.0.0',
        description: 'Test experience description',
        tags: ['test', 'demo']
      }
    };

    mockExperience = {
      id: 'test-experience-1',
      contract: mockContract,
      reactComponent: () => null,
      state: {
        data: {},
        loading: {},
        errors: {},
        lastUpdated: new Date()
      },
      operations: new Map()
    };
  });

  describe('bookmarkExperience', () => {
    it('should bookmark an experience successfully', async () => {
      mockInvoke.mockResolvedValue('test-experience-1');

      const result = await persistenceService.bookmarkExperience(mockExperience);

      expect(result).toBe('test-experience-1');
      expect(mockInvoke).toHaveBeenCalledWith('bookmark_experience', {
        experienceId: 'test-experience-1',
        name: 'Test Experience',
        description: 'Test experience description',
        contract: mockContract,
        tags: ['test', 'demo']
      });
    });

    it('should handle unnamed experiences', async () => {
      const unnamedContract = { ...mockContract, name: '' };
      const unnamedExperience = {
        ...mockExperience,
        contract: unnamedContract
      };
      mockInvoke.mockResolvedValue('test-experience-1');

      await persistenceService.bookmarkExperience(unnamedExperience);

      expect(mockInvoke).toHaveBeenCalledWith('bookmark_experience', {
        experienceId: 'test-experience-1',
        name: 'Unnamed Experience',
        description: 'Test experience description',
        contract: unnamedExperience.contract,
        tags: ['test', 'demo']
      });
    });

    it('should throw error on bookmark failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Storage error'));

      await expect(persistenceService.bookmarkExperience(mockExperience))
        .rejects.toThrow('Failed to bookmark experience: Error: Storage error');
    });
  });

  describe('loadBookmarkedExperience', () => {
    it('should load a bookmarked experience successfully', async () => {
      const mockBookmarkData = {
        id: 'test-experience-1',
        name: 'Test Experience',
        contract: mockContract,
        last_accessed_at: '2024-01-01T00:00:00Z'
      };
      mockInvoke.mockResolvedValue(mockBookmarkData);

      const result = await persistenceService.loadBookmarkedExperience('test-experience-1');

      expect(result).toBeDefined();
      expect(result!.id).toBe('test-experience-1');
      expect(result!.contract).toEqual(mockContract);
      expect(result!.state.lastUpdated).toEqual(new Date('2024-01-01T00:00:00Z'));
      expect(mockInvoke).toHaveBeenCalledWith('load_bookmarked_experience', {
        experienceId: 'test-experience-1'
      });
    });

    it('should return null for non-existent experience', async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await persistenceService.loadBookmarkedExperience('non-existent');

      expect(result).toBeNull();
    });

    it('should throw error on load failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Storage error'));

      await expect(persistenceService.loadBookmarkedExperience('test-experience-1'))
        .rejects.toThrow('Failed to load bookmarked experience: Error: Storage error');
    });
  });

  describe('listBookmarkedExperiences', () => {
    it('should list all bookmarked experiences', async () => {
      const mockBookmarks = [
        {
          id: 'exp-1',
          name: 'Experience 1',
          description: 'First experience',
          contract: mockContract,
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessedAt: '2024-01-02T00:00:00Z',
          tags: ['tag1'],
          thumbnail: null
        },
        {
          id: 'exp-2',
          name: 'Experience 2',
          description: null,
          contract: mockContract,
          createdAt: '2024-01-03T00:00:00Z',
          lastAccessedAt: '2024-01-04T00:00:00Z',
          tags: null,
          thumbnail: 'thumb.png'
        }
      ];
      mockInvoke.mockResolvedValue(mockBookmarks);

      const result = await persistenceService.listBookmarkedExperiences();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('exp-1');
      expect(result[0].createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
      expect(result[1].id).toBe('exp-2');
      expect(result[1].thumbnail).toBe('thumb.png');
    });

    it('should handle empty bookmark list', async () => {
      mockInvoke.mockResolvedValue([]);

      const result = await persistenceService.listBookmarkedExperiences();

      expect(result).toHaveLength(0);
    });
  });

  describe('shareExperience', () => {
    it('should create a shareable contract', async () => {
      const mockShareableContract = {
        contract: mockContract,
        metadata: {
          title: 'Shared Experience',
          description: 'Shared for testing',
          author: 'Test Author',
          created_at: '2024-01-01T00:00:00Z',
          shared_at: '2024-01-02T00:00:00Z',
          tags: ['shared'],
          category: 'demo'
        },
        version: '1.0.0',
        checksum: 'abc123'
      };
      mockInvoke.mockResolvedValue(mockShareableContract);

      const result = await persistenceService.shareExperience('test-experience-1', {
        title: 'Shared Experience',
        description: 'Shared for testing',
        author: 'Test Author',
        tags: ['shared'],
        category: 'demo'
      });

      expect(result.contract).toEqual(mockContract);
      expect(result.metadata.title).toBe('Shared Experience');
      expect(result.metadata.createdAt).toEqual(new Date('2024-01-01T00:00:00Z'));
      expect(result.checksum).toBe('abc123');
    });
  });

  describe('importSharedExperience', () => {
    it('should import a shared experience successfully', async () => {
      const shareableContract: ShareableContract = {
        contract: mockContract,
        metadata: {
          title: 'Imported Experience',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          sharedAt: new Date('2024-01-02T00:00:00Z')
        },
        version: '1.0.0',
        checksum: 'abc123'
      };

      mockInvoke
        .mockResolvedValueOnce({ success: true, experienceId: 'imported-123' })
        .mockResolvedValueOnce({
          id: 'imported-123',
          contract: mockContract,
          last_accessed_at: '2024-01-02T00:00:00Z'
        });

      const result = await persistenceService.importSharedExperience(shareableContract);

      expect(result.id).toBe('imported-123');
      expect(result.contract).toEqual(mockContract);
    });

    it('should handle import failure', async () => {
      const shareableContract: ShareableContract = {
        contract: mockContract,
        metadata: {
          title: 'Failed Import',
          createdAt: new Date(),
          sharedAt: new Date()
        },
        version: '1.0.0',
        checksum: 'abc123'
      };

      mockInvoke.mockResolvedValue({ success: false, message: 'Import failed' });

      await expect(persistenceService.importSharedExperience(shareableContract))
        .rejects.toThrow('Failed to import shared experience: Error: Import failed');
    });
  });

  describe('duplicateExperience', () => {
    it('should duplicate an experience with new name', async () => {
      mockInvoke
        .mockResolvedValueOnce('duplicate-123')
        .mockResolvedValueOnce({
          id: 'duplicate-123',
          contract: { ...mockContract, name: 'Test Experience (Copy)' },
          last_accessed_at: '2024-01-02T00:00:00Z'
        });

      const result = await persistenceService.duplicateExperience('test-experience-1', 'Test Experience (Copy)');

      expect(result.id).toBe('duplicate-123');
      expect(result.contract.name).toBe('Test Experience (Copy)');
      expect(mockInvoke).toHaveBeenCalledWith('duplicate_experience', {
        experienceId: 'test-experience-1',
        newName: 'Test Experience (Copy)'
      });
    });
  });

  describe('updateExperience', () => {
    it('should update an experience with versioning', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await persistenceService.updateExperience('test-experience-1', {
        contract: mockContract,
        preserveUserEdits: true
      });

      expect(mockInvoke).toHaveBeenCalledWith('update_experience', {
        experienceId: 'test-experience-1',
        newContract: mockContract,
        newBlueprint: undefined,
        preserveUserEdits: true,
        changesSummary: 'Experience updated via API'
      });
    });
  });

  describe('getExperienceVersions', () => {
    it('should return version history', async () => {
      const mockVersions = [
        {
          version: 2,
          createdAt: '2024-01-02T00:00:00Z',
          changesSummary: 'Updated UI elements'
        },
        {
          version: 1,
          createdAt: '2024-01-01T00:00:00Z',
          changesSummary: 'Initial version'
        }
      ];
      mockInvoke.mockResolvedValue(mockVersions);

      const result = await persistenceService.getExperienceVersions('test-experience-1');

      expect(result).toHaveLength(2);
      expect(result[0].version).toBe(2);
      expect(result[0].createdAt).toEqual(new Date('2024-01-02T00:00:00Z'));
      expect(result[1].changesSummary).toBe('Initial version');
    });
  });

  describe('restoreExperienceVersion', () => {
    it('should restore to specific version', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await persistenceService.restoreExperienceVersion('test-experience-1', 1);

      expect(mockInvoke).toHaveBeenCalledWith('restore_experience_version', {
        experienceId: 'test-experience-1',
        version: 1
      });
    });
  });

  describe('exportExperience', () => {
    it('should export experience in JSON format', async () => {
      const mockShareableContract = {
        contract: mockContract,
        metadata: { title: 'Export Test', createdAt: new Date(), sharedAt: new Date() },
        version: '1.0.0',
        checksum: 'abc123'
      };
      
      mockInvoke
        .mockResolvedValueOnce({
          id: 'test-experience-1',
          contract: mockContract,
          last_accessed_at: '2024-01-01T00:00:00Z'
        })
        .mockResolvedValueOnce(mockShareableContract);

      const result = await persistenceService.exportExperience('test-experience-1');

      expect(result).toContain('"contract"');
      expect(result).toContain('"metadata"');
      expect(result).toContain('"checksum"');
    });
  });

  describe('importExperience', () => {
    it('should import experience from JSON string', async () => {
      const shareableContract: ShareableContract = {
        contract: mockContract,
        metadata: {
          title: 'Imported',
          createdAt: new Date(),
          sharedAt: new Date()
        },
        version: '1.0.0',
        checksum: 'abc123'
      };

      const jsonData = JSON.stringify(shareableContract);

      mockInvoke.mockImplementation(async (command: string, args: any) => {
        // Contract validation and finalization run in the kernel; storage
        // commands answer like the Rust side.
        if (command.startsWith('runtime_')) {
          return (await import('../../../test/kernel-invoke')).kernelInvoke(command, args);
        }
        if (command === 'import_shared_experience') {
          return { success: true, experienceId: 'imported-123' };
        }
        if (command === 'load_bookmarked_experience') {
          return {
            id: 'imported-123',
            contract: mockContract,
            last_accessed_at: '2024-01-01T00:00:00Z'
          };
        }
        return {};
      });

      const result = await persistenceService.importExperience(jsonData);

      expect(result.success).toBe(true);
      expect(result.experienceId).toBe('imported-123');
    });

    it('should handle invalid JSON', async () => {
      const result = await persistenceService.importExperience('invalid json');

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('not valid JSON');
    });

    it('sends the Rust command a camelCase envelope with no nulls', async () => {
      // The accepted wire shape is pinned on the Rust side by the
      // share_wire_tests module in src-tauri/src/lib.rs.
      const jsonData = JSON.stringify({
        contract: mockContract,
        metadata: {
          title: 'Imported',
          description: null,
          author: null,
          created_at: '2026-07-20T10:00:00.000000+00:00',
          shared_at: '2026-07-23T09:30:00.000000+00:00',
          tags: null,
          category: null
        },
        version: '1.0.0',
        checksum: 'abc123'
      });

      mockInvoke.mockImplementation(async (command: string, args: any) => {
        if (command.startsWith('runtime_')) {
          return (await import('../../../test/kernel-invoke')).kernelInvoke(command, args);
        }
        if (command === 'import_shared_experience') {
          return { success: true, experienceId: 'imported-123' };
        }
        if (command === 'load_bookmarked_experience') {
          return {
            id: 'imported-123',
            contract: mockContract,
            last_accessed_at: '2024-01-01T00:00:00Z'
          };
        }
        return {};
      });

      const result = await persistenceService.importExperience(jsonData);
      expect(result.success).toBe(true);

      const importCall = mockInvoke.mock.calls.find(
        ([command]: [string]) => command === 'import_shared_experience'
      );
      expect(importCall).toBeDefined();
      const sent = importCall![1].shareableContract;
      expect(sent.metadata.title).toBe('Imported');
      expect(sent.metadata.createdAt).toBeInstanceOf(Date);
      expect(sent.metadata.sharedAt).toBeInstanceOf(Date);
      expect(sent.metadata).not.toHaveProperty('created_at');
      expect(Object.values(sent.metadata)).not.toContain(null);
      expect(typeof sent.checksum).toBe('string');
    });
  });
});