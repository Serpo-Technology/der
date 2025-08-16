/**
 * Tauri Storage Provider - File system storage using Tauri commands
 * Requirements: 4.1, 4.2
 */

import { invoke } from '@tauri-apps/api/core';
import { StorageProvider } from '../../types/persistence';

export class TauriStorageProvider implements StorageProvider {
  private basePath: string;

  constructor(basePath: string = 'storage') {
    this.basePath = basePath;
  }

  /**
   * Save data to storage
   */
  async save(key: string, data: any): Promise<void> {
    try {
      const path = this.getPath(key);
      const jsonData = JSON.stringify(data, null, 2);
      
      await invoke('write_repository_index', {
        path,
        data: jsonData
      });
    } catch (error) {
      throw new Error(`Failed to save data for key ${key}: ${error}`);
    }
  }

  /**
   * Load data from storage
   */
  async load(key: string): Promise<any | null> {
    try {
      const path = this.getPath(key);
      const jsonData = await invoke<string>('read_repository_index', {
        path
      });
      
      return JSON.parse(jsonData);
    } catch (error) {
      // Return null if file doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Delete data from storage
   */
  async delete(key: string): Promise<void> {
    try {
      const path = this.getPath(key);
      await invoke('delete_component_manifest', {
        path
      });
    } catch (error) {
      throw new Error(`Failed to delete data for key ${key}: ${error}`);
    }
  }

  /**
   * List all keys with optional prefix filter
   */
  async list(_prefix?: string): Promise<string[]> {
    // This is a simplified implementation
    // In a real implementation, we would need a Tauri command to list files
    // For now, we'll return an empty array and rely on the bookmark commands
    return [];
  }

  /**
   * Check if a key exists in storage
   */
  async exists(key: string): Promise<boolean> {
    try {
      const data = await this.load(key);
      return data !== null;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the full path for a storage key
   */
  private getPath(key: string): string {
    return `${this.basePath}/${key}.json`;
  }
}

// Export singleton instance
export const tauriStorageProvider = new TauriStorageProvider();