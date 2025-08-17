/**
 * Integrated Experience Service - Orchestrates all services for complete integration
 * This service wires together all components for seamless user workflows
 */

import { AIInterpreterService } from './ai-interpreter';
import { RepositoryService } from './repository/repository-service';
import { DynamicExperienceRuntimeService } from '../components/runtime/DynamicExperienceRuntimeService';
import { ExperienceEditorService } from './edit-preservation/ExperienceEditorService';
import { SharingService } from './persistence/SharingService';
import { BookmarkManager } from './persistence/BookmarkManager';
import { PersistenceService } from './persistence/PersistenceService';
import { Blueprint } from '../models/blueprint';
import { Contract } from '../models/contract';
import type { Experience, ExperienceState, EditOperation } from '../types/experience';
import type { ShareableExperience, BookmarkData } from '../types/persistence';

export interface IntegratedWorkflowOptions {
  preserveEdits?: boolean;
  autoSave?: boolean;
  enableRealTimeUpdates?: boolean;
  enableCollaboration?: boolean;
}

export interface ExperienceCreationResult {
  experienceId: string;
  blueprint: Blueprint;
  contract: Contract;
  experience: Experience;
  renderComponent: React.ComponentType;
}

export interface ExperienceEditResult {
  success: boolean;
  conflicts?: any[];
  preservedEdits?: EditOperation[];
  updatedContract: Contract;
}

export class IntegratedExperienceService {
  private aiInterpreter: AIInterpreterService;
  private repository: RepositoryService;
  private runtime: DynamicExperienceRuntimeService;
  private editor: ExperienceEditorService;
  private sharing: SharingService;
  private bookmarks: BookmarkManager;
  private persistence: PersistenceService;

  constructor() {
    this.aiInterpreter = new AIInterpreterService();
    this.repository = new RepositoryService();
    this.runtime = new DynamicExperienceRuntimeService();
    this.editor = new ExperienceEditorService();
    this.sharing = new SharingService();
    this.bookmarks = new BookmarkManager();
    this.persistence = new PersistenceService();
  }

  /**
   * Complete workflow: Natural language -> Blueprint -> Contract -> Experience
   */
  async createExperienceFromNaturalLanguage(
    input: string,
    options: IntegratedWorkflowOptions = {}
  ): Promise<ExperienceCreationResult> {
    try {
      // Step 1: Parse natural language to blueprint
      const blueprint = await this.aiInterpreter.parseNaturalLanguage(input);
      
      // Step 2: Generate contract from blueprint
      const contract = await this.aiInterpreter.generateContract(blueprint);
      
      // Step 3: Create experience ID and initialize editor if needed
      const experienceId = this.generateExperienceId();
      
      if (options.preserveEdits) {
        await this.editor.initializeExperience(experienceId, contract);
      }
      
      // Step 4: Render experience
      const renderComponent = await this.runtime.renderExperience(contract, experienceId);
      
      // Step 5: Create experience object
      const experience: Experience = {
        id: experienceId,
        contract,
        reactComponent: renderComponent,
        state: {
          data: {},
          loading: {},
          errors: {},
          lastUpdated: new Date()
        },
        operations: new Map()
      };

      // Step 6: Auto-save if enabled
      if (options.autoSave) {
        await this.persistence.saveExperience(experience);
      }

      return {
        experienceId,
        blueprint,
        contract,
        experience,
        renderComponent
      };
    } catch (error) {
      throw new Error(`Failed to create experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Edit experience with conflict resolution and edit preservation
   */
  async editExperience(
    experienceId: string,
    edit: EditOperation,
    options: IntegratedWorkflowOptions = {}
  ): Promise<ExperienceEditResult> {
    try {
      // Apply edit through editor service
      await this.editor.applyEdit(experienceId, edit);
      
      // Get updated contract
      const updatedContract = await this.editor.getCurrentContract(experienceId);
      
      // Update runtime if real-time updates are enabled
      if (options.enableRealTimeUpdates) {
        await this.runtime.updateExperience(experienceId, updatedContract);
      }

      // Auto-save if enabled
      if (options.autoSave) {
        const experience = await this.runtime.getExperience(experienceId);
        if (experience) {
          await this.persistence.saveExperience({
            ...experience,
            contract: updatedContract
          });
        }
      }

      return {
        success: true,
        updatedContract
      };
    } catch (error) {
      return {
        success: false,
        updatedContract: await this.editor.getCurrentContract(experienceId)
      };
    }
  }

  /**
   * Regenerate experience with AI while preserving user edits
   */
  async regenerateExperienceWithPreservation(
    experienceId: string,
    newInput: string,
    options: IntegratedWorkflowOptions = {}
  ): Promise<ExperienceEditResult> {
    try {
      // Generate new contract from input
      const newBlueprint = await this.aiInterpreter.parseNaturalLanguage(newInput);
      const newContract = await this.aiInterpreter.generateContract(newBlueprint);
      
      // Use editor service to preserve edits
      const preservedContract = await this.editor.regenerateWithPreservation(
        experienceId,
        newContract
      );

      // Update runtime
      await this.runtime.updateExperience(experienceId, preservedContract);

      // Auto-save if enabled
      if (options.autoSave) {
        const experience = await this.runtime.getExperience(experienceId);
        if (experience) {
          await this.persistence.saveExperience({
            ...experience,
            contract: preservedContract
          });
        }
      }

      return {
        success: true,
        updatedContract: preservedContract
      };
    } catch (error) {
      throw new Error(`Failed to regenerate experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Share experience with others
   */
  async shareExperience(
    experienceId: string,
    shareOptions: {
      title: string;
      description?: string;
      isPublic: boolean;
      allowEditing?: boolean;
      allowedUsers?: string[];
    }
  ): Promise<{ shareUrl: string; shareableExperience: ShareableExperience }> {
    try {
      // Get current experience
      const experience = await this.runtime.getExperience(experienceId);
      if (!experience) {
        throw new Error('Experience not found');
      }

      // Create shareable experience
      const shareableExperience = await this.sharing.createShareableExperience(
        experienceId,
        experience.contract,
        {
          ...shareOptions,
          createdBy: 'current-user' // TODO: Get from auth service
        }
      );

      // Generate share URL
      const shareUrl = await this.sharing.generateShareUrl(shareableExperience.id);

      return { shareUrl, shareableExperience };
    } catch (error) {
      throw new Error(`Failed to share experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Import shared experience
   */
  async importSharedExperience(
    shareUrl: string,
    userId: string
  ): Promise<ExperienceCreationResult> {
    try {
      // Import from sharing service
      const importedExperience = await this.sharing.importFromUrl(shareUrl, userId);
      
      // Initialize in editor for customization
      await this.editor.initializeExperience(
        importedExperience.experienceId,
        importedExperience.contract
      );

      // Render the imported experience
      const renderComponent = await this.runtime.renderExperience(
        importedExperience.contract,
        importedExperience.experienceId
      );

      // Create experience object
      const experience: Experience = {
        id: importedExperience.experienceId,
        contract: importedExperience.contract,
        reactComponent: renderComponent,
        state: {
          data: {},
          loading: {},
          errors: {},
          lastUpdated: new Date()
        },
        operations: new Map()
      };

      return {
        experienceId: importedExperience.experienceId,
        blueprint: new Blueprint({
          intent: 'Imported experience',
          capabilities: [],
          requirements: [],
          context: { imported: true }
        }),
        contract: importedExperience.contract,
        experience,
        renderComponent
      };
    } catch (error) {
      throw new Error(`Failed to import experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Bookmark experience for later use
   */
  async bookmarkExperience(
    experienceId: string,
    userId: string,
    bookmarkOptions: {
      personalNote?: string;
      tags?: string[];
      collection?: string;
    } = {}
  ): Promise<BookmarkData> {
    try {
      // Get current experience
      const experience = await this.runtime.getExperience(experienceId);
      if (!experience) {
        throw new Error('Experience not found');
      }

      // Create shareable version for bookmarking
      const shareableExperience: ShareableExperience = {
        id: experienceId,
        experienceId,
        contract: experience.contract,
        metadata: {
          title: experience.contract.name || 'Untitled Experience',
          isPublic: false,
          createdBy: userId,
          createdAt: new Date(),
          updatedAt: new Date()
        },
        checksum: this.generateChecksum(experience.contract)
      };

      // Bookmark through bookmark manager
      return await this.bookmarks.bookmarkExperience(
        userId,
        shareableExperience,
        bookmarkOptions
      );
    } catch (error) {
      throw new Error(`Failed to bookmark experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load bookmarked experience
   */
  async loadBookmarkedExperience(
    bookmarkId: string,
    userId: string
  ): Promise<ExperienceCreationResult> {
    try {
      // Get bookmark
      const bookmark = await this.bookmarks.getBookmark(userId, bookmarkId);
      if (!bookmark) {
        throw new Error('Bookmark not found');
      }

      // Get the shareable experience
      const shareableExperience = await this.sharing.getSharedExperience(bookmark.experienceId);
      if (!shareableExperience) {
        throw new Error('Shared experience not found');
      }

      // Create new experience ID for the loaded experience
      const newExperienceId = this.generateExperienceId();

      // Initialize in editor
      await this.editor.initializeExperience(newExperienceId, shareableExperience.contract);

      // Render experience
      const renderComponent = await this.runtime.renderExperience(
        shareableExperience.contract,
        newExperienceId
      );

      // Create experience object
      const experience: Experience = {
        id: newExperienceId,
        contract: shareableExperience.contract,
        reactComponent: renderComponent,
        state: {
          data: {},
          loading: {},
          errors: {},
          lastUpdated: new Date()
        },
        operations: new Map()
      };

      return {
        experienceId: newExperienceId,
        blueprint: new Blueprint({
          intent: 'Loaded from bookmark',
          capabilities: [],
          requirements: [],
          context: { bookmarked: true }
        }),
        contract: shareableExperience.contract,
        experience,
        renderComponent
      };
    } catch (error) {
      throw new Error(`Failed to load bookmarked experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get all user bookmarks
   */
  async getUserBookmarks(userId: string): Promise<BookmarkData[]> {
    return await this.bookmarks.getAllBookmarks(userId);
  }

  /**
   * Search bookmarks
   */
  async searchBookmarks(
    userId: string,
    query: { tags?: string[]; query?: string; collection?: string }
  ): Promise<BookmarkData[]> {
    return await this.bookmarks.searchBookmarks(userId, query);
  }

  /**
   * Get experience state
   */
  async getExperienceState(experienceId: string): Promise<ExperienceState | null> {
    const experience = await this.runtime.getExperience(experienceId);
    return experience?.state || null;
  }

  /**
   * Update experience state
   */
  async updateExperienceState(
    experienceId: string,
    stateUpdate: Partial<ExperienceState>
  ): Promise<void> {
    await this.runtime.updateExperienceState(experienceId, stateUpdate);
  }

  /**
   * Get edit history for an experience
   */
  async getEditHistory(experienceId: string): Promise<EditOperation[]> {
    return await this.editor.getEditHistory(experienceId);
  }

  /**
   * Undo last edit
   */
  async undoLastEdit(experienceId: string): Promise<Contract> {
    await this.editor.undoLastEdit(experienceId);
    return await this.editor.getCurrentContract(experienceId);
  }

  /**
   * Redo last edit
   */
  async redoLastEdit(experienceId: string): Promise<Contract> {
    await this.editor.redoLastEdit(experienceId);
    return await this.editor.getCurrentContract(experienceId);
  }

  /**
   * Clean up resources for an experience
   */
  async cleanupExperience(experienceId: string): Promise<void> {
    await this.runtime.cleanupExperience(experienceId);
    // Note: Editor service cleanup would be added here if needed
  }

  /**
   * Get service health status
   */
  async getServiceHealth(): Promise<{
    aiInterpreter: boolean;
    repository: boolean;
    runtime: boolean;
    editor: boolean;
    sharing: boolean;
    bookmarks: boolean;
    persistence: boolean;
  }> {
    return {
      aiInterpreter: true, // TODO: Implement health checks
      repository: true,
      runtime: true,
      editor: true,
      sharing: true,
      bookmarks: true,
      persistence: true
    };
  }

  // Private helper methods
  private generateExperienceId(): string {
    return `exp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private generateChecksum(contract: Contract): string {
    // Simple checksum based on contract content
    const contractString = JSON.stringify(contract);
    let hash = 0;
    for (let i = 0; i < contractString.length; i++) {
      const char = contractString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }
}

// Singleton instance for global use
export const integratedExperienceService = new IntegratedExperienceService();

export default IntegratedExperienceService;
