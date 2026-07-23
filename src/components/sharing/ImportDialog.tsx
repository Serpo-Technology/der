/**
 * Import Dialog Component - UI for importing shared experiences
 * Requirements: 4.3, 4.4, 4.5
 */

import React, { useState, useCallback } from 'react';
import { ExportFormat } from '../../types/persistence';
import { sharingService } from '../../services/persistence';
import { ParsedShare } from '../../services/persistence/share-format';
import { Experience } from '../../types/experience';
import './ImportDialog.css';

interface ImportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImportSuccess?: (experience: Experience) => void;
  onError?: (error: string) => void;
  onSuccess?: (message: string) => void;
}

export const ImportDialog: React.FC<ImportDialogProps> = ({
  isOpen,
  onClose,
  onImportSuccess,
  onError,
  onSuccess
}) => {
  const [importMethod, setImportMethod] = useState<'paste' | 'file'>('paste');
  const [importData, setImportData] = useState('');
  const [importFormat, setImportFormat] = useState<ExportFormat>({ format: 'json' });
  const [isProcessing, setIsProcessing] = useState(false);
  const [validationResult, setValidationResult] = useState<ParsedShare | null>(null);
  const [currentStep, setCurrentStep] = useState<'input' | 'validate' | 'import'>('input');

  // Handle file upload
  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      setImportData(content);
      
      // Auto-detect format from file extension
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (extension === 'json') {
        setImportFormat({ format: 'json' });
      } else if (extension === 'yaml' || extension === 'yml') {
        setImportFormat({ format: 'yaml' });
      }
    };
    reader.readAsText(file);
  }, []);

  // Validate import data: parsing, hydration, and the vocabulary check all
  // happen in the service; this component renders only the result.
  const handleValidate = useCallback(() => {
    if (!importData.trim()) {
      onError?.('Please provide data to import');
      return;
    }

    setIsProcessing(true);
    try {
      setValidationResult(sharingService.validateSharedExperienceText(importData));
      setCurrentStep('validate');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to validate import data';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [importData, onError]);

  // Perform import
  const handleImport = useCallback(async () => {
    if (!validationResult?.shareable || validationResult.problems.length > 0) return;

    setIsProcessing(true);
    try {
      const result = await sharingService.importSharedExperience(importData, importFormat);

      if (result.success && result.experienceId) {
        // Create a basic Experience object for the callback
        const experience: Experience = {
          id: result.experienceId,
          contract: validationResult.shareable.contract,
          reactComponent: () => null,
          state: {
            data: {},
            loading: {},
            errors: {},
            lastUpdated: new Date()
          },
          operations: new Map()
        };

        onImportSuccess?.(experience);
        onSuccess?.('Experience imported successfully!');
        handleClose();
      } else {
        const errors = result.errors?.join(', ') || 'Unknown import error';
        onError?.(errors);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to import experience';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [validationResult, importData, importFormat, onImportSuccess, onSuccess, onError]);

  // Reset dialog
  const handleReset = useCallback(() => {
    setCurrentStep('input');
    setImportData('');
    setValidationResult(null);
    setImportMethod('paste');
    setImportFormat({ format: 'json' });
  }, []);

  // Close dialog
  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  if (!isOpen) return null;

  return (
    <div className="import-dialog-overlay">
      <div className="import-dialog">
        <div className="import-header">
          <h2>Import Shared Experience</h2>
          <button className="close-button" onClick={handleClose}>×</button>
        </div>

        <div className="import-content">
          {/* Step 1: Input */}
          {currentStep === 'input' && (
            <div className="import-input-step">
              <h3>Import Method</h3>
              
              <div className="method-selection">
                <label className="method-option">
                  <input
                    type="radio"
                    name="importMethod"
                    value="paste"
                    checked={importMethod === 'paste'}
                    onChange={(e) => setImportMethod(e.target.value as 'paste')}
                  />
                  <span>Paste Data</span>
                  <small>Copy and paste the shared experience data</small>
                </label>
                
                <label className="method-option">
                  <input
                    type="radio"
                    name="importMethod"
                    value="file"
                    checked={importMethod === 'file'}
                    onChange={(e) => setImportMethod(e.target.value as 'file')}
                  />
                  <span>Upload File</span>
                  <small>Select a file containing the shared experience</small>
                </label>
              </div>

              {importMethod === 'paste' && (
                <div className="paste-input">
                  <label htmlFor="import-data">Shared Experience Data</label>
                  <textarea
                    id="import-data"
                    value={importData}
                    onChange={(e) => setImportData(e.target.value)}
                    placeholder="Paste the shared experience JSON data here..."
                    rows={12}
                  />
                  
                  <div className="format-selection">
                    <label>Data Format:</label>
                    <select
                      value={importFormat.format}
                      onChange={(e) => setImportFormat({ format: e.target.value as any })}
                    >
                      <option value="json">JSON</option>
                      <option value="yaml">YAML</option>
                      <option value="binary">Binary</option>
                    </select>
                  </div>
                </div>
              )}

              {importMethod === 'file' && (
                <div className="file-input">
                  <label htmlFor="import-file">Select File</label>
                  <input
                    id="import-file"
                    type="file"
                    accept=".json,.yaml,.yml"
                    onChange={handleFileUpload}
                  />
                  
                  {importData && (
                    <div className="file-preview">
                      <h4>File Content Preview</h4>
                      <pre>{importData.substring(0, 300)}{importData.length > 300 ? '...' : ''}</pre>
                    </div>
                  )}
                </div>
              )}

              <div className="step-actions">
                <button
                  className="validate-button primary"
                  onClick={handleValidate}
                  disabled={!importData.trim() || isProcessing}
                >
                  {isProcessing ? 'Validating...' : 'Validate & Preview'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Validation */}
          {currentStep === 'validate' && validationResult && (
            <div className="validation-step">
              <h3>Import Validation</h3>

              <div
                className={`validation-result ${
                  validationResult.problems.length === 0 ? 'valid' : 'invalid'
                }`}
              >
                <div className="validation-header">
                  <span className="validation-icon">
                    {validationResult.problems.length === 0 ? '✅' : '❌'}
                  </span>
                  <h4>
                    {validationResult.problems.length === 0
                      ? 'Ready to import'
                      : 'This share cannot open here'}
                  </h4>
                </div>

                {validationResult.problems.length > 0 && (
                  <div className="validation-errors">
                    <h5>Problems:</h5>
                    <ul>
                      {validationResult.problems.map((problem, index) => (
                        <li key={index} className="error-item">{problem}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {validationResult.warnings.length > 0 && (
                  <div className="validation-warnings">
                    <h5>Notes:</h5>
                    <ul>
                      {validationResult.warnings.map((warning, index) => (
                        <li key={index} className="warning-item">{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {validationResult.shareable && (
                <div className="contract-preview">
                  <h4>Experience Preview</h4>
                  <div className="contract-details">
                    <div className="detail-row">
                      <strong>Title:</strong>
                      <span>{validationResult.shareable.metadata.title}</span>
                    </div>
                    <div className="detail-row">
                      <strong>Version:</strong>
                      <span>{validationResult.shareable.version}</span>
                    </div>
                    {validationResult.shareable.metadata.author && (
                      <div className="detail-row">
                        <strong>Author:</strong>
                        <span>{validationResult.shareable.metadata.author}</span>
                      </div>
                    )}
                    {validationResult.shareable.metadata.description && (
                      <div className="detail-row">
                        <strong>Description:</strong>
                        <span>{validationResult.shareable.metadata.description}</span>
                      </div>
                    )}
                    <div className="detail-row">
                      <strong>Created:</strong>
                      <span>{validationResult.shareable.metadata.createdAt.toLocaleDateString()}</span>
                    </div>
                    <div className="detail-row">
                      <strong>Shared:</strong>
                      <span>{validationResult.shareable.metadata.sharedAt.toLocaleDateString()}</span>
                    </div>
                    {(validationResult.shareable.metadata.tags ?? []).length > 0 && (
                      <div className="detail-row">
                        <strong>Tags:</strong>
                        <div className="tags">
                          {(validationResult.shareable.metadata.tags ?? []).map(tag => (
                            <span key={tag} className="tag">{tag}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {validationResult.shareable.checksum && (
                      <div className="detail-row">
                        <strong>Checksum:</strong>
                        <span className="checksum">{validationResult.shareable.checksum}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="step-actions">
                <button
                  className="back-button"
                  onClick={() => setCurrentStep('input')}
                  disabled={isProcessing}
                >
                  Back
                </button>
                <button
                  className="import-button primary"
                  onClick={handleImport}
                  disabled={
                    !validationResult.shareable ||
                    validationResult.problems.length > 0 ||
                    isProcessing
                  }
                >
                  {isProcessing ? 'Importing...' : 'Import Experience'}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Progress Indicator */}
        <div className="progress-indicator">
          <div className={`progress-step ${currentStep === 'input' ? 'active' : currentStep === 'validate' ? 'completed' : ''}`}>
            1. Input
          </div>
          <div className={`progress-step ${currentStep === 'validate' ? 'active' : ''}`}>
            2. Validate
          </div>
        </div>
      </div>
    </div>
  );
};