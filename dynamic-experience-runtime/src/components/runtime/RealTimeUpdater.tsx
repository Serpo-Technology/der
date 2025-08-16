/**
 * Real-Time Updater - Manages real-time contract updates and component hot-swapping
 * Requirements: 3.5, 9.2, 9.3, 9.4
 */

import React, { useCallback, useRef, useEffect } from 'react';
import { Contract } from '../../types/contract';
import { Experience } from '../../types/experience';
import { ContractChangeDetector, ContractChangeAnalysis } from './ContractChangeDetector';
import { DynamicExperienceRuntimeService } from './DynamicExperienceRuntimeService';

export interface UpdateStrategy {
  type: 'full-rerender' | 'partial-update' | 'hot-swap';
  reason: string;
  affectedElements: string[];
  affectedOperations: string[];
}

export interface RealTimeUpdateOptions {
  enableHotSwap?: boolean;
  enablePartialUpdates?: boolean;
  updateThrottleMs?: number;
  maxUpdateQueue?: number;
  onUpdateStart?: (strategy: UpdateStrategy) => void;
  onUpdateComplete?: (strategy: UpdateStrategy, success: boolean) => void;
  onUpdateError?: (error: Error, strategy: UpdateStrategy) => void;
}

export interface UpdateQueueItem {
  contract: Contract;
  timestamp: number;
  priority: 'low' | 'medium' | 'high';
}

export class RealTimeUpdater {
  private changeDetector: ContractChangeDetector;
  private runtimeService: DynamicExperienceRuntimeService;
  private updateQueue: UpdateQueueItem[] = [];
  private isProcessing = false;
  private updateTimer: NodeJS.Timeout | null = null;
  private options: Required<RealTimeUpdateOptions>;

  constructor(
    runtimeService: DynamicExperienceRuntimeService,
    options: RealTimeUpdateOptions = {}
  ) {
    this.runtimeService = runtimeService;
    this.changeDetector = new ContractChangeDetector();
    this.options = {
      enableHotSwap: true,
      enablePartialUpdates: true,
      updateThrottleMs: 100,
      maxUpdateQueue: 10,
      onUpdateStart: () => {},
      onUpdateComplete: () => {},
      onUpdateError: () => {},
      ...options
    };
  }

  async updateContract(
    experienceId: string, 
    newContract: Contract, 
    priority: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<void> {
    // Add to update queue
    this.enqueueUpdate({
      contract: newContract,
      timestamp: Date.now(),
      priority
    });

    // Process queue if not already processing
    if (!this.isProcessing) {
      this.scheduleProcessing();
    }
  }

  private enqueueUpdate(update: UpdateQueueItem): void {
    // Remove older updates for the same contract if queue is full
    if (this.updateQueue.length >= this.options.maxUpdateQueue) {
      this.updateQueue.shift(); // Remove oldest
    }

    // Insert based on priority
    const insertIndex = this.findInsertIndex(update.priority);
    this.updateQueue.splice(insertIndex, 0, update);
  }

  private findInsertIndex(priority: 'low' | 'medium' | 'high'): number {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const targetPriority = priorityOrder[priority];

    for (let i = 0; i < this.updateQueue.length; i++) {
      if (priorityOrder[this.updateQueue[i].priority] < targetPriority) {
        return i;
      }
    }
    return this.updateQueue.length;
  }

  private scheduleProcessing(): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }

    this.updateTimer = setTimeout(() => {
      this.processUpdateQueue();
    }, this.options.updateThrottleMs);
  }

  private async processUpdateQueue(): Promise<void> {
    if (this.isProcessing || this.updateQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      // Process the highest priority update
      const update = this.updateQueue.shift();
      if (update) {
        await this.processUpdate(update);
      }

      // Continue processing if there are more updates
      if (this.updateQueue.length > 0) {
        this.scheduleProcessing();
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processUpdate(update: UpdateQueueItem): Promise<void> {
    try {
      // Detect changes
      const analysis = this.changeDetector.detectChanges(update.contract);
      
      if (!analysis.hasChanges) {
        return; // No changes to process
      }

      // Determine update strategy
      const strategy = this.determineUpdateStrategy(analysis);
      
      // Notify start
      this.options.onUpdateStart(strategy);

      // Execute update based on strategy
      let success = false;
      switch (strategy.type) {
        case 'hot-swap':
          success = await this.performHotSwap(analysis, strategy);
          break;
        case 'partial-update':
          success = await this.performPartialUpdate(analysis, strategy);
          break;
        case 'full-rerender':
          success = await this.performFullRerender(update.contract, strategy);
          break;
      }

      // Notify completion
      this.options.onUpdateComplete(strategy, success);

    } catch (error) {
      const strategy: UpdateStrategy = {
        type: 'full-rerender',
        reason: 'error-fallback',
        affectedElements: [],
        affectedOperations: []
      };
      
      this.options.onUpdateError(error as Error, strategy);
      
      // Fallback to full rerender on error
      try {
        const fallbackSuccess = await this.performFullRerender(update.contract, strategy);
        if (!fallbackSuccess) {
          throw new Error('Fallback rerender failed');
        }
      } catch (fallbackError) {
        console.error('Fallback rerender also failed:', fallbackError);
      }
    }
  }

  private determineUpdateStrategy(analysis: ContractChangeAnalysis): UpdateStrategy {
    // Force full rerender for major changes
    if (analysis.requiresFullRerender) {
      return {
        type: 'full-rerender',
        reason: 'major-structural-changes',
        affectedElements: analysis.affectedElements,
        affectedOperations: analysis.affectedOperations
      };
    }

    // Use hot-swap for simple element property changes
    if (this.options.enableHotSwap && this.canUseHotSwap(analysis)) {
      return {
        type: 'hot-swap',
        reason: 'simple-property-changes',
        affectedElements: analysis.affectedElements,
        affectedOperations: analysis.affectedOperations
      };
    }

    // Use partial updates for moderate changes
    if (this.options.enablePartialUpdates && this.canUsePartialUpdate(analysis)) {
      return {
        type: 'partial-update',
        reason: 'moderate-changes',
        affectedElements: analysis.affectedElements,
        affectedOperations: analysis.affectedOperations
      };
    }

    // Default to full rerender
    return {
      type: 'full-rerender',
      reason: 'complex-changes',
      affectedElements: analysis.affectedElements,
      affectedOperations: analysis.affectedOperations
    };
  }

  private canUseHotSwap(analysis: ContractChangeAnalysis): boolean {
    // Hot-swap is suitable for:
    // - Only property changes (no structural changes)
    // - Small number of affected elements
    // - No operation changes
    return (
      analysis.changes.every(change => 
        change.type === 'element' && change.action === 'modified'
      ) &&
      analysis.affectedElements.length <= 3 &&
      analysis.affectedOperations.length === 0
    );
  }

  private canUsePartialUpdate(analysis: ContractChangeAnalysis): boolean {
    // Partial update is suitable for:
    // - Limited number of changes
    // - No layout/styling changes
    // - Manageable number of affected elements
    return (
      analysis.changes.length <= 5 &&
      !analysis.changes.some(change => 
        change.type === 'layout' || change.type === 'styling'
      ) &&
      analysis.affectedElements.length <= 10
    );
  }

  private async performHotSwap(
    analysis: ContractChangeAnalysis, 
    strategy: UpdateStrategy
  ): Promise<boolean> {
    try {
      // Hot-swap involves updating component properties without remounting
      for (const elementId of strategy.affectedElements) {
        await this.hotSwapElement(elementId, analysis);
      }
      return true;
    } catch (error) {
      console.error('Hot-swap failed:', error);
      return false;
    }
  }

  private async hotSwapElement(
    elementId: string, 
    analysis: ContractChangeAnalysis
  ): Promise<void> {
    const elementChanges = this.changeDetector.getElementChanges(elementId, analysis.changes);
    
    for (const change of elementChanges) {
      if (change.action === 'modified' && change.newValue) {
        // Update element properties in place
        await this.updateElementProperties(elementId, change.newValue);
      }
    }
  }

  private async updateElementProperties(elementId: string, newElement: any): Promise<void> {
    // This would interact with the DOM or React component tree to update properties
    // For now, we'll simulate the update
    console.log(`Hot-swapping element ${elementId} with new properties:`, newElement.properties);
    
    // In a real implementation, this might:
    // 1. Find the React component instance
    // 2. Update its props
    // 3. Trigger a re-render of just that component
  }

  private async performPartialUpdate(
    analysis: ContractChangeAnalysis, 
    strategy: UpdateStrategy
  ): Promise<boolean> {
    try {
      // Get all experiences and update affected ones
      const experiences = this.runtimeService.getAllExperiences();
      
      for (const experience of experiences) {
        await this.runtimeService.updateExperience(experience, analysis.delta);
      }
      
      return true;
    } catch (error) {
      console.error('Partial update failed:', error);
      throw error; // Re-throw to trigger main error handling
    }
  }

  private async performFullRerender(
    contract: Contract, 
    strategy: UpdateStrategy
  ): Promise<boolean> {
    try {
      // Clear all experiences and recreate them
      this.runtimeService.clearAllExperiences();
      
      // Create new experience with updated contract
      await this.runtimeService.renderExperience(contract);
      
      return true;
    } catch (error) {
      console.error('Full rerender failed:', error);
      return false;
    }
  }

  // Public API methods

  clearUpdateQueue(): void {
    this.updateQueue = [];
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
  }

  getQueueStatus(): { length: number; isProcessing: boolean; nextUpdate?: UpdateQueueItem } {
    return {
      length: this.updateQueue.length,
      isProcessing: this.isProcessing,
      nextUpdate: this.updateQueue[0]
    };
  }

  setOptions(newOptions: Partial<RealTimeUpdateOptions>): void {
    this.options = { ...this.options, ...newOptions };
  }

  // Reset the updater state
  reset(): void {
    this.clearUpdateQueue();
    this.changeDetector.reset();
    this.isProcessing = false;
  }
}

// React Hook for using RealTimeUpdater
export function useRealTimeUpdater(
  runtimeService: DynamicExperienceRuntimeService,
  options?: RealTimeUpdateOptions
) {
  const updaterRef = useRef<RealTimeUpdater | null>(null);

  useEffect(() => {
    updaterRef.current = new RealTimeUpdater(runtimeService, options);
    
    return () => {
      updaterRef.current?.reset();
    };
  }, [runtimeService]);

  const updateContract = useCallback(
    async (experienceId: string, contract: Contract, priority?: 'low' | 'medium' | 'high') => {
      if (updaterRef.current) {
        await updaterRef.current.updateContract(experienceId, contract, priority);
      }
    },
    []
  );

  const clearQueue = useCallback(() => {
    updaterRef.current?.clearUpdateQueue();
  }, []);

  const getStatus = useCallback(() => {
    return updaterRef.current?.getQueueStatus() || { length: 0, isProcessing: false };
  }, []);

  return {
    updateContract,
    clearQueue,
    getStatus,
    updater: updaterRef.current
  };
}

export default RealTimeUpdater;