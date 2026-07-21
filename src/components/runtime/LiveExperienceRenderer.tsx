/**
 * Live Experience Renderer - DynamicExperienceRenderer with real-time update capabilities
 * Requirements: 3.5, 9.2, 9.3, 9.4
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Contract } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { DynamicExperienceRenderer } from './DynamicExperienceRenderer';
import { useRealTimeUpdater, UpdateStrategy, RealTimeUpdateOptions } from './RealTimeUpdater';
import { dynamicExperienceRuntimeService } from './DynamicExperienceRuntimeService';

interface LiveExperienceRendererProps {
  initialContract: Contract;
  experienceId: string;
  enableRealTimeUpdates?: boolean;
  updateOptions?: RealTimeUpdateOptions;
  onContractUpdate?: (contract: Contract) => void;
  onUpdateStart?: (strategy: UpdateStrategy) => void;
  onUpdateComplete?: (strategy: UpdateStrategy, success: boolean) => void;
  onUpdateError?: (error: Error, strategy: UpdateStrategy) => void;
  onStateChange?: (state: ExperienceState) => void;
  onError?: (error: Error) => void;
}

export const LiveExperienceRenderer: React.FC<LiveExperienceRendererProps> = ({
  initialContract,
  experienceId,
  enableRealTimeUpdates = true,
  updateOptions = {},
  onContractUpdate,
  onUpdateStart,
  onUpdateComplete,
  onUpdateError,
  onStateChange,
  onError
}) => {
  const [currentContract, setCurrentContract] = useState<Contract>(initialContract);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateStrategy, setUpdateStrategy] = useState<UpdateStrategy | null>(null);
  const [renderKey, setRenderKey] = useState(0);

  // Real-time updater with callbacks
  const realTimeOptions: RealTimeUpdateOptions = {
    ...updateOptions,
    onUpdateStart: (strategy) => {
      setIsUpdating(true);
      setUpdateStrategy(strategy);
      onUpdateStart?.(strategy);
    },
    onUpdateComplete: (strategy, success) => {
      setIsUpdating(false);
      setUpdateStrategy(null);
      
      // Force re-render for full rerenders
      if (strategy.type === 'full-rerender' && success) {
        setRenderKey(prev => prev + 1);
      }
      
      onUpdateComplete?.(strategy, success);
    },
    onUpdateError: (error, strategy) => {
      setIsUpdating(false);
      setUpdateStrategy(null);
      onUpdateError?.(error, strategy);
    }
  };

  const { updateContract, clearQueue } = useRealTimeUpdater(
    dynamicExperienceRuntimeService,
    realTimeOptions
  );

  // Handle contract updates
  const handleContractUpdate = useCallback(async (
    newContract: Contract, 
    priority: 'low' | 'medium' | 'high' = 'medium'
  ) => {
    if (!enableRealTimeUpdates) {
      // Direct update without real-time processing
      setCurrentContract(newContract);
      setRenderKey(prev => prev + 1);
      onContractUpdate?.(newContract);
      return;
    }

    try {
      await updateContract(experienceId, newContract, priority);
      setCurrentContract(newContract);
      onContractUpdate?.(newContract);
    } catch (error) {
      console.error('Failed to update contract:', error);
      onError?.(error as Error);
    }
  }, [experienceId, enableRealTimeUpdates, updateContract, onContractUpdate, onError]);

  // Expose update method via ref
  const updateRef = useRef(handleContractUpdate);
  updateRef.current = handleContractUpdate;

  // Handle external contract changes
  useEffect(() => {
    if (initialContract !== currentContract) {
      handleContractUpdate(initialContract);
    }
  }, [initialContract, currentContract, handleContractUpdate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearQueue();
    };
  }, [clearQueue]);

  // Enhanced state change handler
  const handleStateChange = useCallback((state: ExperienceState) => {
    onStateChange?.(state);
  }, [onStateChange]);

  // Enhanced error handler
  const handleError = useCallback((error: Error) => {
    console.error('Experience error:', error);
    onError?.(error);
  }, [onError]);

  return (
    <div className="live-experience-renderer">
      {/* Update status indicator */}
      {isUpdating && (
        <div className="update-indicator" style={{
          position: 'absolute',
          top: 0,
          right: 0,
          background: 'rgba(0, 123, 255, 0.8)',
          color: 'white',
          padding: '4px 8px',
          fontSize: '12px',
          borderRadius: '0 0 0 4px',
          zIndex: 1000
        }}>
          Updating ({updateStrategy?.type})...
        </div>
      )}

      {/* Main experience renderer */}
      <DynamicExperienceRenderer
        key={renderKey}
        contract={currentContract}
        experienceId={experienceId}
        onStateChange={handleStateChange}
        onError={handleError}
      />
    </div>
  );
};

// Hook for external contract updates
export function useLiveExperienceUpdater(_experienceId: string) {
  const rendererRef = useRef<{ updateContract: (contract: Contract, priority?: 'low' | 'medium' | 'high') => Promise<void> } | null>(null);

  const updateContract = useCallback(async (
    contract: Contract, 
    priority: 'low' | 'medium' | 'high' = 'medium'
  ) => {
    if (rendererRef.current) {
      await rendererRef.current.updateContract(contract, priority);
    }
  }, []);

  const registerRenderer = useCallback((updateFn: (contract: Contract, priority?: 'low' | 'medium' | 'high') => Promise<void>) => {
    rendererRef.current = { updateContract: updateFn };
  }, []);

  return {
    updateContract,
    registerRenderer
  };
}

// Enhanced Live Experience Renderer with additional features
export interface EnhancedLiveExperienceRendererProps extends LiveExperienceRendererProps {
  enableUpdateHistory?: boolean;
  maxHistorySize?: number;
  enableUpdateMetrics?: boolean;
  debugMode?: boolean;
}

export const EnhancedLiveExperienceRenderer: React.FC<EnhancedLiveExperienceRendererProps> = ({
  enableUpdateHistory = false,
  maxHistorySize = 10,
  enableUpdateMetrics = false,
  debugMode = false,
  ...props
}) => {
  const [updateHistory, setUpdateHistory] = useState<Array<{
    timestamp: number;
    strategy: UpdateStrategy;
    success: boolean;
    contract: Contract;
  }>>([]);

  const [updateMetrics, setUpdateMetrics] = useState({
    totalUpdates: 0,
    successfulUpdates: 0,
    failedUpdates: 0,
    averageUpdateTime: 0,
    updatesByStrategy: {
      'hot-swap': 0,
      'partial-update': 0,
      'full-rerender': 0
    }
  });

  const updateStartTime = useRef<number>(0);

  const handleUpdateStart = useCallback((strategy: UpdateStrategy) => {
    updateStartTime.current = Date.now();
    
    if (debugMode) {
      console.log('Update started:', strategy);
    }
    
    props.onUpdateStart?.(strategy);
  }, [debugMode, props]);

  const handleUpdateComplete = useCallback((strategy: UpdateStrategy, success: boolean) => {
    const updateTime = Date.now() - updateStartTime.current;
    
    // Update history
    if (enableUpdateHistory) {
      setUpdateHistory(prev => {
        const newHistory = [...prev, {
          timestamp: Date.now(),
          strategy,
          success,
          contract: props.initialContract
        }];
        
        // Limit history size
        if (newHistory.length > maxHistorySize) {
          newHistory.shift();
        }
        
        return newHistory;
      });
    }

    // Update metrics
    if (enableUpdateMetrics) {
      setUpdateMetrics(prev => ({
        totalUpdates: prev.totalUpdates + 1,
        successfulUpdates: prev.successfulUpdates + (success ? 1 : 0),
        failedUpdates: prev.failedUpdates + (success ? 0 : 1),
        averageUpdateTime: (prev.averageUpdateTime * prev.totalUpdates + updateTime) / (prev.totalUpdates + 1),
        updatesByStrategy: {
          ...prev.updatesByStrategy,
          [strategy.type]: prev.updatesByStrategy[strategy.type] + 1
        }
      }));
    }

    if (debugMode) {
      console.log('Update completed:', { strategy, success, updateTime });
    }
    
    props.onUpdateComplete?.(strategy, success);
  }, [enableUpdateHistory, enableUpdateMetrics, maxHistorySize, debugMode, props]);

  const handleUpdateError = useCallback((error: Error, strategy: UpdateStrategy) => {
    if (debugMode) {
      console.error('Update error:', error, strategy);
    }
    
    props.onUpdateError?.(error, strategy);
  }, [debugMode, props]);

  return (
    <div className="enhanced-live-experience-renderer">
      <LiveExperienceRenderer
        {...props}
        onUpdateStart={handleUpdateStart}
        onUpdateComplete={handleUpdateComplete}
        onUpdateError={handleUpdateError}
      />
      
      {/* Debug information */}
      {debugMode && (
        <div className="debug-panel" style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          background: 'rgba(0, 0, 0, 0.8)',
          color: 'white',
          padding: '10px',
          fontSize: '12px',
          maxWidth: '300px',
          maxHeight: '200px',
          overflow: 'auto',
          zIndex: 1001
        }}>
          <h4>Live Update Debug</h4>
          {enableUpdateMetrics && (
            <div>
              <p>Total Updates: {updateMetrics.totalUpdates}</p>
              <p>Success Rate: {updateMetrics.totalUpdates > 0 ? 
                Math.round((updateMetrics.successfulUpdates / updateMetrics.totalUpdates) * 100) : 0}%</p>
              <p>Avg Time: {Math.round(updateMetrics.averageUpdateTime)}ms</p>
            </div>
          )}
          {enableUpdateHistory && updateHistory.length > 0 && (
            <div>
              <h5>Recent Updates:</h5>
              {updateHistory.slice(-3).map((update, index) => (
                <div key={index} style={{ fontSize: '10px', marginBottom: '2px' }}>
                  {update.strategy.type} - {update.success ? '✓' : '✗'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default LiveExperienceRenderer;