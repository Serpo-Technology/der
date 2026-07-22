/**
 * Contract Editor Component - Contract editing with validation and error feedback
 * Requirements: 5.2, 5.5, 10.3, 10.7
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import './ContractEditor.css';
import { Contract } from '../../models/contract';
import { ValidationResult, UIElement, OperationBinding, ContractEdits } from '../../types/contract';
import { JsonEditor } from './JsonEditor';

interface ContractEditorProps {
  contract: Contract;
  onChange: (contract: Contract, edits: ContractEdits) => void;
  onValidationChange?: (validation: ValidationResult) => void;
  readOnly?: boolean;
  enableSelectiveRegeneration?: boolean;
  onRegenerateSection?: (sectionType: string, sectionId?: string) => void;
}

interface EditingSection {
  type: 'element' | 'operation' | 'layout' | 'styling' | 'metadata';
  id?: string;
  title: string;
}

export const ContractEditor: React.FC<ContractEditorProps> = ({
  contract,
  onChange,
  onValidationChange,
  readOnly = false,
  enableSelectiveRegeneration = false,
  onRegenerateSection
}) => {
  const [editingMode, setEditingMode] = useState<'visual' | 'json'>('visual');
  const [selectedSection, setSelectedSection] = useState<EditingSection | null>(null);
  const [validation, setValidation] = useState<ValidationResult>({ isValid: true, errors: [], warnings: [] });
  const [contractEdits, setContractEdits] = useState<ContractEdits>({
    elementEdits: {},
    operationEdits: {}
  });

  // Validate contract whenever it changes
  useEffect(() => {
    const validationResult = contract.validate();
    const referenceValidation = contract.validateReferences();
    
    const combinedValidation: ValidationResult = {
      isValid: validationResult.isValid && referenceValidation.isValid,
      errors: [...validationResult.errors, ...referenceValidation.errors],
      warnings: [...validationResult.warnings, ...referenceValidation.warnings]
    };

    setValidation(combinedValidation);
    onValidationChange?.(combinedValidation);
  }, [contract, onValidationChange]);

  // Available sections for editing. Elements nest, so the section list
  // flattens the tree with indentation showing containment.
  const editingSections: EditingSection[] = useMemo(() => {
    const elementSections: EditingSection[] = [];
    const collect = (elements: typeof contract.elements, depth: number) => {
      for (const element of elements) {
        elementSections.push({
          type: 'element' as const,
          id: element.id,
          title: `${'  '.repeat(depth)}Element: ${element.id} (${element.type})`
        });
        if (element.children?.length) collect(element.children, depth + 1);
      }
    };
    collect(contract.elements, 0);

    return [
      { type: 'metadata', title: 'Contract Metadata' },
      { type: 'layout', title: 'Layout Configuration' },
      { type: 'styling', title: 'Styling Configuration' },
      ...elementSections,
      ...contract.operations.map(operation => ({
        type: 'operation' as const,
        id: operation.id,
        title: `Operation: ${operation.id} (${operation.operationName})`
      }))
    ];
  }, [contract]);

  const handleContractChange = useCallback((newContract: Contract) => {
    onChange(newContract, contractEdits);
  }, [onChange, contractEdits]);

  const handleElementEdit = useCallback((elementId: string, updates: Partial<UIElement>) => {
    const updatedContract = contract.clone();
    updatedContract.updateElement(elementId, updates);
    
    const newEdits = {
      ...contractEdits,
      elementEdits: {
        ...contractEdits.elementEdits,
        [elementId]: { ...contractEdits.elementEdits[elementId], ...updates }
      }
    };
    
    setContractEdits(newEdits);
    onChange(updatedContract, newEdits);
  }, [contract, contractEdits, onChange]);

  const handleOperationEdit = useCallback((operationId: string, updates: Partial<OperationBinding>) => {
    const updatedContract = contract.clone();
    updatedContract.updateOperation(operationId, updates);
    
    const newEdits = {
      ...contractEdits,
      operationEdits: {
        ...contractEdits.operationEdits,
        [operationId]: { ...contractEdits.operationEdits[operationId], ...updates }
      }
    };
    
    setContractEdits(newEdits);
    onChange(updatedContract, newEdits);
  }, [contract, contractEdits, onChange]);

  const handleAddElement = useCallback(() => {
    const newElement: UIElement = {
      id: `element_${Date.now()}`,
      type: 'div',
      properties: {},
      dataBindings: [],
      eventBindings: []
    };

    const updatedContract = contract.clone();
    updatedContract.addElement(newElement);
    handleContractChange(updatedContract);
  }, [contract, handleContractChange]);

  const handleRemoveElement = useCallback((elementId: string) => {
    const updatedContract = contract.clone();
    updatedContract.removeElement(elementId);
    
    // Remove from edits tracking
    const newEdits = { ...contractEdits };
    delete newEdits.elementEdits[elementId];
    setContractEdits(newEdits);
    
    onChange(updatedContract, newEdits);
  }, [contract, contractEdits, onChange]);

  const handleAddOperation = useCallback(() => {
    const newOperation: OperationBinding = {
      id: `operation_${Date.now()}`,
      operationName: 'new_operation',
      inputs: [],
      outputs: [],
      triggers: []
    };

    const updatedContract = contract.clone();
    updatedContract.addOperation(newOperation);
    handleContractChange(updatedContract);
  }, [contract, handleContractChange]);

  const handleRemoveOperation = useCallback((operationId: string) => {
    const updatedContract = contract.clone();
    updatedContract.removeOperation(operationId);
    
    // Remove from edits tracking
    const newEdits = { ...contractEdits };
    delete newEdits.operationEdits[operationId];
    setContractEdits(newEdits);
    
    onChange(updatedContract, newEdits);
  }, [contract, contractEdits, onChange]);

  const handleRegenerateSection = useCallback((section: EditingSection) => {
    if (onRegenerateSection) {
      onRegenerateSection(section.type, section.id);
    }
  }, [onRegenerateSection]);

  if (editingMode === 'json') {
    return (
      <div className="contract-editor">
        <div className="contract-editor-header">
          <h3>Contract Editor</h3>
          <div className="editor-controls">
            <button 
              onClick={() => setEditingMode('visual')}
              className="mode-button"
            >
              Visual Editor
            </button>
            <button 
              onClick={() => setEditingMode('json')}
              className="mode-button active"
            >
              JSON Editor
            </button>
          </div>
        </div>

        <JsonEditor
          value={contract.toObject()}
          onChange={(value) => {
            try {
              const newContract = Contract.fromObject(value);
              handleContractChange(newContract);
            } catch (error) {
              console.error('Invalid contract JSON:', error);
            }
          }}
          readOnly={readOnly}
          schema="contract"
        />

        <ValidationDisplay validation={validation} />
      </div>
    );
  }

  return (
    <div className="contract-editor">
      <div className="contract-editor-header">
        <h3>Contract Editor</h3>
        <div className="editor-controls">
          <button 
            onClick={() => setEditingMode('visual')}
            className="mode-button active"
          >
            Visual Editor
          </button>
          <button 
            onClick={() => setEditingMode('json')}
            className="mode-button"
          >
            JSON Editor
          </button>
        </div>
      </div>

      <div className="contract-editor-content">
        <div className="contract-sidebar">
          <div className="contract-summary">
            <h4>Contract Summary</h4>
            <div className="summary-item">
              <strong>Name:</strong> {contract.name}
            </div>
            <div className="summary-item">
              <strong>Version:</strong> {contract.version}
            </div>
            <div className="summary-item">
              <strong>Elements:</strong> {contract.elements.length}
            </div>
            <div className="summary-item">
              <strong>Operations:</strong> {contract.operations.length}
            </div>
          </div>

          <div className="section-list">
            <h4>Sections</h4>
            {editingSections.map((section, _index) => (
              <div
                key={`${section.type}-${section.id || 'root'}`}
                className={`section-item ${selectedSection === section ? 'selected' : ''}`}
                onClick={() => setSelectedSection(section)}
              >
                <span className="section-title">{section.title}</span>
                {enableSelectiveRegeneration && !readOnly && (
                  <button
                    className="regenerate-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRegenerateSection(section);
                    }}
                    title="Regenerate this section"
                  >
                    🔄
                  </button>
                )}
              </div>
            ))}
          </div>

          {!readOnly && (
            <div className="add-controls">
              <button onClick={handleAddElement} className="add-button">
                + Add Element
              </button>
              <button onClick={handleAddOperation} className="add-button">
                + Add Operation
              </button>
            </div>
          )}
        </div>

        <div className="contract-main">
          {selectedSection ? (
            <SectionEditor
              section={selectedSection}
              contract={contract}
              onElementEdit={handleElementEdit}
              onOperationEdit={handleOperationEdit}
              onRemoveElement={handleRemoveElement}
              onRemoveOperation={handleRemoveOperation}
              readOnly={readOnly}
            />
          ) : (
            <div className="no-selection">
              <p>Select a section from the sidebar to edit</p>
            </div>
          )}
        </div>
      </div>

      <ValidationDisplay validation={validation} />
    </div>
  );
};

// Section Editor Component
interface SectionEditorProps {
  section: EditingSection;
  contract: Contract;
  onElementEdit: (elementId: string, updates: Partial<UIElement>) => void;
  onOperationEdit: (operationId: string, updates: Partial<OperationBinding>) => void;
  onRemoveElement: (elementId: string) => void;
  onRemoveOperation: (operationId: string) => void;
  readOnly: boolean;
}

const SectionEditor: React.FC<SectionEditorProps> = ({
  section,
  contract,
  onElementEdit,
  onOperationEdit,
  onRemoveElement,
  onRemoveOperation,
  readOnly
}) => {
  if (section.type === 'element' && section.id) {
    const element = contract.getElement(section.id);
    if (!element) return <div>Element not found</div>;

    return (
      <ElementEditor
        element={element}
        onEdit={(updates) => onElementEdit(section.id!, updates)}
        onRemove={() => onRemoveElement(section.id!)}
        readOnly={readOnly}
      />
    );
  }

  if (section.type === 'operation' && section.id) {
    const operation = contract.getOperation(section.id);
    if (!operation) return <div>Operation not found</div>;

    return (
      <OperationEditor
        operation={operation}
        onEdit={(updates) => onOperationEdit(section.id!, updates)}
        onRemove={() => onRemoveOperation(section.id!)}
        readOnly={readOnly}
      />
    );
  }

  if (section.type === 'metadata') {
    return <MetadataEditor contract={contract} readOnly={readOnly} />;
  }

  if (section.type === 'layout') {
    return <LayoutEditor contract={contract} readOnly={readOnly} />;
  }

  if (section.type === 'styling') {
    return <StylingEditor contract={contract} readOnly={readOnly} />;
  }

  return <div>Unknown section type</div>;
};

// Element Editor Component
interface ElementEditorProps {
  element: UIElement;
  onEdit: (updates: Partial<UIElement>) => void;
  onRemove: () => void;
  readOnly: boolean;
}

const ElementEditor: React.FC<ElementEditorProps> = ({
  element,
  onEdit,
  onRemove,
  readOnly
}) => {
  return (
    <div className="element-editor">
      <div className="element-header">
        <h4>Element: {element.id}</h4>
        {!readOnly && (
          <button onClick={onRemove} className="remove-button">
            Remove
          </button>
        )}
      </div>

      <div className="element-fields">
        <div className="field-group">
          <label>ID:</label>
          <input
            type="text"
            value={element.id}
            onChange={(e) => onEdit({ id: e.target.value })}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label>Type:</label>
          <input
            type="text"
            value={element.type}
            onChange={(e) => onEdit({ type: e.target.value })}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label htmlFor="element-properties">Properties:</label>
          <textarea
            id="element-properties"
            value={JSON.stringify(element.properties, null, 2)}
            onChange={(e) => {
              try {
                const properties = JSON.parse(e.target.value);
                onEdit({ properties });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>

        <div className="field-group">
          <label>Data Bindings:</label>
          <textarea
            value={JSON.stringify(element.dataBindings, null, 2)}
            onChange={(e) => {
              try {
                const dataBindings = JSON.parse(e.target.value);
                onEdit({ dataBindings });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>

        <div className="field-group">
          <label>Event Bindings:</label>
          <textarea
            value={JSON.stringify(element.eventBindings, null, 2)}
            onChange={(e) => {
              try {
                const eventBindings = JSON.parse(e.target.value);
                onEdit({ eventBindings });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>
      </div>
    </div>
  );
};

// Operation Editor Component
interface OperationEditorProps {
  operation: OperationBinding;
  onEdit: (updates: Partial<OperationBinding>) => void;
  onRemove: () => void;
  readOnly: boolean;
}

const OperationEditor: React.FC<OperationEditorProps> = ({
  operation,
  onEdit,
  onRemove,
  readOnly
}) => {
  return (
    <div className="operation-editor">
      <div className="operation-header">
        <h4>Operation: {operation.id}</h4>
        {!readOnly && (
          <button onClick={onRemove} className="remove-button">
            Remove
          </button>
        )}
      </div>

      <div className="operation-fields">
        <div className="field-group">
          <label>ID:</label>
          <input
            type="text"
            value={operation.id}
            onChange={(e) => onEdit({ id: e.target.value })}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label>Operation Name:</label>
          <input
            type="text"
            value={operation.operationName}
            onChange={(e) => onEdit({ operationName: e.target.value })}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label>Inputs:</label>
          <textarea
            value={JSON.stringify(operation.inputs, null, 2)}
            onChange={(e) => {
              try {
                const inputs = JSON.parse(e.target.value);
                onEdit({ inputs });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>

        <div className="field-group">
          <label>Outputs:</label>
          <textarea
            value={JSON.stringify(operation.outputs, null, 2)}
            onChange={(e) => {
              try {
                const outputs = JSON.parse(e.target.value);
                onEdit({ outputs });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>

        <div className="field-group">
          <label>Triggers:</label>
          <textarea
            value={JSON.stringify(operation.triggers, null, 2)}
            onChange={(e) => {
              try {
                const triggers = JSON.parse(e.target.value);
                onEdit({ triggers });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={5}
          />
        </div>
      </div>
    </div>
  );
};

// Metadata Editor Component
const MetadataEditor: React.FC<{ contract: Contract; readOnly: boolean }> = ({
  contract,
  readOnly
}) => {
  return (
    <div className="metadata-editor">
      <h4>Contract Metadata</h4>
      <div className="metadata-fields">
        <div className="field-group">
          <label htmlFor="contract-name">Name:</label>
          <input
            id="contract-name"
            type="text"
            value={contract.name}
            onChange={(e) => {
              contract.name = e.target.value;
              contract.updateMetadata({});
            }}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-version">Version:</label>
          <input
            id="contract-version"
            type="text"
            value={contract.version}
            onChange={(e) => {
              contract.version = e.target.value;
              contract.updateMetadata({});
            }}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-description">Description:</label>
          <textarea
            id="contract-description"
            value={contract.metadata.description || ''}
            onChange={(e) => {
              contract.updateMetadata({ description: e.target.value });
            }}
            readOnly={readOnly}
            rows={3}
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-author">Author:</label>
          <input
            id="contract-author"
            type="text"
            value={contract.metadata.author || ''}
            onChange={(e) => {
              contract.updateMetadata({ author: e.target.value });
            }}
            readOnly={readOnly}
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-tags">Tags:</label>
          <input
            id="contract-tags"
            type="text"
            value={contract.metadata.tags?.join(', ') || ''}
            onChange={(e) => {
              const tags = e.target.value.split(',').map(tag => tag.trim()).filter(Boolean);
              contract.updateMetadata({ tags });
            }}
            readOnly={readOnly}
            placeholder="tag1, tag2, tag3"
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-created">Created:</label>
          <input
            id="contract-created"
            type="text"
            value={contract.metadata.createdAt.toISOString()}
            readOnly
          />
        </div>

        <div className="field-group">
          <label htmlFor="contract-updated">Updated:</label>
          <input
            id="contract-updated"
            type="text"
            value={contract.metadata.updatedAt.toISOString()}
            readOnly
          />
        </div>
      </div>
    </div>
  );
};

// Layout Editor Component
const LayoutEditor: React.FC<{ contract: Contract; readOnly: boolean }> = ({
  contract,
  readOnly
}) => {
  return (
    <div className="layout-editor">
      <h4>Layout Configuration</h4>
      <div className="layout-fields">
        <div className="field-group">
          <label htmlFor="layout-type">Layout Type:</label>
          <select
            id="layout-type"
            value={contract.layout.type}
            onChange={(e) => {
              contract.updateLayout({
                ...contract.layout,
                type: e.target.value as 'grid' | 'flex' | 'absolute'
              });
            }}
            disabled={readOnly}
          >
            <option value="flex">Flex</option>
            <option value="grid">Grid</option>
            <option value="absolute">Absolute</option>
          </select>
        </div>

        <div className="field-group">
          <label htmlFor="layout-properties">Properties:</label>
          <textarea
            id="layout-properties"
            value={JSON.stringify(contract.layout.properties, null, 2)}
            onChange={(e) => {
              try {
                const properties = JSON.parse(e.target.value);
                contract.updateLayout({
                  ...contract.layout,
                  properties
                });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={8}
          />
        </div>
      </div>
    </div>
  );
};

// Styling Editor Component
const StylingEditor: React.FC<{ contract: Contract; readOnly: boolean }> = ({
  contract,
  readOnly
}) => {
  return (
    <div className="styling-editor">
      <h4>Styling Configuration</h4>
      <div className="styling-fields">
        <div className="field-group">
          <label htmlFor="theme-select">Theme:</label>
          <select
            id="theme-select"
            value={contract.styling.theme}
            onChange={(e) => {
              contract.updateStyling({
                ...contract.styling,
                theme: e.target.value
              });
            }}
            disabled={readOnly}
          >
            <option value="default">Default</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        <div className="field-group">
          <label htmlFor="custom-styles">Custom Styles:</label>
          <textarea
            id="custom-styles"
            value={JSON.stringify(contract.styling.customStyles || {}, null, 2)}
            onChange={(e) => {
              try {
                const customStyles = JSON.parse(e.target.value);
                contract.updateStyling({
                  ...contract.styling,
                  customStyles
                });
              } catch {
                // Invalid JSON, don't update
              }
            }}
            readOnly={readOnly}
            rows={8}
          />
        </div>
      </div>
    </div>
  );
};

// Validation Display Component
interface ValidationDisplayProps {
  validation: ValidationResult;
}

const ValidationDisplay: React.FC<ValidationDisplayProps> = ({ validation }) => {
  if (validation.isValid && validation.warnings.length === 0) {
    return (
      <div className="validation-display valid">
        <div className="validation-status">
          ✓ Contract is valid
        </div>
      </div>
    );
  }

  return (
    <div className="validation-display">
      <div className={`validation-status ${validation.isValid ? 'valid' : 'invalid'}`}>
        {validation.isValid ? '⚠ Valid with warnings' : '✗ Contract has errors'}
      </div>

      {validation.errors.length > 0 && (
        <div className="validation-errors">
          <h5>Errors:</h5>
          {validation.errors.map((error, index) => (
            <div key={index} className="validation-error">
              <strong>{error.path}:</strong> {error.message}
            </div>
          ))}
        </div>
      )}

      {validation.warnings.length > 0 && (
        <div className="validation-warnings">
          <h5>Warnings:</h5>
          {validation.warnings.map((warning, index) => (
            <div key={index} className="validation-warning">
              <strong>{warning.path}:</strong> {warning.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};