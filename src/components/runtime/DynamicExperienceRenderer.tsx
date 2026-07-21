/**
 * Dynamic Experience Renderer - Core component for rendering contracts as React experiences
 * Requirements: 3.1, 3.2, 9.1
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Contract, UIElement } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { ComponentRenderer } from './ComponentRenderer';
import { ExperienceStateManager } from './ExperienceStateManager';
import { OperationExecutor, EventContext } from './OperationExecutor';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { normalizeContract } from '../../schemas/contract';

interface DynamicExperienceRendererProps {
  contract: Contract;
  experienceId: string;
  onStateChange?: (state: ExperienceState) => void;
  onError?: (error: Error) => void;
}

export const DynamicExperienceRenderer: React.FC<DynamicExperienceRendererProps> = ({
  contract,
  experienceId,
  onStateChange,
  onError
}) => {
  const [experienceState, setExperienceState] = useState<ExperienceState>({
    data: {},
    loading: {},
    errors: {},
    lastUpdated: new Date()
  });

  // Convert legacy trigger wiring into event bindings before anything runs.
  const normalizedContract = useMemo(() => normalizeContract(contract), [contract]);

  const stateManager = useMemo(() => new ExperienceStateManager(experienceId), [experienceId]);
  const operationExecutor = useMemo(() => new OperationExecutor(), []);
  const componentRenderer = useMemo(() => new ComponentRenderer(), []);

  // Initialize experience state
  useEffect(() => {
    const initializeState = async () => {
      try {
        const initialState = await stateManager.initializeState(normalizedContract);
        setExperienceState(initialState);
        onStateChange?.(initialState);
      } catch (error) {
        onError?.(error as Error);
      }
    };

    initializeState();
  }, [normalizedContract, stateManager, onStateChange, onError]);

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = stateManager.subscribeToStateChanges((newState) => {
      setExperienceState(newState);
      onStateChange?.(newState);
    });

    return unsubscribe;
  }, [stateManager, onStateChange]);

  // Handle operation execution
  const handleOperationExecution = useCallback(
    async (operationId: string, eventContext: EventContext) => {
      try {
        const operation = normalizedContract.operations.find(op => op.id === operationId);
        if (!operation) {
          throw new Error(`Operation ${operationId} not found in contract`);
        }

        stateManager.setLoading(operationId, true);
        const result = await operationExecutor.executeOperation(operation, eventContext, stateManager);

        // Update state with operation results
        stateManager.updateStateFromOperationResult(operationId, result, operation.outputs);

      } catch (error) {
        stateManager.setError(operationId, error as Error);
        onError?.(error as Error);
      } finally {
        stateManager.setLoading(operationId, false);
      }
    },
    [normalizedContract.operations, stateManager, operationExecutor, onError]
  );

  // Controlled inputs write their value here on every change
  const setElementValue = useCallback(
    (elementId: string, value: unknown) => {
      stateManager.setData(`element_${elementId}`, value);
    },
    [stateManager]
  );

  // Render UI elements recursively, containing render failures per element
  const renderUIElements = useCallback((elements: UIElement[]): React.ReactNode => {
    return elements.map((element) => {
      const RenderedComponent = componentRenderer.renderUIElement(
        element,
        experienceState,
        handleOperationExecution,
        { setElementValue }
      );

      return (
        <ErrorBoundary
          key={element.id}
          fallback={
            <div style={{ color: '#b91c1c', fontSize: '0.85rem' }}>
              Element "{element.id}" failed to render
            </div>
          }
        >
          <RenderedComponent />
        </ErrorBoundary>
      );
    });
  }, [componentRenderer, experienceState, handleOperationExecution, setElementValue]);

  // Apply layout styling
  const layoutStyles = useMemo(() => {
    const { layout } = normalizedContract;
    const baseStyles: React.CSSProperties = {
      width: '100%',
      height: '100%'
    };

    switch (layout.type) {
      case 'grid':
        return {
          ...baseStyles,
          display: 'grid',
          ...layout.properties
        };
      case 'flex':
        return {
          ...baseStyles,
          display: 'flex',
          ...layout.properties
        };
      case 'absolute':
        return {
          ...baseStyles,
          position: 'relative',
          ...layout.properties
        };
      default:
        return baseStyles;
    }
  }, [normalizedContract]);

  return (
    <div
      className="dynamic-experience-container"
      style={layoutStyles as React.CSSProperties}
      data-experience-id={experienceId}
      data-contract-name={normalizedContract.name}
      data-testid="dynamic-experience-container"
    >
      <ErrorBoundary
        fallback={<div style={{ color: '#b91c1c' }}>This experience failed to render.</div>}
      >
        {(!normalizedContract.elements || normalizedContract.elements.length === 0) ? (
          <div style={{ color: '#6c757d', fontStyle: 'italic' }}>No elements to render</div>
        ) : (
          renderUIElements(normalizedContract.elements)
        )}
      </ErrorBoundary>
    </div>
  );
};

export default DynamicExperienceRenderer;
