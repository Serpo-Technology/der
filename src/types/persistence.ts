/**
 * Persistence types - Bookmarking, sharing, and storage
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { Experience, ExperienceUpdate } from './experience';
import { Contract } from './contract';

export interface PersistenceLayer {
  bookmarkExperience(experience: Experience): Promise<string>;
  loadBookmarkedExperience(id: string): Promise<Experience | null>;
  shareExperience(experienceId: string): Promise<ShareableContract>;
  importSharedExperience(contract: ShareableContract): Promise<Experience>;
  duplicateExperience(experienceId: string): Promise<Experience>;
  updateExperience(experienceId: string, changes: ExperienceUpdate): Promise<void>;
  listBookmarkedExperiences(): Promise<BookmarkedExperience[]>;
  deleteBookmarkedExperience(id: string): Promise<void>;
}

export interface ShareableContract {
  contract: Contract;
  metadata: ShareMetadata;
  version: string;
  checksum: string;
}

export interface ShareMetadata {
  title: string;
  description?: string;
  author?: string;
  createdAt: Date;
  sharedAt: Date;
  tags?: string[];
  category?: string;
}

export interface BookmarkedExperience {
  id: string;
  name: string;
  description?: string;
  contract: Contract;
  createdAt: Date;
  lastAccessedAt: Date;
  tags?: string[];
  thumbnail?: string;
}

export interface StorageProvider {
  save(key: string, data: any): Promise<void>;
  load(key: string): Promise<any | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

export interface ExportFormat {
  format: 'json' | 'yaml' | 'binary';
  compression?: 'gzip' | 'brotli';
  encryption?: boolean;
}

export interface ImportResult {
  success: boolean;
  experienceId?: string;
  errors?: string[];
  warnings?: string[];
}