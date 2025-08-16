/**
 * Edit Tracker Service - Tracks user edits for preservation
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

import { EditTracker as IEditTracker, UserEdit } from '../../interfaces/experience-editor';

export class EditTracker implements IEditTracker {
  private edits: Map<string, UserEdit[]> = new Map();
  private preservedEdits: Set<string> = new Set();

  /**
   * Tracks a user edit
   */
  trackEdit(edit: UserEdit): void {
    const locationEdits = this.edits.get(edit.location) || [];
    
    // Add the new edit (preserve the original timestamp if provided)
    const newEdit = {
      ...edit,
      timestamp: edit.timestamp || new Date(),
      preserved: edit.preserved || false
    };
    
    locationEdits.push(newEdit);
    
    this.edits.set(edit.location, locationEdits);
  }

  /**
   * Gets edits for a specific location or all edits
   */
  getEdits(location?: string): UserEdit[] {
    if (location) {
      return this.edits.get(location) || [];
    }
    
    // Return all edits
    const allEdits: UserEdit[] = [];
    for (const locationEdits of this.edits.values()) {
      allEdits.push(...locationEdits);
    }
    
    return allEdits.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Clears edits for a specific location or all edits
   */
  clearEdits(location?: string): void {
    if (location) {
      this.edits.delete(location);
      this.preservedEdits.delete(location);
    } else {
      this.edits.clear();
      this.preservedEdits.clear();
    }
  }

  /**
   * Marks edits as preserved
   */
  preserveEdits(edits: UserEdit[]): void {
    edits.forEach(edit => {
      const locationEdits = this.edits.get(edit.location) || [];
      const editIndex = locationEdits.findIndex(
        e => e.timestamp.getTime() === edit.timestamp.getTime()
      );
      
      if (editIndex !== -1) {
        locationEdits[editIndex] = { ...edit, preserved: true };
        this.edits.set(edit.location, locationEdits);
        this.preservedEdits.add(edit.location);
      }
    });
  }

  /**
   * Gets all preserved edits
   */
  getPreservedEdits(): UserEdit[] {
    return this.getEdits().filter(edit => edit.preserved);
  }

  /**
   * Gets all unpreserved edits
   */
  getUnpreservedEdits(): UserEdit[] {
    return this.getEdits().filter(edit => !edit.preserved);
  }

  /**
   * Checks if a location has preserved edits
   */
  hasPreservedEdits(location: string): boolean {
    return this.preservedEdits.has(location);
  }

  /**
   * Gets the latest edit for a specific location
   */
  getLatestEdit(location: string): UserEdit | undefined {
    const locationEdits = this.edits.get(location) || [];
    if (locationEdits.length === 0) return undefined;
    
    return locationEdits.reduce((latest, current) => 
      current.timestamp > latest.timestamp ? current : latest
    );
  }

  /**
   * Gets edit history for a specific location
   */
  getEditHistory(location: string): UserEdit[] {
    return (this.edits.get(location) || [])
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Reverts the latest edit for a location
   */
  revertLatestEdit(location: string): UserEdit | undefined {
    const locationEdits = this.edits.get(location) || [];
    if (locationEdits.length === 0) return undefined;
    
    const latestEdit = locationEdits.pop();
    
    if (locationEdits.length === 0) {
      this.edits.delete(location);
      this.preservedEdits.delete(location);
    } else {
      this.edits.set(location, locationEdits);
    }
    
    return latestEdit;
  }

  /**
   * Gets statistics about tracked edits
   */
  getEditStats(): {
    totalEdits: number;
    preservedEdits: number;
    unpreservedEdits: number;
    locationsWithEdits: number;
    locationsWithPreservedEdits: number;
  } {
    const allEdits = this.getEdits();
    const preservedEdits = allEdits.filter(edit => edit.preserved);
    
    return {
      totalEdits: allEdits.length,
      preservedEdits: preservedEdits.length,
      unpreservedEdits: allEdits.length - preservedEdits.length,
      locationsWithEdits: this.edits.size,
      locationsWithPreservedEdits: this.preservedEdits.size
    };
  }

  /**
   * Exports all edits to JSON
   */
  exportEdits(): string {
    const editsData = {
      edits: Array.from(this.edits.entries()),
      preservedEdits: Array.from(this.preservedEdits),
      exportedAt: new Date().toISOString()
    };
    
    return JSON.stringify(editsData, null, 2);
  }

  /**
   * Imports edits from JSON
   */
  importEdits(jsonData: string): void {
    try {
      const editsData = JSON.parse(jsonData);
      
      this.edits.clear();
      this.preservedEdits.clear();
      
      // Restore edits
      editsData.edits.forEach(([location, locationEdits]: [string, UserEdit[]]) => {
        const restoredEdits = locationEdits.map(edit => ({
          ...edit,
          timestamp: new Date(edit.timestamp)
        }));
        this.edits.set(location, restoredEdits);
      });
      
      // Restore preserved edits set
      editsData.preservedEdits.forEach((location: string) => {
        this.preservedEdits.add(location);
      });
    } catch (error) {
      throw new Error(`Failed to import edits: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Creates a snapshot of current edits state
   */
  createSnapshot(): EditSnapshot {
    return {
      edits: new Map(this.edits),
      preservedEdits: new Set(this.preservedEdits),
      timestamp: new Date()
    };
  }

  /**
   * Restores edits from a snapshot
   */
  restoreFromSnapshot(snapshot: EditSnapshot): void {
    this.edits = new Map(snapshot.edits);
    this.preservedEdits = new Set(snapshot.preservedEdits);
  }
}

export interface EditSnapshot {
  edits: Map<string, UserEdit[]>;
  preservedEdits: Set<string>;
  timestamp: Date;
}