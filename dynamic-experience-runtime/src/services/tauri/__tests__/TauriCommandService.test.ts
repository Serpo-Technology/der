/**
 * Tests for Tauri Command Service
 * Requirements: 3.3, 3.4, 8.1, 8.2, 8.3, 8.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TauriCommandService, OperationRequest } from '../TauriCommandService';
import { Contract } from '../../../types/contract';
import { ExperienceState } from '../../../types/experience';

// Mock Tauri API
const mockInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockInvoke
}));

// Mock window.__TAURI__
const mockWindow = {
  __TAURI__: true
};

describe('TauriCommandService', () => {
  let service: TauriCommandService;
  let originalWindow: any;

  beforeEach(() => {
    service = TauriCommandService.getInstance();
    // Reset the singleton state for each test
    (service as any).isInitialized = false;
    (service as any).tauriAvailable = false;
    
    originalWindow = global.window;
    global.window = mockWindow as any;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  describe('initialization', () => {
    it('detects Tauri environment correctly', async () => {
      await service.initialize();
      expect(service.isTauriAvailable()).toBe(true);
    });

    it('handles non-Tauri environment', async () => {
      global.window = {} as any;
      const newService = new (TauriCommandService as any)();
      await newService.initialize();
      expect(newService.isTauriAvailable()).toBe(false);
    });

    it('initializes only once', async () => {
      await service.initialize();
      await service.initialize(); // Second call should not reinitialize
      expect(service.isTauriAvailable()).toBe(true);
    });
  });

  describe('executeOperation', () => {
    const mockOperationRequest: OperationRequest = {
      operation_id: 'test_op',
      operation_name: 'testOperation',
      operation_type: 'remote',
      inputs: { param1: 'value1' },
      implementation: {
        type: 'remote',
        endpoint: 'https://api.example.com/test',
        method: 'POST'
      }
    };

    it('executes operation via Tauri when available', async () => {
      const mockResult = {
        success: true,
        data: { result: 'success' },
        execution_time_ms: 100
      };

      mockInvoke.mockResolvedValue(mockResult);

      const result = await service.executeOperation(mockOperationRequest);

      expect(mockInvoke).toHaveBeenCalledWith('execute_operation', { request: mockOperationRequest });
      expect(result).toEqual(mockResult);
    });

    it('uses mock implementation when Tauri unavailable', async () => {
      global.window = {} as any;
      const newService = new (TauriCommandService as any)();
      
      const result = await newService.executeOperation(mockOperationRequest);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('message');
      expect(result.execution_time_ms).toBeGreaterThan(0);
    });

    it('handles Tauri command errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Tauri command failed'));

      await expect(service.executeOperation(mockOperationRequest))
        .rejects.toThrow('Tauri command failed');
    });

    it('executes different operation types', async () => {
      const localRequest: OperationRequest = {
        ...mockOperationRequest,
        operation_type: 'local',
        implementation: { type: 'local', code: 'return "local result";' }
      };

      const repositoryRequest: OperationRequest = {
        ...mockOperationRequest,
        operation_type: 'repository',
        implementation: { type: 'repository', repository_id: 'custom_op' }
      };

      mockInvoke.mockResolvedValue({ success: true, data: 'result' });

      await service.executeOperation(localRequest);
      await service.executeOperation(repositoryRequest);

      expect(mockInvoke).toHaveBeenCalledTimes(2);
    });
  });

  describe('experience state management', () => {
    const mockState: ExperienceState = {
      data: { key: 'value' },
      loading: { op1: false },
      errors: {},
      lastUpdated: new Date()
    };

    it('saves experience state via Tauri', async () => {
      mockInvoke.mockResolvedValue(undefined);

      await service.saveExperienceState('exp1', mockState);

      expect(mockInvoke).toHaveBeenCalledWith('save_experience_state', {
        experience_id: 'exp1',
        state: mockState
      });
    });

    it('loads experience state via Tauri', async () => {
      mockInvoke.mockResolvedValue(mockState);

      const result = await service.loadExperienceState('exp1');

      expect(mockInvoke).toHaveBeenCalledWith('load_experience_state', {
        experience_id: 'exp1'
      });
      expect(result).toEqual(mockState);
    });

    it('uses localStorage fallback for state management', async () => {
      const mockLocalStorage = { setItem: vi.fn(), getItem: vi.fn() };
      // Ensure window exists but __TAURI__ is undefined to simulate non-Tauri environment
      global.window = { localStorage: mockLocalStorage, __TAURI__: undefined } as any;
      // Mock global localStorage as well
      global.localStorage = mockLocalStorage as any;
      
      // Reset the service state to force re-initialization
      const newService = TauriCommandService.getInstance();
      (newService as any).isInitialized = false;
      (newService as any).tauriAvailable = false;
      
      await newService.saveExperienceState('exp1', mockState);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'experience_state_exp1',
        JSON.stringify(mockState)
      );

      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockState));
      const result = await newService.loadExperienceState('exp1');
      // After JSON serialization/deserialization, Date objects become strings
      const expectedState = {
        ...mockState,
        lastUpdated: mockState.lastUpdated.toISOString()
      };
      expect(result).toEqual(expectedState);
    });

    it('handles missing state gracefully', async () => {
      mockInvoke.mockResolvedValue(null);

      const result = await service.loadExperienceState('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('contract management', () => {
    const mockContract: Contract = {
      name: 'TestContract',
      version: '1.0.0',
      elements: [],
      operations: [],
      layout: { type: 'flex', properties: {} },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        version: '1.0.0'
      }
    };

    it('saves contract via Tauri', async () => {
      mockInvoke.mockResolvedValue('TestContract');

      const contractId = await service.saveContract(mockContract);

      expect(mockInvoke).toHaveBeenCalledWith('save_contract', {
        contract: mockContract
      });
      expect(contractId).toBe('TestContract');
    });

    it('loads contract via Tauri', async () => {
      mockInvoke.mockResolvedValue(mockContract);

      const result = await service.loadContract('TestContract');

      expect(mockInvoke).toHaveBeenCalledWith('load_contract', {
        contract_id: 'TestContract'
      });
      expect(result).toEqual(mockContract);
    });

    it('uses localStorage fallback for contracts', async () => {
      const mockLocalStorage = { setItem: vi.fn(), getItem: vi.fn() };
      // Ensure window exists but __TAURI__ is undefined to simulate non-Tauri environment
      global.window = { localStorage: mockLocalStorage, __TAURI__: undefined } as any;
      // Mock global localStorage as well
      global.localStorage = mockLocalStorage as any;
      
      // Reset the service state to force re-initialization
      const newService = TauriCommandService.getInstance();
      (newService as any).isInitialized = false;
      (newService as any).tauriAvailable = false;

      const contractId = await newService.saveContract(mockContract);
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'contract_TestContract',
        JSON.stringify(mockContract)
      );
      expect(contractId).toBe('TestContract');

      mockLocalStorage.getItem.mockReturnValue(JSON.stringify(mockContract));
      const result = await newService.loadContract('TestContract');
      // After JSON serialization/deserialization, Date objects become strings
      const expectedContract = {
        ...mockContract,
        metadata: {
          ...mockContract.metadata,
          createdAt: mockContract.metadata.createdAt.toISOString(),
          updatedAt: mockContract.metadata.updatedAt.toISOString()
        }
      };
      expect(result).toEqual(expectedContract);
    });
  });

  describe('repository queries', () => {
    const mockComponents = [
      {
        id: 'button-component',
        name: 'Button',
        type: 'ui-element',
        version: '1.0.0'
      }
    ];

    it('queries repository via Tauri', async () => {
      mockInvoke.mockResolvedValue(mockComponents);

      const criteria = { type: 'ui-element' };
      const result = await service.queryRepository(criteria);

      expect(mockInvoke).toHaveBeenCalledWith('query_repository', {
        criteria
      });
      expect(result).toEqual(mockComponents);
    });

    it('uses mock repository when Tauri unavailable', async () => {
      global.window = {} as any;
      const newService = new (TauriCommandService as any)();

      const result = await newService.queryRepository({ type: 'ui-element' });

      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('type', 'ui-element');
    });

    it('filters mock repository results', async () => {
      global.window = {} as any;
      const newService = new (TauriCommandService as any)();

      const uiElements = await newService.queryRepository({ type: 'ui-element' });
      const operations = await newService.queryRepository({ type: 'operation' });

      expect(uiElements.every((comp: { type: string; }) => comp.type === 'ui-element')).toBe(true);
      expect(operations.every((comp: { type: string; }) => comp.type === 'operation')).toBe(true);
    });

    it('handles repository query errors', async () => {
      mockInvoke.mockRejectedValue(new Error('Repository query failed'));

      const result = await service.queryRepository({ type: 'ui-element' });
      expect(result).toEqual([]);
    });
  });

  describe('connection testing', () => {
    it('tests Tauri connection successfully', async () => {
      mockInvoke.mockResolvedValue('Hello test!');

      const isConnected = await service.testConnection();

      expect(mockInvoke).toHaveBeenCalledWith('greet', { name: 'test' });
      expect(isConnected).toBe(true);
    });

    it('handles connection test failure', async () => {
      mockInvoke.mockRejectedValue(new Error('Connection failed'));

      const isConnected = await service.testConnection();
      expect(isConnected).toBe(false);
    });

    it('returns false when Tauri unavailable', async () => {
      global.window = {} as any;
      const newService = new (TauriCommandService as any)();

      const isConnected = await newService.testConnection();
      expect(isConnected).toBe(false);
    });
  });

  describe('singleton pattern', () => {
    it('returns same instance', () => {
      const instance1 = TauriCommandService.getInstance();
      const instance2 = TauriCommandService.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('error handling', () => {
    it('handles state save errors gracefully', async () => {
      mockInvoke.mockRejectedValue(new Error('Save failed'));

      await expect(service.saveExperienceState('exp1', {} as any))
        .rejects.toThrow('Save failed');
    });

    it('handles contract save errors gracefully', async () => {
      mockInvoke.mockRejectedValue(new Error('Contract save failed'));

      await expect(service.saveContract({} as any))
        .rejects.toThrow('Contract save failed');
    });

    it('returns null for failed loads', async () => {
      mockInvoke.mockRejectedValue(new Error('Load failed'));

      const state = await service.loadExperienceState('exp1');
      const contract = await service.loadContract('contract1');

      expect(state).toBeNull();
      expect(contract).toBeNull();
    });
  });
});