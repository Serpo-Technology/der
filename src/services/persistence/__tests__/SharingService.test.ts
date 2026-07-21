/**
 * Tests for SharingService
 * Requirements: 4.3, 4.4, 4.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SharingService } from '../SharingService';
import { ShareableContract } from '../../../types/persistence';
import { Contract } from '../../../types/contract';
import { persistenceService } from '../PersistenceService';

// Mock the persistence service
vi.mock('../PersistenceService', () => ({
  persistenceService: {
    shareExperience: vi.fn(),
    exportExperience: vi.fn(),
    importExperience: vi.fn(),
    duplicateExperience: vi.fn()
  }
}));

describe('SharingService', () => {
  let sharingService: SharingService;
  let mockContract: Contract;
  let mockShareableContract: ShareableContract;
  let mockPersistenceService: any;

  beforeEach(() => {
    sharingService = new SharingService();
    mockPersistenceService = vi.mocked(persistenceService);
    vi.clearAllMocks();

    mockContract = {
      name: 'Test Experience',
      version: '1.0.0',
      elements: [],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date('2024-01-01T00:00:00Z'),
        updatedAt: new Date('2024-01-01T00:00:00Z'),
        version: '1.0.0',
        description: 'Test description',
        tags: ['test', 'demo']
      }
    };

    mockShareableContract = {
      contract: mockContract,
      metadata: {
        title: 'Shared Experience',
        description: 'Shared for testing',
        author: 'Test Author',
        createdAt: new Date('2024-01-01T00:00:00Z'),
        sharedAt: new Date('2024-01-02T00:00:00Z'),
        tags: ['shared'],
        category: 'demo'
      },
      version: '1.0.0',
      checksum: 'abc123'
    };
  });

  describe('createShareableContract', () => {
    it('should create a shareable contract with default options', async () => {
      mockPersistenceService.shareExperience.mockResolvedValue(mockShareableContract);

      const result = await sharingService.createShareableContract('test-experience-1');

      expect(result).toEqual(mockShareableContract);
      expect(mockPersistenceService.shareExperience).toHaveBeenCalledWith('test-experience-1', {
        title: 'Shared Experience',
        description: undefined,
        author: undefined,
        tags: undefined,
        category: undefined
      });
    });

    it('should create a shareable contract with custom options', async () => {
      mockPersistenceService.shareExperience.mockResolvedValue(mockShareableContract);

      const options = {
        title: 'Custom Title',
        description: 'Custom description',
        author: 'Custom Author',
        tags: ['custom', 'tags'],
        category: 'custom'
      };

      const result = await sharingService.createShareableContract('test-experience-1', options);

      expect(result).toEqual(mockShareableContract);
      expect(mockPersistenceService.shareExperience).toHaveBeenCalledWith('test-experience-1', options);
    });

    it('should handle creation failure', async () => {
      mockPersistenceService.shareExperience.mockRejectedValue(new Error('Share failed'));

      await expect(sharingService.createShareableContract('test-experience-1'))
        .rejects.toThrow('Failed to create shareable contract: Error: Share failed');
    });
  });

  describe('exportForSharing', () => {
    it('should export experience in JSON format', async () => {
      mockPersistenceService.shareExperience.mockResolvedValue(mockShareableContract);
      mockPersistenceService.exportExperience.mockResolvedValue(JSON.stringify(mockShareableContract));

      const result = await sharingService.exportForSharing('test-experience-1');

      expect(result).toContain('"contract"');
      expect(result).toContain('"metadata"');
      expect(mockPersistenceService.shareExperience).toHaveBeenCalled();
      expect(mockPersistenceService.exportExperience).toHaveBeenCalledWith('test-experience-1', { format: 'json' });
    });

    it('should export with custom format and options', async () => {
      mockPersistenceService.shareExperience.mockResolvedValue(mockShareableContract);
      mockPersistenceService.exportExperience.mockResolvedValue('exported-data');

      const format = { format: 'yaml' as const };
      const options = { title: 'Custom Export', author: 'Test Author' };

      const result = await sharingService.exportForSharing('test-experience-1', format, options);

      expect(result).toBe('exported-data');
      expect(mockPersistenceService.shareExperience).toHaveBeenCalledWith('test-experience-1', options);
      expect(mockPersistenceService.exportExperience).toHaveBeenCalledWith('test-experience-1', format);
    });
  });

  describe('importSharedExperience', () => {
    it('should import shared experience successfully', async () => {
      const importResult = { success: true, experienceId: 'imported-123' };
      mockPersistenceService.importExperience.mockResolvedValue(importResult);

      const data = JSON.stringify(mockShareableContract);
      const result = await sharingService.importSharedExperience(data);

      expect(result).toEqual(importResult);
      expect(mockPersistenceService.importExperience).toHaveBeenCalledWith(data, { format: 'json' });
    });

    it('should import with custom format', async () => {
      const importResult = { success: true, experienceId: 'imported-123' };
      mockPersistenceService.importExperience.mockResolvedValue(importResult);

      const data = 'yaml-data';
      const format = { format: 'yaml' as const };
      const result = await sharingService.importSharedExperience(data, format);

      expect(result).toEqual(importResult);
      expect(mockPersistenceService.importExperience).toHaveBeenCalledWith(data, format);
    });

    it('should handle import failure', async () => {
      mockPersistenceService.importExperience.mockRejectedValue(new Error('Import failed'));

      const result = await sharingService.importSharedExperience('invalid-data');

      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('Failed to import shared experience');
    });
  });

  describe('validateShareableContract', () => {
    it('should validate a valid shareable contract', async () => {
      // Add elements to make the contract valid
      const validContract = {
        ...mockShareableContract,
        contract: {
          ...mockShareableContract.contract,
          elements: [{ 
            id: 'test-element', 
            type: 'button', 
            properties: {},
            dataBindings: [],
            eventBindings: []
          }]
        }
      };

      const result = await sharingService.validateShareableContract(validContract);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should detect missing required fields', async () => {
      const invalidContract = {
        ...mockShareableContract,
        contract: undefined as any,
        checksum: ''
      };

      const result = await sharingService.validateShareableContract(invalidContract);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing contract data');
      expect(result.errors).toContain('Invalid checksum');
    });

    it('should detect missing metadata fields', async () => {
      const contractWithoutMetadata = {
        ...mockShareableContract,
        metadata: {
          title: '',
          createdAt: undefined as any,
          sharedAt: undefined as any
        } as any
      };

      const result = await sharingService.validateShareableContract(contractWithoutMetadata);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Missing creation date in metadata');
      expect(result.errors).toContain('Missing share date in metadata');
      expect(result.warnings).toContain('Missing title in metadata');
    });

    it('should detect contract structure warnings', async () => {
      const contractWithoutElements = {
        ...mockShareableContract,
        contract: {
          ...mockContract,
          name: undefined as any,
          elements: []
        }
      };

      const result = await sharingService.validateShareableContract(contractWithoutElements);

      expect(result.isValid).toBe(true); // Warnings don't make it invalid
      expect(result.warnings).toContain('Contract missing name');
      expect(result.warnings).toContain('Contract has no UI elements');
    });

    it('should handle validation errors', async () => {
      const result = await sharingService.validateShareableContract(null as any);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Validation error');
    });
  });

  describe('duplicateSharedExperience', () => {
    it('should duplicate a shared experience', async () => {
      const mockExperience = {
        id: 'duplicated-123',
        contract: mockContract,
        reactComponent: () => null,
        state: { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
        operations: new Map()
      };

      mockPersistenceService.importExperience.mockResolvedValue({
        success: true,
        experienceId: 'imported-123'
      });
      mockPersistenceService.duplicateExperience.mockResolvedValue(mockExperience);

      const result = await sharingService.duplicateSharedExperience(mockShareableContract, 'Duplicated Experience');

      expect(result).toEqual(mockExperience);
      expect(mockPersistenceService.importExperience).toHaveBeenCalled();
      expect(mockPersistenceService.duplicateExperience).toHaveBeenCalledWith('imported-123', 'Duplicated Experience');
    });

    it('should handle import failure during duplication', async () => {
      mockPersistenceService.importExperience.mockResolvedValue({
        success: false,
        errors: ['Import failed']
      });

      await expect(sharingService.duplicateSharedExperience(mockShareableContract))
        .rejects.toThrow('Failed to duplicate shared experience: Error: Failed to import shared experience for duplication');
    });
  });

  describe('getSharingStats', () => {
    it('should return sharing statistics', async () => {
      const result = await sharingService.getSharingStats('test-experience-1');

      expect(result.timesShared).toBe(0);
      expect(result.shareFormats).toEqual(['json']);
      expect(result.lastShared).toBeUndefined();
    });
  });

  describe('generateShareLink', () => {
    it('should generate a share link with default options', async () => {
      const result = await sharingService.generateShareLink('test-experience-1');

      expect(result.id).toMatch(/^share-\d+-[a-z0-9]+$/);
      expect(result.url).toContain('https://example.com/share/');
      expect(result.accessCount).toBe(0);
      expect(result.expiresAt).toBeUndefined();
      expect(result.maxAccess).toBeUndefined();
    });

    it('should generate a share link with custom options', async () => {
      const options = { expiresIn: 24, maxAccess: 10 };
      const result = await sharingService.generateShareLink('test-experience-1', options);

      expect(result.expiresAt).toBeDefined();
      expect(result.maxAccess).toBe(10);
      expect(result.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('revokeShareLink', () => {
    it('should revoke a share link', async () => {
      // This is a placeholder test since the method just logs
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await sharingService.revokeShareLink('share-123');

      expect(consoleSpy).toHaveBeenCalledWith('Share link share-123 revoked');
      consoleSpy.mockRestore();
    });
  });

  describe('getShareLinks', () => {
    it('should return empty array for share links', async () => {
      const result = await sharingService.getShareLinks('test-experience-1');

      expect(result).toEqual([]);
    });
  });
});