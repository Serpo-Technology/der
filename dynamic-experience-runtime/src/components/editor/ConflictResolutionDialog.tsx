/**
 * Conflict Resolution Dialog - UI for resolving editing conflicts
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

import React, { useState, useCallback } from 'react';
import './ConflictResolutionDialog.css';
import { EditingConflict, Resolution, ResolutionOption } from '../../interfaces/experience-editor';

interface ConflictResolutionDialogProps {
  conflicts: EditingConflict[];
  onResolve: (resolutions: Resolution[]) => void;
  onCancel: () => void;
  isOpen: boolean;
}

export const ConflictResolutionDialog: React.FC<ConflictResolutionDialogProps> = ({
  conflicts,
  onResolve,
  onCancel,
  isOpen
}) => {
  const [resolutions, setResolutions] = useState<Map<string, Resolution>>(new Map());
  const [customValues, setCustomValues] = useState<Map<string, any>>(new Map());

  const handleOptionSelect = useCallback((conflictLocation: string, optionId: string) => {
    const newResolutions = new Map(resolutions);
    newResolutions.set(conflictLocation, {
      conflictId: conflictLocation,
      selectedOption: optionId
    });
    setResolutions(newResolutions);
  }, [resolutions]);

  const handleCustomValueChange = useCallback((conflictLocation: string, value: string) => {
    const newCustomValues = new Map(customValues);
    try {
      const parsedValue = JSON.parse(value);
      newCustomValues.set(conflictLocation, parsedValue);
    } catch {
      // If not valid JSON, store as string
      newCustomValues.set(conflictLocation, value);
    }
    setCustomValues(newCustomValues);
  }, [customValues]);

  const handleResolveAll = useCallback(() => {
    const allResolutions: Resolution[] = [];
    
    conflicts.forEach(conflict => {
      const resolution = resolutions.get(conflict.location);
      if (resolution) {
        if (resolution.selectedOption === 'custom') {
          resolution.customValue = customValues.get(conflict.location);
        }
        allResolutions.push(resolution);
      } else {
        // Default to keeping user edits
        allResolutions.push({
          conflictId: conflict.location,
          selectedOption: 'keep-user'
        });
      }
    });

    onResolve(allResolutions);
  }, [conflicts, resolutions, customValues, onResolve]);

  const getConflictTypeIcon = (type: EditingConflict['type']): string => {
    switch (type) {
      case 'ai-user-conflict':
        return '⚡';
      case 'dependency-conflict':
        return '🔗';
      case 'validation-conflict':
        return '⚠️';
      default:
        return '❓';
    }
  };

  const getConflictTypeDescription = (type: EditingConflict['type']): string => {
    switch (type) {
      case 'ai-user-conflict':
        return 'AI suggestion conflicts with your changes';
      case 'dependency-conflict':
        return 'Changes create dependency issues';
      case 'validation-conflict':
        return 'Changes cause validation errors';
      default:
        return 'Unknown conflict type';
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="conflict-resolution-overlay">
      <div className="conflict-resolution-dialog">
        <div className="dialog-header">
          <h2>Resolve Editing Conflicts</h2>
          <p>
            {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} found. 
            Please choose how to resolve each one.
          </p>
        </div>

        <div className="conflicts-list">
          {conflicts.map((conflict, index) => (
            <ConflictItem
              key={conflict.location}
              conflict={conflict}
              index={index}
              resolution={resolutions.get(conflict.location)}
              customValue={customValues.get(conflict.location)}
              onOptionSelect={handleOptionSelect}
              onCustomValueChange={handleCustomValueChange}
              getConflictTypeIcon={getConflictTypeIcon}
              getConflictTypeDescription={getConflictTypeDescription}
            />
          ))}
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel} className="cancel-button">
            Cancel
          </button>
          <button onClick={handleResolveAll} className="resolve-button">
            Resolve All Conflicts
          </button>
        </div>
      </div>
    </div>
  );
};

interface ConflictItemProps {
  conflict: EditingConflict;
  index: number;
  resolution?: Resolution;
  customValue?: any;
  onOptionSelect: (conflictLocation: string, optionId: string) => void;
  onCustomValueChange: (conflictLocation: string, value: string) => void;
  getConflictTypeIcon: (type: EditingConflict['type']) => string;
  getConflictTypeDescription: (type: EditingConflict['type']) => string;
}

const ConflictItem: React.FC<ConflictItemProps> = ({
  conflict,
  index,
  resolution,
  customValue,
  onOptionSelect,
  onCustomValueChange,
  getConflictTypeIcon,
  getConflictTypeDescription
}) => {
  const [showPreview, setShowPreview] = useState(false);

  return (
    <div className="conflict-item">
      <div className="conflict-header">
        <div className="conflict-info">
          <span className="conflict-icon">
            {getConflictTypeIcon(conflict.type)}
          </span>
          <div className="conflict-details">
            <h4>Conflict #{index + 1}: {conflict.location}</h4>
            <p className="conflict-description">
              {getConflictTypeDescription(conflict.type)}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowPreview(!showPreview)}
          className="preview-toggle"
        >
          {showPreview ? 'Hide' : 'Show'} Details
        </button>
      </div>

      {showPreview && (
        <div className="conflict-preview">
          <div className="value-comparison">
            <div className="ai-value">
              <h5>AI Suggestion:</h5>
              <pre>{JSON.stringify(conflict.aiSuggestion, null, 2)}</pre>
            </div>
            <div className="user-value">
              <h5>Your Changes:</h5>
              <pre>{JSON.stringify(conflict.userEdit, null, 2)}</pre>
            </div>
          </div>
        </div>
      )}

      <div className="resolution-options">
        <h5>Choose Resolution:</h5>
        {conflict.resolutionOptions.map(option => (
          <ResolutionOption
            key={option.id}
            option={option}
            conflict={conflict}
            isSelected={resolution?.selectedOption === option.id}
            onSelect={() => onOptionSelect(conflict.location, option.id)}
            customValue={customValue}
            onCustomValueChange={(value) => onCustomValueChange(conflict.location, value)}
          />
        ))}
      </div>
    </div>
  );
};

interface ResolutionOptionProps {
  option: ResolutionOption;
  conflict: EditingConflict;
  isSelected: boolean;
  onSelect: () => void;
  customValue?: any;
  onCustomValueChange: (value: string) => void;
}

const ResolutionOption: React.FC<ResolutionOptionProps> = ({
  option,
  conflict,
  isSelected,
  onSelect,
  customValue,
  onCustomValueChange
}) => {
  return (
    <div className={`resolution-option ${isSelected ? 'selected' : ''}`}>
      <label className="option-label">
        <input
          type="radio"
          name={`conflict-${conflict.location}`}
          checked={isSelected}
          onChange={onSelect}
        />
        <span className="option-text">{option.description}</span>
      </label>

      {option.preview && (
        <div className="option-preview">
          <strong>Preview:</strong>
          <pre>{JSON.stringify(option.preview, null, 2)}</pre>
        </div>
      )}

      {option.action === 'custom' && isSelected && (
        <div className="custom-value-input">
          <label>Custom Value:</label>
          <textarea
            value={customValue ? JSON.stringify(customValue, null, 2) : ''}
            onChange={(e) => onCustomValueChange(e.target.value)}
            placeholder="Enter custom value (JSON format)"
            rows={4}
          />
        </div>
      )}
    </div>
  );
};