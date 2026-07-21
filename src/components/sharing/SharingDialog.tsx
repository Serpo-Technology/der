/**
 * Sharing Dialog Component - UI for sharing experiences
 * Requirements: 4.3, 4.4, 4.5
 */

import React, { useState, useCallback } from 'react';
import { ShareableContract, ExportFormat } from '../../types/persistence';
import { sharingService, ShareOptions } from '../../services/persistence';
import './SharingDialog.css';

interface SharingDialogProps {
  experienceId: string;
  experienceName: string;
  isOpen: boolean;
  onClose: () => void;
  onError?: (error: string) => void;
  onSuccess?: (message: string) => void;
}

export const SharingDialog: React.FC<SharingDialogProps> = ({
  experienceId,
  experienceName,
  isOpen,
  onClose,
  onError,
  onSuccess
}) => {
  const [shareOptions, setShareOptions] = useState<ShareOptions>({
    title: experienceName,
    description: '',
    author: '',
    tags: [],
    category: ''
  });
  const [exportFormat, setExportFormat] = useState<ExportFormat>({ format: 'json' });
  const [isProcessing, setIsProcessing] = useState(false);
  const [shareableContract, setShareableContract] = useState<ShareableContract | null>(null);
  const [exportedData, setExportedData] = useState<string>('');
  const [currentStep, setCurrentStep] = useState<'options' | 'export' | 'share'>('options');

  // Handle share options change
  const handleOptionsChange = useCallback((field: keyof ShareOptions, value: any) => {
    setShareOptions(prev => ({ ...prev, [field]: value }));
  }, []);

  // Handle tags input
  const handleTagsChange = useCallback((tagsString: string) => {
    const tags = tagsString.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0);
    setShareOptions(prev => ({ ...prev, tags }));
  }, []);

  // Generate shareable contract
  const handleGenerateContract = useCallback(async () => {
    setIsProcessing(true);
    try {
      const contract = await sharingService.createShareableContract(experienceId, shareOptions);
      setShareableContract(contract);
      setCurrentStep('export');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create shareable contract';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [experienceId, shareOptions, onError]);

  // Export for sharing
  const handleExport = useCallback(async () => {
    if (!shareableContract) return;

    setIsProcessing(true);
    try {
      const exported = await sharingService.exportForSharing(experienceId, exportFormat, shareOptions);
      setExportedData(exported);
      setCurrentStep('share');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to export experience';
      onError?.(errorMessage);
    } finally {
      setIsProcessing(false);
    }
  }, [experienceId, shareableContract, exportFormat, shareOptions, onError]);

  // Copy to clipboard
  const handleCopyToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(exportedData);
      onSuccess?.('Copied to clipboard!');
    } catch {
      onError?.('Failed to copy to clipboard');
    }
  }, [exportedData, onSuccess, onError]);

  // Download file
  const handleDownload = useCallback(() => {
    const blob = new Blob([exportedData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${shareOptions.title || experienceName}.${exportFormat.format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onSuccess?.('File downloaded successfully!');
  }, [exportedData, shareOptions.title, experienceName, exportFormat.format, onSuccess]);

  // Reset dialog
  const handleReset = useCallback(() => {
    setCurrentStep('options');
    setShareableContract(null);
    setExportedData('');
    setShareOptions({
      title: experienceName,
      description: '',
      author: '',
      tags: [],
      category: ''
    });
  }, [experienceName]);

  // Close dialog
  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  if (!isOpen) return null;

  return (
    <div className="sharing-dialog-overlay">
      <div className="sharing-dialog">
        <div className="sharing-header">
          <h2>Share Experience</h2>
          <button className="close-button" onClick={handleClose}>×</button>
        </div>

        <div className="sharing-content">
          {/* Step 1: Share Options */}
          {currentStep === 'options' && (
            <div className="share-options-step">
              <h3>Configure Sharing Options</h3>
              
              <div className="form-group">
                <label htmlFor="share-title">Title *</label>
                <input
                  id="share-title"
                  type="text"
                  value={shareOptions.title || ''}
                  onChange={(e) => handleOptionsChange('title', e.target.value)}
                  placeholder="Enter a title for the shared experience"
                  required
                />
              </div>

              <div className="form-group">
                <label htmlFor="share-description">Description</label>
                <textarea
                  id="share-description"
                  value={shareOptions.description || ''}
                  onChange={(e) => handleOptionsChange('description', e.target.value)}
                  placeholder="Describe what this experience does..."
                  rows={3}
                />
              </div>

              <div className="form-group">
                <label htmlFor="share-author">Author</label>
                <input
                  id="share-author"
                  type="text"
                  value={shareOptions.author || ''}
                  onChange={(e) => handleOptionsChange('author', e.target.value)}
                  placeholder="Your name or organization"
                />
              </div>

              <div className="form-group">
                <label htmlFor="share-tags">Tags</label>
                <input
                  id="share-tags"
                  type="text"
                  value={shareOptions.tags?.join(', ') || ''}
                  onChange={(e) => handleTagsChange(e.target.value)}
                  placeholder="Enter tags separated by commas (e.g., productivity, dashboard, demo)"
                />
                <small>Separate multiple tags with commas</small>
              </div>

              <div className="form-group">
                <label htmlFor="share-category">Category</label>
                <select
                  id="share-category"
                  value={shareOptions.category || ''}
                  onChange={(e) => handleOptionsChange('category', e.target.value)}
                >
                  <option value="">Select a category</option>
                  <option value="productivity">Productivity</option>
                  <option value="dashboard">Dashboard</option>
                  <option value="form">Form</option>
                  <option value="game">Game</option>
                  <option value="utility">Utility</option>
                  <option value="demo">Demo</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="step-actions">
                <button
                  className="generate-button primary"
                  onClick={handleGenerateContract}
                  disabled={!shareOptions.title || isProcessing}
                >
                  {isProcessing ? 'Generating...' : 'Generate Shareable Contract'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Export Options */}
          {currentStep === 'export' && shareableContract && (
            <div className="export-options-step">
              <h3>Export Format</h3>
              
              <div className="contract-info">
                <h4>Shareable Contract Generated</h4>
                <div className="contract-details">
                  <p><strong>Title:</strong> {shareableContract.metadata.title}</p>
                  <p><strong>Version:</strong> {shareableContract.version}</p>
                  <p><strong>Checksum:</strong> {shareableContract.checksum.substring(0, 8)}...</p>
                  {shareableContract.metadata.description && (
                    <p><strong>Description:</strong> {shareableContract.metadata.description}</p>
                  )}
                </div>
              </div>

              <div className="format-selection">
                <h4>Choose Export Format</h4>
                <div className="format-options">
                  <label className="format-option">
                    <input
                      type="radio"
                      name="format"
                      value="json"
                      checked={exportFormat.format === 'json'}
                      onChange={(e) => setExportFormat({ format: e.target.value as any })}
                    />
                    <span>JSON (Recommended)</span>
                    <small>Human-readable format, widely supported</small>
                  </label>
                  
                  <label className="format-option">
                    <input
                      type="radio"
                      name="format"
                      value="yaml"
                      checked={exportFormat.format === 'yaml'}
                      onChange={(e) => setExportFormat({ format: e.target.value as any })}
                    />
                    <span>YAML</span>
                    <small>More readable format for configuration</small>
                  </label>
                  
                  <label className="format-option">
                    <input
                      type="radio"
                      name="format"
                      value="binary"
                      checked={exportFormat.format === 'binary'}
                      onChange={(e) => setExportFormat({ format: e.target.value as any })}
                    />
                    <span>Binary</span>
                    <small>Compact format for large experiences</small>
                  </label>
                </div>
              </div>

              <div className="step-actions">
                <button
                  className="back-button"
                  onClick={() => setCurrentStep('options')}
                  disabled={isProcessing}
                >
                  Back
                </button>
                <button
                  className="export-button primary"
                  onClick={handleExport}
                  disabled={isProcessing}
                >
                  {isProcessing ? 'Exporting...' : 'Export Experience'}
                </button>
              </div>
            </div>
          )}

          {/* Step 3: Share */}
          {currentStep === 'share' && exportedData && (
            <div className="share-step">
              <h3>Share Your Experience</h3>
              
              <div className="export-preview">
                <h4>Exported Data</h4>
                <div className="export-data">
                  <pre>{exportedData.substring(0, 500)}{exportedData.length > 500 ? '...' : ''}</pre>
                </div>
                <div className="data-info">
                  <span>Format: {exportFormat.format.toUpperCase()}</span>
                  <span>Size: {new Blob([exportedData]).size} bytes</span>
                </div>
              </div>

              <div className="share-actions">
                <h4>Share Options</h4>
                <div className="action-buttons">
                  <button
                    className="copy-button"
                    onClick={handleCopyToClipboard}
                  >
                    📋 Copy to Clipboard
                  </button>
                  
                  <button
                    className="download-button"
                    onClick={handleDownload}
                  >
                    💾 Download File
                  </button>
                </div>
              </div>

              <div className="step-actions">
                <button
                  className="back-button"
                  onClick={() => setCurrentStep('export')}
                >
                  Back
                </button>
                <button
                  className="done-button primary"
                  onClick={handleClose}
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Progress Indicator */}
        <div className="progress-indicator">
          <div className={`progress-step ${currentStep === 'options' ? 'active' : (currentStep === 'export' || currentStep === 'share') ? 'completed' : ''}`}>
            1. Options
          </div>
          <div className={`progress-step ${currentStep === 'export' ? 'active' : currentStep === 'share' ? 'completed' : ''}`}>
            2. Export
          </div>
          <div className={`progress-step ${currentStep === 'share' ? 'active' : ''}`}>
            3. Share
          </div>
        </div>
      </div>
    </div>
  );
};