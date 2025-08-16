/**
 * Dynamic Experience Renderer - Core component for rendering contracts as React experiences
 * Requirements: 3.1, 3.2, 9.1
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Contract, UIElement, DataBinding, EventBinding } from '../../types/contract';
import { Experience, ExperienceState } from '../../types/experience';
import { ComponentRenderer } from './ComponentRenderer';
import { ExperienceStateManager } from './ExperienceStateManager';
import { OperationExecutor } from './OperationExecutor';

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

  const stateManager = useMemo(() => new ExperienceStateManager(experienceId), [experienceId]);
  const operationExecutor = useMemo(() => new OperationExecutor(), []);
  const componentRenderer = useMemo(() => new ComponentRenderer(stateManager, operationExecutor), [stateManager, operationExecutor]);

  // Initialize experience state
  useEffect(() => {
    const initializeState = async () => {
      try {
        const initialState = await stateManager.initializeState(contract);
        setExperienceState(initialState);
        onStateChange?.(initialState);
      } catch (error) {
        onError?.(error as Error);
      }
    };

    initializeState();
  }, [contract, stateManager, onStateChange, onError]);

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = stateManager.subscribeToStateChanges((newState) => {
      setExperienceState(newState);
      onStateChange?.(newState);
    });

    return unsubscribe;
  }, [stateManager, onStateChange]);

  // Handle operation execution
  const handleOperationExecution = useCallback(async (operationId: string, inputs: any[]) => {
    try {
      const operation = contract.operations.find(op => op.id === operationId);
      if (!operation) {
        throw new Error(`Operation ${operationId} not found in contract`);
      }

      stateManager.setLoading(operationId, true);
      const result = await operationExecutor.executeOperation(operation, inputs);
      
      // Update state with operation results
      stateManager.updateStateFromOperationResult(operationId, result, operation.outputs);
      
    } catch (error) {
      stateManager.setError(operationId, error as Error);
      onError?.(error as Error);
    } finally {
      stateManager.setLoading(operationId, false);
    }
  }, [contract.operations, stateManager, operationExecutor, onError]);

  // Render UI elements recursively
  const renderUIElements = useCallback((elements: UIElement[]): React.ReactNode => {
    return elements.map((element) => {
      const RenderedComponent = componentRenderer.renderUIElement(
        element,
        experienceState,
        handleOperationExecution
      );
      
      return (
        <React.Fragment key={element.id}>
          <RenderedComponent />
        </React.Fragment>
      );
    });
  }, [componentRenderer, experienceState, handleOperationExecution]);

  // Apply layout styling
  const layoutStyles = useMemo(() => {
    const { layout } = contract;
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
  }, [contract.layout]);

  return (
    <div 
      className="dynamic-experience-container"
      style={layoutStyles as React.CSSProperties}
      data-experience-id={experienceId}
      data-contract-name={contract.name}
      data-testid="dynamic-experience-container"
    >
      {renderUIElements(contract.elements)}
    </div>
  );
};

export default DynamicExperienceRenderer;