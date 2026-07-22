/**
 * Main Interface - Primary user interface that integrates all components
 * Provides natural language input, blueprint and contract editing, bookmarks,
 * parts, and settings; created apps open in their own windows.
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import './MainInterface.css';

// Import existing components
import { BlueprintEditor } from './editor/BlueprintEditor';
import { ContractEditor } from './editor/ContractEditor';
import { ExperienceNotes } from './runtime/ExperienceEditBar';

// Import persistence components
import { BookmarkManager } from './bookmarks';
import { SharingDialog, ImportDialog } from './sharing';
import { SettingsView } from './settings/SettingsView';
import { PartsView } from './parts/PartsView';

// Import types
import { Blueprint } from '../types/blueprint';
import { Contract as ContractClass } from '../models/contract';
import { ValidationResult, ValidationWarning } from '../types/contract';
import { Experience } from '../types/experience';
import { BookmarkedExperience } from '../types/persistence';

// Import services
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
type ViewMode = 'create' | 'blueprint' | 'contract' | 'bookmarks' | 'import' | 'parts' | 'settings';

interface MainInterfaceState {
  currentMode: ViewMode;
  naturalLanguageInput: string;
  blueprint: Blueprint | null;
  contract: ContractClass | null;
  currentExperienceId?: string | null;
  isProcessing: boolean;
  error: string | null;
  notice: string | null;
  validationResults: {
    blueprint?: ValidationResult;
    contract?: ValidationResult;
  };
  bookmarkedExperiences: BookmarkedExperience[];
  contractWarnings: ValidationWarning[];
  shareTarget: { id: string; name: string } | null;
  showImportDialog: boolean;
}

export const MainInterface: React.FC = () => {
  const [state, setState] = useState<MainInterfaceState>({
    currentMode: 'create',
    naturalLanguageInput: '',
    blueprint: null,
    contract: null,
    currentExperienceId: null,
    isProcessing: false,
    error: null,
    notice: null,
    validationResults: {},
    bookmarkedExperiences: [],
    contractWarnings: [],
    shareTarget: null,
    showImportDialog: false
  });

  // Initialize services (provider and model come from the stored settings;
  // the shared repository singleton is seeded at app startup)
  const services = useMemo(() => {
    const llmClient = new LLMClient();

    return {
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

  // Open an experience as its own app window.
  const openExperienceWindow = useCallback(async (
    experienceId: string,
    contract: ContractClass,
    title: string
  ) => {
    const payload = { experienceId, contract: contract.toObject(), title };
    if (isTauriRuntime()) {
      await invoke('open_experience_window', payload);
      return;
    }
    // Browser fallback for debugging outside the desktop shell
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
  }, []);

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

      // In the desktop shell the service already opened the app window (live
      // assembly); outside it, fall back to the debug window.
      const title = result.contract.name || 'Experience';
      if (!isTauriRuntime()) {
        await openExperienceWindow(result.experienceId, result.contract, title);
      }

      setState(prev => ({
        ...prev,
        blueprint: result.blueprint,
        contract: result.contract,
        currentExperienceId: result.experienceId,
        naturalLanguageInput: '',
        notice: `"${title}" opened in its own window. Review its blueprint and contract from the tabs above.`,
        contractWarnings: result.warnings ?? [],
        validationResults: { ...prev.validationResults, blueprint: validation },
        isProcessing: false
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to create the app',
        isProcessing: false
      }));
    }
  }, [state.naturalLanguageInput, services, openExperienceWindow]);

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

  // Navigation handlers
  const handleModeChange = useCallback((mode: ViewMode) => {
    setState(prev => ({ ...prev, currentMode: mode, error: null }));
  }, []);

  const clearNotice = useCallback(() => {
    setState(prev => ({ ...prev, notice: null, contractWarnings: [] }));
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
      currentExperienceId: null,
      isProcessing: false,
      error: null,
      notice: null,
      validationResults: {},
      bookmarkedExperiences: [],
      contractWarnings: [],
      shareTarget: null,
      showImportDialog: false
    });
  }, []);

  // Handle sharing dialog (opened from a bookmark card)
  const handleShareBookmark = useCallback((id: string, name: string) => {
    setState(prev => ({ ...prev, shareTarget: { id, name } }));
  }, []);

  const handleCloseSharingDialog = useCallback(() => {
    setState(prev => ({ ...prev, shareTarget: null }));
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

      const title = contract.name || 'Imported experience';
      await openExperienceWindow(experience.id, contract, title);

      setState(prev => ({
        ...prev,
        blueprint: experience.blueprint || null,
        contract: contract,
        currentExperienceId: experience.id,
        notice: `"${title}" opened in its own window.`,
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
  }, [loadBookmarkedExperiences, openExperienceWindow]);

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
          className={`nav-button ${state.currentMode === 'parts' ? 'active' : ''}`}
          onClick={() => handleModeChange('parts')}
        >
          Parts
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
            notice={state.notice}
            warnings={state.contractWarnings}
            onDismissNotice={clearNotice}
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

        {state.currentMode === 'bookmarks' && (
          <BookmarkManager
            onError={handleError}
            onShare={handleShareBookmark}
            onBookmarksChanged={loadBookmarkedExperiences}
          />
        )}

        {state.currentMode === 'parts' && (
          <PartsView onError={handleError} />
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
      {state.shareTarget && (
        <SharingDialog
          experienceId={state.shareTarget.id}
          experienceName={state.shareTarget.name}
          isOpen={true}
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
  notice?: string | null;
  warnings?: ValidationWarning[];
  onDismissNotice?: () => void;
}

const CreateView: React.FC<CreateViewProps> = ({
  naturalLanguageInput,
  onInputChange,
  onGenerateBlueprint,
  isProcessing,
  notice,
  warnings,
  onDismissNotice
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

      {notice && (
        <div className="create-notice">
          <span>{notice}</span>
          {onDismissNotice && (
            <button type="button" onClick={onDismissNotice} aria-label="Dismiss notice">
              Dismiss
            </button>
          )}
        </div>
      )}
      {warnings && warnings.length > 0 && <ExperienceNotes warnings={warnings} />}

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
