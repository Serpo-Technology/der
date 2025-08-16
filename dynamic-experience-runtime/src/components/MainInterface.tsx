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

// Import types
import { Blueprint } from '../types/blueprint';
import { Contract } from '../models/contract';
import { ValidationResult } from '../types/contract';
import { ExperienceState } from '../types/experience';

// Import services
import { NaturalLanguageParser } from '../services/ai-interpreter/natural-language-parser';
import { BlueprintGenerator } from '../services/ai-interpreter/blueprint-generator';
import { ContractBuilder } from '../services/ai-interpreter/contract-builder';
import { LLMClient } from '../services/ai-interpreter/llm-client';
import { RepositoryService } from '../services/repository/repository-service';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Navigation modes
type ViewMode = 'create' | 'blueprint' | 'contract' | 'preview' | 'bookmarks';

interface MainInterfaceState {
  currentMode: ViewMode;
  naturalLanguageInput: string;
  blueprint: Blueprint | null;
  contract: Contract | null;
  experienceState: ExperienceState | null;
  isProcessing: boolean;
  error: string | null;
  validationResults: {
    blueprint?: ValidationResult;
    contract?: ValidationResult;
  };
  bookmarkedExperiences: any[];
}

export const MainInterface: React.FC = () => {
  const [state, setState] = useState<MainInterfaceState>({
    currentMode: 'create',
    naturalLanguageInput: '',
    blueprint: null,
    contract: null,
    experienceState: null,
    isProcessing: false,
    error: null,
    validationResults: {},
    bookmarkedExperiences: []
  });

  // Initialize services
  const services = useMemo(() => {
    const llmClient = new LLMClient({
      provider: 'local',
      model: 'gpt-3.5-turbo',
      temperature: 0.7
    });
    const repositoryService = new RepositoryService();
    
    return {
      naturalLanguageParser: new NaturalLanguageParser(llmClient),
      blueprintGenerator: new BlueprintGenerator(),
      contractBuilder: new ContractBuilder(repositoryService),
      repositoryService
    };
  }, []);

  // Load bookmarked experiences
  const loadBookmarkedExperiences = useCallback(async () => {
    try {
      const experiences = await invoke<any[]>('list_bookmarked_experiences');
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

  // Handle natural language processing
  const handleGenerateBlueprint = useCallback(async () => {
    if (!state.naturalLanguageInput.trim()) {
      setState(prev => ({ ...prev, error: 'Please enter a description of what you want to build.' }));
      return;
    }

    setState(prev => ({ ...prev, isProcessing: true, error: null }));

    try {
      // Parse natural language input
      const intent = await services.naturalLanguageParser.extractIntent(state.naturalLanguageInput);
      
      // Generate blueprint from intent
      const blueprint = services.blueprintGenerator.generateFromIntent(intent);
      
      // Validate blueprint
      const validation = services.blueprintGenerator.validateBlueprint(blueprint);
      
      setState(prev => ({
        ...prev,
        blueprint,
        currentMode: 'blueprint',
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
      const contract = new Contract(contractData);
      
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
  const handleContractChange = useCallback((contract: Contract) => {
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
      bookmarkedExperiences: []
    });
  }, []);

  // Load experience from bookmark
  const handleLoadExperience = useCallback(async (experienceId: string) => {
    setState(prev => ({ ...prev, isProcessing: true, error: null }));
    
    try {
      const contractData = await invoke<any>('load_contract', { contractId: experienceId });
      if (contractData) {
        const contract = new Contract(contractData);
        setState(prev => ({
          ...prev,
          contract,
          currentMode: 'preview',
          isProcessing: false
        }));
      } else {
        setState(prev => ({
          ...prev,
          error: 'Experience not found',
          isProcessing: false
        }));
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to load experience',
        isProcessing: false
      }));
    }
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
          Preview {state.contract && '▶'}
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
          <span>Processing...</span>
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
            onStateChange={handleExperienceStateChange}
            onError={handleExperienceError}
          />
        )}

        {state.currentMode === 'bookmarks' && (
          <BookmarksView
            experiences={state.bookmarkedExperiences}
            onLoadExperience={handleLoadExperience}
            onRefresh={loadBookmarkedExperiences}
            isLoading={state.isProcessing}
          />
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
        <h2>Describe Your Experience</h2>
        <p>Tell us what you want to build in natural language. Be as specific as possible about the functionality and interface you need.</p>
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
            Generate Blueprint
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

// Bookmarks View Component
interface BookmarksViewProps {
  experiences: any[];
  onLoadExperience: (experienceId: string) => void;
  onRefresh: () => void;
  isLoading: boolean;
}

const BookmarksView: React.FC<BookmarksViewProps> = ({
  experiences,
  onLoadExperience,
  onRefresh,
  isLoading
}) => {
  return (
    <div className="bookmarks-view">
      <div className="bookmarks-header">
        <h2>Bookmarked Experiences</h2>
        <button 
          className="refresh-button"
          onClick={onRefresh}
          disabled={isLoading}
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {experiences.length === 0 ? (
        <div className="empty-bookmarks">
          <div className="empty-icon">📚</div>
          <h3>No Bookmarked Experiences</h3>
          <p>Create and save your first experience to see it here.</p>
        </div>
      ) : (
        <div className="experiences-grid">
          {experiences.map((experience) => (
            <div key={experience.id} className="experience-card">
              <div className="experience-header">
                <h3>{experience.name}</h3>
                <span className="experience-date">
                  {new Date(experience.lastModified).toLocaleDateString()}
                </span>
              </div>
              <p className="experience-description">{experience.description}</p>
              <div className="experience-actions">
                <button
                  className="load-button primary"
                  onClick={() => onLoadExperience(experience.id)}
                  disabled={isLoading}
                >
                  Open Experience
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
  contract: Contract;
  validation?: ValidationResult;
  onContractChange: (contract: Contract) => void;
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
  contract: Contract;
  onStateChange: (state: ExperienceState) => void;
  onError: (error: Error) => void;
}

const PreviewView: React.FC<PreviewViewProps> = ({
  contract,
  onStateChange,
  onError
}) => {
  return (
    <div className="preview-view">
      <div className="preview-header">
        <h2>Experience Preview</h2>
        <p>This is how your experience will look and behave:</p>
      </div>

      <div className="preview-container">
        <DynamicExperienceRenderer
          contract={contract}
          experienceId="preview"
          onStateChange={onStateChange}
          onError={onError}
        />
      </div>
    </div>
  );
};

