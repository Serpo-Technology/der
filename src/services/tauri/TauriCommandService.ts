/**
 * Tauri Command Service - Centralized service for Tauri backend communication
 * Requirements: 3.3, 3.4, 8.1, 8.2, 8.3, 8.5
 */

import { Contract } from '../../types/contract';
import { ExperienceState } from '../../types/experience';

export interface OperationRequest {
  operation_id: string;
  operation_name: string;
  operation_type: 'remote' | 'local' | 'repository';
  inputs: Record<string, any>;
  implementation: {
    type: 'remote' | 'local' | 'repository';
    endpoint?: string;
    method?: string;
    headers?: Record<string, string>;
    code?: string;
    repository_id?: string;
  };
}

export interface OperationResult {
  success: boolean;
  data?: any;
  error?: string;
  execution_time_ms: number;
}

/**
 * True when running inside the Tauri webview. Tauri v2 injects
 * `__TAURI_INTERNALS__`; `__TAURI__` only exists with `withGlobalTauri`
 * (and is what tests set to force the native path).
 */
export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export class TauriCommandService {
  private static instance: TauriCommandService;
  private isInitialized = false;
  private tauriAvailable = false;

  private constructor() {}

  static getInstance(): TauriCommandService {
    if (!TauriCommandService.instance) {
      TauriCommandService.instance = new TauriCommandService();
    }
    return TauriCommandService.instance;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Check if we're running in a Tauri environment
      this.tauriAvailable = isTauriRuntime();
      this.isInitialized = true;
      
      if (this.tauriAvailable) {
        console.log('Tauri environment detected - using native commands');
      } else {
        console.log('Non-Tauri environment - using mock responses');
      }
    } catch (error) {
      console.warn('Failed to initialize Tauri commands:', error);
      this.tauriAvailable = false;
      this.isInitialized = true;
    }
  }

  async executeOperation(request: OperationRequest): Promise<OperationResult> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // The Tauri invoke API expects the arguments as a Record<string, unknown>
        // so we wrap the request in an object with a key, e.g. { request }
        return await invoke('execute_operation', { request });
      } catch (error) {
        console.error('Tauri operation execution failed:', error);
        throw error;
      }
    } else {
      // Mock implementation for development/testing
      return this.mockExecuteOperation(request);
    }
  }

  async saveExperienceState(experienceId: string, state: ExperienceState): Promise<void> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('save_experience_state', { 
          experience_id: experienceId, 
          state 
        });
      } catch (error) {
        console.error('Failed to save experience state:', error);
        throw error;
      }
    } else {
      // Mock implementation - store in localStorage for development
      localStorage.setItem(`experience_state_${experienceId}`, JSON.stringify(state));
    }
  }

  async loadExperienceState(experienceId: string): Promise<ExperienceState | null> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('load_experience_state', { experience_id: experienceId });
      } catch (error) {
        console.error('Failed to load experience state:', error);
        return null;
      }
    } else {
      // Mock implementation - load from localStorage
      const stored = localStorage.getItem(`experience_state_${experienceId}`);
      return stored ? JSON.parse(stored) : null;
    }
  }

  async saveContract(contract: Contract): Promise<string> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('save_contract', { contract });
      } catch (error) {
        console.error('Failed to save contract:', error);
        throw error;
      }
    } else {
      // Mock implementation
      const contractId = contract.name || `contract_${Date.now()}`;
      localStorage.setItem(`contract_${contractId}`, JSON.stringify(contract));
      return contractId;
    }
  }

  async loadContract(contractId: string): Promise<Contract | null> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('load_contract', { contract_id: contractId });
      } catch (error) {
        console.error('Failed to load contract:', error);
        return null;
      }
    } else {
      // Mock implementation
      const stored = localStorage.getItem(`contract_${contractId}`);
      return stored ? JSON.parse(stored) : null;
    }
  }

  async queryRepository(criteria: any): Promise<any[]> {
    await this.initialize();

    if (this.tauriAvailable) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke('query_repository', { criteria });
      } catch (error) {
        console.error('Failed to query repository:', error);
        return [];
      }
    } else {
      // Mock implementation
      return this.mockQueryRepository(criteria);
    }
  }

  // Mock implementations for development/testing
  private async mockExecuteOperation(request: OperationRequest): Promise<OperationResult> {
    const startTime = Date.now();
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const mockData = {
      success: true,
      message: `Mock execution of ${request.operation_name}`,
      operation_type: request.operation_type,
      inputs: request.inputs,
      timestamp: new Date().toISOString()
    };

    return {
      success: true,
      data: mockData,
      execution_time_ms: Date.now() - startTime
    };
  }

  private mockQueryRepository(criteria: any): any[] {
    const mockComponents = [
      {
        id: 'button-component',
        name: 'Button',
        type: 'ui-element',
        version: '1.0.0',
        capabilities: ['clickable', 'styled'],
        description: 'Standard button component'
      },
      {
        id: 'input-component',
        name: 'Input',
        type: 'ui-element',
        version: '1.0.0',
        capabilities: ['text-input', 'validation'],
        description: 'Text input component'
      },
      {
        id: 'api-fetch-operation',
        name: 'API Fetch',
        type: 'operation',
        version: '1.0.0',
        capabilities: ['http-request', 'json-parsing'],
        description: 'Fetch data from remote API'
      }
    ];

    // Simple filtering
    if (criteria?.type) {
      return mockComponents.filter(comp => comp.type === criteria.type);
    }

    return mockComponents;
  }

  // Utility methods
  isTauriAvailable(): boolean {
    return this.tauriAvailable;
  }

  async testConnection(): Promise<boolean> {
    await this.initialize();
    
    if (!this.tauriAvailable) {
      return false;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('greet', { name: 'test' });
      return true;
    } catch (error) {
      console.error('Tauri connection test failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const tauriCommandService = TauriCommandService.getInstance();
export default TauriCommandService;