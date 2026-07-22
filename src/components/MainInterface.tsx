/**
 * Main Interface - Primary user interface that integrates all components
 * Provides natural language input, blueprint editing, contract editing, and experience preview
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import './MainInterface.css';

// Import existing components
import { BlueprintEditor } from './editor/BlueprintEditor';
import { ContractEditor } from './editor/ContractEditor';
import { DynamicExperienceRenderer } from './runtime/DynamicExperienceRenderer';
import { ExperienceEditBar } from './runtime/ExperienceEditBar';

// Import persistence components
import { BookmarkManager } from './bookmarks';
import { SharingDialog, ImportDialog } from './sharing';
import { SettingsView } from './settings/SettingsView';

// Import types
import { Blueprint } from '../types/blueprint';
import { Contract as ContractClass } from '../models/contract';
import { ValidationResult, ValidationWarning } from '../types/contract';
import { ExperienceState, Experience } from '../types/experience';

// Import services
import { NaturalLanguageParser } from '../services/ai-interpreter/natural-language-parser';
import { BlueprintGenerator } from '../services/ai-interpreter/blueprint-generator';
import { ContractBuilder } from '../services/ai-interpreter/contract-builder';
import { LLMClient } from '../services/ai-interpreter/llm-client';
import { repositoryService } from '../services/repository/repository-service';
import { persistenceService } from '../services/persistence';
import { integratedExperienceService } from '../services/IntegratedExperienceService';
import { isTauriRuntime } from '../services/tauri/TauriCommandService';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Navigation modes
type ViewMode = 'create' | 'blueprint' | 'contract' | 'preview' | 'bookmarks' | 'import' | 'settings';

interface MainInterfaceState {
  currentMode: ViewMode;
  naturalLanguageInput: string;
  blueprint: Blueprint | null;
  contract: ContractClass | null;
  currentExperienceId?: string | null;
  experienceState: ExperienceState | null;
  isProcessing: boolean;
  error: string | null;
  validationResults: {
    blueprint?: ValidationResult;
    contract?: ValidationResult;
  };
  bookmarkedExperiences: any[];
  contractWarnings: ValidationWarning[];
  showSharingDialog: boolean;
  showImportDialog: boolean;
  currentExperienceBookmarked: boolean;
}

export const MainInterface: React.FC = () => {
  const [state, setState] = useState<MainInterfaceState>({
    currentMode: 'create',
    naturalLanguageInput: '',
    blueprint: null,
    contract: null,
    currentExperienceId: null,
    experienceState: null,
    isProcessing: false,
    error: null,
    validationResults: {},
    bookmarkedExperiences: [],
    contractWarnings: [],
    showSharingDialog: false,
    showImportDialog: false,
    currentExperienceBookmarked: false
  });

  // Initialize services (provider and model come from the stored settings;
  // the shared repository singleton is seeded at app startup)
  const services = useMemo(() => {
    const llmClient = new LLMClient();

    return {
      naturalLanguageParser: new NaturalLanguageParser(llmClient),
      blueprintGenerator: new BlueprintGenerator(),
      contractBuilder: new ContractBuilder(repositoryService, llmClient),
      repositoryService
    };
  }, []);

  // Load bookmarked experiences
  const loadBookmarkedExperiences = useCallback(async () => {
    try {
      const experiences = await persistenceService.listBookmarkedExperiences();
      setState(prev => ({ ...prev, bookmarkedExperiences: experiences }));
    } catch (error) {
      console.error('Failed to load bookmarked experiences:', error);
    }
  }, []);

  // System tray event listeners
  useEffect(() => {
    const setupEventListeners = async () => {
      // Listen for navigate-to-create event from system tray
      await listen('navigate-to-create', () => {
        setState(prev => ({ ...prev, currentMode: 'create' }));
      });

      // Listen for show-bookmarks event from system tray
      await listen('show-bookmarks', () => {
        loadBookmarkedExperiences();
        setState(prev => ({ ...prev, currentMode: 'bookmarks' }));
      });
    };

    setupEventListeners();
    loadBookmarkedExperiences(); // Load on startup
  }, [loadBookmarkedExperiences]);

  // Handle natural language processing with integrated service
  const handleGenerateBlueprint = useCallback(async () => {
    if (!state.naturalLanguageInput.trim()) {
      setState(prev => ({ ...prev, error: 'Please enter a description of what you want to build.' }));
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true, error: null }));

    try {
      // Use integrated service for complete workflow
      const result = await integratedExperienceService.createExperienceFromNaturalLanguage(
        state.naturalLanguageInput,
        {
          preserveEdits: true,
          autoSave: true,
          enableRealTimeUpdates: true
        }
      );
      
      // Validate blueprint
      const validation = services.blueprintGenerator.validateBlueprint(result.blueprint);
      
      setState(prev => ({
        ...prev,
        blueprint: result.blueprint,
        contract: result.contract,
        currentExperienceId: result.experienceId,
        currentMode: 'preview',
        currentExperienceBookmarked: false,
        contractWarnings: result.warnings ?? [],
        validationResults: { ...prev.validationResults, blueprint: validation },
        isProcessing: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to generate blueprint',
        isProcessing: false
      }));
    }
  }, [state.naturalLanguageInput, services]);

  // Handle blueprint to contract generation
  const handleGenerateContract = useCallback(async () => {
    if (!state.blueprint) {
      setState(prev => ({ ...prev, error: 'No blueprint available to generate contract from.' }));
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true, error: null }));

    try {
      // Generate contract from blueprint
      const contractData = await services.contractBuilder.generateFromBlueprint(state.blueprint);
      const contract = new ContractClass(contractData);
      
      // Validate contract
      const validation = services.contractBuilder.validateContract(contractData);
      
      setState(prev => ({
        ...prev,
        contract,
        currentMode: 'contract',
        validationResults: { ...prev.validationResults, contract: validation },
        isProcessing: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to generate contract',
        isProcessing: false
      }));
    }
  }, [state.blueprint, services]);

  // Handle blueprint changes
  const handleBlueprintChange = useCallback((blueprint: Blueprint) => {
    setState(prev => ({ ...prev, blueprint }));
  }, []);

  // Handle contract changes
  const handleContractChange = useCallback((contract: ContractClass) => {
    setState(prev => ({ ...prev, contract }));
  }, []);

  // Handle validation changes
  const handleBlueprintValidationChange = useCallback((validation: ValidationResult) => {
    setState(prev => ({
      ...prev,
      validationResults: { ...prev.validationResults, blueprint: validation }
    }));
  }, []);

  const handleContractValidationChange = useCallback((validation: ValidationResult) => {
    setState(prev => ({
      ...prev,
      validationResults: { ...prev.validationResults, contract: validation }
    }));
  }, []);

  // Handle experience state changes
  const handleExperienceStateChange = useCallback((experienceState: ExperienceState) => {
    setState(prev => ({ ...prev, experienceState }));
  }, []);

  // Live preview data carried across contract edits (recomputed only when
  // the contract object changes, so typing does not re-seed the renderer).
  const previewRehydrationData = useMemo(
    () => ({ ...(state.experienceState?.data ?? {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.contract]
  );

  // Apply a natural-language change to the previewed experience
  const handleRefineExperience = useCallback(async (instruction: string) => {
    if (!state.contract || !state.currentExperienceId) {
      throw new Error('Generate an experience before editing it.');
    }
    setState(prev => ({ ...prev, isProcessing: true }));
    try {
      const result = await integratedExperienceService.refineExperience(
        state.currentExperienceId,
        instruction,
        state.contract
      );
      setState(prev => ({
        ...prev,
        contract: result.contract,
        contractWarnings: result.warnings,
        isProcessing: false
      }));
    } catch (error) {
      setState(prev => ({ ...prev, isProcessing: false }));
      throw error;
    }
  }, [state.contract, state.currentExperienceId]);

  // Handle experience errors
  const handleExperienceError = useCallback((error: Error) => {
    setState(prev => ({ ...prev, error: error.message }));
  }, []);

  // Navigation handlers
  const handleModeChange = useCallback((mode: ViewMode) => {
    setState(prev => ({ ...prev, currentMode: mode, error: null }));
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }));
  }, []);

  // Reset to start
  const handleReset = useCallback(() => {
    setState({
      currentMode: 'create',
      naturalLanguageInput: '',
      blueprint: null,
      contract: null,
      experienceState: null,
      isProcessing: false,
      error: null,
      validationResults: {},
      bookmarkedExperiences: [],
      contractWarnings: [],
      showSharingDialog: false,
      showImportDialog: false,
      currentExperienceBookmarked: false
    });
  }, []);

  // Load experience from bookmark
  const handleLoadExperience = useCallback(async (experience: Experience) => {
    try {
      const contract = ContractClass.fromObject(experience.contract);
      setState(prev => ({
        ...prev,
        contract,
        currentExperienceId: experience.id,
        currentMode: 'preview',
        currentExperienceBookmarked: true
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: `Could not open this bookmark: ${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }, []);

  // Handle bookmark creation
  const handleBookmarkExperience = useCallback(async () => {
    if (!state.contract) return;
    const experienceId = state.currentExperienceId || `exp-${Date.now()}`;
    if (!state.currentExperienceId) {
      setState(prev => ({ ...prev, currentExperienceId: experienceId }));
    }

    setState(prev => ({ ...prev, isProcessing: true, error: null }));
    try {
      await persistenceService.bookmarkExperience({
        id: experienceId,
        contract: state.contract,
        reactComponent: () => null,
        state: { data: {}, loading: {}, errors: {}, lastUpdated: new Date() },
        operations: new Map()
      });

      setState(prev => ({
        ...prev,
        currentExperienceBookmarked: true,
        isProcessing: false
      }));
      await loadBookmarkedExperiences();
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to bookmark experience',
        isProcessing: false
      }));
    }
  }, [state.contract, state.currentExperienceId, loadBookmarkedExperiences]);

  // Handle sharing dialog
  const handleShowSharingDialog = useCallback(() => {
    setState(prev => ({ ...prev, showSharingDialog: true }));
  }, []);

  const handleCloseSharingDialog = useCallback(() => {
    setState(prev => ({ ...prev, showSharingDialog: false }));
  }, []);

  // Handle import dialog
  const handleShowImportDialog = useCallback(() => {
    setState(prev => ({ ...prev, showImportDialog: true }));
  }, []);

  const handleCloseImportDialog = useCallback(() => {
    setState(prev => ({ ...prev, showImportDialog: false }));
  }, []);

  // Handle import success using integrated service
  const handleImportSuccess = useCallback(async (experience: Experience) => {
    setState(prev => ({ ...prev, isProcessing: true, error: null }));
    
    try {
      // Convert Experience to Contract if needed
      const contract = experience.contract instanceof ContractClass 
        ? experience.contract 
        : ContractClass.fromObject(experience.contract);

      setState(prev => ({
        ...prev,
        blueprint: experience.blueprint || null,
        contract: contract,
        currentMode: 'preview',
        currentExperienceBookmarked: false,
        showImportDialog: false,
        isProcessing: false
      }));
      
      await loadBookmarkedExperiences();
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to import experience',
        showImportDialog: false,
        isProcessing: false
      }));
    }
  }, [loadBookmarkedExperiences]);

  // Handle success/error messages
  const handleSuccess = useCallback((message: string) => {
    // You could implement a toast notification system here
    console.log('Success:', message);
  }, []);

  const handleError = useCallback((error: string) => {
    setState(prev => ({ ...prev, error }));
  }, []);

  return (
    <div className="main-interface">
      {/* Header */}
      <header className="main-header">
        <h1>Dynamic Experience Runtime</h1>
        <p>Create and manage your interactive experiences</p>
      </header>

      {/* Navigation */}
      <nav className="main-navigation">
        <button
          className={`nav-button ${state.currentMode === 'create' ? 'active' : ''}`}
          onClick={() => handleModeChange('create')}
        >
          New Experience
        </button>
        <button
          className={`nav-button ${state.currentMode === 'blueprint' ? 'active' : ''}`}
          onClick={() => handleModeChange('blueprint')}
          disabled={!state.blueprint}
        >
          Blueprint {state.blueprint && '✓'}
        </button>
        <button
          className={`nav-button ${state.currentMode === 'contract' ? 'active' : ''}`}
          onClick={() => handleModeChange('contract')}
          disabled={!state.contract}
        >
          Contract {state.contract && '✓'}
        </button>
        <button
          className={`nav-button ${state.currentMode === 'preview' ? 'active' : ''}`}
          onClick={() => handleModeChange('preview')}
          disabled={!state.contract}
        >
          Preview
        </button>
        <button
          className={`nav-button ${state.currentMode === 'bookmarks' ? 'active' : ''}`}
          onClick={() => {
            loadBookmarkedExperiences();
            handleModeChange('bookmarks');
          }}
        >
          Bookmarks ({state.bookmarkedExperiences.length})
        </button>
        <button
          className="nav-button"
          onClick={handleShowImportDialog}
          title="Import shared experience"
        >
          Import
        </button>
        <button
          className={`nav-button ${state.currentMode === 'settings' ? 'active' : ''}`}
          onClick={() => handleModeChange('settings')}
        >
          Settings
        </button>
        <button
          className="nav-button reset"
          onClick={handleReset}
          title="Start over"
        >
          Reset
        </button>
      </nav>

      {/* Error Display */}
      {state.error && (
        <div className="error-banner">
          <span className="error-message">{state.error}</span>
          <button className="error-close" onClick={clearError}>×</button>
        </div>
      )}

      {/* Processing Indicator */}
      {state.isProcessing && (
        <div className="processing-indicator">
          <div className="spinner"></div>
          <span>Building your app...</span>
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        {state.currentMode === 'create' && (
          <CreateView
            naturalLanguageInput={state.naturalLanguageInput}
            onInputChange={(input) => setState(prev => ({ ...prev, naturalLanguageInput: input }))}
            onGenerateBlueprint={handleGenerateBlueprint}
            isProcessing={state.isProcessing}
          />
        )}

        {state.currentMode === 'blueprint' && state.blueprint && (
          <BlueprintView
            blueprint={state.blueprint}
            validation={state.validationResults.blueprint}
            onBlueprintChange={handleBlueprintChange}
            onValidationChange={handleBlueprintValidationChange}
            onGenerateContract={handleGenerateContract}
            isProcessing={state.isProcessing}
          />
        )}

        {state.currentMode === 'contract' && state.contract && (
          <ContractView
            contract={state.contract}
            validation={state.validationResults.contract}
            onContractChange={handleContractChange}
            onValidationChange={handleContractValidationChange}
          />
        )}

        {state.currentMode === 'preview' && state.contract && (
          <PreviewView
            contract={state.contract}
            experienceId={state.currentExperienceId || 'preview'}
            initialData={previewRehydrationData}
            onRefine={handleRefineExperience}
            warnings={state.contractWarnings}
            onDismissWarnings={() => setState(prev => ({ ...prev, contractWarnings: [] }))}
            onStateChange={handleExperienceStateChange}
            onError={handleExperienceError}
            onBookmark={handleBookmarkExperience}
            onShare={handleShowSharingDialog}
            isBookmarked={state.currentExperienceBookmarked}
            isProcessing={state.isProcessing}
            onOpenWindow={async () => {
              try {
                const payload = {
                  experienceId: state.currentExperienceId || `exp-${Date.now()}`,
                  contract: state.contract!.toObject(),
                  title: (state.contract && state.contract.name) || 'Experience'
                };
                // Prefer Tauri window if available
                const hasTauri = isTauriRuntime();
                if (hasTauri) {
                  console.log('Invoking Tauri open_experience_window with', payload);
                  await invoke('open_experience_window', payload);
                  console.log('Tauri open_experience_window success');
                } else {
                  // Browser fallback for debugging
                  const win = window.open('', '_blank', 'noopener,noreferrer');
                  if (!win) {
                    throw new Error('Popup blocked. Enable popups for this site.');
                  }
                  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${payload.title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#0b0e14;color:#e6e6e6} pre{white-space:pre-wrap;word-break:break-word;background:#121621;border:1px solid #2a2f3a;border-radius:8px;padding:12px}</style></head><body><h2>Experience (Debug Window)</h2><p>This is a debug view because Tauri is not available.</p><h3>Contract JSON</h3><pre>${
                    JSON.stringify(payload.contract, null, 2)
                  }</pre></body></html>`;
                  win.document.open();
                  win.document.write(html);
                  win.document.close();
                }
              } catch (e) {
                console.error('Failed to open window', e);
                setState(prev => ({ ...prev, error: e instanceof Error ? e.message : 'Failed to open window' }));
              }
            }}
          />
        )}

        {state.currentMode === 'bookmarks' && (
          <BookmarkManager
            onLoadExperience={handleLoadExperience}
            onError={handleError}
          />
        )}

        {state.currentMode === 'settings' && (
          <SettingsView onError={handleError} />
        )}
      </main>

      {/* Status Bar */}
      <footer className="main-footer">
        <div className="status-info">
          <span>Mode: {state.currentMode}</span>
          {state.blueprint && <span>Blueprint: ✓</span>}
          {state.contract && <span>Contract: ✓</span>}
          {state.validationResults.blueprint && !state.validationResults.blueprint.isValid && (
            <span className="validation-error">Blueprint: {state.validationResults.blueprint.errors.length} errors</span>
          )}
          {state.validationResults.contract && !state.validationResults.contract.isValid && (
            <span className="validation-error">Contract: {state.validationResults.contract.errors.length} errors</span>
          )}
        </div>
      </footer>

      {/* Sharing Dialog */}
      {state.contract && state.currentExperienceId && (
        <SharingDialog
          experienceId={state.currentExperienceId}
          experienceName={state.contract.name || 'Unnamed Experience'}
          isOpen={state.showSharingDialog}
          onClose={handleCloseSharingDialog}
          onError={handleError}
          onSuccess={handleSuccess}
        />
      )}

      {/* Import Dialog */}
      <ImportDialog
        isOpen={state.showImportDialog}
        onClose={handleCloseImportDialog}
        onImportSuccess={handleImportSuccess}
        onError={handleError}
        onSuccess={handleSuccess}
      />
    </div>
  );
};

// Create View Component
interface CreateViewProps {
  naturalLanguageInput: string;
  onInputChange: (input: string) => void;
  onGenerateBlueprint: () => void;
  isProcessing: boolean;
}

const CreateView: React.FC<CreateViewProps> = ({
  naturalLanguageInput,
  onInputChange,
  onGenerateBlueprint,
  isProcessing
}) => {
  const examplePrompts = [
    "Create a todo list app with add, delete, and mark complete functionality",
    "Build a simple calculator with basic arithmetic operations",
    "Make a weather dashboard that shows current conditions and forecast",
    "Create a contact manager with search and filtering capabilities",
    "Build a note-taking app with categories and tags"
  ];

  return (
    <div className="create-view">
      <div className="create-header">
        <h2>What do you want to build?</h2>
        <p>Describe the app in plain language and it opens ready to use. The blueprint and contract behind it stay editable from the tabs above.</p>
      </div>

      <div className="input-section">
        <textarea
          className="natural-language-input"
          value={naturalLanguageInput}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="Describe what you want to build... For example: 'Create a todo list app where users can add tasks, mark them as complete, and delete them. Include a filter to show only incomplete tasks.'"
          rows={6}
          disabled={isProcessing}
        />
        
        <div className="input-actions">
          <button
            className="generate-button primary"
            onClick={onGenerateBlueprint}
            disabled={!naturalLanguageInput.trim() || isProcessing}
          >
            Create app
          </button>
        </div>
      </div>

      <div className="examples-section">
        <h3>Example Prompts</h3>
        <div className="example-prompts">
          {examplePrompts.map((prompt, index) => (
            <button
              key={index}
              className="example-prompt"
              onClick={() => onInputChange(prompt)}
              disabled={isProcessing}
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};



// Blueprint View Component
interface BlueprintViewProps {
  blueprint: Blueprint;
  validation?: ValidationResult;
  onBlueprintChange: (blueprint: Blueprint) => void;
  onValidationChange: (validation: ValidationResult) => void;
  onGenerateContract: () => void;
  isProcessing: boolean;
}

const BlueprintView: React.FC<BlueprintViewProps> = ({
  blueprint,
  validation,
  onBlueprintChange,
  onValidationChange,
  onGenerateContract,
  isProcessing
}) => {
  return (
    <div className="blueprint-view">
      <div className="blueprint-header">
        <h2>Blueprint Editor</h2>
        <div className="blueprint-actions">
          <button
            className="generate-contract-button primary"
            onClick={onGenerateContract}
            disabled={validation && !validation.isValid || isProcessing}
          >
            Generate Contract
          </button>
        </div>
      </div>

      <BlueprintEditor
        blueprint={blueprint}
        onBlueprintChange={onBlueprintChange}
        onValidationChange={onValidationChange}
      />
    </div>
  );
};

// Contract View Component
interface ContractViewProps {
  contract: ContractClass;
  validation?: ValidationResult;
  onContractChange: (contract: ContractClass) => void;
  onValidationChange: (validation: ValidationResult) => void;
}

const ContractView: React.FC<ContractViewProps> = ({
  contract,
  onContractChange,
  onValidationChange
}) => {
  return (
    <div className="contract-view">
      <div className="contract-header">
        <h2>Contract Editor</h2>
      </div>

      <ContractEditor
        contract={contract}
        onChange={(newContract) => onContractChange(newContract)}
        onValidationChange={onValidationChange}
      />
    </div>
  );
};

// Preview View Component
interface PreviewViewProps {
  contract: ContractClass;
  experienceId: string;
  initialData?: Record<string, unknown>;
  onRefine?: (instruction: string) => Promise<void>;
  warnings?: ValidationWarning[];
  onDismissWarnings?: () => void;
  onStateChange: (state: ExperienceState) => void;
  onError: (error: Error) => void;
  onBookmark?: () => void;
  onShare?: () => void;
  onOpenWindow?: () => void;
  isBookmarked?: boolean;
  isProcessing?: boolean;
}

const PreviewView: React.FC<PreviewViewProps> = ({
  contract,
  experienceId,
  initialData,
  onRefine,
  warnings,
  onDismissWarnings,
  onStateChange,
  onError,
  onBookmark,
  onShare,
  onOpenWindow,
  isBookmarked = false,
  isProcessing = false
}) => {
  return (
    <div className="preview-view">
      <div className="preview-header">
        <div className="preview-title">
          <h2>{contract.name || 'Your app'}</h2>
          {contract.metadata?.description && <p>{contract.metadata.description}</p>}
        </div>
        <div className="preview-actions">
          {onBookmark && (
            <button
              className={`bookmark-button ${isBookmarked ? 'bookmarked' : ''}`}
              onClick={onBookmark}
              disabled={isProcessing}
              title={isBookmarked ? 'Remove bookmark' : 'Bookmark this experience'}
            >
              {isBookmarked ? 'Bookmarked' : 'Bookmark'}
            </button>
          )}
          {onShare && (
            <button
              className="share-button"
              onClick={onShare}
              disabled={isProcessing}
              title="Share this experience"
            >
              Share
            </button>
          )}
          {onOpenWindow && (
            <button
              className="open-window-button"
              onClick={onOpenWindow}
              disabled={isProcessing}
              title="Open in new window"
            >
              Open in window
            </button>
          )}
        </div>
      </div>

      {onRefine && (
        <ExperienceEditBar
          onSubmit={onRefine}
          busy={isProcessing}
          warnings={warnings}
          onDismissWarnings={onDismissWarnings}
        />
      )}
      <div className="preview-container">
        <DynamicExperienceRenderer
          contract={contract}
          initialData={initialData}
          experienceId={experienceId}
          onStateChange={onStateChange}
          onError={onError}
        />
      </div>
    </div>
  );
};

