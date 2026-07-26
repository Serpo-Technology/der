/**
 * Renders an experience over a runtime core session and applies contract
 * updates pushed from other windows while it stays mounted.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Contract } from '../../types/contract';
import { ExperienceState } from '../../types/experience';
import { CoreExperienceRenderer } from './CoreExperienceRenderer';

interface LiveExperienceRendererProps {
  initialContract: Contract;
  experienceId: string;
  /** Previously saved state data, merged over the contract's seeds. */
  initialData?: Record<string, unknown>;
  onContractUpdate?: (contract: Contract) => void;
  onStateChange?: (state: ExperienceState) => void;
  onError?: (error: Error) => void;
}

export const LiveExperienceRenderer: React.FC<LiveExperienceRendererProps> = ({
  initialContract,
  experienceId,
  initialData,
  onContractUpdate,
  onStateChange,
  onError
}) => {
  const [currentContract, setCurrentContract] = useState<Contract>(initialContract);

  // External contract changes (edits, streamed drafts) swap the session in
  // place; the core renderer preserves state across the swap.
  useEffect(() => {
    if (initialContract !== currentContract) {
      setCurrentContract(initialContract);
      onContractUpdate?.(initialContract);
    }
  }, [initialContract, currentContract, onContractUpdate]);

  const handleStateChange = useCallback((state: ExperienceState) => {
    onStateChange?.(state);
  }, [onStateChange]);

  const handleError = useCallback((error: Error) => {
    console.error('Experience error:', error);
    onError?.(error);
  }, [onError]);

  return (
    <div className="live-experience-renderer">
      <CoreExperienceRenderer
        contract={currentContract}
        experienceId={experienceId}
        initialData={initialData}
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
