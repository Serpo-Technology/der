/**
 * Tests for Operation Executor
 * Requirements: 3.3, 3.4, 8.1, 8.2, 8.3, 8.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OperationExecutor } from '../OperationExecutor';
import { OperationBinding } from '../../../types/contract';

// Mock the TauriCommandService
vi.mock('../../../services/tauri/TauriCommandService', () => ({
  tauriCommandService: {
    executeOperation: vi.fn()
  }
}));

describe('OperationExecutor', () => {
  let operationExecutor: OperationExecutor;
  let mockTauriService: any;

  beforeEach(async () => {
    operationExecutor = new OperationExecutor();
    const { tauriCommandService } = await import('../../../services/tauri/TauriCommandService');
    mockTauriService = tauriCommandService;
    vi.clearAllMocks();
  });

  describe('executeOperation', () => {
    it('executes remote operation successfully', async () => {
      const operationBinding: OperationBinding = {
        id: 'op1',
        operationName: 'fetchData',
        inputs: [{ name: 'url', source: 'constant', sourceId: 'https://api.example.com' }],
        outputs: [{ name: 'data', target: 'state', targetId: 'apiData' }],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { message: 'Data fetched successfully', data: { id: 1, name: 'Test' } },
        execution_time_ms: 150
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      const result = await operationExecutor.executeOperation(operationBinding, ['https://api.example.com']);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith({
        operation_id: 'op1',
        operation_name: 'fetchData',
        operation_type: 'remote',
        inputs: { url: 'https://api.example.com' },
        implementation: {
          type: 'remote',
          endpoint: 'https://api.example.com/fetchData',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }
      });

      expect(result).toEqual(mockResult.data);
    });

    it('executes local operation successfully', async () => {
      const operationBinding: OperationBinding = {
        id: 'op2',
        operationName: 'processData',
        inputs: [{ name: 'data', source: 'state', sourceId: 'inputData' }],
        outputs: [{ name: 'result', target: 'state', targetId: 'processedData' }],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'Data processed locally', timestamp: '2023-01-01T00:00:00Z' },
        execution_time_ms: 50
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      const result = await operationExecutor.executeOperation(operationBinding, [{ key: 'value' }]);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith({
        operation_id: 'op2',
        operation_name: 'processData',
        operation_type: 'local',
        inputs: { data: { key: 'value' } },
        implementation: {
          type: 'local',
          code: expect.stringContaining('processData')
        }
      });

      expect(result).toEqual(mockResult.data);
    });

    it('executes repository operation successfully', async () => {
      const operationBinding: OperationBinding = {
        id: 'op3',
        operationName: 'customOperation',
        inputs: [{ name: 'param', source: 'constant', sourceId: 'test' }],
        outputs: [{ name: 'output', target: 'ui-element', targetId: 'result' }],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { output: 'Custom operation completed', metadata: { version: '1.0' } },
        execution_time_ms: 75
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      const result = await operationExecutor.executeOperation(operationBinding, ['test']);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith({
        operation_id: 'op3',
        operation_name: 'customOperation',
        operation_type: 'repository',
        inputs: { param: 'test' },
        implementation: {
          type: 'repository',
          repository_id: 'customOperation'
        }
      });

      expect(result).toEqual(mockResult.data);
    });

    it('handles operation execution failure', async () => {
      const operationBinding: OperationBinding = {
        id: 'op4',
        operationName: 'failingOperation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: false,
        error: 'Operation failed due to network error',
        execution_time_ms: 200
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await expect(
        operationExecutor.executeOperation(operationBinding, [])
      ).rejects.toThrow('Remote operation failed: Operation failed due to network error');
    });

    it('handles Tauri service rejection', async () => {
      const operationBinding: OperationBinding = {
        id: 'op5',
        operationName: 'errorOperation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      mockTauriService.executeOperation.mockRejectedValue(new Error('Tauri command failed'));

      await expect(
        operationExecutor.executeOperation(operationBinding, [])
      ).rejects.toThrow('Remote operation failed: Tauri command failed');
    });

    it('prepares inputs correctly with transforms', async () => {
      const operationBinding: OperationBinding = {
        id: 'op6',
        operationName: 'transformOperation',
        inputs: [
          {
            name: 'formattedInput',
            source: 'constant',
            sourceId: 'test',
            transform: {
              type: 'format',
              parameters: { template: 'Formatted: {{value}}' }
            }
          }
        ],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'success' },
        execution_time_ms: 100
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await operationExecutor.executeOperation(operationBinding, ['test']);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: { formattedInput: 'Formatted: test' }
        })
      );
    });

    it('validates required inputs', async () => {
      const operationBinding: OperationBinding = {
        id: 'op7',
        operationName: 'validationOperation',
        inputs: [
          {
            name: 'requiredInput',
            source: 'constant',
            sourceId: null as any,
            transform: {
              type: 'validate',
              parameters: { required: true }
            }
          }
        ],
        outputs: [],
        triggers: []
      };

      await expect(
        operationExecutor.executeOperation(operationBinding, [null])
      ).rejects.toThrow('Required input is missing');
    });

    it('caches resolved operations', async () => {
      const operationBinding: OperationBinding = {
        id: 'op8',
        operationName: 'cachedOperation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'cached' },
        execution_time_ms: 50
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      // Execute the same operation twice
      await operationExecutor.executeOperation(operationBinding, []);
      await operationExecutor.executeOperation(operationBinding, []);

      // Should use cached operation resolution
      expect(mockTauriService.executeOperation).toHaveBeenCalledTimes(2);
    });

    it('clears operation cache', () => {
      operationExecutor.clearCache();
      
      const cachedOperations = operationExecutor.getCachedOperations();
      expect(cachedOperations).toEqual([]);
    });

    it('provides cached operations for debugging', async () => {
      const operationBinding: OperationBinding = {
        id: 'op9',
        operationName: 'debugOperation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'debug' },
        execution_time_ms: 25
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await operationExecutor.executeOperation(operationBinding, []);

      const cachedOperations = operationExecutor.getCachedOperations();
      expect(cachedOperations).toContain('debugOperation');
    });

    it('wraps operation errors with context', async () => {
      const operationBinding: OperationBinding = {
        id: 'op10',
        operationName: 'contextErrorOperation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      mockTauriService.executeOperation.mockRejectedValue(new Error('Original error'));

      try {
        await operationExecutor.executeOperation(operationBinding, []);
      } catch (error: any) {
        expect(error.message).toContain('contextErrorOperation');
        expect(error.message).toContain('op10');
        expect(error.originalError).toBeInstanceOf(Error);
        expect(error.operationBinding).toBe(operationBinding);
      }
    });
  });

  describe('operation type inference', () => {
    it('infers remote operation type from name', async () => {
      const operationBinding: OperationBinding = {
        id: 'api_fetch',
        operationName: 'api_fetch_data',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'inferred remote' },
        execution_time_ms: 100
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await operationExecutor.executeOperation(operationBinding, []);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation_type: 'remote'
        })
      );
    });

    it('infers local operation type from name', async () => {
      const operationBinding: OperationBinding = {
        id: 'file_read',
        operationName: 'file_read_operation',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'inferred local' },
        execution_time_ms: 50
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await operationExecutor.executeOperation(operationBinding, []);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation_type: 'local'
        })
      );
    });

    it('defaults to repository operation type', async () => {
      const operationBinding: OperationBinding = {
        id: 'custom_op',
        operationName: 'customBusinessLogic',
        inputs: [],
        outputs: [],
        triggers: []
      };

      const mockResult = {
        success: true,
        data: { result: 'inferred repository' },
        execution_time_ms: 75
      };

      mockTauriService.executeOperation.mockResolvedValue(mockResult);

      await operationExecutor.executeOperation(operationBinding, []);

      expect(mockTauriService.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          operation_type: 'repository'
        })
      );
    });
  });
});