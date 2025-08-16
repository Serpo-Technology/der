// Service layer exports will be added as we implement them
export * from './ai-interpreter';
export * from './contract-builder';
export * from './repository';
export * from './persistence';
export * from './edit-preservation';

// Tauri command service
export { TauriCommandService, tauriCommandService } from './tauri/TauriCommandService';
export type { OperationRequest, OperationResult } from './tauri/TauriCommandService';