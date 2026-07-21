/**
 * Conflict Resolver Service - Resolves conflicts between AI changes and user edits
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

import { 
  ConflictResolver as IConflictResolver, 
  EditingConflict, 
  Resolution, 
  UserEdit,
  ResolutionOption 
} from '../../interfaces/experience-editor';

export class ConflictResolver implements IConflictResolver {
  /**
   * Detects conflicts between AI changes and user edits
   */
  detectConflicts(aiChanges: any, userEdits: UserEdit[]): EditingConflict[] {
    const conflicts: EditingConflict[] = [];
    
    // Group user edits by location
    const editsByLocation = new Map<string, UserEdit[]>();
    userEdits.forEach(edit => {
      const locationEdits = editsByLocation.get(edit.location) || [];
      locationEdits.push(edit);
      editsByLocation.set(edit.location, locationEdits);
    });

    // Check for conflicts with AI changes
    this.traverseObject(aiChanges, '', (path, aiValue) => {
      const userEditsForPath = editsByLocation.get(path);
      if (userEditsForPath && userEditsForPath.length > 0) {
        const latestUserEdit = userEditsForPath.reduce((latest, current) => 
          current.timestamp > latest.timestamp ? current : latest
        );

        // Check if AI value conflicts with user edit
        if (JSON.stringify(aiValue) !== JSON.stringify(latestUserEdit.newValue)) {
          const conflict = this.createConflict(path, aiValue, latestUserEdit);
          conflicts.push(conflict);
        }
      }
    });

    // Check for dependency conflicts
    const dependencyConflicts = this.detectDependencyConflicts(aiChanges, userEdits);
    conflicts.push(...dependencyConflicts);

    // Check for validation conflicts
    const validationConflicts = this.detectValidationConflicts(aiChanges, userEdits);
    conflicts.push(...validationConflicts);

    return conflicts;
  }

  /**
   * Resolves a conflict using the provided resolution
   */
  resolveConflict(conflict: EditingConflict, resolution: Resolution): any {
    const selectedOption = conflict.resolutionOptions.find(
      option => option.id === resolution.selectedOption
    );

    if (!selectedOption) {
      throw new Error(`Invalid resolution option: ${resolution.selectedOption}`);
    }

    switch (selectedOption.action) {
      case 'keep-user':
        return conflict.userEdit;

      case 'keep-ai':
        return conflict.aiSuggestion;

      case 'merge':
        return this.mergeValues(conflict.aiSuggestion, conflict.userEdit);

      case 'custom':
        if (resolution.customValue === undefined) {
          throw new Error('Custom resolution requires a custom value');
        }
        return resolution.customValue;

      default:
        throw new Error(`Unknown resolution action: ${selectedOption.action}`);
    }
  }

  /**
   * Merges AI changes with user edits
   */
  mergeChanges(aiChanges: any, userEdits: UserEdit[]): any {
    const merged = this.deepClone(aiChanges);
    
    // Apply user edits to the merged result
    userEdits.forEach(edit => {
      if (edit.preserved) {
        this.setValueAtPath(merged, edit.location, edit.newValue);
      }
    });

    return merged;
  }

  /**
   * Creates a conflict object
   */
  private createConflict(location: string, aiValue: any, userEdit: UserEdit): EditingConflict {
    const resolutionOptions: ResolutionOption[] = [
      {
        id: 'keep-user',
        description: 'Keep your changes',
        action: 'keep-user',
        preview: userEdit.newValue
      },
      {
        id: 'keep-ai',
        description: 'Accept AI suggestion',
        action: 'keep-ai',
        preview: aiValue
      }
    ];

    // Add merge option if values can be merged
    if (this.canMerge(aiValue, userEdit.newValue)) {
      resolutionOptions.push({
        id: 'merge',
        description: 'Merge both changes',
        action: 'merge',
        preview: this.mergeValues(aiValue, userEdit.newValue)
      });
    }

    // Always add custom option
    resolutionOptions.push({
      id: 'custom',
      description: 'Provide custom value',
      action: 'custom'
    });

    return {
      type: 'ai-user-conflict',
      location,
      aiSuggestion: aiValue,
      userEdit: userEdit.newValue,
      resolutionOptions
    };
  }

  /**
   * Detects dependency conflicts
   */
  private detectDependencyConflicts(aiChanges: any, userEdits: UserEdit[]): EditingConflict[] {
    const conflicts: EditingConflict[] = [];
    
    // Check for circular dependencies or broken references
    userEdits.forEach(edit => {
      if (this.createsDependencyConflict(edit, aiChanges)) {
        conflicts.push({
          type: 'dependency-conflict',
          location: edit.location,
          aiSuggestion: this.getValueAtPath(aiChanges, edit.location),
          userEdit: edit.newValue,
          resolutionOptions: [
            {
              id: 'fix-dependency',
              description: 'Fix dependency automatically',
              action: 'keep-ai'
            },
            {
              id: 'keep-user-fix-manually',
              description: 'Keep user edit and fix manually',
              action: 'keep-user'
            }
          ]
        });
      }
    });

    return conflicts;
  }

  /**
   * Detects validation conflicts
   */
  private detectValidationConflicts(aiChanges: any, userEdits: UserEdit[]): EditingConflict[] {
    const conflicts: EditingConflict[] = [];
    
    userEdits.forEach(edit => {
      if (this.createsValidationConflict(edit, aiChanges)) {
        conflicts.push({
          type: 'validation-conflict',
          location: edit.location,
          aiSuggestion: this.getValueAtPath(aiChanges, edit.location),
          userEdit: edit.newValue,
          resolutionOptions: [
            {
              id: 'fix-validation',
              description: 'Fix validation error automatically',
              action: 'keep-ai'
            },
            {
              id: 'keep-invalid',
              description: 'Keep user edit (may cause validation errors)',
              action: 'keep-user'
            }
          ]
        });
      }
    });

    return conflicts;
  }

  /**
   * Checks if two values can be merged
   */
  private canMerge(value1: any, value2: any): boolean {
    // Can merge objects
    if (this.isObject(value1) && this.isObject(value2)) {
      return true;
    }

    // Can merge arrays
    if (Array.isArray(value1) && Array.isArray(value2)) {
      return true;
    }

    // Can merge strings (concatenation)
    if (typeof value1 === 'string' && typeof value2 === 'string') {
      return true;
    }

    return false;
  }

  /**
   * Merges two values
   */
  private mergeValues(value1: any, value2: any): any {
    if (this.isObject(value1) && this.isObject(value2)) {
      return { ...value1, ...value2 };
    }

    if (Array.isArray(value1) && Array.isArray(value2)) {
      // Merge arrays by combining unique elements
      const combined = [...value1];
      value2.forEach(item => {
        if (!combined.some(existing => JSON.stringify(existing) === JSON.stringify(item))) {
          combined.push(item);
        }
      });
      return combined;
    }

    if (typeof value1 === 'string' && typeof value2 === 'string') {
      // For strings, prefer the user edit but indicate it's a merge
      return value2; // User edit takes precedence
    }

    // For other types, prefer user edit
    return value2;
  }

  /**
   * Checks if an edit creates a dependency conflict
   */
  private createsDependencyConflict(edit: UserEdit, aiChanges: any): boolean {
    // This is a simplified check - in a real implementation, you'd check
    // for circular references, broken references, etc.
    
    // Check if the edit references something that doesn't exist in AI changes
    if (typeof edit.newValue === 'object' && edit.newValue !== null) {
      return this.hasInvalidReferences(edit.newValue, aiChanges);
    }

    return false;
  }

  /**
   * Checks if an edit creates a validation conflict
   */
  private createsValidationConflict(edit: UserEdit, aiChanges: any): boolean {
    // This is a simplified check - in a real implementation, you'd run
    // full validation against the schema
    
    // Check for basic type mismatches
    const aiValue = this.getValueAtPath(aiChanges, edit.location);
    if (aiValue !== undefined && typeof aiValue !== typeof edit.newValue) {
      return true;
    }

    return false;
  }

  /**
   * Checks if an object has invalid references
   */
  private hasInvalidReferences(obj: any, context: any): boolean {
    // Simplified reference checking
    if (typeof obj === 'string' && obj.includes('_id')) {
      // Check if referenced ID exists in context
      return !this.findIdInContext(obj, context);
    }

    if (this.isObject(obj)) {
      return Object.values(obj).some(value => this.hasInvalidReferences(value, context));
    }

    if (Array.isArray(obj)) {
      return obj.some(item => this.hasInvalidReferences(item, context));
    }

    return false;
  }

  /**
   * Finds an ID in the context
   */
  private findIdInContext(id: string, context: any): boolean {
    // Simplified ID search
    return JSON.stringify(context).includes(id);
  }

  /**
   * Traverses an object and calls a callback for each path-value pair
   */
  private traverseObject(obj: any, basePath: string, callback: (path: string, value: any) => void): void {
    if (this.isObject(obj)) {
      Object.entries(obj).forEach(([key, value]) => {
        const path = basePath ? `${basePath}.${key}` : key;
        callback(path, value);
        this.traverseObject(value, path, callback);
      });
    } else if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        const path = `${basePath}[${index}]`;
        callback(path, item);
        this.traverseObject(item, path, callback);
      });
    }
  }

  /**
   * Gets a value at a specific path in an object
   */
  private getValueAtPath(obj: any, path: string): any {
    const parts = path.split(/[.[\]]+/).filter(Boolean);
    let current = obj;
    
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }
    
    return current;
  }

  /**
   * Sets a value at a specific path in an object
   */
  private setValueAtPath(obj: any, path: string, value: any): void {
    const parts = path.split(/[.[\]]+/).filter(Boolean);
    let current = obj;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!(part in current) || current[part] === null || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }
    
    const lastPart = parts[parts.length - 1];
    current[lastPart] = value;
  }

  /**
   * Deep clones an object
   */
  private deepClone(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime());
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.deepClone(item));
    }

    const cloned: any = {};
    Object.keys(obj).forEach(key => {
      cloned[key] = this.deepClone(obj[key]);
    });

    return cloned;
  }

  /**
   * Checks if a value is a plain object
   */
  private isObject(value: any): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
  }
}