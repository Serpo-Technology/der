/**
 * Edit Preservation System - Tracks and preserves user modifications
 * Requirements: 2.4, 5.2, 5.6, 10.4, 10.5, 10.6
 */

import { Contract, ContractEdits } from '../../types/contract';
import { Blueprint } from '../../types/blueprint';

export interface EditTracker {
  trackEdit(location: string, originalValue: any, newValue: any): void;
  getEdits(): UserEdit[];
  clearEdits(): void;
  hasEdits(): boolean;
}

export interface UserEdit {
  id: string;
  location: string;
  originalValue: any;
  newValue: any;
  timestamp: Date;
  preserved: boolean;
  type: 'blueprint' | 'contract' | 'element' | 'operation';
}

export interface EditConflict {
  id: string;
  location: string;
  userEdit: UserEdit;
  aiSuggestion: any;
  conflictType: 'value-mismatch' | 'structure-change' | 'dependency-conflict';
  resolutionOptions: ConflictResolution[];
}

export interface ConflictResolution {
  id: string;
  description: string;
  action: 'keep-user' | 'accept-ai' | 'merge' | 'manual';
  mergedValue?: any;
}

export class EditPreservationSystem {
  private edits: Map<string, UserEdit> = new Map();
  private editCounter = 0;

  trackEdit(location: string, originalValue: any, newValue: any, type: UserEdit['type'] = 'contract'): UserEdit {
    const editId = `edit_${++this.editCounter}`;
    const edit: UserEdit = {
      id: editId,
      location,
      originalValue,
      newValue,
      timestamp: new Date(),
      preserved: true,
      type
    };

    this.edits.set(location, edit);
    return edit;
  }

  getEdits(): UserEdit[] {
    return Array.from(this.edits.values());
  }

  getEditsByType(type: UserEdit['type']): UserEdit[] {
    return this.getEdits().filter(edit => edit.type === type);
  }

  getEditByLocation(location: string): UserEdit | undefined {
    return this.edits.get(location);
  }

  clearEdits(): void {
    this.edits.clear();
    this.editCounter = 0;
  }

  hasEdits(): boolean {
    return this.edits.size > 0;
  }

  preserveUserEditsInContract(originalContract: Contract, userEdits: ContractEdits): Contract {
    const preservedContract = { ...originalContract };

    // Track all user edits
    this.trackContractEdits(originalContract, userEdits);

    // Apply preserved edits
    return this.applyPreservedEdits(preservedContract, userEdits);
  }

  regenerateWithPreservation(
    _blueprint: Blueprint, 
    existingContract: Contract, 
    newContract: Contract, 
    sections: string[]
  ): { contract: Contract; conflicts: EditConflict[] } {
    const conflicts: EditConflict[] = [];
    let preservedContract = { ...newContract };

    // Get existing user edits from the contract
    const existingEdits = this.extractEditsFromContract(existingContract);

    // For each section to regenerate
    for (const section of sections) {
      const sectionEdits = existingEdits.filter(edit => 
        edit.location.startsWith(section) && edit.preserved
      );

      for (const edit of sectionEdits) {
        const conflict = this.detectConflict(edit, newContract);
        if (conflict) {
          conflicts.push(conflict);
        } else {
          // Apply the edit if no conflict
          preservedContract = this.applyEditToContract(preservedContract, edit);
        }
      }
    }

    return { contract: preservedContract, conflicts };
  }

  resolveConflicts(contract: Contract, conflicts: EditConflict[], resolutions: Map<string, ConflictResolution>): Contract {
    let resolvedContract = { ...contract };

    for (const conflict of conflicts) {
      const resolution = resolutions.get(conflict.id);
      if (!resolution) continue;

      switch (resolution.action) {
        case 'keep-user':
          resolvedContract = this.applyEditToContract(resolvedContract, conflict.userEdit);
          break;
        case 'accept-ai':
          // AI suggestion is already in the contract, no action needed
          break;
        case 'merge':
          if (resolution.mergedValue !== undefined) {
            resolvedContract = this.applyValueToContract(resolvedContract, conflict.location, resolution.mergedValue);
          }
          break;
        case 'manual':
          // Manual resolution should be handled by the UI
          break;
      }
    }

    return resolvedContract;
  }

  private trackContractEdits(originalContract: Contract, userEdits: ContractEdits): void {
    // Track element edits
    if (userEdits.elementEdits) {
      for (const [elementId, edits] of Object.entries(userEdits.elementEdits)) {
        const originalElement = originalContract.elements.find(el => el.id === elementId);
        if (originalElement) {
          for (const [property, newValue] of Object.entries(edits)) {
            const location = `elements.${elementId}.${property}`;
            const originalValue = (originalElement as any)[property];
            this.trackEdit(location, originalValue, newValue, 'element');
          }
        }
      }
    }

    // Track operation edits
    if (userEdits.operationEdits) {
      for (const [operationId, edits] of Object.entries(userEdits.operationEdits)) {
        const originalOperation = originalContract.operations.find(op => op.id === operationId);
        if (originalOperation) {
          for (const [property, newValue] of Object.entries(edits)) {
            const location = `operations.${operationId}.${property}`;
            const originalValue = (originalOperation as any)[property];
            this.trackEdit(location, originalValue, newValue, 'operation');
          }
        }
      }
    }

    // Track layout edits
    if (userEdits.layoutEdits) {
      for (const [property, newValue] of Object.entries(userEdits.layoutEdits)) {
        const location = `layout.${property}`;
        const originalValue = (originalContract.layout as any)[property];
        this.trackEdit(location, originalValue, newValue, 'contract');
      }
    }

    // Track style edits
    if (userEdits.styleEdits) {
      for (const [property, newValue] of Object.entries(userEdits.styleEdits)) {
        const location = `styling.${property}`;
        const originalValue = (originalContract.styling as any)[property];
        this.trackEdit(location, originalValue, newValue, 'contract');
      }
    }
  }

  private applyPreservedEdits(contract: Contract, userEdits: ContractEdits): Contract {
    let modifiedContract = { ...contract };

    // Apply element edits
    if (userEdits.elementEdits) {
      modifiedContract.elements = contract.elements.map(element => {
        const edits = userEdits.elementEdits[element.id];
        if (edits) {
          return { ...element, ...edits };
        }
        return element;
      });
    }

    // Apply operation edits
    if (userEdits.operationEdits) {
      modifiedContract.operations = contract.operations.map(operation => {
        const edits = userEdits.operationEdits[operation.id];
        if (edits) {
          return { ...operation, ...edits };
        }
        return operation;
      });
    }

    // Apply layout edits
    if (userEdits.layoutEdits) {
      modifiedContract.layout = { ...contract.layout, ...userEdits.layoutEdits };
    }

    // Apply style edits
    if (userEdits.styleEdits) {
      modifiedContract.styling = { ...contract.styling, ...userEdits.styleEdits };
    }

    // Update metadata
    modifiedContract.metadata = {
      ...contract.metadata,
      updatedAt: new Date()
    };

    return modifiedContract;
  }

  private extractEditsFromContract(_contract: Contract): UserEdit[] {
    // In a real implementation, this would extract edit metadata stored in the contract
    // For now, return the current tracked edits
    return this.getEdits();
  }

  private detectConflict(edit: UserEdit, newContract: Contract): EditConflict | null {
    const currentValue = this.getValueFromContract(newContract, edit.location);
    
    // Check if the AI generated a different value than what the user had
    if (currentValue !== edit.newValue && currentValue !== edit.originalValue) {
      return {
        id: `conflict_${edit.id}`,
        location: edit.location,
        userEdit: edit,
        aiSuggestion: currentValue,
        conflictType: 'value-mismatch',
        resolutionOptions: [
          {
            id: 'keep-user',
            description: 'Keep your changes',
            action: 'keep-user'
          },
          {
            id: 'accept-ai',
            description: 'Accept AI suggestion',
            action: 'accept-ai'
          },
          {
            id: 'merge',
            description: 'Merge both values',
            action: 'merge',
            mergedValue: this.suggestMergedValue(edit.newValue, currentValue)
          }
        ]
      };
    }

    return null;
  }

  private applyEditToContract(contract: Contract, edit: UserEdit): Contract {
    return this.applyValueToContract(contract, edit.location, edit.newValue);
  }

  private applyValueToContract(contract: Contract, location: string, value: any): Contract {
    const modifiedContract = { ...contract };
    const pathParts = location.split('.');
    
    let current: any = modifiedContract;
    for (let i = 0; i < pathParts.length - 1; i++) {
      const part = pathParts[i];
      if (part === 'elements') {
        const elementId = pathParts[i + 1];
        const elementIndex = contract.elements.findIndex(el => el.id === elementId);
        if (elementIndex >= 0) {
          modifiedContract.elements = [...contract.elements];
          modifiedContract.elements[elementIndex] = { ...contract.elements[elementIndex] };
          current = modifiedContract.elements[elementIndex];
          i++; // Skip the element ID part
        }
      } else if (part === 'operations') {
        const operationId = pathParts[i + 1];
        const operationIndex = contract.operations.findIndex(op => op.id === operationId);
        if (operationIndex >= 0) {
          modifiedContract.operations = [...contract.operations];
          modifiedContract.operations[operationIndex] = { ...contract.operations[operationIndex] };
          current = modifiedContract.operations[operationIndex];
          i++; // Skip the operation ID part
        }
      } else {
        if (!(part in current)) {
          current[part] = {};
        }
        current = current[part];
      }
    }

    const finalProperty = pathParts[pathParts.length - 1];
    current[finalProperty] = value;

    return modifiedContract;
  }

  private getValueFromContract(contract: Contract, location: string): any {
    const pathParts = location.split('.');
    let current: any = contract;

    for (let i = 0; i < pathParts.length; i++) {
      const part = pathParts[i];
      if (part === 'elements') {
        const elementId = pathParts[i + 1];
        current = contract.elements.find(el => el.id === elementId);
        i++; // Skip the element ID part
      } else if (part === 'operations') {
        const operationId = pathParts[i + 1];
        current = contract.operations.find(op => op.id === operationId);
        i++; // Skip the operation ID part
      } else {
        current = current?.[part];
      }

      if (current === undefined) {
        return undefined;
      }
    }

    return current;
  }

  private suggestMergedValue(userValue: any, aiValue: any): any {
    // Simple merge strategy - in a real implementation this would be more sophisticated
    if (typeof userValue === 'string' && typeof aiValue === 'string') {
      return `${userValue} ${aiValue}`;
    }
    
    if (typeof userValue === 'object' && typeof aiValue === 'object') {
      return { ...aiValue, ...userValue };
    }

    // Default to user value
    return userValue;
  }
}