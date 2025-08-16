/**
 * JSON Editor Component - JSON editing with validation
 * Requirements: 5.1, 10.2, 10.3
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Blueprint } from '../../types/blueprint';
import { Contract } from '../../types/contract';

interface JsonEditorProps {
  value: Blueprint | Contract;
  onChange: (value: any) => void;
  readOnly?: boolean;
  schema: 'blueprint' | 'contract';
}

export const JsonEditor: React.FC<JsonEditorProps> = ({
  value,
  onChange,
  readOnly = false,
  schema
}) => {
  const [jsonText, setJsonText] = useState(JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [isValid, setIsValid] = useState(true);

  // Update JSON text when value prop changes
  useEffect(() => {
    setJsonText(JSON.stringify(value, null, 2));
  }, [value]);

  const handleTextChange = useCallback((newText: string) => {
    setJsonText(newText);
    
    try {
      const parsed = JSON.parse(newText);
      setParseError(null);
      setIsValid(true);
      
      // Validate the parsed object matches the expected schema
      const validationResult = validateSchema(parsed, schema);
      if (validationResult.isValid) {
        onChange(parsed);
      } else {
        setParseError(validationResult.error);
        setIsValid(false);
      }
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Invalid JSON');
      setIsValid(false);
    }
  }, [onChange, schema]);

  const formatJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const formatted = JSON.stringify(parsed, null, 2);
      setJsonText(formatted);
    } catch (error) {
      // If JSON is invalid, don't format
    }
  };

  const minifyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      const minified = JSON.stringify(parsed);
      setJsonText(minified);
    } catch (error) {
      // If JSON is invalid, don't minify
    }
  };

  return (
    <div className="json-editor">
      <div className="json-editor-header">
        <h4>JSON Editor ({schema})</h4>
        <div className="json-editor-controls">
          <button onClick={formatJson} disabled={!isValid || readOnly}>
            Format
          </button>
          <button onClick={minifyJson} disabled={!isValid || readOnly}>
            Minify
          </button>
          <div className={`json-status ${isValid ? 'valid' : 'invalid'}`}>
            {isValid ? '✓ Valid' : '✗ Invalid'}
          </div>
        </div>
      </div>

      <div className="json-editor-content">
        <textarea
          value={jsonText}
          onChange={(e) => handleTextChange(e.target.value)}
          readOnly={readOnly}
          className={`json-textarea ${!isValid ? 'error' : ''}`}
          spellCheck={false}
          rows={20}
        />
      </div>

      {parseError && (
        <div className="json-error">
          <strong>JSON Error:</strong> {parseError}
        </div>
      )}

      <div className="json-editor-help">
        <details>
          <summary>Schema Help</summary>
          <div className="schema-help">
            {schema === 'blueprint' ? (
              <BlueprintSchemaHelp />
            ) : (
              <ContractSchemaHelp />
            )}
          </div>
        </details>
      </div>
    </div>
  );
};

// Schema validation function
function validateSchema(obj: any, schema: 'blueprint' | 'contract'): { isValid: boolean; error?: string } {
  if (schema === 'blueprint') {
    return validateBlueprintSchema(obj);
  } else {
    return validateContractSchema(obj);
  }
}

function validateBlueprintSchema(obj: any): { isValid: boolean; error?: string } {
  if (typeof obj !== 'object' || obj === null) {
    return { isValid: false, error: 'Blueprint must be an object' };
  }

  const required = ['description', 'goal', 'requiredCapabilities', 'uiElements', 'operations', 'ambiguities'];
  for (const field of required) {
    if (!(field in obj)) {
      return { isValid: false, error: `Missing required field: ${field}` };
    }
  }

  if (typeof obj.description !== 'string') {
    return { isValid: false, error: 'description must be a string' };
  }

  if (typeof obj.goal !== 'string') {
    return { isValid: false, error: 'goal must be a string' };
  }

  if (!Array.isArray(obj.requiredCapabilities)) {
    return { isValid: false, error: 'requiredCapabilities must be an array' };
  }

  if (!Array.isArray(obj.uiElements)) {
    return { isValid: false, error: 'uiElements must be an array' };
  }

  if (!Array.isArray(obj.operations)) {
    return { isValid: false, error: 'operations must be an array' };
  }

  if (!Array.isArray(obj.ambiguities)) {
    return { isValid: false, error: 'ambiguities must be an array' };
  }

  return { isValid: true };
}

function validateContractSchema(obj: any): { isValid: boolean; error?: string } {
  if (typeof obj !== 'object' || obj === null) {
    return { isValid: false, error: 'Contract must be an object' };
  }

  const required = ['name', 'version', 'elements', 'operations'];
  for (const field of required) {
    if (!(field in obj)) {
      return { isValid: false, error: `Missing required field: ${field}` };
    }
  }

  if (typeof obj.name !== 'string') {
    return { isValid: false, error: 'name must be a string' };
  }

  if (typeof obj.version !== 'string') {
    return { isValid: false, error: 'version must be a string' };
  }

  if (!Array.isArray(obj.elements)) {
    return { isValid: false, error: 'elements must be an array' };
  }

  if (!Array.isArray(obj.operations)) {
    return { isValid: false, error: 'operations must be an array' };
  }

  return { isValid: true };
}

// Schema help components
const BlueprintSchemaHelp: React.FC = () => (
  <div className="blueprint-schema-help">
    <h5>Blueprint Schema</h5>
    <pre>{`{
  "description": "string - Natural language description",
  "goal": "string - Main goal of the experience",
  "requiredCapabilities": ["string"] - Array of capabilities,
  "uiElements": [
    {
      "type": "string - UI element type",
      "purpose": "string - Purpose description",
      "properties": {} - Optional properties object,
      "capabilities": ["string"] - Required capabilities
    }
  ],
  "operations": [
    {
      "name": "string - Operation name",
      "purpose": "string - Purpose description",
      "inputs": ["string"] - Input parameters,
      "outputs": ["string"] - Output parameters,
      "executionType": "remote|local|repository"
    }
  ],
  "ambiguities": [
    {
      "id": "string - Unique identifier",
      "description": "string - Ambiguity description",
      "options": ["string"] - Available options,
      "question": "string - Clarifying question"
    }
  ],
  "userModifications": [] - Optional user modifications
}`}</pre>
  </div>
);

const ContractSchemaHelp: React.FC = () => (
  <div className="contract-schema-help">
    <h5>Contract Schema</h5>
    <pre>{`{
  "name": "string - Contract name",
  "version": "string - Contract version",
  "elements": [
    {
      "id": "string - Unique element ID",
      "type": "string - Element type",
      "properties": {} - Element properties,
      "dataBindings": [] - Data binding configurations,
      "eventBindings": [] - Event binding configurations,
      "children": [] - Optional child elements
    }
  ],
  "operations": [
    {
      "id": "string - Unique operation ID",
      "operationName": "string - Operation name",
      "inputs": [] - Input bindings,
      "outputs": [] - Output bindings,
      "triggers": [] - Trigger specifications
    }
  ],
  "metadata": {} - Optional metadata
}`}</pre>
  </div>
);