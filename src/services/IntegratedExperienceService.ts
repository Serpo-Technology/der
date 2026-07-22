/**
 * Integrated Experience Service - Orchestrates all services for complete integration
 * This service wires together all components for seamless user workflows
 */

import type React from 'react';
import { AIInterpreterService } from './ai-interpreter';
import { RepositoryService, repositoryService } from './repository/repository-service';
import { DynamicExperienceRuntimeService } from '../components/runtime/DynamicExperienceRuntimeService';
import { ExperienceEditorService } from './edit-preservation/ExperienceEditorService';
import { SharingService } from './persistence/SharingService';
import { BookmarkManager } from './persistence/BookmarkManager';
import { PersistenceService } from './persistence/PersistenceService';
import { Blueprint as BlueprintModel } from '../models/blueprint';
import { Contract as ContractModel } from '../models/contract';
import { emit } from '@tauri-apps/api/event';
import type { Contract, ValidationWarning } from '../types/contract';
import type { Experience, ExperienceState } from '../types/experience';
import type { ShareableContract, BookmarkedExperience } from '../types/persistence';

export interface IntegratedWorkflowOptions {
  preserveEdits?: boolean;
  autoSave?: boolean;
  enableRealTimeUpdates?: boolean;
  enableCollaboration?: boolean;
}

export interface ExperienceCreationResult {
  experienceId: string;
  blueprint: BlueprintModel;
  contract: ContractModel;
  experience: Experience;
  renderComponent: React.ComponentType;
  warnings?: ValidationWarning[];
}

export interface ExperienceEditResult {
  success: boolean;
  conflicts?: any[];
  preservedEdits?: any[];
  updatedContract: ContractModel;
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
    // Shared singleton so generation sees the seeded component catalog.
    this.repository = repositoryService;

    // Provider, model, and credentials come from the stored settings.
    this.aiInterpreter = new AIInterpreterService(this.repository);

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
      const blueprintData = await this.aiInterpreter.parseNaturalLanguage(input);
      const blueprint = BlueprintModel.fromObject(blueprintData);
      
      // Step 2: Generate contract from blueprint
      const contractData = await this.aiInterpreter.generateContract(blueprintData);
      const contract = ContractModel.fromObject(contractData);
      
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
        renderComponent,
        warnings: this.aiInterpreter.getLastContractWarnings()
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
    edit: any,
    options: IntegratedWorkflowOptions = {}
  ): Promise<ExperienceEditResult> {
    try {
      // Apply edit through editor service
      await this.editor.applyEdit(experienceId, edit);
      
      // Get updated contract
      const updatedContract = await this.editor.getCurrentContract(experienceId);
      
      if (!updatedContract) {
        throw new Error(`Failed to get updated contract for experience ${experienceId}`);
      }
      
      // Update runtime if real-time updates are enabled
      if (options.enableRealTimeUpdates) {
        await this.runtime.updateExperienceContract(experienceId, updatedContract);
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
    } catch {
      const fallbackContract = await this.editor.getCurrentContract(experienceId);
      return {
        success: false,
        updatedContract: fallbackContract || new ContractModel({ name: 'Error Contract', version: '1.0.0', elements: [], operations: [] })
      };
    }
  }

  /**
   * Applies a natural-language edit to a live experience. The contract
   * regenerates through the manifest-validated pipeline with stable ids, so
   * the user's data survives; the runtime, other windows, persistence, and
   * any bookmark of the app are all brought up to date.
   */
  async refineExperience(
    experienceId: string,
    instruction: string,
    currentContract?: ContractModel | Contract
  ): Promise<{ contract: ContractModel; warnings: ValidationWarning[] }> {
    const existing =
      currentContract ?? (await this.runtime.getExperience(experienceId))?.contract;
    if (!existing) {
      throw new Error(`No contract available for experience ${experienceId}`);
    }

    const { contract: editedData, warnings } = await this.aiInterpreter.editContract(
      existing as Contract,
      instruction
    );
    const contract = ContractModel.fromObject(editedData);

    // Update the runtime when it knows this experience (registers preview
    // sessions); it emits the cross-window contract-updated event. Standalone
    // windows may not be registered here, so emit the event ourselves then.
    const known = await this.runtime.getExperience(experienceId);
    if (known) {
      await this.runtime.updateExperienceContract(experienceId, contract);
    } else {
      try {
        await emit('experience-contract-updated', { experienceId, contract: contract.toObject() });
      } catch {
        // Outside Tauri there is no event bus; the caller applies the result.
      }
    }

    await this.persistence
      .saveExperience({
        id: experienceId,
        contract,
        reactComponent: () => null,
        state: known?.state ?? { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
        operations: new Map()
      })
      .catch((error) => console.warn('Failed to save refined experience', error));

    // Keep a bookmarked app (and its tray entry) current.
    try {
      const bookmark = await this.persistence.loadBookmarkRecord(experienceId);
      if (bookmark) {
        await this.persistence.bookmarkExperience({
          id: experienceId,
          contract,
          reactComponent: () => null,
          state: { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
          operations: new Map()
        });
      }
    } catch {
      // Bookmark sync is best-effort.
    }

    return { contract, warnings };
  }

  /**
   * Legacy name kept for existing callers; delegates to refineExperience.
   */
  async regenerateExperienceWithPreservation(
    experienceId: string,
    newInput: string,
    _options: IntegratedWorkflowOptions = {}
  ): Promise<ExperienceEditResult> {
    try {
      const { contract } = await this.refineExperience(experienceId, newInput);
      return { success: true, updatedContract: contract };
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
  ): Promise<{ shareUrl: string; shareableExperience: ShareableContract }> {
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
      const shareUrl = await this.sharing.generateShareUrl(experienceId);

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
      const contractModel = ContractModel.fromObject(importedExperience.contract);
      const renderComponent = await this.runtime.renderExperience(
        contractModel,
        importedExperience.experienceId
      );

      // Create experience object
      const experience: Experience = {
        id: importedExperience.experienceId,
        contract: contractModel,
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
        blueprint: new BlueprintModel({
          uiElements: [],
          operations: [],
          requiredCapabilities: [],
          ambiguities: []
        }),
        contract: contractModel,
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
  ): Promise<BookmarkedExperience> {
    try {
      // Get current experience
      const experience = await this.runtime.getExperience(experienceId);
      if (!experience) {
        throw new Error('Experience not found');
      }

      // Create shareable version for bookmarking
      const shareableExperience: ShareableContract = {
        contract: experience.contract,
        metadata: {
          title: experience.contract.name || 'Untitled Experience',
          createdAt: new Date(),
          sharedAt: new Date()
        },
        version: '1.0.0',
        checksum: this.generateChecksum(experience.contract)
      };

      // Bookmark through bookmark manager
      const bookmarkId = await this.bookmarks.bookmarkExperience(
        userId,
        shareableExperience,
        bookmarkOptions
      );
      
      // Return a proper BookmarkedExperience object
      return {
        id: bookmarkId,
        name: shareableExperience.metadata.title,
        contract: shareableExperience.contract,
        createdAt: shareableExperience.metadata.createdAt,
        lastAccessedAt: new Date(),
        tags: bookmarkOptions.tags
      };
    } catch (error) {
      throw new Error(`Failed to bookmark experience: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Load bookmarked experience
   */
  async loadBookmarkedExperience(
    bookmarkId: string,
    _userId: string
  ): Promise<ExperienceCreationResult> {
    try {
      // Get bookmark
      const bookmark = await this.bookmarks.getBookmark(bookmarkId);
      if (!bookmark) {
        throw new Error('Bookmark not found');
      }

      // Get the shareable experience - use the bookmark's contract directly
      const shareableExperience = { 
        contract: bookmark.contract,
        metadata: { title: bookmark.name, createdAt: bookmark.createdAt, sharedAt: bookmark.createdAt },
        version: '1.0.0',
        checksum: 'bookmark-checksum'
      };
      if (!shareableExperience) {
        throw new Error('Shared experience not found');
      }

      // Create new experience ID for the loaded experience
      const newExperienceId = this.generateExperienceId();

      // Initialize in editor
      const bookmarkContractModel = ContractModel.fromObject(shareableExperience.contract);
      await this.editor.initializeExperience(newExperienceId, bookmarkContractModel);

      // Render experience
      const renderComponent = await this.runtime.renderExperience(
        bookmarkContractModel,
        newExperienceId
      );

      // Create experience object
      const experience: Experience = {
        id: newExperienceId,
        contract: bookmarkContractModel,
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
        blueprint: new BlueprintModel({
          uiElements: [],
          operations: [],
          requiredCapabilities: [],
          ambiguities: []
        }),
        contract: bookmarkContractModel,
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
  async getUserBookmarks(userId: string): Promise<BookmarkedExperience[]> {
    return await this.bookmarks.getAllBookmarks(userId);
  }

  /**
   * Search bookmarks
   */
  async searchBookmarks(
    _userId: string,
    query: { tags?: string[]; query?: string; collection?: string }
  ): Promise<BookmarkedExperience[]> {
    return await this.bookmarks.searchBookmarks(query.query || '');
  }

  /**
   * Get experience state
   */
  async getExperienceState(experienceId: string): Promise<ExperienceState | null> {
    const experience = await this.runtime.getExperience(experienceId);
    if (!experience?.state) return null;
    
    // Ensure the state matches ExperienceState interface
    if (typeof experience.state === 'object' && 'data' in experience.state && 'loading' in experience.state) {
      return experience.state as ExperienceState;
    }
    
    // Convert generic state to ExperienceState format
    return {
      data: experience.state as Record<string, any> || {},
      loading: {},
      errors: {},
      lastUpdated: new Date()
    };
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
  async getEditHistory(experienceId: string): Promise<any[]> {
    return await this.editor.getEditHistory(experienceId);
  }

  /**
   * Undo last edit
   */
  async undoLastEdit(experienceId: string): Promise<ContractModel> {
    await this.editor.undoLastEdit(experienceId);
    const contract = await this.editor.getCurrentContract(experienceId);
    if (!contract) {
      throw new Error(`Failed to get contract after undo for experience ${experienceId}`);
    }
    return contract;
  }

  /**
   * Redo last edit
   */
  async redoLastEdit(experienceId: string): Promise<ContractModel> {
    await this.editor.redoLastEdit(experienceId);
    const contract = await this.editor.getCurrentContract(experienceId);
    if (!contract) {
      throw new Error(`Failed to get contract after redo for experience ${experienceId}`);
    }
    return contract;
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

  private generateChecksum(contract: any): string {
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
