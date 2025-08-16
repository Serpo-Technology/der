/**
 * Sharing Service - Handle experience sharing and collaboration
 * Requirements: 4.3, 4.4, 4.5
 */

import { ShareableContract, ShareMetadata, ImportResult, ExportFormat } from '../../types/persistence';
import { Experience } from '../../types/experience';
import { persistenceService } from './PersistenceService';

export interface ShareOptions {
  title?: string;
  description?: string;
  author?: string;
  tags?: string[];
  category?: string;
  includeVersionHistory?: boolean;
}

export interface ShareLink {
  id: string;
  url: string;
  expiresAt?: Date;
  accessCount: number;
  maxAccess?: number;
}

export class SharingService {
  /**
   * Create a shareable contract from an experience
   */
  async createShareableContract(
    experienceId: string,
    options: ShareOptions = {}
  ): Promise<ShareableContract> {
    try {
      const metadata: Partial<ShareMetadata> = {
        title: options.title || 'Shared Experience',
        description: options.description,
        author: options.author,
        tags: options.tags,
        category: options.category
      };

      return await persistenceService.shareExperience(experienceId, metadata);
    } catch (error) {
      throw new Error(`Failed to create shareable contract: ${error}`);
    }
  }

  /**
   * Export experience to various formats for sharing
   */
  async exportForSharing(
    experienceId: string,
    format: ExportFormat = { format: 'json' },
    options: ShareOptions = {}
  ): Promise<string> {
    try {
      // Create shareable contract first
      await this.createShareableContract(experienceId, options);
      
      // Export in requested format
      return await persistenceService.exportExperience(experienceId, format);
    } catch (error) {
      throw new Error(`Failed to export for sharing: ${error}`);
    }
  }

  /**
   * Import a shared experience from various formats
   */
  async importSharedExperience(
    data: string,
    format: ExportFormat = { format: 'json' }
  ): Promise<ImportResult> {
    try {
      return await persistenceService.importExperience(data, format);
    } catch (error) {
      return {
        success: false,
        errors: [`Failed to import shared experience: ${error}`]
      };
    }
  }

  /**
   * Validate a shareable contract
   */
  async validateShareableContract(contract: ShareableContract): Promise<{
    isValid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Check required fields
      if (!contract.contract) {
        errors.push('Missing contract data');
      }
      if (!contract.metadata) {
        errors.push('Missing metadata');
      }
      if (!contract.version) {
        errors.push('Missing version information');
      }
      if (!contract.checksum) {
        errors.push('Missing checksum');
      }

      // Validate contract structure
      if (contract.contract) {
        if (!contract.contract.name) {
          warnings.push('Contract missing name');
        }
        if (!contract.contract.elements || contract.contract.elements.length === 0) {
          warnings.push('Contract has no UI elements');
        }
      }

      // Validate metadata
      if (contract.metadata) {
        if (!contract.metadata.title) {
          warnings.push('Missing title in metadata');
        }
        if (!contract.metadata.createdAt) {
          errors.push('Missing creation date in metadata');
        }
        if (!contract.metadata.sharedAt) {
          errors.push('Missing share date in metadata');
        }
      }

      // Validate checksum (basic check)
      if (contract.checksum !== undefined && contract.checksum.length === 0) {
        errors.push('Invalid checksum');
      }

      return {
        isValid: errors.length === 0,
        errors,
        warnings
      };
    } catch (error) {
      return {
        isValid: false,
        errors: [`Validation error: ${error}`],
        warnings
      };
    }
  }

  /**
   * Create a duplicate of a shared experience
   */
  async duplicateSharedExperience(
    contract: ShareableContract,
    newName?: string
  ): Promise<Experience> {
    try {
      // Import the shared experience first
      const importResult = await this.importSharedExperience(
        JSON.stringify(contract),
        { format: 'json' }
      );

      if (!importResult.success || !importResult.experienceId) {
        throw new Error('Failed to import shared experience for duplication');
      }

      // Duplicate the imported experience
      return await persistenceService.duplicateExperience(
        importResult.experienceId,
        newName
      );
    } catch (error) {
      throw new Error(`Failed to duplicate shared experience: ${error}`);
    }
  }

  /**
   * Get sharing statistics for an experience
   */
  async getSharingStats(_experienceId: string): Promise<{
    timesShared: number;
    lastShared?: Date;
    shareFormats: string[];
  }> {
    // This is a placeholder implementation
    // In a real system, we would track sharing statistics
    return {
      timesShared: 0,
      shareFormats: ['json']
    };
  }

  /**
   * Generate a shareable URL (placeholder for future implementation)
   */
  async generateShareLink(
    _experienceId: string,
    options: {
      expiresIn?: number; // hours
      maxAccess?: number;
    } = {}
  ): Promise<ShareLink> {
    // This is a placeholder implementation
    // In a real system, this would generate a secure shareable URL
    const shareId = `share-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    return {
      id: shareId,
      url: `https://example.com/share/${shareId}`,
      expiresAt: options.expiresIn ? new Date(Date.now() + options.expiresIn * 60 * 60 * 1000) : undefined,
      accessCount: 0,
      maxAccess: options.maxAccess
    };
  }

  /**
   * Revoke a share link (placeholder for future implementation)
   */
  async revokeShareLink(shareId: string): Promise<void> {
    // This is a placeholder implementation
    // In a real system, this would revoke access to a shared link
    console.log(`Share link ${shareId} revoked`);
  }

  /**
   * List all active share links for an experience (placeholder)
   */
  async getShareLinks(_experienceId: string): Promise<ShareLink[]> {
    // This is a placeholder implementation
    // In a real system, this would return all active share links
    return [];
  }
}

// Export singleton instance
export const sharingService = new SharingService();