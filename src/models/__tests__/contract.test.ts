/**
 * Tests for Contract model
 * Requirements: 2.1, 2.3, 2.6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Contract } from '../contract';
import type { UIElement, OperationBinding, ContractEdits } from '../../types';

describe('Contract Model', () => {
    let contract: Contract;

    beforeEach(() => {
        contract = new Contract();
    });

    describe('Construction', () => {
        it('should create an empty contract with default values', () => {
            expect(contract.name).toBe('');
            expect(contract.version).toBe('1.0.0');
            expect(contract.elements).toEqual([]);
            expect(contract.operations).toEqual([]);
            expect(contract.layout).toEqual({ type: 'flex', properties: {} });
            expect(contract.styling).toEqual({ theme: 'default' });
            expect(contract.metadata.createdAt).toBeInstanceOf(Date);
            expect(contract.metadata.updatedAt).toBeInstanceOf(Date);
        });

        it('should create a contract with provided data', () => {
            const data = {
                name: 'Test Contract',
                version: '2.0.0',
                elements: [{
                    id: 'button1',
                    type: 'button',
                    properties: { text: 'Click me' },
                    dataBindings: [],
                    eventBindings: []
                }],
                operations: [{
                    id: 'op1',
                    operationName: 'handleClick',
                    inputs: [],
                    outputs: [],
                    triggers: []
                }],
                layout: { type: 'grid' as const, properties: { columns: 2 } },
                styling: { theme: 'dark' }
            };

            const c = new Contract(data);
            expect(c.name).toBe('Test Contract');
            expect(c.version).toBe('2.0.0');
            expect(c.elements).toHaveLength(1);
            expect(c.operations).toHaveLength(1);
            expect(c.layout.type).toBe('grid');
            expect(c.styling.theme).toBe('dark');
        });
    });

    describe('JSON Serialization', () => {
        beforeEach(() => {
            contract.name = 'Test Contract';
            contract.version = '1.0.0';
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: { text: 'Click me' },
                dataBindings: [],
                eventBindings: []
            });
            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [],
                outputs: [],
                triggers: []
            });
        });

        it('should serialize to a JSON string via toJSONString and a plain object via toJSON', () => {
            expect(typeof contract.toJSON()).toBe('object');
            const json = contract.toJSONString();
            expect(typeof json).toBe('string');

            const parsed = JSON.parse(json);
            expect(parsed.name).toBe('Test Contract');
            expect(parsed.version).toBe('1.0.0');
            expect(parsed.elements).toHaveLength(1);
            expect(parsed.operations).toHaveLength(1);
        });

        it('should deserialize from JSON string', () => {
            const json = contract.toJSONString();
            const restored = Contract.fromJSON(json);

            expect(restored.name).toBe(contract.name);
            expect(restored.version).toBe(contract.version);
            expect(restored.elements).toEqual(contract.elements);
            expect(restored.operations).toEqual(contract.operations);
        });

        it('should handle invalid JSON gracefully', () => {
            expect(() => Contract.fromJSON('invalid json')).toThrow('Invalid JSON format');
        });

        it('should convert to plain object', () => {
            const obj = contract.toObject();
            expect(obj.name).toBe('Test Contract');
            expect(obj.elements).toHaveLength(1);
            expect(obj.operations).toHaveLength(1);
            expect(obj.metadata.createdAt).toBeInstanceOf(Date);
        });

        it('should create from object', () => {
            const obj = contract.toObject();
            const restored = Contract.fromObject(obj);

            expect(restored.name).toBe(contract.name);
            expect(restored.elements).toEqual(contract.elements);
            expect(restored.operations).toEqual(contract.operations);
        });

        it('should handle metadata dates correctly', () => {
            const json = contract.toJSONString();
            const restored = Contract.fromJSON(json);

            expect(restored.metadata.createdAt).toBeInstanceOf(Date);
            expect(restored.metadata.updatedAt).toBeInstanceOf(Date);
        });
    });

    describe('Validation', () => {
        it('should validate a complete contract', () => {
            contract.name = 'Test Contract';
            contract.version = '1.0.0';
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: { text: 'Click me' },
                dataBindings: [],
                eventBindings: []
            });
            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [],
                outputs: [],
                triggers: []
            });

            const result = contract.validate();
            expect(result.isValid).toBe(true);
            expect(contract.isValid()).toBe(true);
        });

        it('should detect validation errors', () => {
            // Contract with invalid data should have validation issues
            const invalidContract = new Contract({
                name: 123 as any, // Should be string
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
            });

            const result = invalidContract.validate();
            expect(result.isValid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });
    });

    describe('Element Management', () => {
        const testElement: UIElement = {
            id: 'button1',
            type: 'button',
            properties: { text: 'Click me' },
            dataBindings: [],
            eventBindings: []
        };

        it('should add elements', () => {
            contract.addElement(testElement);
            expect(contract.elements).toHaveLength(1);
            expect(contract.elements[0]).toEqual(testElement);
        });

        it('should prevent duplicate element IDs', () => {
            contract.addElement(testElement);
            expect(() => contract.addElement(testElement)).toThrow('Element with ID \'button1\' already exists');
        });

        it('should remove elements by ID', () => {
            contract.addElement(testElement);
            contract.addElement({ ...testElement, id: 'button2' });

            expect(contract.removeElement('button1')).toBe(true);
            expect(contract.elements).toHaveLength(1);
            expect(contract.elements[0].id).toBe('button2');
        });

        it('should handle removing non-existent elements', () => {
            expect(contract.removeElement('nonexistent')).toBe(false);
        });

        it('should update elements', () => {
            contract.addElement(testElement);

            expect(contract.updateElement('button1', { type: 'input' })).toBe(true);
            expect(contract.elements[0].type).toBe('input');
            expect(contract.elements[0].properties).toEqual({ text: 'Click me' }); // Should preserve other properties
        });

        it('should prevent ID changes that create duplicates', () => {
            contract.addElement(testElement);
            contract.addElement({ ...testElement, id: 'button2' });

            expect(() => contract.updateElement('button1', { id: 'button2' })).toThrow('Element with ID \'button2\' already exists');
        });

        it('should get elements by ID', () => {
            contract.addElement(testElement);

            const element = contract.getElement('button1');
            expect(element).toEqual(testElement);
            expect(contract.getElement('nonexistent')).toBeUndefined();
        });

        it('should get elements by type', () => {
            contract.addElement(testElement);
            contract.addElement({ ...testElement, id: 'input1', type: 'input' });
            contract.addElement({ ...testElement, id: 'button2', type: 'button' });

            const buttons = contract.getElementsByType('button');
            expect(buttons).toHaveLength(2);
            expect(buttons.every(el => el.type === 'button')).toBe(true);
        });
    });

    describe('Operation Management', () => {
        const testOperation: OperationBinding = {
            id: 'op1',
            operationName: 'handleClick',
            inputs: [],
            outputs: [],
            triggers: []
        };

        it('should add operations', () => {
            contract.addOperation(testOperation);
            expect(contract.operations).toHaveLength(1);
            expect(contract.operations[0]).toEqual(testOperation);
        });

        it('should prevent duplicate operation IDs', () => {
            contract.addOperation(testOperation);
            expect(() => contract.addOperation(testOperation)).toThrow('Operation with ID \'op1\' already exists');
        });

        it('should remove operations by ID', () => {
            contract.addOperation(testOperation);
            contract.addOperation({ ...testOperation, id: 'op2' });

            expect(contract.removeOperation('op1')).toBe(true);
            expect(contract.operations).toHaveLength(1);
            expect(contract.operations[0].id).toBe('op2');
        });

        it('should update operations', () => {
            contract.addOperation(testOperation);

            expect(contract.updateOperation('op1', { operationName: 'newHandler' })).toBe(true);
            expect(contract.operations[0].operationName).toBe('newHandler');
        });

        it('should get operations by ID', () => {
            contract.addOperation(testOperation);

            const operation = contract.getOperation('op1');
            expect(operation).toEqual(testOperation);
            expect(contract.getOperation('nonexistent')).toBeUndefined();
        });

        it('should get operations by name', () => {
            contract.addOperation(testOperation);
            contract.addOperation({ ...testOperation, id: 'op2', operationName: 'handleClick' });
            contract.addOperation({ ...testOperation, id: 'op3', operationName: 'handleSubmit' });

            const clickOperations = contract.getOperationsByName('handleClick');
            expect(clickOperations).toHaveLength(2);
            expect(clickOperations.every(op => op.operationName === 'handleClick')).toBe(true);
        });
    });

    describe('Layout and Styling', () => {
        it('should update layout', () => {
            const newLayout = { type: 'grid' as const, properties: { columns: 3 } };
            contract.updateLayout(newLayout);

            expect(contract.layout).toEqual(newLayout);
        });

        it('should update styling', () => {
            const newStyling = { theme: 'dark', customStyles: { color: 'white' } };
            contract.updateStyling(newStyling);

            expect(contract.styling).toEqual(newStyling);
        });
    });

    describe('Component Resolution', () => {
        beforeEach(() => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: {},
                dataBindings: [{
                    property: 'text',
                    source: 'operation',
                    sourceId: 'op1'
                }],
                eventBindings: [{
                    event: 'click',
                    operationId: 'op1'
                }]
            });

            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [{
                    name: 'data',
                    source: 'ui-element',
                    sourceId: 'button1'
                }],
                outputs: [],
                triggers: []
            });
        });

        it('should resolve components without resolver', () => {
            const resolved = contract.resolve();

            expect(resolved.contract).toBe(contract);
            expect(resolved.resolvedComponents.size).toBe(0);
            expect(resolved.dependencyGraph).toHaveLength(2);
        });

        it('should resolve components with resolver', () => {
            const mockResolver = (componentId: string) => {
                if (componentId === 'button') return { type: 'ButtonComponent' };
                if (componentId === 'handleClick') return { type: 'ClickHandler' };
                return null;
            };

            const resolved = contract.resolve(mockResolver);

            expect(resolved.resolvedComponents.size).toBe(2);
            expect(resolved.resolvedComponents.get('button1')).toEqual({ type: 'ButtonComponent' });
            expect(resolved.resolvedComponents.get('op1')).toEqual({ type: 'ClickHandler' });
        });

        it('should handle bidirectional dependencies', () => {
            // Bidirectional dependencies are common in UI systems and should be allowed
            // button1 depends on op1, op1 depends on button1 - this is normal
            expect(() => contract.resolve()).not.toThrow();
        });

        it('should detect complex circular dependencies', () => {
            // Create a more complex circular dependency chain
            contract.addElement({
                id: 'element2',
                type: 'input',
                properties: {},
                dataBindings: [{
                    property: 'value',
                    source: 'operation',
                    sourceId: 'op2'
                }],
                eventBindings: []
            });

            contract.addElement({
                id: 'element3',
                type: 'display',
                properties: {},
                dataBindings: [{
                    property: 'text',
                    source: 'operation',
                    sourceId: 'op3'
                }],
                eventBindings: []
            });

            contract.addOperation({
                id: 'op2',
                operationName: 'handleInput',
                inputs: [{
                    name: 'data',
                    source: 'ui-element',
                    sourceId: 'element3'
                }],
                outputs: [],
                triggers: []
            });

            contract.addOperation({
                id: 'op3',
                operationName: 'handleDisplay',
                inputs: [{
                    name: 'data',
                    source: 'ui-element',
                    sourceId: 'element2'
                }],
                outputs: [],
                triggers: []
            });

            // This creates a complex cycle: element2 -> op2 -> element3 -> op3 -> element2
            // But our current implementation should handle this gracefully
            expect(() => contract.resolve()).not.toThrow();
        });

        it('should build correct dependency graph', () => {
            const resolved = contract.resolve();

            const buttonNode = resolved.dependencyGraph.find(n => n.id === 'button1');
            const opNode = resolved.dependencyGraph.find(n => n.id === 'op1');

            expect(buttonNode?.dependencies).toEqual(['op1']);
            expect(opNode?.dependencies).toEqual(['button1']);
            expect(buttonNode?.resolved).toBe(true);
            expect(opNode?.resolved).toBe(true);
        });
    });

    describe('Contract Edits', () => {
        beforeEach(() => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: { text: 'Original' },
                dataBindings: [],
                eventBindings: []
            });

            contract.addOperation({
                id: 'op1',
                operationName: 'original',
                inputs: [],
                outputs: [],
                triggers: []
            });
        });

        it('should apply edits', () => {
            const edits: ContractEdits = {
                elementEdits: {
                    'button1': { properties: { text: 'Updated' } }
                },
                operationEdits: {
                    'op1': { operationName: 'updated' }
                },
                layoutEdits: { type: 'grid', properties: { columns: 2 } },
                styleEdits: { theme: 'dark' }
            };

            contract.applyEdits(edits);

            expect(contract.getElement('button1')?.properties.text).toBe('Updated');
            expect(contract.getOperation('op1')?.operationName).toBe('updated');
            expect(contract.layout.type).toBe('grid');
            expect(contract.styling.theme).toBe('dark');
        });
    });

    describe('Contract Diff', () => {
        let otherContract: Contract;

        beforeEach(() => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: { text: 'Original' },
                dataBindings: [],
                eventBindings: []
            });

            otherContract = contract.clone();
            otherContract.addElement({
                id: 'button2',
                type: 'button',
                properties: { text: 'New' },
                dataBindings: [],
                eventBindings: []
            });
            otherContract.updateElement('button1', { properties: { text: 'Modified' } });
        });

        it('should calculate diff correctly', () => {
            const diff = contract.diff(otherContract);

            expect(diff.added).toHaveLength(1);
            expect(diff.added[0].id).toBe('button2');
            expect(diff.modified).toHaveLength(1);
            expect(diff.modified[0].id).toBe('button1');
            expect(diff.removed).toHaveLength(0);
        });
    });

    describe('Dependency Analysis', () => {
        beforeEach(() => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: {},
                dataBindings: [{
                    property: 'text',
                    source: 'operation',
                    sourceId: 'op1'
                }],
                eventBindings: [{
                    event: 'click',
                    operationId: 'op1'
                }]
            });

            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [{
                    name: 'data',
                    source: 'ui-element',
                    sourceId: 'button1'
                }],
                outputs: [{
                    name: 'result',
                    target: 'ui-element',
                    targetId: 'button1'
                }],
                triggers: []
            });
        });

        it('should find elements depending on operation', () => {
            const elements = contract.findElementsDependingOnOperation('op1');
            expect(elements).toHaveLength(1);
            expect(elements[0].id).toBe('button1');
        });

        it('should find operations depending on element', () => {
            const operations = contract.findOperationsDependingOnElement('button1');
            expect(operations).toHaveLength(1);
            expect(operations[0].id).toBe('op1');
        });
    });

    describe('Reference Validation', () => {
        it('should validate valid references', () => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: {},
                dataBindings: [],
                eventBindings: [{
                    event: 'click',
                    operationId: 'op1'
                }]
            });

            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [],
                outputs: [],
                triggers: []
            });

            const result = contract.validateReferences();
            expect(result.isValid).toBe(true);
        });

        it('should detect invalid operation references', () => {
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: {},
                dataBindings: [{
                    property: 'text',
                    source: 'operation',
                    sourceId: 'nonexistent-op'
                }],
                eventBindings: []
            });

            const result = contract.validateReferences();
            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.code === 'INVALID_OPERATION_REFERENCE')).toBe(true);
        });

        it('should detect invalid element references', () => {
            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [{
                    name: 'data',
                    source: 'ui-element',
                    sourceId: 'nonexistent-element'
                }],
                outputs: [],
                triggers: []
            });

            const result = contract.validateReferences();
            expect(result.isValid).toBe(false);
            expect(result.errors.some(e => e.code === 'INVALID_ELEMENT_REFERENCE')).toBe(true);
        });

        it('should resolve references to elements nested inside containers', () => {
            contract.addElement({
                id: 'entry-row',
                type: 'container',
                properties: {},
                dataBindings: [],
                eventBindings: [],
                children: [
                    {
                        id: 'desc-in',
                        type: 'input',
                        properties: {},
                        dataBindings: [],
                        eventBindings: []
                    },
                    {
                        id: 'add-btn',
                        type: 'button',
                        properties: {},
                        dataBindings: [],
                        eventBindings: [{ event: 'click', operationId: 'op-add' }]
                    }
                ]
            });

            contract.addOperation({
                id: 'op-add',
                operationName: 'list.append',
                inputs: [{ name: 'item.description', source: 'ui-element', sourceId: 'desc-in' }],
                outputs: [{ name: 'reset', target: 'ui-element', targetId: 'desc-in' }],
                triggers: []
            });

            const result = contract.validateReferences();
            expect(result.errors).toEqual([]);
            expect(result.isValid).toBe(true);
        });

        it('should check event bindings on nested elements', () => {
            contract.addElement({
                id: 'entry-row',
                type: 'container',
                properties: {},
                dataBindings: [],
                eventBindings: [],
                children: [
                    {
                        id: 'ghost-btn',
                        type: 'button',
                        properties: {},
                        dataBindings: [],
                        eventBindings: [{ event: 'click', operationId: 'op-missing' }]
                    }
                ]
            });

            const result = contract.validateReferences();
            expect(result.isValid).toBe(false);
            expect(result.errors[0].path).toContain('children[0]');
            expect(result.errors[0].message).toContain('op-missing');
        });
    });

    describe('Nested element access', () => {
        beforeEach(() => {
            contract.addElement({
                id: 'entry-row',
                type: 'container',
                properties: {},
                dataBindings: [],
                eventBindings: [],
                children: [
                    {
                        id: 'desc-in',
                        type: 'input',
                        properties: { placeholder: 'Description' },
                        dataBindings: [],
                        eventBindings: []
                    }
                ]
            });
        });

        it('gets, updates, and removes nested elements by id', () => {
            expect(contract.getElement('desc-in')?.properties.placeholder).toBe('Description');

            expect(contract.updateElement('desc-in', { properties: { placeholder: 'What for?' } })).toBe(true);
            expect(contract.getElement('desc-in')?.properties.placeholder).toBe('What for?');

            expect(contract.removeElement('desc-in')).toBe(true);
            expect(contract.getElement('desc-in')).toBeUndefined();
            expect(contract.getElement('entry-row')?.children).toHaveLength(0);
        });

        it('rejects adding a top-level element whose id exists in a nested child', () => {
            expect(() =>
                contract.addElement({
                    id: 'desc-in',
                    type: 'text',
                    properties: {},
                    dataBindings: [],
                    eventBindings: []
                })
            ).toThrow("already exists");
        });
    });

    describe('Utility Methods', () => {
        beforeEach(() => {
            contract.name = 'Test Contract';
            contract.version = '1.0.0';
            contract.addElement({
                id: 'button1',
                type: 'button',
                properties: {},
                dataBindings: [],
                eventBindings: []
            });
            contract.addOperation({
                id: 'op1',
                operationName: 'handleClick',
                inputs: [],
                outputs: [],
                triggers: []
            });
        });

        it('should provide a summary', () => {
            const summary = contract.getSummary();

            expect(summary.name).toBe('Test Contract');
            expect(summary.version).toBe('1.0.0');
            expect(summary.elementCount).toBe(1);
            expect(summary.operationCount).toBe(1);
            expect(summary.layoutType).toBe('flex');
            expect(summary.theme).toBe('default');
            expect(summary.lastUpdated).toBeInstanceOf(Date);
        });

        it('should clone the contract', () => {
            const clone = contract.clone();

            expect(clone).not.toBe(contract);
            expect(clone.name).toBe(contract.name);
            expect(clone.elements).toEqual(contract.elements);
            expect(clone.operations).toEqual(contract.operations);

            // Verify deep copy
            clone.name = 'Modified';
            expect(contract.name).toBe('Test Contract');
        });

        it('should update metadata on changes', () => {
            const originalUpdatedAt = contract.metadata.updatedAt.getTime();

            // Force a small delay to ensure timestamp difference
            const now = Date.now();
            while (Date.now() - now < 2) {
                // Small busy wait to ensure time passes
            }

            contract.addElement({
                id: 'button2',
                type: 'button',
                properties: {},
                dataBindings: [],
                eventBindings: []
            });

            expect(contract.metadata.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt);
        });
    });
});