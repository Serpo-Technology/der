/**
 * Persistence Service - Main service for bookmarking, sharing, and versioning
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.3, 5.4
 */

import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import {
  PersistenceLayer,
  BookmarkedExperience,
  ShareableContract,
  ShareMetadata,
  ImportResult,
  ExportFormat
} from '../../types/persistence';
import { Experience, ExperienceUpdate } from '../../types/experience';

/**
 * Older records stored contracts double-encoded (a JSON string inside the
 * JSON document); accept both shapes when reading.
 */
function parseMaybeJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }
  return value as T;
}

export class PersistenceService implements PersistenceLayer {
  private schemaInitialized = false;

  private async ensureSchema() {
    if (this.schemaInitialized) return;
    const db = await Database.load('sqlite:der.db');
    await db.execute(`CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY,
      name TEXT,
      contract TEXT NOT NULL,
      state TEXT,
      created_at TEXT,
      updated_at TEXT
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      contract TEXT NOT NULL,
      created_at TEXT,
      last_accessed_at TEXT,
      tags TEXT
    );`);
    this.schemaInitialized = true;
  }
  /**
   * Save an experience
   */
  async saveExperience(experience: Experience): Promise<void> {
    try {
      await this.ensureSchema();
      // Persist via SQLite (primary) and filesystem (fallback)
      const db = await Database.load('sqlite:der.db');
      await db.execute(
        `INSERT INTO experiences (id, name, contract, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, contract=excluded.contract, state=excluded.state, updated_at=datetime('now')`,
        [
          experience.id,
          experience.contract.name || 'Unnamed Experience',
          JSON.stringify(experience.contract),
          JSON.stringify(experience.state || {})
        ]
      );
      // Fallback file persistence
      await invoke('save_experience', {
        experienceId: experience.id,
        contract: experience.contract,
        state: experience.state,
        metadata: experience.metadata
      });
    } catch (error) {
      throw new Error(`Failed to save experience: ${error}`);
    }
  }

  /**
   * Load an experience by ID
   */
  async loadExperience(experienceId: string): Promise<Experience | null> {
    try {
      await this.ensureSchema();
      const db = await Database.load('sqlite:der.db');
      const rows = await db.select<any[]>(
        `SELECT id, name, contract, state, created_at, updated_at FROM experiences WHERE id = ?1`,
        [experienceId]
      );
      if (rows && rows.length > 0) {
        const row = rows[0];
        const parsedContract = parseMaybeJson<any>(JSON.parse(row.contract));
        return {
          id: row.id,
          contract: parsedContract,
          state: row.state ? parseMaybeJson(JSON.parse(row.state)) : {},
          metadata: {
            createdAt: row.created_at ? new Date(row.created_at) : new Date(),
            updatedAt: row.updated_at ? new Date(row.updated_at) : new Date(),
            version: parsedContract?.version || '1.0.0'
          }
        } as Experience;
      }
      // Fallback to filesystem
      const experienceData = await invoke<any>('load_experience', { experienceId });
      if (!experienceData) return null;
      return {
        id: experienceData.experienceId,
        contract: parseMaybeJson(experienceData.contract),
        state: parseMaybeJson(experienceData.state) || {},
        metadata: experienceData.metadata || {}
      };
    } catch (error) {
      throw new Error(`Failed to load experience: ${error}`);
    }
  }

  /**
   * Bookmark an experience for later access
   * Requirements: 4.1, 4.2
   */
  async bookmarkExperience(experience: Experience): Promise<string> {
    try {
      const experienceId = await invoke<string>('bookmark_experience', {
        experienceId: experience.id,
        name: experience.contract.name || 'Unnamed Experience',
        description: experience.contract.metadata?.description,
        contract: experience.contract,
        tags: experience.contract.metadata?.tags
      });

      return experienceId;
    } catch (error) {
      throw new Error(`Failed to bookmark experience: ${error}`);
    }
  }

  /**
   * Load a bookmarked experience by ID
   * Requirements: 4.1, 4.2
   */
  async loadBookmarkedExperience(id: string): Promise<Experience | null> {
    try {
      const bookmarkData = await invoke<any>('load_bookmarked_experience', {
        experienceId: id
      });

      if (!bookmarkData) {
        return null;
      }

      // Convert bookmark data back to Experience format
      const experience: Experience = {
        id: bookmarkData.id,
        contract: parseMaybeJson(bookmarkData.contract),
        reactComponent: () => null, // Will be populated by DER
        state: {
          data: {},
          loading: {},
          errors: {},
          lastUpdated: new Date(bookmarkData.last_accessed_at)
        },
        operations: new Map()
      };

      return experience;
    } catch (error) {
      throw new Error(`Failed to load bookmarked experience: ${error}`);
    }
  }

  /**
   * Load the full bookmark record (metadata plus contract) by ID.
   */
  async loadBookmarkRecord(id: string): Promise<BookmarkedExperience | null> {
    try {
      const bookmark = await invoke<any>('load_bookmarked_experience', { experienceId: id });
      if (!bookmark) {
        return null;
      }
      return {
        id: bookmark.id,
        name: bookmark.name,
        description: bookmark.description ?? undefined,
        contract: parseMaybeJson(bookmark.contract),
        createdAt: new Date(bookmark.created_at),
        lastAccessedAt: new Date(bookmark.last_accessed_at),
        tags: bookmark.tags ?? undefined,
        thumbnail: bookmark.thumbnail ?? undefined
      };
    } catch (error) {
      throw new Error(`Failed to load bookmark: ${error}`);
    }
  }

  /**
   * Get list of all bookmarked experiences
   * Requirements: 4.1, 4.2
   */
  async listBookmarkedExperiences(): Promise<BookmarkedExperience[]> {
    try {
      const bookmarks = await invoke<any[]>('list_bookmarked_experiences_detailed');
      
      return bookmarks.map(bookmark => ({
        id: bookmark.id,
        name: bookmark.name,
        description: bookmark.description,
        contract: bookmark.contract,
        createdAt: new Date(bookmark.createdAt),
        lastAccessedAt: new Date(bookmark.lastAccessedAt),
        tags: bookmark.tags,
        thumbnail: bookmark.thumbnail
      }));
    } catch (error) {
      throw new Error(`Failed to list bookmarked experiences: ${error}`);
    }
  }

  /**
   * Delete a bookmarked experience
   * Requirements: 4.1, 4.2
   */
  async deleteBookmarkedExperience(id: string): Promise<void> {
    try {
      await invoke('delete_bookmarked_experience', {
        experienceId: id
      });
    } catch (error) {
      throw new Error(`Failed to delete bookmarked experience: ${error}`);
    }
  }

  /**
   * Create a shareable contract from an experience
   * Requirements: 4.3, 4.4, 4.5
   */
  async shareExperience(experienceId: string, metadata?: Partial<ShareMetadata>): Promise<ShareableContract> {
    try {
      const shareableContract = await invoke<any>('share_experience', {
        experienceId,
        title: metadata?.title || 'Shared Experience',
        description: metadata?.description,
        author: metadata?.author,
        tags: metadata?.tags,
        category: metadata?.category
      });

      return {
        contract: shareableContract.contract,
        metadata: {
          title: shareableContract.metadata.title,
          description: shareableContract.metadata.description,
          author: shareableContract.metadata.author,
          createdAt: new Date(shareableContract.metadata.created_at),
          sharedAt: new Date(shareableContract.metadata.shared_at),
          tags: shareableContract.metadata.tags,
          category: shareableContract.metadata.category
        },
        version: shareableContract.version,
        checksum: shareableContract.checksum
      };
    } catch (error) {
      throw new Error(`Failed to share experience: ${error}`);
    }
  }

  /**
   * Import a shared experience
   * Requirements: 4.3, 4.4, 4.5
   */
  async importSharedExperience(contract: ShareableContract): Promise<Experience> {
    try {
      const result = await invoke<any>('import_shared_experience', {
        shareableContract: contract
      });

      if (!result.success) {
        throw new Error(result.message || 'Import failed');
      }

      // Load the imported experience
      const experience = await this.loadBookmarkedExperience(result.experienceId);
      if (!experience) {
        throw new Error('Failed to load imported experience');
      }

      return experience;
    } catch (error) {
      throw new Error(`Failed to import shared experience: ${error}`);
    }
  }

  /**
   * Duplicate an existing experience
   * Requirements: 4.3, 4.4, 4.5
   */
  async duplicateExperience(experienceId: string, newName?: string): Promise<Experience> {
    try {
      const duplicateId = await invoke<string>('duplicate_experience', {
        experienceId,
        newName
      });

      const duplicatedExperience = await this.loadBookmarkedExperience(duplicateId);
      if (!duplicatedExperience) {
        throw new Error('Failed to load duplicated experience');
      }

      return duplicatedExperience;
    } catch (error) {
      throw new Error(`Failed to duplicate experience: ${error}`);
    }
  }

  /**
   * Update an experience with versioning support
   * Requirements: 5.3, 5.4
   */
  async updateExperience(experienceId: string, changes: ExperienceUpdate): Promise<void> {
    try {
      await invoke('update_experience', {
        experienceId,
        newContract: changes.contract,
        newBlueprint: changes.blueprint,
        preserveUserEdits: changes.preserveUserEdits,
        changesSummary: 'Experience updated via API'
      });
    } catch (error) {
      throw new Error(`Failed to update experience: ${error}`);
    }
  }

  /**
   * Get version history for an experience
   * Requirements: 5.3, 5.4
   */
  async getExperienceVersions(experienceId: string): Promise<Array<{
    version: number;
    createdAt: Date;
    changesSummary?: string;
  }>> {
    try {
      const versions = await invoke<any[]>('get_experience_versions', {
        experienceId
      });

      return versions.map(version => ({
        version: version.version,
        createdAt: new Date(version.createdAt),
        changesSummary: version.changesSummary
      }));
    } catch (error) {
      throw new Error(`Failed to get experience versions: ${error}`);
    }
  }

  /**
   * Restore an experience to a specific version
   * Requirements: 5.3, 5.4
   */
  async restoreExperienceVersion(experienceId: string, version: number): Promise<void> {
    try {
      await invoke('restore_experience_version', {
        experienceId,
        version
      });
    } catch (error) {
      throw new Error(`Failed to restore experience version: ${error}`);
    }
  }

  /**
   * Export experience in various formats
   * Requirements: 4.3, 4.4, 4.5
   */
  async exportExperience(
    experienceId: string, 
    format: ExportFormat = { format: 'json' }
  ): Promise<string> {
    try {
      const experience = await this.loadBookmarkedExperience(experienceId);
      if (!experience) {
        throw new Error('Experience not found');
      }

      const shareableContract = await this.shareExperience(experienceId);
      
      switch (format.format) {
        case 'json':
          return JSON.stringify(shareableContract, null, 2);
        case 'yaml':
          // For now, return JSON - YAML support can be added later
          return JSON.stringify(shareableContract, null, 2);
        case 'binary':
          // For now, return JSON - binary support can be added later
          return JSON.stringify(shareableContract);
        default:
          throw new Error(`Unsupported export format: ${format.format}`);
      }
    } catch (error) {
      throw new Error(`Failed to export experience: ${error}`);
    }
  }

  /**
   * Import experience from various formats
   * Requirements: 4.3, 4.4, 4.5
   */
  async importExperience(data: string, format: ExportFormat = { format: 'json' }): Promise<ImportResult> {
    try {
      let shareableContract: ShareableContract;

      switch (format.format) {
        case 'json':
          shareableContract = JSON.parse(data);
          break;
        case 'yaml':
          // For now, try JSON parsing - YAML support can be added later
          shareableContract = JSON.parse(data);
          break;
        case 'binary':
          // For now, try JSON parsing - binary support can be added later
          shareableContract = JSON.parse(data);
          break;
        default:
          return {
            success: false,
            errors: [`Unsupported import format: ${format.format}`]
          };
      }

      const experience = await this.importSharedExperience(shareableContract);
      
      return {
        success: true,
        experienceId: experience.id
      };
    } catch (error) {
      return {
        success: false,
        errors: [`Failed to import experience: ${error}`]
      };
    }
  }
}

// Export singleton instance
export const persistenceService = new PersistenceService();