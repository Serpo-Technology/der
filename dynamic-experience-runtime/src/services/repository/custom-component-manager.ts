/**
 * Custom Component Manager
 * Requirements: 7.1, 7.2, 7.5
 * 
 * Creates manifest validation for custom UI elements and operations,
 * implements custom component integration with standard components,
 * and writes dependency resolution for custom component requirements.
 */

import type {
    ComponentManifest,
    UIElementManifest,
    OperationManifest,
    Dependency,
    JSONSchema,
    InputSpec,
    OutputSpec,
    OperationImplementation
} from '../../types/component';
import { componentRegistry, type ComponentRegistryOptions } from './component-registry';
import { repositoryService } from './repository-service';
import { discoveryService, type ComponentRecommendation } from './discovery-service';

export interface CustomComponentValidation {
    valid: boolean;
    errors: string[];
    warnings: string[];
    suggestions: string[];
}

export interface CustomComponentIntegration {
    compatible: ComponentManifest[];
    conflicts: ComponentManifest[];
    recommendations: ComponentManifest[];
    integrationPlan: IntegrationStep[];
}

export interface IntegrationStep {
    type: 'install' | 'configure' | 'validate' | 'test';
    description: string;
    component?: ComponentManifest;
    dependencies?: Dependency[];
    optional: boolean;
}

export interface CustomComponentTemplate {
    id: string;
    name: string;
    type: 'ui-element' | 'operation';
    description: string;
    baseCapabilities: string[];
    requiredFields: string[];
    optionalFields: string[];
    exampleManifest: Partial<ComponentManifest> & {
        inputs?: InputSpec[];
        outputs?: OutputSpec[];
        renderFunction?: string;
        executionType?: string;
        implementation?: OperationImplementation;
        styleSchema?: JSONSchema;
    };
}

export class CustomComponentManager {
    private templates: Map<string, CustomComponentTemplate> = new Map();

    constructor() {
        this.initializeTemplates();
    }

    /**
     * Validate a custom component manifest
     */
    async validateCustomComponent(manifest: ComponentManifest): Promise<CustomComponentValidation> {
        const errors: string[] = [];
        const warnings: string[] = [];
        const suggestions: string[] = [];

        // Basic manifest validation
        const basicValidation = this.validateBasicManifest(manifest);
        errors.push(...basicValidation.errors);
        warnings.push(...basicValidation.warnings);

        // Schema validation
        const schemaValidation = this.validateComponentSchema(manifest);
        errors.push(...schemaValidation.errors);
        warnings.push(...schemaValidation.warnings);

        // Capability validation
        const capabilityValidation = await this.validateCapabilities(manifest);
        errors.push(...capabilityValidation.errors);
        warnings.push(...capabilityValidation.warnings);
        suggestions.push(...capabilityValidation.suggestions);

        // Dependency validation
        const dependencyValidation = await this.validateCustomDependencies(manifest);
        errors.push(...dependencyValidation.errors);
        warnings.push(...dependencyValidation.warnings);

        // Integration validation
        const integrationValidation = await this.validateIntegration(manifest);
        warnings.push(...integrationValidation.warnings);
        suggestions.push(...integrationValidation.suggestions);

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            suggestions
        };
    }

    /**
     * Register a custom component with enhanced validation
     */
    async registerCustomComponent(
        manifest: ComponentManifest,
        options: ComponentRegistryOptions & {
            skipValidation?: boolean;
            autoFixIssues?: boolean;
        } = {}
    ): Promise<void> {
        const { skipValidation = false, autoFixIssues = false, ...registryOptions } = options;

        if (!skipValidation) {
            const validation = await this.validateCustomComponent(manifest);

            if (!validation.valid) {
                if (autoFixIssues) {
                    manifest = await this.autoFixManifest(manifest, validation);
                } else {
                    throw new Error(`Custom component validation failed: ${validation.errors.join(', ')}`);
                }
            }
        }

        // Register with custom source
        await componentRegistry.registerComponent(manifest, {
            ...registryOptions,
            source: 'custom'
        });
    }

    /**
     * Create integration plan for custom component
     */
    async createIntegrationPlan(manifest: ComponentManifest): Promise<CustomComponentIntegration> {
        const compatible: ComponentManifest[] = [];
        const conflicts: ComponentManifest[] = [];
        const recommendations: ComponentManifest[] = [];
        const integrationPlan: IntegrationStep[] = [];

        // Find compatible components
        const allComponents = await repositoryService.listComponents();

        for (const component of allComponents) {
            if (this.areComponentsCompatible(manifest, component)) {
                compatible.push(component);
            } else if (this.haveConflicts(manifest, component)) {
                conflicts.push(component);
            }
        }

        // Get recommendations for complementary components
        const recs = await discoveryService.getRecommendations([manifest.id]);
        recommendations.push(...recs.map(r => r.component));

        // Create integration steps
        integrationPlan.push({
            type: 'validate',
            description: 'Validate custom component manifest',
            component: manifest,
            optional: false
        });

        // Add dependency installation steps
        for (const dep of manifest.dependencies) {
            if (!dep.optional) {
                integrationPlan.push({
                    type: 'install',
                    description: `Install required dependency: ${dep.name}@${dep.version}`,
                    dependencies: [dep],
                    optional: false
                });
            }
        }

        // Add configuration step
        integrationPlan.push({
            type: 'configure',
            description: 'Configure component integration with existing components',
            component: manifest,
            optional: false
        });

        // Add testing step
        integrationPlan.push({
            type: 'test',
            description: 'Test component functionality and integration',
            component: manifest,
            optional: true
        });

        return {
            compatible,
            conflicts,
            recommendations,
            integrationPlan
        };
    }

    /**
     * Resolve custom component dependencies
     */
    async resolveCustomDependencies(manifest: ComponentManifest): Promise<{
        resolved: ComponentManifest[];
        missing: Dependency[];
        alternatives: { [depName: string]: ComponentManifest[] };
        installationOrder: ComponentManifest[];
    }> {
        const resolved: ComponentManifest[] = [];
        const missing: Dependency[] = [];
        const alternatives: { [depName: string]: ComponentManifest[] } = {};
        const installationOrder: ComponentManifest[] = [];

        // Process each dependency
        for (const dep of manifest.dependencies) {
            const depComponent = await repositoryService.getComponent(dep.name, dep.version);

            if (depComponent) {
                resolved.push(depComponent);
            } else {
                // Try to find alternatives
                const alts = await this.findAlternativeDependencies(dep);
                if (alts.length > 0) {
                    alternatives[dep.name] = alts;
                } else if (!dep.optional) {
                    missing.push(dep);
                }
            }
        }

        // Calculate installation order (topological sort)
        installationOrder.push(...this.calculateInstallationOrder(resolved));

        return {
            resolved,
            missing,
            alternatives,
            installationOrder
        };
    }

    /**
     * Generate custom component template
     */
    generateComponentTemplate(
        type: 'ui-element' | 'operation',
        baseCapabilities: string[] = []
    ): CustomComponentTemplate {
        const templateId = `custom-${type}-${Date.now()}`;

        const baseTemplate: CustomComponentTemplate = {
            id: templateId,
            name: `Custom ${type === 'ui-element' ? 'UI Element' : 'Operation'}`,
            type,
            description: `A custom ${type} component`,
            baseCapabilities,
            requiredFields: ['id', 'name', 'version', 'type', 'description', 'capabilities'],
            optionalFields: ['dependencies', 'schema'],
            exampleManifest: {
                id: templateId,
                name: `Custom ${type === 'ui-element' ? 'UI Element' : 'Operation'}`,
                version: '1.0.0',
                type,
                description: `A custom ${type} component`,
                capabilities: baseCapabilities,
                dependencies: [],
                schema: {
                    type: 'object',
                    properties: {}
                }
            }
        };

        if (type === 'ui-element') {
            baseTemplate.requiredFields.push('inputs', 'outputs', 'renderFunction');
            baseTemplate.optionalFields.push('styleSchema');
            const uiManifest = baseTemplate.exampleManifest as Partial<UIElementManifest>;
            uiManifest.inputs = [];
            uiManifest.outputs = [];
            uiManifest.renderFunction = 'renderCustomElement';
        } else {
            baseTemplate.requiredFields.push('inputs', 'outputs', 'executionType', 'implementation');
            const opManifest = baseTemplate.exampleManifest as Partial<OperationManifest>;
            opManifest.inputs = [];
            opManifest.outputs = [];
            opManifest.executionType = 'local';
            opManifest.implementation = {
                type: 'local'
            };
        }

        return baseTemplate;
    }

    /**
     * Get available component templates
     */
    getAvailableTemplates(): CustomComponentTemplate[] {
        return Array.from(this.templates.values());
    }

    /**
     * Get template by ID
     */
    getTemplate(templateId: string): CustomComponentTemplate | null {
        return this.templates.get(templateId) || null;
    }

    /**
     * Create component from template
     */
    createFromTemplate(
        templateId: string,
        customizations: Partial<ComponentManifest>
    ): ComponentManifest {
        const template = this.getTemplate(templateId);
        if (!template) {
            throw new Error(`Template ${templateId} not found`);
        }

        const manifest = {
            ...template.exampleManifest,
            ...customizations
        } as ComponentManifest;

        // Ensure required fields are present and not empty
        template.requiredFields.forEach(field => {
            if (!(field in manifest) || !manifest[field as keyof ComponentManifest]) {
                throw new Error(`Required field ${field} missing from component manifest`);
            }
        });

        return manifest;
    }

    /**
     * Validate basic manifest structure
     */
    private validateBasicManifest(manifest: ComponentManifest): {
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Required fields
        const requiredFields = ['id', 'name', 'version', 'type', 'description', 'capabilities'];
        requiredFields.forEach(field => {
            if (!(field in manifest) || !manifest[field as keyof ComponentManifest]) {
                errors.push(`Missing required field: ${field}`);
            }
        });

        // ID format validation
        if (manifest.id && !/^[a-z0-9-]+$/.test(manifest.id)) {
            errors.push('Component ID must contain only lowercase letters, numbers, and hyphens');
        }

        // Version format validation
        if (manifest.version && !/^\d+\.\d+\.\d+/.test(manifest.version)) {
            warnings.push('Version should follow semantic versioning (e.g., 1.0.0)');
        }

        // Type validation
        if (manifest.type && !['ui-element', 'operation'].includes(manifest.type)) {
            errors.push('Component type must be either "ui-element" or "operation"');
        }

        // Capabilities validation
        if (manifest.capabilities && !Array.isArray(manifest.capabilities)) {
            errors.push('Capabilities must be an array');
        }

        return { errors, warnings };
    }

    /**
     * Validate component schema
     */
    private validateComponentSchema(manifest: ComponentManifest): {
        errors: string[];
        warnings: string[];
    } {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!manifest.schema) {
            warnings.push('Component schema is recommended for better validation');
            return { errors, warnings };
        }

        // Basic JSON Schema validation
        if (typeof manifest.schema !== 'object') {
            errors.push('Schema must be a valid JSON Schema object');
            return { errors, warnings };
        }

        if (!manifest.schema.type) {
            warnings.push('Schema should specify a type');
        }

        // Type-specific schema validation
        if (manifest.type === 'ui-element') {
            const uiManifest = manifest as UIElementManifest;
            if (uiManifest.styleSchema && typeof uiManifest.styleSchema !== 'object') {
                errors.push('Style schema must be a valid JSON Schema object');
            }
        }

        return { errors, warnings };
    }

    /**
     * Validate component capabilities
     */
    private async validateCapabilities(manifest: ComponentManifest): Promise<{
        errors: string[];
        warnings: string[];
        suggestions: string[];
    }> {
        const errors: string[] = [];
        const warnings: string[] = [];
        const suggestions: string[] = [];

        if (!manifest.capabilities || manifest.capabilities.length === 0) {
            warnings.push('Component should declare at least one capability');
            return { errors, warnings, suggestions };
        }

        // Check for common capability patterns
        const commonCapabilities = [
            'clickable', 'styled', 'input', 'output', 'validation',
            'http', 'async', 'storage', 'auth', 'navigation'
        ];

        const unknownCapabilities = manifest.capabilities.filter(
            cap => !commonCapabilities.includes(cap)
        );

        if (unknownCapabilities.length > 0) {
            warnings.push(`Unknown capabilities: ${unknownCapabilities.join(', ')}`);
            suggestions.push('Consider using standard capability names for better discoverability');
        }

        // Type-specific capability validation
        if (manifest.type === 'ui-element') {
            const hasUICapabilities = manifest.capabilities.some(cap =>
                ['clickable', 'styled', 'input', 'output'].includes(cap)
            );
            if (!hasUICapabilities) {
                suggestions.push('UI elements typically have capabilities like "clickable", "styled", "input", or "output"');
            }
        }

        if (manifest.type === 'operation') {
            const hasOpCapabilities = manifest.capabilities.some(cap =>
                ['http', 'async', 'storage', 'auth'].includes(cap)
            );
            if (!hasOpCapabilities) {
                suggestions.push('Operations typically have capabilities like "http", "async", "storage", or "auth"');
            }
        }

        return { errors, warnings, suggestions };
    }

    /**
     * Validate custom component dependencies
     */
    private async validateCustomDependencies(manifest: ComponentManifest): Promise<{
        errors: string[];
        warnings: string[];
    }> {
        const errors: string[] = [];
        const warnings: string[] = [];

        if (!manifest.dependencies || manifest.dependencies.length === 0) {
            return { errors, warnings };
        }

        for (const dep of manifest.dependencies) {
            // Validate dependency structure
            if (!dep.name || !dep.version || !dep.type) {
                errors.push(`Invalid dependency structure: ${JSON.stringify(dep)}`);
                continue;
            }

            // Check if dependency exists
            const depComponent = await repositoryService.getComponent(dep.name, dep.version);
            if (!depComponent && !dep.optional) {
                warnings.push(`Required dependency not found: ${dep.name}@${dep.version}`);
            }

            // Check for circular dependencies
            if (dep.name === manifest.id) {
                errors.push('Component cannot depend on itself');
            }
        }

        return { errors, warnings };
    }

    /**
     * Validate integration with existing components
     */
    private async validateIntegration(manifest: ComponentManifest): Promise<{
        warnings: string[];
        suggestions: string[];
    }> {
        const warnings: string[] = [];
        const suggestions: string[] = [];

        // Check for naming conflicts
        const existing = await repositoryService.getComponent(manifest.id);
        if (existing) {
            warnings.push(`Component with ID "${manifest.id}" already exists`);
        }

        // Check for capability overlaps
        const similarComponents = await discoveryService.findByCapabilityRequirements(manifest.capabilities);
        if (similarComponents.length > 0) {
            suggestions.push(`Similar components exist: ${similarComponents.map((c: ComponentRecommendation) => c.component.name).join(', ')}`);
        }

        return { warnings, suggestions };
    }

    /**
     * Auto-fix common manifest issues
     */
    private async autoFixManifest(
        manifest: ComponentManifest,
        _validation: CustomComponentValidation
    ): Promise<ComponentManifest> {
        const fixed = { ...manifest };

        // Fix missing capabilities
        if (!fixed.capabilities || fixed.capabilities.length === 0) {
            fixed.capabilities = fixed.type === 'ui-element' ? ['styled'] : ['async'];
        }

        // Fix missing schema
        if (!fixed.schema) {
            fixed.schema = {
                type: 'object',
                properties: {}
            };
        }

        // Fix version format
        if (fixed.version && !/^\d+\.\d+\.\d+/.test(fixed.version)) {
            fixed.version = '1.0.0';
        }

        return fixed;
    }

    /**
     * Check if two components are compatible
     */
    private areComponentsCompatible(componentA: ComponentManifest, componentB: ComponentManifest): boolean {
        // Check for dependency relationships
        const aUsesB = componentA.dependencies.some(dep => dep.name === componentB.id);
        const bUsesA = componentB.dependencies.some(dep => dep.name === componentA.id);

        // Check for complementary capabilities
        const sharedCapabilities = componentA.capabilities.filter(cap =>
            componentB.capabilities.includes(cap)
        );

        return aUsesB || bUsesA || sharedCapabilities.length > 0;
    }

    /**
     * Check if two components have conflicts
     */
    private haveConflicts(componentA: ComponentManifest, componentB: ComponentManifest): boolean {
        // Simple conflict detection - same ID or conflicting capabilities
        if (componentA.id === componentB.id) {
            return true;
        }

        // Could add more sophisticated conflict detection here
        return false;
    }

    /**
     * Find alternative dependencies
     */
    private async findAlternativeDependencies(dependency: Dependency): Promise<ComponentManifest[]> {
        // Find components with similar capabilities or names
        const byCapabilities = await discoveryService.searchSemantic(dependency.name, dependency.type === 'library' ? undefined : dependency.type);
        return byCapabilities.slice(0, 3); // Limit alternatives
    }

    /**
     * Calculate installation order for dependencies
     */
    private calculateInstallationOrder(components: ComponentManifest[]): ComponentManifest[] {
        // Simple topological sort - in practice would need more sophisticated algorithm
        const sorted: ComponentManifest[] = [];
        const visited = new Set<string>();

        const visit = (component: ComponentManifest) => {
            if (visited.has(component.id)) return;

            // Visit dependencies first
            component.dependencies.forEach(dep => {
                const depComponent = components.find(c => c.id === dep.name);
                if (depComponent) {
                    visit(depComponent);
                }
            });

            visited.add(component.id);
            sorted.push(component);
        };

        components.forEach(visit);
        return sorted;
    }

    /**
     * Initialize built-in templates
     */
    private initializeTemplates(): void {
        // Basic UI Element template
        this.templates.set('basic-ui-element', {
            id: 'basic-ui-element',
            name: 'Basic UI Element',
            type: 'ui-element',
            description: 'A basic UI element template',
            baseCapabilities: ['styled'],
            requiredFields: ['id', 'name', 'version', 'type', 'description', 'capabilities', 'inputs', 'outputs', 'renderFunction'],
            optionalFields: ['dependencies', 'schema', 'styleSchema'],
            exampleManifest: {
                id: 'my-ui-element',
                name: 'My UI Element',
                version: '1.0.0',
                type: 'ui-element',
                description: 'A custom UI element',
                capabilities: ['styled'],
                dependencies: [],
                schema: { type: 'object', properties: {} },
                inputs: [],
                outputs: [],
                renderFunction: 'renderMyElement'
            }
        });

        // Basic Operation template
        this.templates.set('basic-operation', {
            id: 'basic-operation',
            name: 'Basic Operation',
            type: 'operation',
            description: 'A basic operation template',
            baseCapabilities: ['async'],
            requiredFields: ['id', 'name', 'version', 'type', 'description', 'capabilities', 'inputs', 'outputs', 'executionType', 'implementation'],
            optionalFields: ['dependencies', 'schema'],
            exampleManifest: {
                id: 'my-operation',
                name: 'My Operation',
                version: '1.0.0',
                type: 'operation',
                description: 'A custom operation',
                capabilities: ['async'],
                dependencies: [],
                schema: { type: 'object', properties: {} },
                inputs: [],
                outputs: [],
                executionType: 'local',
                implementation: { type: 'local' }
            }
        });
    }
}

// Export singleton instance
export const customComponentManager = new CustomComponentManager();