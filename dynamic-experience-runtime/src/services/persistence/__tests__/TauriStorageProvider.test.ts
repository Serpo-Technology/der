/**
 * Tests for TauriStorageProvider
 * Requirements: 4.1, 4.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TauriStorageProvider } from '../TauriStorageProvider';
import { invoke } from '@tauri-apps/api/core';

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}));

describe('TauriStorageProvider', () => {
  let storageProvider: TauriStorageProvider;
  let mockInvoke: any;

  beforeEach(() => {
    storageProvider = new TauriStorageProvider('test-storage');
    mockInvoke = vi.mocked(invoke);
    vi.clearAllMocks();
  });

  describe('save', () => {
    it('should save data successfully', async () => {
      const testData = { name: 'Test', value: 123 };
      mockInvoke.mockResolvedValue(undefined);

      await storageProvider.save('test-key', testData);

      expect(mockInvoke).toHaveBeenCalledWith('write_repository_index', {
        path: 'test-storage/test-key.json',
        data: JSON.stringify(testData, null, 2)
      });
    });

    it('should handle save failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Write failed'));

      await expect(storageProvider.save('test-key', { data: 'test' }))
        .rejects.toThrow('Failed to save data for key test-key: Error: Write failed');
    });

    it('should serialize complex data structures', async () => {
      const complexData = {
        array: [1, 2, 3],
        nested: { deep: { value: 'test' } },
        date: new Date('2024-01-01T00:00:00Z'),
        null: null,
        boolean: true
      };
      mockInvoke.mockResolvedValue(undefined);

      await storageProvider.save('complex-key', complexData);

      const expectedJson = JSON.stringify(complexData, null, 2);
      expect(mockInvoke).toHaveBeenCalledWith('write_repository_index', {
        path: 'test-storage/complex-key.json',
        data: expectedJson
      });
    });
  });

  describe('load', () => {
    it('should load data successfully', async () => {
      const testData = { name: 'Test', value: 123 };
      mockInvoke.mockResolvedValue(JSON.stringify(testData));

      const result = await storageProvider.load('test-key');

      expect(result).toEqual(testData);
      expect(mockInvoke).toHaveBeenCalledWith('read_repository_index', {
        path: 'test-storage/test-key.json'
      });
    });

    it('should return null when file does not exist', async () => {
      mockInvoke.mockRejectedValue(new Error('File not found'));

      const result = await storageProvider.load('non-existent-key');

      expect(result).toBeNull();
    });

    it('should return null when data cannot be read', async () => {
      mockInvoke.mockRejectedValue(new Error('Permission denied'));

      const result = await storageProvider.load('test-key');

      expect(result).toBeNull();
    });

    it('should handle invalid JSON gracefully', async () => {
      mockInvoke.mockResolvedValue('invalid json {');

      const result = await storageProvider.load('test-key');

      expect(result).toBeNull();
    });

    it('should parse complex data structures', async () => {
      const complexData = {
        array: [1, 2, 3],
        nested: { deep: { value: 'test' } },
        null: null,
        boolean: true
      };
      mockInvoke.mockResolvedValue(JSON.stringify(complexData));

      const result = await storageProvider.load('complex-key');

      expect(result).toEqual(complexData);
    });
  });

  describe('delete', () => {
    it('should delete data successfully', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await storageProvider.delete('test-key');

      expect(mockInvoke).toHaveBeenCalledWith('delete_component_manifest', {
        path: 'test-storage/test-key.json'
      });
    });

    it('should handle delete failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Delete failed'));

      await expect(storageProvider.delete('test-key'))
        .rejects.toThrow('Failed to delete data for key test-key: Error: Delete failed');
    });
  });

  describe('exists', () => {
    it('should return true when data exists', async () => {
      mockInvoke.mockResolvedValue('{"data": "exists"}');

      const result = await storageProvider.exists('test-key');

      expect(result).toBe(true);
    });

    it('should return false when data does not exist', async () => {
      mockInvoke.mockRejectedValue(new Error('File not found'));

      const result = await storageProvider.exists('non-existent-key');

      expect(result).toBe(false);
    });

    it('should return false when load throws error', async () => {
      mockInvoke.mockRejectedValue(new Error('Permission denied'));

      const result = await storageProvider.exists('test-key');

      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('should return empty array (placeholder implementation)', async () => {
      const result = await storageProvider.list();

      expect(result).toEqual([]);
    });

    it('should return empty array with prefix (placeholder implementation)', async () => {
      const result = await storageProvider.list('test-');

      expect(result).toEqual([]);
    });
  });

  describe('constructor', () => {
    it('should use default base path when not provided', () => {
      const defaultProvider = new TauriStorageProvider();
      
      // Test by checking the path used in a save operation
      mockInvoke.mockResolvedValue(undefined);
      defaultProvider.save('test', {});

      expect(mockInvoke).toHaveBeenCalledWith('write_repository_index', {
        path: 'storage/test.json',
        data: '{}'
      });
    });

    it('should use custom base path when provided', () => {
      const customProvider = new TauriStorageProvider('custom-path');
      
      mockInvoke.mockResolvedValue(undefined);
      customProvider.save('test', {});

      expect(mockInvoke).toHaveBeenCalledWith('write_repository_index', {
        path: 'custom-path/test.json',
        data: '{}'
      });
    });
  });

  describe('path generation', () => {
    it('should generate correct paths for different keys', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await storageProvider.save('simple-key', {});
      expect(mockInvoke).toHaveBeenLastCalledWith('write_repository_index', {
        path: 'test-storage/simple-key.json',
        data: '{}'
      });

      await storageProvider.save('key-with-dashes', {});
      expect(mockInvoke).toHaveBeenLastCalledWith('write_repository_index', {
        path: 'test-storage/key-with-dashes.json',
        data: '{}'
      });

      await storageProvider.save('key_with_underscores', {});
      expect(mockInvoke).toHaveBeenLastCalledWith('write_repository_index', {
        path: 'test-storage/key_with_underscores.json',
        data: '{}'
      });
    });
  });
});