/**
 * Custom Component Manager Tests
 * Requirements: 7.1, 7.2, 7.5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomComponentManager } from '../custom-component-manager';
import type { UIElementManifest, OperationManifest } from '../../../types/component';

// Mock services
vi.mock('../component-registry', () => ({
    componentRegistry: {
        registerComponent: vi.fn()
    }
}));

vi.mock('../repository-service', () => ({
    repositoryService: {
        getComponent: vi.fn(),
        listComponents: vi.fn()
    }
}));

vi.mock('../discovery-service', () => ({
    discoveryService: {
        findByCapabilityRequirements: vi.fn(),
        getRecommendations: vi.fn(),
        searchSemantic: vi.fn()
    }
}));

import { componentRegistry } from '../component-registry';
import { repositoryService } from '../repository-service';
import { discoveryService } from '../discovery-service';

const mockComponentRegistry = vi.mocked(componentRegistry);
const mockRepositoryService = vi.mocked(repositoryService);
const mockDiscoveryService = vi.mocked(discoveryService);

describe('CustomComponentManager', () => {
    let manager: CustomComponentManager;

    const validUIElement: UIElementManifest = {
        id: 'custom-button',
        name: 'Custom Button',
        version: '1.0.0',
        type: 'ui-element',
        description: 'A custom button component',
        capabilities: ['clickable', 'styled'],
        dependencies: [],
        schema: {
            type: 'object',
            properties: {
                text: { type: 'string' }
            }
        },
        inputs: [
            { name: 'text', type: 'string', required: true }
        ],
        outputs: [
            { name: 'onClick', type: 'event' }
        ],
        renderFunction: 'renderCustomButton',
        styleSchema: {
            type: 'object',
            properties: {
                color: { type: 'string' }
            }
        }
    };

    const validOperation: OperationManifest = {
        id: 'custom-api',
        name: 'Custom API',
        version: '1.0.0',
        type: 'operation',
        description: 'A custom API operation',
        capabilities: ['http', 'async'],
        dependencies: [],
        schema: {
            type: 'object',
            properties: {
                url: { type: 'string' }
            }
        },
        inputs: [
            { name: 'url', type: 'string', required: true }
        ],
        outputs: [
            { name: 'response', type: 'object' }
        ],
        executionType: 'remote',
        implementation: {
            type: 'remote',
            endpoint: 'https://api.example.com',
            method: 'GET'
        }
    };

    beforeEach(() => {
        manager = new CustomComponentManager();
        vi.clearAllMocks();
    });

    describe('Component Validation', () => {
        it('should validate a valid UI element', async () => {
            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);

            const validation = await manager.validateCustomComponent(validUIElement);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        it('should validate a valid operation', async () => {
            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);

            const validation = await manager.validateCustomComponent(validOperation);

            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
        });

        it('should detect missing required fields', async () => {
            const invalidComponent = {
                ...validUIElement,
                id: '', // Missing required field
                name: '' // Missing required field
            };

            const validation = await manager.validateCustomComponent(invalidComponent);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toContain('Missing required field: id');
            expect(validation.errors).toContain('Missing required field: name');
        });

        it('should validate ID format', async () => {
            const invalidComponent = {
                ...validUIElement,
                id: 'Invalid_ID!' // Invalid characters
            };

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);

            const validation = await manager.validateCustomComponent(invalidComponent);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toContain('Component ID must contain only lowercase letters, numbers, and hyphens');
        });

        it('should warn about version format', async () => {
            const componentWithBadVersion = {
                ...validUIElement,
                version: 'v1' // Invalid version format
            };

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);

            const validation = await manager.validateCustomComponent(componentWithBadVersion);

            expect(validation.warnings).toContain('Version should follow semantic versioning (e.g., 1.0.0)');
        });

        it('should validate component type', async () => {
            const invalidComponent = {
                ...validUIElement,
                type: 'invalid-type' as 'ui-element' | 'operation'
            };

            const validation = await manager.validateCustomComponent(invalidComponent);

            expect(validation.valid).toBe(false);
            expect(validation.errors).toContain('Component type must be either "ui-element" or "operation"');
        });

        it('should suggest standard capabilities', async () => {
            const componentWithUnknownCaps = {
                ...validUIElement,
                capabilities: ['unknown-capability']
            };

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);

            const validation = await manager.validateCustomComponent(componentWithUnknownCaps);

            expect(validation.warnings).toContain('Unknown capabilities: unknown-capability');
            expect(validation.suggestions).toContain('Consider using standard capability names for better discoverability');
        });
    });

    describe('Component Registration', () => {
        it('should register a valid custom component', async () => {
            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);
            mockComponentRegistry.registerComponent.mockResolvedValue();

            await manager.registerCustomComponent(validUIElement);

            expect(mockComponentRegistry.registerComponent).toHaveBeenCalledWith(
                validUIElement,
                expect.objectContaining({ source: 'custom' })
            );
        });

        it('should auto-fix issues when requested', async () => {
            const componentWithIssues = {
                id: validUIElement.id,
                name: validUIElement.name,
                version: validUIElement.version,
                type: validUIElement.type,
                description: validUIElement.description,
                capabilities: [], // Missing capabilities
                dependencies: validUIElement.dependencies,
                inputs: validUIElement.inputs,
                outputs: validUIElement.outputs,
                renderFunction: validUIElement.renderFunction,
                styleSchema: validUIElement.styleSchema
                // Intentionally omitting schema to test auto-fix
            } as unknown as UIElementManifest;

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.findByCapabilityRequirements.mockResolvedValue([]);
            mockComponentRegistry.registerComponent.mockResolvedValue();

            await manager.registerCustomComponent(componentWithIssues, { autoFixIssues: true });

            // Check that the component was registered (auto-fix happens internally)
            expect(mockComponentRegistry.registerComponent).toHaveBeenCalledWith(
                expect.any(Object),
                expect.objectContaining({ source: 'custom' })
            );
        });

        it('should skip validation when requested', async () => {
            const invalidComponent = {
                ...validUIElement,
                id: '' // Invalid but should be skipped
            };

            mockComponentRegistry.registerComponent.mockResolvedValue();

            await manager.registerCustomComponent(invalidComponent, { skipValidation: true });

            expect(mockComponentRegistry.registerComponent).toHaveBeenCalled();
        });
    });

    describe('Integration Planning', () => {
        it('should create integration plan', async () => {
            mockRepositoryService.listComponents.mockResolvedValue([validOperation]);
            mockDiscoveryService.getRecommendations.mockResolvedValue([
                { component: validOperation, score: 80, reasons: ['Compatible'], compatibility: 'full' }
            ]);

            const integration = await manager.createIntegrationPlan(validUIElement);

            expect(integration.integrationPlan.length).toBeGreaterThan(0);
            expect(integration.integrationPlan[0].type).toBe('validate');
            expect(integration.integrationPlan.some(step => step.type === 'configure')).toBe(true);
            expect(integration.integrationPlan.some(step => step.type === 'test')).toBe(true);
        });

        it('should identify compatible components', async () => {
            const compatibleComponent = {
                ...validOperation,
                dependencies: [{ type: 'ui-element' as const, name: 'custom-button', version: '1.0.0', optional: false }]
            };

            mockRepositoryService.listComponents.mockResolvedValue([compatibleComponent]);
            mockDiscoveryService.getRecommendations.mockResolvedValue([]);

            const integration = await manager.createIntegrationPlan(validUIElement);

            expect(integration.compatible).toHaveLength(1);
            expect(integration.compatible[0].id).toBe('custom-api');
        });
    });

    describe('Dependency Resolution', () => {
        it('should resolve existing dependencies', async () => {
            const componentWithDeps = {
                ...validOperation,
                dependencies: [
                    { type: 'library' as const, name: 'axios', version: '1.0.0', optional: false }
                ]
            };

            const axiosComponent = {
                id: 'axios',
                name: 'Axios',
                version: '1.0.0',
                type: 'operation' as const,
                description: 'HTTP client',
                capabilities: ['http'],
                dependencies: [],
                schema: { type: 'object' },
                inputs: [],
                outputs: [],
                executionType: 'local' as const,
                implementation: { type: 'local' as const }
            };

            mockRepositoryService.getComponent.mockResolvedValue(axiosComponent);

            const resolution = await manager.resolveCustomDependencies(componentWithDeps);

            expect(resolution.resolved).toHaveLength(1);
            expect(resolution.resolved[0].id).toBe('axios');
            expect(resolution.missing).toHaveLength(0);
        });

        it('should identify missing dependencies', async () => {
            const componentWithMissingDeps = {
                ...validOperation,
                dependencies: [
                    { type: 'library' as const, name: 'missing-lib', version: '1.0.0', optional: false }
                ]
            };

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.searchSemantic.mockResolvedValue([]);

            const resolution = await manager.resolveCustomDependencies(componentWithMissingDeps);

            expect(resolution.resolved).toHaveLength(0);
            expect(resolution.missing).toHaveLength(1);
            expect(resolution.missing[0].name).toBe('missing-lib');
        });

        it('should find alternative dependencies', async () => {
            const componentWithMissingDeps = {
                ...validOperation,
                dependencies: [
                    { type: 'library' as const, name: 'missing-lib', version: '1.0.0', optional: false }
                ]
            };

            const alternativeComponent = {
                id: 'alternative-lib',
                name: 'Alternative Library',
                version: '1.0.0',
                type: 'operation' as const,
                description: 'Alternative HTTP client',
                capabilities: ['http'],
                dependencies: [],
                schema: { type: 'object' },
                inputs: [],
                outputs: [],
                executionType: 'local' as const,
                implementation: { type: 'local' as const }
            };

            mockRepositoryService.getComponent.mockResolvedValue(null);
            mockDiscoveryService.searchSemantic.mockResolvedValue([alternativeComponent]);

            const resolution = await manager.resolveCustomDependencies(componentWithMissingDeps);

            expect(resolution.alternatives['missing-lib']).toHaveLength(1);
            expect(resolution.alternatives['missing-lib'][0].id).toBe('alternative-lib');
        });
    });

    describe('Component Templates', () => {
        it('should provide built-in templates', () => {
            const templates = manager.getAvailableTemplates();

            expect(templates.length).toBeGreaterThan(0);
            expect(templates.some(t => t.type === 'ui-element')).toBe(true);
            expect(templates.some(t => t.type === 'operation')).toBe(true);
        });

        it('should generate UI element template', () => {
            const template = manager.generateComponentTemplate('ui-element', ['clickable']);

            expect(template.type).toBe('ui-element');
            expect(template.baseCapabilities).toContain('clickable');
            expect(template.requiredFields).toContain('renderFunction');
        });

        it('should generate operation template', () => {
            const template = manager.generateComponentTemplate('operation', ['http']);

            expect(template.type).toBe('operation');
            expect(template.baseCapabilities).toContain('http');
            expect(template.requiredFields).toContain('executionType');
        });

        it('should create component from template', () => {
            const template = manager.getTemplate('basic-ui-element');
            expect(template).toBeDefined();

            const component = manager.createFromTemplate('basic-ui-element', {
                id: 'my-custom-element',
                name: 'My Custom Element'
            });

            expect(component.id).toBe('my-custom-element');
            expect(component.name).toBe('My Custom Element');
            expect(component.type).toBe('ui-element');
        });

        it('should validate required fields when creating from template', () => {
            expect(() => {
                manager.createFromTemplate('basic-ui-element', {
                    id: '', // Empty required field
                    name: 'Test Component'
                });
            }).toThrow('Required field id missing from component manifest');
        });
    });

    describe('Error Handling', () => {
        it('should handle invalid template ID', () => {
            expect(() => {
                manager.createFromTemplate('non-existent-template', {});
            }).toThrow('Template non-existent-template not found');
        });

        it('should handle validation failures during registration', async () => {
            const invalidComponent = {
                ...validUIElement,
                id: '' // Invalid
            };

            await expect(manager.registerCustomComponent(invalidComponent))
                .rejects.toThrow('Custom component validation failed');
        });
    });
});