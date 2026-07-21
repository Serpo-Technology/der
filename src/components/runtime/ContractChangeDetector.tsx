/**
 * Contract Change Detector - Detects and analyzes changes in contracts
 * Requirements: 3.5, 9.2, 9.3, 9.4
 */

import { Contract, ContractDelta, UIElement, OperationBinding } from '../../types/contract';

export interface ContractChange {
  type: 'element' | 'operation' | 'layout' | 'styling' | 'metadata';
  action: 'added' | 'modified' | 'removed';
  path: string;
  oldValue?: any;
  newValue?: any;
  elementId?: string;
  operationId?: string;
}

export interface ContractChangeAnalysis {
  hasChanges: boolean;
  changes: ContractChange[];
  delta: ContractDelta;
  requiresFullRerender: boolean;
  affectedElements: string[];
  affectedOperations: string[];
}

export class ContractChangeDetector {
  private previousContract: Contract | null = null;

  detectChanges(newContract: Contract): ContractChangeAnalysis {
    if (!this.previousContract) {
      // First time - everything is new
      this.previousContract = newContract;
      return this.createInitialAnalysis(newContract);
    }

    const changes = this.compareContracts(this.previousContract, newContract);
    const delta = this.createContractDelta(changes);
    const analysis = this.analyzeChanges(changes, delta);

    this.previousContract = newContract;
    return analysis;
  }

  private createInitialAnalysis(contract: Contract): ContractChangeAnalysis {
    return {
      hasChanges: true,
      changes: [
        {
          type: 'element',
          action: 'added',
          path: 'elements',
          newValue: contract.elements
        }
      ],
      delta: {
        added: contract.elements,
        modified: [],
        removed: [],
        operationChanges: contract.operations
      },
      requiresFullRerender: true,
      affectedElements: contract.elements.map(el => el.id),
      affectedOperations: contract.operations.map(op => op.id)
    };
  }

  private compareContracts(oldContract: Contract, newContract: Contract): ContractChange[] {
    const changes: ContractChange[] = [];

    // Compare basic contract properties
    if (oldContract.name !== newContract.name) {
      changes.push({
        type: 'metadata',
        action: 'modified',
        path: 'name',
        oldValue: oldContract.name,
        newValue: newContract.name
      });
    }

    if (oldContract.version !== newContract.version) {
      changes.push({
        type: 'metadata',
        action: 'modified',
        path: 'version',
        oldValue: oldContract.version,
        newValue: newContract.version
      });
    }

    // Compare elements
    changes.push(...this.compareElements(oldContract.elements, newContract.elements));

    // Compare operations
    changes.push(...this.compareOperations(oldContract.operations, newContract.operations));

    // Compare layout
    if (!this.deepEqual(oldContract.layout, newContract.layout)) {
      changes.push({
        type: 'layout',
        action: 'modified',
        path: 'layout',
        oldValue: oldContract.layout,
        newValue: newContract.layout
      });
    }

    // Compare styling
    if (!this.deepEqual(oldContract.styling, newContract.styling)) {
      changes.push({
        type: 'styling',
        action: 'modified',
        path: 'styling',
        oldValue: oldContract.styling,
        newValue: newContract.styling
      });
    }

    // Compare metadata
    if (!this.deepEqual(oldContract.metadata, newContract.metadata)) {
      changes.push({
        type: 'metadata',
        action: 'modified',
        path: 'metadata',
        oldValue: oldContract.metadata,
        newValue: newContract.metadata
      });
    }

    return changes;
  }

  private compareElements(oldElements: UIElement[], newElements: UIElement[]): ContractChange[] {
    const changes: ContractChange[] = [];
    const oldElementsMap = new Map(oldElements.map(el => [el.id, el]));
    const newElementsMap = new Map(newElements.map(el => [el.id, el]));

    // Find added elements
    for (const [id, element] of newElementsMap) {
      if (!oldElementsMap.has(id)) {
        changes.push({
          type: 'element',
          action: 'added',
          path: `elements.${id}`,
          newValue: element,
          elementId: id
        });
      }
    }

    // Find removed elements
    for (const [id, element] of oldElementsMap) {
      if (!newElementsMap.has(id)) {
        changes.push({
          type: 'element',
          action: 'removed',
          path: `elements.${id}`,
          oldValue: element,
          elementId: id
        });
      }
    }

    // Find modified elements
    for (const [id, newElement] of newElementsMap) {
      const oldElement = oldElementsMap.get(id);
      if (oldElement && !this.deepEqual(oldElement, newElement)) {
        changes.push({
          type: 'element',
          action: 'modified',
          path: `elements.${id}`,
          oldValue: oldElement,
          newValue: newElement,
          elementId: id
        });
      }
    }

    return changes;
  }

  private compareOperations(oldOperations: OperationBinding[], newOperations: OperationBinding[]): ContractChange[] {
    const changes: ContractChange[] = [];
    const oldOperationsMap = new Map(oldOperations.map(op => [op.id, op]));
    const newOperationsMap = new Map(newOperations.map(op => [op.id, op]));

    // Find added operations
    for (const [id, operation] of newOperationsMap) {
      if (!oldOperationsMap.has(id)) {
        changes.push({
          type: 'operation',
          action: 'added',
          path: `operations.${id}`,
          newValue: operation,
          operationId: id
        });
      }
    }

    // Find removed operations
    for (const [id, operation] of oldOperationsMap) {
      if (!newOperationsMap.has(id)) {
        changes.push({
          type: 'operation',
          action: 'removed',
          path: `operations.${id}`,
          oldValue: operation,
          operationId: id
        });
      }
    }

    // Find modified operations
    for (const [id, newOperation] of newOperationsMap) {
      const oldOperation = oldOperationsMap.get(id);
      if (oldOperation && !this.deepEqual(oldOperation, newOperation)) {
        changes.push({
          type: 'operation',
          action: 'modified',
          path: `operations.${id}`,
          oldValue: oldOperation,
          newValue: newOperation,
          operationId: id
        });
      }
    }

    return changes;
  }

  private createContractDelta(changes: ContractChange[]): ContractDelta {
    const delta: ContractDelta = {
      added: [],
      modified: [],
      removed: [],
      operationChanges: []
    };

    for (const change of changes) {
      if (change.type === 'element') {
        switch (change.action) {
          case 'added':
            delta.added.push(change.newValue);
            break;
          case 'modified':
            delta.modified.push(change.newValue);
            break;
          case 'removed':
            if (change.elementId) {
              delta.removed.push(change.elementId);
            }
            break;
        }
      } else if (change.type === 'operation') {
        if (change.action !== 'removed') {
          delta.operationChanges.push(change.newValue);
        }
      }
    }

    return delta;
  }

  private analyzeChanges(changes: ContractChange[], delta: ContractDelta): ContractChangeAnalysis {
    const hasChanges = changes.length > 0;
    const affectedElements = new Set<string>();
    const affectedOperations = new Set<string>();
    let requiresFullRerender = false;

    for (const change of changes) {
      // Layout or styling changes require full rerender
      if (change.type === 'layout' || change.type === 'styling') {
        requiresFullRerender = true;
      }

      // Track affected elements and operations
      if (change.elementId) {
        affectedElements.add(change.elementId);
      }
      if (change.operationId) {
        affectedOperations.add(change.operationId);
      }

      // Large structural changes require full rerender
      if (change.type === 'element' && change.action === 'added' && 
          change.newValue?.children && change.newValue.children.length > 5) {
        requiresFullRerender = true;
      }
    }

    return {
      hasChanges,
      changes,
      delta,
      requiresFullRerender,
      affectedElements: Array.from(affectedElements),
      affectedOperations: Array.from(affectedOperations)
    };
  }

  private deepEqual(obj1: any, obj2: any): boolean {
    if (obj1 === obj2) return true;
    
    if (obj1 == null || obj2 == null) return obj1 === obj2;
    
    if (typeof obj1 !== typeof obj2) return false;
    
    if (typeof obj1 !== 'object') return obj1 === obj2;
    
    if (Array.isArray(obj1) !== Array.isArray(obj2)) return false;
    
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    if (keys1.length !== keys2.length) return false;
    
    for (const key of keys1) {
      if (!keys2.includes(key)) return false;
      if (!this.deepEqual(obj1[key], obj2[key])) return false;
    }
    
    return true;
  }

  // Reset the detector (useful for testing or when starting fresh)
  reset(): void {
    this.previousContract = null;
  }

  // Get the current contract being tracked
  getCurrentContract(): Contract | null {
    return this.previousContract;
  }

  // Check if a specific element has changed
  hasElementChanged(elementId: string, changes: ContractChange[]): boolean {
    return changes.some(change => 
      change.type === 'element' && change.elementId === elementId
    );
  }

  // Check if a specific operation has changed
  hasOperationChanged(operationId: string, changes: ContractChange[]): boolean {
    return changes.some(change => 
      change.type === 'operation' && change.operationId === operationId
    );
  }

  // Get changes for a specific element
  getElementChanges(elementId: string, changes: ContractChange[]): ContractChange[] {
    return changes.filter(change => 
      change.type === 'element' && change.elementId === elementId
    );
  }

  // Get changes for a specific operation
  getOperationChanges(operationId: string, changes: ContractChange[]): ContractChange[] {
    return changes.filter(change => 
      change.type === 'operation' && change.operationId === operationId
    );
  }
}

export default ContractChangeDetector;