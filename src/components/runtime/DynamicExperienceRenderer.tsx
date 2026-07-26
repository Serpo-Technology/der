/**
 * Dynamic Experience Renderer - Core component for rendering contracts as React experiences
 * Requirements: 3.1, 3.2, 9.1
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import './experience.css';
import { Contract, UIElement } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { ComponentRenderer } from './ComponentRenderer';
import { ExperienceStateManager } from './ExperienceStateManager';
import { OperationExecutor, EventContext } from './OperationExecutor';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { normalizeContract } from '../../schemas/contract';
import { STYLE_ACCENTS, STYLE_THEMES } from '../../services/operations/registry';
import { backgroundVariables, hexAccentVariables, isHexAccent } from '../../services/operations/accent-color';
import { expandPackOperations } from '../../services/fragments/ui-fragments';

interface DynamicExperienceRendererProps {
  contract: Contract;
  experienceId: string;
  /** Previously saved state data, merged over the contract's seeds. */
  initialData?: Record<string, unknown>;
  onStateChange?: (state: ExperienceState) => void;
  onError?: (error: Error) => void;
}

export const DynamicExperienceRenderer: React.FC<DynamicExperienceRendererProps> = ({
  contract,
  experienceId,
  initialData,
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

  // Pack instances derive their shipped operations per render; the contract
  // itself keeps only the compact instance elements.
  const effectiveOperations = useMemo(
    () => [
      ...normalizedContract.operations,
      ...expandPackOperations(normalizedContract.elements ?? []).map((pack) => pack.operation)
    ],
    [normalizedContract]
  );

  const stateManager = useMemo(() => new ExperienceStateManager(experienceId), [experienceId]);
  const operationExecutor = useMemo(() => new OperationExecutor(), []);
  const componentRenderer = useMemo(() => new ComponentRenderer(), []);

  // Initialize experience state (saved per-app data overrides contract seeds)
  useEffect(() => {
    const initializeState = async () => {
      try {
        let initialState = await stateManager.initializeState(normalizedContract);
        if (initialData && Object.keys(initialData).length > 0) {
          initialState = {
            ...initialState,
            data: { ...initialState.data, ...initialData }
          };
          stateManager.updateState(initialState);
        }
        setExperienceState(initialState);
        onStateChange?.(initialState);
      } catch (error) {
        onError?.(error as Error);
      }
    };

    initializeState();
  }, [normalizedContract, stateManager, initialData, onStateChange, onError]);

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = stateManager.subscribeToStateChanges((newState) => {
      setExperienceState(newState);
      onStateChange?.(newState);
    });

    return unsubscribe;
  }, [stateManager, onStateChange]);

  // Handle operation execution
  const [operationError, setOperationError] = useState<string | null>(null);
  const dismissedErrorRef = React.useRef<string | null>(null);

  const handleOperationExecution = useCallback(
    async (operationId: string, eventContext: EventContext) => {
      try {
        const operation = effectiveOperations.find(op => op.id === operationId);
        if (!operation) {
          throw new Error(`Operation ${operationId} not found in contract`);
        }

        stateManager.setLoading(operationId, true);
        const result = await operationExecutor.executeOperation(operation, eventContext, stateManager);

        // Update state with operation results
        stateManager.updateStateFromOperationResult(operationId, result, operation.outputs);
        setOperationError(null);

      } catch (error) {
        stateManager.setError(operationId, error as Error);
        const message = error instanceof Error ? error.message : String(error);
        if (dismissedErrorRef.current !== message) {
          setOperationError(message);
        }
        onError?.(error as Error);
        // Callers running a chain of operations need the failure to stop the
        // rest; the error is already recorded and displayed above.
        throw error;
      } finally {
        stateManager.setLoading(operationId, false);
      }
    },
    [effectiveOperations, stateManager, operationExecutor, onError]
  );

  // Controlled inputs write their value here on every change
  const setElementValue = useCallback(
    (elementId: string, value: unknown) => {
      stateManager.setData(`element_${elementId}`, value);
    },
    [stateManager]
  );

  // Render UI elements recursively, containing render failures per element.
  // Elements render as direct JSX so component identity stays stable across
  // state updates (inputs keep focus while typing).
  const renderUIElements = useCallback((elements: UIElement[]): React.ReactNode => {
    return elements.map((element) => (
      <ErrorBoundary
        key={element.id}
        fallback={
          <div style={{ color: '#b91c1c', fontSize: '0.85rem' }}>
            Element "{element.id}" failed to render
          </div>
        }
      >
        {componentRenderer.renderElement(element, experienceState, handleOperationExecution, {
          setElementValue
        })}
      </ErrorBoundary>
    ));
  }, [componentRenderer, experienceState, handleOperationExecution, setElementValue]);

  // Apply layout styling; hand-made or partial contracts may omit layout.
  const layoutStyles = useMemo(() => {
    const layout = normalizedContract.layout ?? { type: 'flex' as const, properties: {} };
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

  // App-level look from the contract; unknown values fall back to default.
  const styling = (normalizedContract.styling ?? { theme: 'default' }) as {
    theme?: string;
    accent?: string;
    background?: string;
  };
  const theme = (STYLE_THEMES as readonly string[]).includes(styling.theme ?? '')
    ? styling.theme
    : 'default';
  const accent =
    styling.accent && (STYLE_ACCENTS as readonly string[]).includes(styling.accent)
      ? styling.accent
      : undefined;
  const hexAccent =
    !accent && styling.accent && isHexAccent(styling.accent) ? styling.accent : undefined;
  const hexBackground =
    styling.background && isHexAccent(styling.background) ? styling.background : undefined;
  const containerClassName = [
    'dynamic-experience-container',
    `der-theme-${theme}`,
    accent ? `der-accent-${accent}` : null
  ]
    .filter(Boolean)
    .join(' ');
  const containerStyles = {
    ...layoutStyles,
    ...(hexAccent ? hexAccentVariables(hexAccent) : undefined),
    ...(hexBackground ? backgroundVariables(hexBackground) : undefined),
  } as React.CSSProperties;

  return (
    <div
      className={containerClassName}
      style={containerStyles}
      data-experience-id={experienceId}
      data-contract-name={normalizedContract.name}
      data-testid="dynamic-experience-container"
    >
      {operationError && (
        <div className="der-operation-error" role="alert">
          <span>{operationError}</span>
          <button
            type="button"
            onClick={() => {
              dismissedErrorRef.current = operationError;
              setOperationError(null);
            }}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}
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
