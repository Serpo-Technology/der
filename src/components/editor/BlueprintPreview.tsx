/**
 * Blueprint Preview Component - Real-time preview of blueprint changes
 * Requirements: 5.1, 10.2, 10.3
 */

import React from 'react';
import { Blueprint } from '../../types/blueprint';

interface BlueprintPreviewProps {
  blueprint: Blueprint;
}

export const BlueprintPreview: React.FC<BlueprintPreviewProps> = ({ blueprint }) => {
  return (
    <div className="blueprint-preview">
      <h3>Blueprint Preview</h3>
      
      <div className="preview-section">
        <h4>Overview</h4>
        <div className="preview-content">
          <p><strong>Goal:</strong> {blueprint.goal || 'Not specified'}</p>
          <p><strong>Description:</strong> {blueprint.description || 'Not specified'}</p>
        </div>
      </div>

      <div className="preview-section">
        <h4>Required Capabilities ({blueprint.requiredCapabilities.length})</h4>
        <div className="preview-content">
          {blueprint.requiredCapabilities.length > 0 ? (
            <ul className="capabilities-preview">
              {blueprint.requiredCapabilities.map((capability, index) => (
                <li key={index} className="capability-preview-item">
                  {capability}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-state">No capabilities specified</p>
          )}
        </div>
      </div>

      <div className="preview-section">
        <h4>UI Elements ({blueprint.uiElements.length})</h4>
        <div className="preview-content">
          {blueprint.uiElements.length > 0 ? (
            <div className="ui-elements-preview">
              {blueprint.uiElements.map((element, index) => (
                <div key={index} className="ui-element-preview">
                  <div className="element-header">
                    <span className="element-type">{element.type}</span>
                    <span className="element-purpose">{element.purpose}</span>
                  </div>
                  {element.capabilities.length > 0 && (
                    <div className="element-capabilities">
                      <strong>Capabilities:</strong> {element.capabilities.join(', ')}
                    </div>
                  )}
                  {element.properties && Object.keys(element.properties).length > 0 && (
                    <div className="element-properties">
                      <strong>Properties:</strong>
                      <pre>{JSON.stringify(element.properties, null, 2)}</pre>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">No UI elements specified</p>
          )}
        </div>
      </div>

      <div className="preview-section">
        <h4>Operations ({blueprint.operations.length})</h4>
        <div className="preview-content">
          {blueprint.operations.length > 0 ? (
            <div className="operations-preview">
              {blueprint.operations.map((operation, index) => (
                <div key={index} className="operation-preview">
                  <div className="operation-header">
                    <span className="operation-name">{operation.name}</span>
                    <span className="operation-type">{operation.executionType}</span>
                  </div>
                  <div className="operation-purpose">{operation.purpose}</div>
                  <div className="operation-io">
                    <div className="operation-inputs">
                      <strong>Inputs:</strong> {operation.inputs.length > 0 ? operation.inputs.join(', ') : 'None'}
                    </div>
                    <div className="operation-outputs">
                      <strong>Outputs:</strong> {operation.outputs.length > 0 ? operation.outputs.join(', ') : 'None'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">No operations specified</p>
          )}
        </div>
      </div>

      {blueprint.ambiguities.length > 0 && (
        <div className="preview-section">
          <h4>Ambiguities ({blueprint.ambiguities.length})</h4>
          <div className="preview-content">
            <div className="ambiguities-preview">
              {blueprint.ambiguities.map((ambiguity, index) => (
                <div key={index} className="ambiguity-preview">
                  <div className="ambiguity-question">{ambiguity.question}</div>
                  <div className="ambiguity-description">{ambiguity.description}</div>
                  {ambiguity.options.length > 0 && (
                    <div className="ambiguity-options">
                      <strong>Options:</strong>
                      <ul>
                        {ambiguity.options.map((option, optionIndex) => (
                          <li key={optionIndex}>{option}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {blueprint.userModifications && blueprint.userModifications.length > 0 && (
        <div className="preview-section">
          <h4>User Modifications ({blueprint.userModifications.length})</h4>
          <div className="preview-content">
            <div className="modifications-preview">
              {blueprint.userModifications.map((modification, index) => (
                <div key={index} className="modification-preview">
                  <div className="modification-location">
                    <strong>Location:</strong> {modification.location}
                  </div>
                  <div className="modification-timestamp">
                    <strong>Modified:</strong> {modification.timestamp.toLocaleString()}
                  </div>
                  <div className="modification-preserved">
                    <strong>Preserved:</strong> {modification.preserved ? 'Yes' : 'No'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="preview-summary">
        <h4>Summary</h4>
        <div className="summary-stats">
          <div className="stat">
            <span className="stat-value">{blueprint.requiredCapabilities.length}</span>
            <span className="stat-label">Capabilities</span>
          </div>
          <div className="stat">
            <span className="stat-value">{blueprint.uiElements.length}</span>
            <span className="stat-label">UI Elements</span>
          </div>
          <div className="stat">
            <span className="stat-value">{blueprint.operations.length}</span>
            <span className="stat-label">Operations</span>
          </div>
          <div className="stat">
            <span className="stat-value">{blueprint.ambiguities.length}</span>
            <span className="stat-label">Ambiguities</span>
          </div>
        </div>
      </div>
    </div>
  );
};