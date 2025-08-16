/**
 * EditTracker Tests
 * Requirements: 5.6, 10.4, 10.5, 10.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EditTracker } from '../EditTracker';
import { UserEdit } from '../../../interfaces/experience-editor';

describe('EditTracker', () => {
  let editTracker: EditTracker;

  beforeEach(() => {
    editTracker = new EditTracker();
  });

  it('tracks user edits', () => {
    const edit: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit);

    const edits = editTracker.getEdits('contract.name');
    expect(edits).toHaveLength(1);
    expect(edits[0].newValue).toBe('New Name');
  });

  it('gets all edits when no location specified', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.version',
      originalValue: '1.0.0',
      newValue: '2.0.0',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    const allEdits = editTracker.getEdits();
    expect(allEdits).toHaveLength(2);
  });

  it('clears edits for specific location', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.version',
      originalValue: '1.0.0',
      newValue: '2.0.0',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    editTracker.clearEdits('contract.name');

    expect(editTracker.getEdits('contract.name')).toHaveLength(0);
    expect(editTracker.getEdits('contract.version')).toHaveLength(1);
  });

  it('clears all edits when no location specified', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.version',
      originalValue: '1.0.0',
      newValue: '2.0.0',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    editTracker.clearEdits();

    expect(editTracker.getEdits()).toHaveLength(0);
  });

  it('preserves edits', () => {
    const edit: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit);
    editTracker.preserveEdits([edit]);

    const preservedEdits = editTracker.getPreservedEdits();
    expect(preservedEdits).toHaveLength(1);
    expect(preservedEdits[0].preserved).toBe(true);
  });

  it('gets latest edit for location', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(2023, 0, 1),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.name',
      originalValue: 'New Name',
      newValue: 'Newer Name',
      timestamp: new Date(2023, 0, 2),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    const latestEdit = editTracker.getLatestEdit('contract.name');
    expect(latestEdit?.newValue).toBe('Newer Name');
  });

  it('gets edit history sorted by timestamp', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(2023, 0, 2),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.name',
      originalValue: 'New Name',
      newValue: 'Newer Name',
      timestamp: new Date(2023, 0, 1),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    const history = editTracker.getEditHistory('contract.name');
    expect(history).toHaveLength(2);
    expect(history[0].timestamp.getTime()).toBeLessThan(history[1].timestamp.getTime());
  });

  it('reverts latest edit', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(2023, 0, 1),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.name',
      originalValue: 'New Name',
      newValue: 'Newer Name',
      timestamp: new Date(2023, 0, 2),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    const revertedEdit = editTracker.revertLatestEdit('contract.name');
    expect(revertedEdit?.newValue).toBe('Newer Name');

    const remainingEdits = editTracker.getEdits('contract.name');
    expect(remainingEdits).toHaveLength(1);
    expect(remainingEdits[0].newValue).toBe('New Name');
  });

  it('gets edit statistics', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.version',
      originalValue: '1.0.0',
      newValue: '2.0.0',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);
    editTracker.preserveEdits([edit1]);

    const stats = editTracker.getEditStats();
    expect(stats.totalEdits).toBe(2);
    expect(stats.preservedEdits).toBe(1);
    expect(stats.unpreservedEdits).toBe(1);
    expect(stats.locationsWithEdits).toBe(2);
    expect(stats.locationsWithPreservedEdits).toBe(1);
  });

  it('exports and imports edits', () => {
    const edit: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit);
    editTracker.preserveEdits([edit]);

    const exported = editTracker.exportEdits();
    const newTracker = new EditTracker();
    newTracker.importEdits(exported);

    const importedEdits = newTracker.getEdits();
    expect(importedEdits).toHaveLength(1);
    expect(importedEdits[0].newValue).toBe('New Name');
    expect(importedEdits[0].preserved).toBe(true);
  });

  it('creates and restores snapshots', () => {
    const edit: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(),
      preserved: false
    };

    editTracker.trackEdit(edit);
    const snapshot = editTracker.createSnapshot();

    // Make more changes
    const edit2: UserEdit = {
      location: 'contract.version',
      originalValue: '1.0.0',
      newValue: '2.0.0',
      timestamp: new Date(),
      preserved: false
    };
    editTracker.trackEdit(edit2);

    expect(editTracker.getEdits()).toHaveLength(2);

    // Restore snapshot
    editTracker.restoreFromSnapshot(snapshot);
    expect(editTracker.getEdits()).toHaveLength(1);
    expect(editTracker.getEdits()[0].newValue).toBe('New Name');
  });

  it('handles multiple edits for same location', () => {
    const edit1: UserEdit = {
      location: 'contract.name',
      originalValue: 'Old Name',
      newValue: 'New Name',
      timestamp: new Date(2023, 0, 1),
      preserved: false
    };

    const edit2: UserEdit = {
      location: 'contract.name',
      originalValue: 'New Name',
      newValue: 'Newer Name',
      timestamp: new Date(2023, 0, 2),
      preserved: false
    };

    editTracker.trackEdit(edit1);
    editTracker.trackEdit(edit2);

    const edits = editTracker.getEdits('contract.name');
    expect(edits).toHaveLength(2);
  });

  it('returns empty array for non-existent location', () => {
    const edits = editTracker.getEdits('non.existent.location');
    expect(edits).toHaveLength(0);
  });

  it('returns undefined for latest edit of non-existent location', () => {
    const latestEdit = editTracker.getLatestEdit('non.existent.location');
    expect(latestEdit).toBeUndefined();
  });

  it('returns undefined when reverting non-existent location', () => {
    const revertedEdit = editTracker.revertLatestEdit('non.existent.location');
    expect(revertedEdit).toBeUndefined();
  });
});