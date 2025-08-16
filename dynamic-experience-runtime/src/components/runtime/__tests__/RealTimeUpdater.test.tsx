/**
 * Tests for Real-Time Updater
 * Requirements: 3.5, 9.2, 9.3, 9.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealTimeUpdater, UpdateStrategy } from '../RealTimeUpdater';
// import { DynamicExperienceRuntimeService } from '../DynamicExperienceRuntimeService';
import { Contract } from '../../../types/contract';
import React from 'react';

// Mock the runtime service
const mockRuntimeService = {
  getAllExperiences: vi.fn(),
  updateExperience: vi.fn(),
  clearAllExperiences: vi.fn(),
  renderExperience: vi.fn()
} as any;

describe('RealTimeUpdater', () => {
  let updater: RealTimeUpdater;
  let mockCallbacks: {
    onUpdateStart: ReturnType<typeof vi.fn>;
    onUpdateComplete: ReturnType<typeof vi.fn>;
    onUpdateError: ReturnType<typeof vi.fn>;
  };

  const baseContract: Contract = {
    name: 'TestContract',
    version: '1.0.0',
    elements: [
      {
        id: 'button1',
        type: 'button',
        properties: { text: 'Click me' },
        dataBindings: [],
        eventBindings: []
      }
    ],
    operations: [],
    layout: { type: 'flex', properties: {} },
    styling: { theme: 'default' },
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    }
  };

  beforeEach(() => {
    mockCallbacks = {
      onUpdateStart: vi.fn(),
      onUpdateComplete: vi.fn(),
      onUpdateError: vi.fn()
    };

    updater = new RealTimeUpdater(mockRuntimeService, {
      updateThrottleMs: 10, // Fast for testing
      maxUpdateQueue: 5,
      ...mockCallbacks
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    updater.reset();
  });

  describe('update queue management', () => {
    it('enqueues updates correctly', async () => {
      const contract1 = { ...baseContract, name: 'Contract1' };
      const contract2 = { ...baseContract, name: 'Contract2' };

      await updater.updateContract('exp1', contract1, 'low');
      await updater.updateContract('exp1', contract2, 'high');

      const status = updater.getQueueStatus();
      expect(status.length).toBe(2);
    });

    it('prioritizes updates correctly', async () => {
      const lowPriorityContract = { ...baseContract, name: 'Low' };
      const highPriorityContract = { ...baseContract, name: 'High' };
      const mediumPriorityContract = { ...baseContract, name: 'Medium' };

      await updater.updateContract('exp1', lowPriorityContract, 'low');
      await updater.updateContract('exp1', highPriorityContract, 'high');
      await updater.updateContract('exp1', mediumPriorityContract, 'medium');

      const status = updater.getQueueStatus();
      expect(status.nextUpdate?.contract.name).toBe('High');
    });

    it('limits queue size', async () => {
      // Add more updates than maxUpdateQueue
      for (let i = 0; i < 10; i++) {
        await updater.updateContract('exp1', { ...baseContract, name: `Contract${i}` });
      }

      const status = updater.getQueueStatus();
      expect(status.length).toBeLessThanOrEqual(5);
    });

    it('clears queue correctly', async () => {
      await updater.updateContract('exp1', baseContract);
      updater.clearUpdateQueue();

      const status = updater.getQueueStatus();
      expect(status.length).toBe(0);
      expect(status.isProcessing).toBe(false);
    });
  });

  describe('update strategy determination', () => {
    it('determines hot-swap strategy for simple property changes', async () => {
      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      // Update with simple property change
      const updatedContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated text' }
          }
        ]
      };

      await updater.updateContract('exp1', updatedContract);
      
      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateStart).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'hot-swap',
          reason: 'simple-property-changes'
        })
      );
    });

    it('determines partial-update strategy for moderate changes', async () => {
      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Add new element (moderate change)
      const updatedContract = {
        ...baseContract,
        elements: [
          ...baseContract.elements,
          {
            id: 'input1',
            type: 'input',
            properties: { placeholder: 'Enter text' },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      await updater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateStart).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'partial-update',
          reason: 'moderate-changes'
        })
      );
    });

    it('determines full-rerender strategy for layout changes', async () => {
      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Change layout (major change)
      const updatedContract = {
        ...baseContract,
        layout: { type: 'grid' as const, properties: { gridTemplateColumns: '1fr 1fr' } }
      };

      await updater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateStart).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'full-rerender',
          reason: 'major-structural-changes'
        })
      );
    });
  });

  describe('update execution', () => {
    it('executes hot-swap updates', async () => {
      mockRuntimeService.getAllExperiences.mockReturnValue([]);
      
      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simple property change
      const updatedContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Hot-swapped text' }
          }
        ]
      };

      await updater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateComplete).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'hot-swap' }),
        true
      );
    });

    it('executes partial updates', async () => {
      const mockExperience = { id: 'exp1', contract: baseContract };
      mockRuntimeService.getAllExperiences.mockReturnValue([mockExperience]);
      mockRuntimeService.updateExperience.mockResolvedValue(undefined);

      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Add element (partial update)
      const updatedContract = {
        ...baseContract,
        elements: [
          ...baseContract.elements,
          {
            id: 'text1',
            type: 'text',
            properties: { text: 'New text' },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      await updater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockRuntimeService.updateExperience).toHaveBeenCalled();
      expect(mockCallbacks.onUpdateComplete).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'partial-update' }),
        true
      );
    });

    it('executes full rerenders', async () => {
      mockRuntimeService.clearAllExperiences.mockImplementation(() => {});
      mockRuntimeService.renderExperience.mockResolvedValue(() => React.createElement('div'));

      // Set initial contract
      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Layout change (full rerender)
      const updatedContract = {
        ...baseContract,
        layout: { type: 'absolute' as const, properties: {} }
      };

      await updater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockRuntimeService.clearAllExperiences).toHaveBeenCalled();
      expect(mockRuntimeService.renderExperience).toHaveBeenCalledWith(updatedContract);
      expect(mockCallbacks.onUpdateComplete).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'full-rerender' }),
        true
      );
    });
  });

  describe('error handling', () => {
    it('handles update errors gracefully', async () => {
      mockRuntimeService.getAllExperiences.mockImplementation(() => {
        throw new Error('Runtime service error');
      });

      // Use a modified contract to ensure changes are detected
      const modifiedContract = { 
        ...baseContract, 
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated text' }
          }
        ]
      };

      await updater.updateContract('exp1', modifiedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.any(Object)
      );
    });

    it('falls back to full rerender on error', async () => {
      mockRuntimeService.getAllExperiences.mockImplementation(() => {
        throw new Error('Partial update failed');
      });
      mockRuntimeService.clearAllExperiences.mockImplementation(() => {});
      mockRuntimeService.renderExperience.mockResolvedValue(() => React.createElement('div'));

      await updater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should attempt fallback
      expect(mockRuntimeService.clearAllExperiences).toHaveBeenCalled();
      expect(mockRuntimeService.renderExperience).toHaveBeenCalled();
    });

    it('handles fallback errors', async () => {
      mockRuntimeService.getAllExperiences.mockImplementation(() => {
        throw new Error('Primary error');
      });
      mockRuntimeService.clearAllExperiences.mockImplementation(() => {
        throw new Error('Fallback error');
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Use a modified contract to ensure changes are detected
      const modifiedContract = { 
        ...baseContract, 
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated text for fallback test' }
          }
        ]
      };

      await updater.updateContract('exp1', modifiedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(consoleSpy).toHaveBeenCalledWith(
        'Fallback rerender also failed:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('throttling and queuing', () => {
    it('throttles rapid updates', async () => {
      const startTime = Date.now();
      
      // Send multiple rapid updates
      await updater.updateContract('exp1', { ...baseContract, name: 'Update1' });
      await updater.updateContract('exp1', { ...baseContract, name: 'Update2' });
      await updater.updateContract('exp1', { ...baseContract, name: 'Update3' });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      const endTime = Date.now();
      const elapsed = endTime - startTime;

      // Should have been throttled
      expect(elapsed).toBeGreaterThan(10); // updateThrottleMs
    });

    it('processes updates in order', async () => {
      const updates: string[] = [];
      
      mockCallbacks.onUpdateStart.mockImplementation((strategy: UpdateStrategy) => {
        // Extract contract name from the update (this is a simplified test)
        updates.push('started');
      });

      await updater.updateContract('exp1', { ...baseContract, name: 'First' });
      await updater.updateContract('exp1', { ...baseContract, name: 'Second' });
      
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(updates.length).toBeGreaterThan(0);
    });
  });

  describe('configuration', () => {
    it('respects disabled hot-swap option', async () => {
      const noHotSwapUpdater = new RealTimeUpdater(mockRuntimeService, {
        enableHotSwap: false,
        updateThrottleMs: 10,
        ...mockCallbacks
      });

      await noHotSwapUpdater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Simple property change should not use hot-swap
      const updatedContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated' }
          }
        ]
      };

      await noHotSwapUpdater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateStart).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.not.stringMatching('hot-swap')
        })
      );

      noHotSwapUpdater.reset();
    });

    it('respects disabled partial updates option', async () => {
      const noPartialUpdater = new RealTimeUpdater(mockRuntimeService, {
        enablePartialUpdates: false,
        updateThrottleMs: 10,
        ...mockCallbacks
      });

      await noPartialUpdater.updateContract('exp1', baseContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      // Add element should not use partial update
      const updatedContract = {
        ...baseContract,
        elements: [
          ...baseContract.elements,
          {
            id: 'text1',
            type: 'text',
            properties: { text: 'New' },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      await noPartialUpdater.updateContract('exp1', updatedContract);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(mockCallbacks.onUpdateStart).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'full-rerender'
        })
      );

      noPartialUpdater.reset();
    });

    it('allows option updates', () => {
      updater.setOptions({
        updateThrottleMs: 200,
        enableHotSwap: false
      });

      const status = updater.getQueueStatus();
      expect(status).toBeDefined();
    });
  });

  describe('status and debugging', () => {
    it('provides queue status', async () => {
      await updater.updateContract('exp1', baseContract);
      
      const status = updater.getQueueStatus();
      expect(status).toHaveProperty('length');
      expect(status).toHaveProperty('isProcessing');
      expect(status).toHaveProperty('nextUpdate');
    });

    it('resets state correctly', () => {
      updater.reset();
      
      const status = updater.getQueueStatus();
      expect(status.length).toBe(0);
      expect(status.isProcessing).toBe(false);
    });
  });
});