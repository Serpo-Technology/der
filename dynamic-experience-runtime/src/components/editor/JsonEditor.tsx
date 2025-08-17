/**
 * JSON Editor Component - JSON editing with validation
 * Requirements: 5.1, 10.2, 10.3
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Blueprint } from '../../types/blueprint';
import { Contract } from '../../types/contract';
import { validateSchema, BLUEPRINT_SCHEMA, CONTRACT_SCHEMA } from '../../utils/validation';

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
      const validationResult = validateAgainstSchema(parsed, schema);
      if (validationResult.isValid) {
        onChange(parsed);
      } else {
        setParseError(validationResult.error || 'Validation failed');
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
function validateAgainstSchema(obj: any, schema: 'blueprint' | 'contract'): { isValid: boolean; error?: string } {
  const schemaDef = schema === 'blueprint' ? BLUEPRINT_SCHEMA : CONTRACT_SCHEMA;
  const result = validateSchema(obj, schemaDef);
  if (!result.isValid) {
    const first = result.errors[0];
    const message = first ? `${first.path}: ${first.message}` : 'Validation failed';
    return { isValid: false, error: message };
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
  "layout": {} - Layout specification,
  "styling": {} - Styling specification,
  "metadata": {} - Metadata (required by schema)
}`}</pre>
  </div>
);