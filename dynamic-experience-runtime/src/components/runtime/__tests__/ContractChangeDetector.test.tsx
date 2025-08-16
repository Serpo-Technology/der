/**
 * Tests for Contract Change Detector
 * Requirements: 3.5, 9.2, 9.3, 9.4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ContractChangeDetector } from '../ContractChangeDetector';
import { Contract, UIElement, OperationBinding } from '../../../types/contract';

describe('ContractChangeDetector', () => {
  let detector: ContractChangeDetector;
  let baseContract: Contract;

  beforeEach(() => {
    detector = new ContractChangeDetector();
    baseContract = {
      name: 'TestContract',
      version: '1.0.0',
      elements: [
        {
          id: 'button1',
          type: 'button',
          properties: { text: 'Click me' },
          dataBindings: [],
          eventBindings: []
        },
        {
          id: 'input1',
          type: 'input',
          properties: { placeholder: 'Enter text' },
          dataBindings: [],
          eventBindings: []
        }
      ],
      operations: [
        {
          id: 'op1',
          operationName: 'testOperation',
          inputs: [],
          outputs: [],
          triggers: []
        }
      ],
      layout: { type: 'flex', properties: { flexDirection: 'column' } },
      styling: { theme: 'default' },
      metadata: {
        createdAt: new Date('2023-01-01'),
        updatedAt: new Date('2023-01-01'),
        version: '1.0.0'
      }
    };
  });

  describe('initial detection', () => {
    it('detects initial contract as all new', () => {
      const analysis = detector.detectChanges(baseContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.requiresFullRerender).toBe(true);
      expect(analysis.affectedElements).toEqual(['button1', 'input1']);
      expect(analysis.affectedOperations).toEqual(['op1']);
      expect(analysis.delta.added).toEqual(baseContract.elements);
    });

    it('returns no changes for identical contract', () => {
      detector.detectChanges(baseContract);
      const analysis = detector.detectChanges(baseContract);

      expect(analysis.hasChanges).toBe(false);
      expect(analysis.changes).toHaveLength(0);
    });
  });

  describe('element changes', () => {
    beforeEach(() => {
      detector.detectChanges(baseContract); // Set initial state
    });

    it('detects added elements', () => {
      const newContract = {
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

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes).toHaveLength(1);
      expect(analysis.changes[0].type).toBe('element');
      expect(analysis.changes[0].action).toBe('added');
      expect(analysis.changes[0].elementId).toBe('text1');
      expect(analysis.affectedElements).toContain('text1');
    });

    it('detects removed elements', () => {
      const newContract = {
        ...baseContract,
        elements: [baseContract.elements[0]] // Remove input1
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes).toHaveLength(1);
      expect(analysis.changes[0].type).toBe('element');
      expect(analysis.changes[0].action).toBe('removed');
      expect(analysis.changes[0].elementId).toBe('input1');
      expect(analysis.affectedElements).toContain('input1');
      expect(analysis.delta.removed).toContain('input1');
    });

    it('detects modified elements', () => {
      const newContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated text' }
          },
          baseContract.elements[1]
        ]
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes).toHaveLength(1);
      expect(analysis.changes[0].type).toBe('element');
      expect(analysis.changes[0].action).toBe('modified');
      expect(analysis.changes[0].elementId).toBe('button1');
      expect(analysis.affectedElements).toContain('button1');
    });

    it('detects multiple element changes', () => {
      const newContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated button' }
          },
          // Remove input1
          {
            id: 'text1',
            type: 'text',
            properties: { text: 'New text' },
            dataBindings: [],
            eventBindings: []
          }
        ]
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes).toHaveLength(3); // modified, removed, added
      expect(analysis.affectedElements).toEqual(expect.arrayContaining(['button1', 'input1', 'text1']));
    });
  });

  describe('operation changes', () => {
    beforeEach(() => {
      detector.detectChanges(baseContract); // Set initial state
    });

    it('detects added operations', () => {
      const newContract = {
        ...baseContract,
        operations: [
          ...baseContract.operations,
          {
            id: 'op2',
            operationName: 'newOperation',
            inputs: [],
            outputs: [],
            triggers: []
          }
        ]
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes.some(c => c.type === 'operation' && c.action === 'added')).toBe(true);
      expect(analysis.affectedOperations).toContain('op2');
    });

    it('detects removed operations', () => {
      const newContract = {
        ...baseContract,
        operations: [] // Remove all operations
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes.some(c => c.type === 'operation' && c.action === 'removed')).toBe(true);
      expect(analysis.affectedOperations).toContain('op1');
    });

    it('detects modified operations', () => {
      const newContract = {
        ...baseContract,
        operations: [
          {
            ...baseContract.operations[0],
            operationName: 'updatedOperation'
          }
        ]
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes.some(c => c.type === 'operation' && c.action === 'modified')).toBe(true);
      expect(analysis.affectedOperations).toContain('op1');
    });
  });

  describe('layout and styling changes', () => {
    beforeEach(() => {
      detector.detectChanges(baseContract); // Set initial state
    });

    it('detects layout changes', () => {
      const newContract = {
        ...baseContract,
        layout: { type: 'grid' as const, properties: { gridTemplateColumns: '1fr 1fr' } }
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.requiresFullRerender).toBe(true);
      expect(analysis.changes.some(c => c.type === 'layout')).toBe(true);
    });

    it('detects styling changes', () => {
      const newContract = {
        ...baseContract,
        styling: { theme: 'dark' }
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.requiresFullRerender).toBe(true);
      expect(analysis.changes.some(c => c.type === 'styling')).toBe(true);
    });

    it('detects metadata changes', () => {
      const newContract = {
        ...baseContract,
        metadata: {
          ...baseContract.metadata,
          version: '1.1.0'
        }
      };

      const analysis = detector.detectChanges(newContract);

      expect(analysis.hasChanges).toBe(true);
      expect(analysis.changes.some(c => c.type === 'metadata')).toBe(true);
    });
  });

  describe('change analysis', () => {
    beforeEach(() => {
      detector.detectChanges(baseContract); // Set initial state
    });

    it('requires full rerender for layout changes', () => {
      const newContract = {
        ...baseContract,
        layout: { type: 'absolute' as const, properties: {} }
      };

      const analysis = detector.detectChanges(newContract);
      expect(analysis.requiresFullRerender).toBe(true);
    });

    it('requires full rerender for large structural changes', () => {
      const manyChildren = Array.from({ length: 10 }, (_, i) => ({
        id: `child${i}`,
        type: 'text',
        properties: { text: `Child ${i}` },
        dataBindings: [],
        eventBindings: []
      }));

      const newContract = {
        ...baseContract,
        elements: [
          ...baseContract.elements,
          {
            id: 'container1',
            type: 'container',
            properties: {},
            dataBindings: [],
            eventBindings: [],
            children: manyChildren
          }
        ]
      };

      const analysis = detector.detectChanges(newContract);
      expect(analysis.requiresFullRerender).toBe(true);
    });

    it('does not require full rerender for simple property changes', () => {
      const newContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated text' }
          },
          baseContract.elements[1]
        ]
      };

      const analysis = detector.detectChanges(newContract);
      expect(analysis.requiresFullRerender).toBe(false);
    });
  });

  describe('utility methods', () => {
    beforeEach(() => {
      detector.detectChanges(baseContract); // Set initial state
    });

    it('checks if specific element has changed', () => {
      const newContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated' }
          },
          baseContract.elements[1]
        ]
      };

      const analysis = detector.detectChanges(newContract);
      
      expect(detector.hasElementChanged('button1', analysis.changes)).toBe(true);
      expect(detector.hasElementChanged('input1', analysis.changes)).toBe(false);
    });

    it('checks if specific operation has changed', () => {
      const newContract = {
        ...baseContract,
        operations: [
          {
            ...baseContract.operations[0],
            operationName: 'updated'
          }
        ]
      };

      const analysis = detector.detectChanges(newContract);
      
      expect(detector.hasOperationChanged('op1', analysis.changes)).toBe(true);
    });

    it('gets changes for specific element', () => {
      const newContract = {
        ...baseContract,
        elements: [
          {
            ...baseContract.elements[0],
            properties: { text: 'Updated' }
          },
          baseContract.elements[1]
        ]
      };

      const analysis = detector.detectChanges(newContract);
      const elementChanges = detector.getElementChanges('button1', analysis.changes);
      
      expect(elementChanges).toHaveLength(1);
      expect(elementChanges[0].action).toBe('modified');
    });

    it('resets detector state', () => {
      detector.reset();
      expect(detector.getCurrentContract()).toBeNull();
      
      const analysis = detector.detectChanges(baseContract);
      expect(analysis.requiresFullRerender).toBe(true);
    });
  });

  describe('deep equality', () => {
    it('correctly compares primitive values', () => {
      const contract1 = { ...baseContract, name: 'Test1' };
      const contract2 = { ...baseContract, name: 'Test2' };

      detector.detectChanges(contract1);
      const analysis = detector.detectChanges(contract2);

      expect(analysis.hasChanges).toBe(true);
    });

    it('correctly compares nested objects', () => {
      const contract1 = {
        ...baseContract,
        layout: { type: 'flex' as const, properties: { flexDirection: 'row' } }
      };
      const contract2 = {
        ...baseContract,
        layout: { type: 'flex' as const, properties: { flexDirection: 'column' } }
      };

      detector.detectChanges(contract1);
      const analysis = detector.detectChanges(contract2);

      expect(analysis.hasChanges).toBe(true);
    });

    it('correctly compares arrays', () => {
      const contract1 = {
        ...baseContract,
        elements: [baseContract.elements[0]]
      };
      const contract2 = {
        ...baseContract,
        elements: [baseContract.elements[0], baseContract.elements[1]]
      };

      detector.detectChanges(contract1);
      const analysis = detector.detectChanges(contract2);

      expect(analysis.hasChanges).toBe(true);
    });
  });
});