/**
 * Blueprint Editor Component - Manual editing interface for blueprints
 * Requirements: 5.1, 10.2, 10.3
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Blueprint, UserModification } from '../../types/blueprint';
import { ValidationResult } from '../../types/contract';
import { BlueprintValidatorComponent, BlueprintValidator } from './BlueprintValidator';
import { BlueprintPreview } from './BlueprintPreview';
import { JsonEditor } from './JsonEditor';

interface BlueprintEditorProps {
  blueprint: Blueprint;
  onBlueprintChange: (blueprint: Blueprint) => void;
  onValidationChange: (validation: ValidationResult) => void;
  readOnly?: boolean;
}

export const BlueprintEditor: React.FC<BlueprintEditorProps> = ({
  blueprint,
  onBlueprintChange,
  onValidationChange,
  readOnly = false
}) => {
  const [editedBlueprint, setEditedBlueprint] = useState<Blueprint>(blueprint);
  const [validation, setValidation] = useState<ValidationResult>({ isValid: true, errors: [], warnings: [] });
  const [showPreview, setShowPreview] = useState(false);
  const [editMode, setEditMode] = useState<'form' | 'json'>('form');

  // Validate blueprint whenever it changes
  useEffect(() => {
    const validator = new BlueprintValidator();
    const result = validator.validate(editedBlueprint);
    setValidation(result);
    onValidationChange(result);
  }, [editedBlueprint, onValidationChange]);

  // Handle blueprint changes with user modification tracking
  const handleBlueprintChange = useCallback((newBlueprint: Blueprint, location: string) => {
    const userModification: UserModification = {
      location,
      originalValue: getValueAtLocation(blueprint, location),
      newValue: getValueAtLocation(newBlueprint, location),
      timestamp: new Date(),
      preserved: true
    };

    const updatedBlueprint = {
      ...newBlueprint,
      userModifications: [
        ...(newBlueprint.userModifications || []),
        userModification
      ]
    };

    setEditedBlueprint(updatedBlueprint);
    onBlueprintChange(updatedBlueprint);
  }, [blueprint, onBlueprintChange]);

  const handleDescriptionChange = (description: string) => {
    const newBlueprint = { ...editedBlueprint, description };
    handleBlueprintChange(newBlueprint, 'description');
  };

  const handleGoalChange = (goal: string) => {
    const newBlueprint = { ...editedBlueprint, goal };
    handleBlueprintChange(newBlueprint, 'goal');
  };

  const handleCapabilitiesChange = (capabilities: string[]) => {
    const newBlueprint = { ...editedBlueprint, requiredCapabilities: capabilities };
    handleBlueprintChange(newBlueprint, 'requiredCapabilities');
  };

  const handleJsonChange = (jsonBlueprint: Blueprint) => {
    handleBlueprintChange(jsonBlueprint, 'json-edit');
  };

  return (
    <div className="blueprint-editor">
      <div className="editor-header">
        <h2>Blueprint Editor</h2>
        <div className="editor-controls">
          <button
            onClick={() => setEditMode(editMode === 'form' ? 'json' : 'form')}
            className="mode-toggle"
          >
            {editMode === 'form' ? 'JSON Mode' : 'Form Mode'}
          </button>
          <button
            onClick={() => setShowPreview(!showPreview)}
            className="preview-toggle"
          >
            {showPreview ? 'Hide Preview' : 'Show Preview'}
          </button>
        </div>
      </div>

      <div className="editor-content">
        {editMode === 'form' ? (
          <BlueprintFormEditor
            blueprint={editedBlueprint}
            onDescriptionChange={handleDescriptionChange}
            onGoalChange={handleGoalChange}
            onCapabilitiesChange={handleCapabilitiesChange}
            readOnly={readOnly}
          />
        ) : (
          <JsonEditor
            value={editedBlueprint}
            onChange={handleJsonChange}
            readOnly={readOnly}
            schema="blueprint"
          />
        )}

        {showPreview && (
          <div className="preview-panel">
            <BlueprintPreview blueprint={editedBlueprint} />
          </div>
        )}
      </div>

      <BlueprintValidatorComponent
        blueprint={editedBlueprint}
        validation={validation}
      />
    </div>
  );
};

// Helper function to get value at a specific location in the blueprint
function getValueAtLocation(blueprint: Blueprint, location: string): any {
  const parts = location.split('.');
  let current: any = blueprint;
  
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  
  return current;
}

// Form-based editor component
interface BlueprintFormEditorProps {
  blueprint: Blueprint;
  onDescriptionChange: (description: string) => void;
  onGoalChange: (goal: string) => void;
  onCapabilitiesChange: (capabilities: string[]) => void;
  readOnly: boolean;
}

const BlueprintFormEditor: React.FC<BlueprintFormEditorProps> = ({
  blueprint,
  onDescriptionChange,
  onGoalChange,
  onCapabilitiesChange,
  readOnly
}) => {
  const [capabilityInput, setCapabilityInput] = useState('');

  const addCapability = () => {
    if (capabilityInput.trim() && !blueprint.requiredCapabilities.includes(capabilityInput.trim())) {
      onCapabilitiesChange([...blueprint.requiredCapabilities, capabilityInput.trim()]);
      setCapabilityInput('');
    }
  };

  const removeCapability = (capability: string) => {
    onCapabilitiesChange(blueprint.requiredCapabilities.filter(c => c !== capability));
  };

  return (
    <div className="blueprint-form-editor">
      <div className="form-section">
        <label htmlFor="description">Description</label>
        <textarea
          id="description"
          value={blueprint.description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Describe what you want to build..."
          readOnly={readOnly}
          rows={4}
        />
      </div>

      <div className="form-section">
        <label htmlFor="goal">Goal</label>
        <input
          id="goal"
          type="text"
          value={blueprint.goal}
          onChange={(e) => onGoalChange(e.target.value)}
          placeholder="What is the main goal of this experience?"
          readOnly={readOnly}
        />
      </div>

      <div className="form-section">
        <label>Required Capabilities</label>
        <div className="capabilities-list">
          {blueprint.requiredCapabilities.map((capability, index) => (
            <div key={index} className="capability-item">
              <span>{capability}</span>
              {!readOnly && (
                <button onClick={() => removeCapability(capability)}>×</button>
              )}
            </div>
          ))}
        </div>
        {!readOnly && (
          <div className="add-capability">
            <input
              type="text"
              value={capabilityInput}
              onChange={(e) => setCapabilityInput(e.target.value)}
              placeholder="Add capability..."
              onKeyPress={(e) => e.key === 'Enter' && addCapability()}
            />
            <button onClick={addCapability}>Add</button>
          </div>
        )}
      </div>
    </div>
  );
};