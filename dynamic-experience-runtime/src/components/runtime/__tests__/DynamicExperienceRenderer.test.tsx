/**
 * Tests for Dynamic Experience Renderer
 * Requirements: 3.1, 3.2, 9.1
 */

import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamicExperienceRenderer } from '../DynamicExperienceRenderer';
import { Contract } from '../../../types/contract';

// Mock the child components
vi.mock('../ExperienceStateManager', () => ({
  ExperienceStateManager: vi.fn().mockImplementation(() => ({
    initializeState: vi.fn().mockResolvedValue({
      data: {},
      loading: {},
      errors: {},
      lastUpdated: new Date()
    }),
    subscribeToStateChanges: vi.fn().mockReturnValue(() => {}),
    setLoading: vi.fn(),
    updateStateFromOperationResult: vi.fn(),
    setError: vi.fn()
  }))
}));

vi.mock('../OperationExecutor', () => ({
  OperationExecutor: vi.fn().mockImplementation(() => ({
    executeOperation: vi.fn().mockResolvedValue({ success: true, data: 'test result' })
  }))
}));

vi.mock('../ComponentRenderer', () => ({
  ComponentRenderer: vi.fn().mockImplementation(() => ({
    renderUIElement: vi.fn().mockReturnValue(() => React.createElement('div', { 'data-testid': 'mock-component' }, 'Mock Component'))
  }))
}));

describe('DynamicExperienceRenderer', () => {
  const mockContract: Contract = {
    name: 'Test Experience',
    version: '1.0.0',
    elements: [
      {
        id: 'button1',
        type: 'button',
        properties: { text: 'Click me' },
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
    layout: {
      type: 'flex',
      properties: { flexDirection: 'column' }
    },
    styling: {
      theme: 'default'
    },
    metadata: {
      createdAt: new Date(),
      updatedAt: new Date(),
      version: '1.0.0'
    }
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', async () => {
    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={mockContract}
          experienceId="test-exp-1"
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-component')).toBeInTheDocument();
    });
  });

  it('applies layout styles correctly', async () => {
    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={mockContract}
          experienceId="test-exp-1"
        />
      );
    });

    await waitFor(() => {
      const container = screen.getByTestId('mock-component').parentElement;
      expect(container).toHaveClass('dynamic-experience-container');
      expect(container).toHaveAttribute('data-experience-id', 'test-exp-1');
      expect(container).toHaveAttribute('data-contract-name', 'Test Experience');
    });
  });

  it('handles different layout types', async () => {
    const gridContract = {
      ...mockContract,
      layout: {
        type: 'grid' as const,
        properties: { gridTemplateColumns: '1fr 1fr' }
      }
    };

    let rerender: any;
    act(() => {
      const result = render(
        <DynamicExperienceRenderer
          contract={gridContract}
          experienceId="test-exp-1"
        />
      );
      rerender = result.rerender;
    });

    // Test absolute layout
    const absoluteContract = {
      ...mockContract,
      layout: {
        type: 'absolute' as const,
        properties: { position: 'relative' }
      }
    };

    act(() => {
      rerender(
        <DynamicExperienceRenderer
          contract={absoluteContract}
          experienceId="test-exp-1"
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('mock-component')).toBeInTheDocument();
    });
  });

  it('calls onStateChange when state updates', async () => {
    const onStateChange = vi.fn();

    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={mockContract}
          experienceId="test-exp-1"
          onStateChange={onStateChange}
        />
      );
    });

    // Wait for initial state setup
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalled();
    });
  });

  it('calls onError when errors occur', async () => {
    const onError = vi.fn();

    // Mock the state manager to throw an error during initialization
    const { ExperienceStateManager } = await import('../ExperienceStateManager');
    vi.mocked(ExperienceStateManager).mockImplementationOnce(() => ({
      initializeState: vi.fn().mockRejectedValue(new Error('Test error')),
      subscribeToStateChanges: vi.fn().mockReturnValue(() => {}),
      setLoading: vi.fn(),
      updateStateFromOperationResult: vi.fn(),
      setError: vi.fn()
    }) as any);

    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={mockContract}
          experienceId="test-exp-1"
          onError={onError}
        />
      );
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  it('renders multiple UI elements', async () => {
    const multiElementContract = {
      ...mockContract,
      elements: [
        {
          id: 'button1',
          type: 'button',
          properties: { text: 'Button 1' },
          dataBindings: [],
          eventBindings: []
        },
        {
          id: 'button2',
          type: 'button',
          properties: { text: 'Button 2' },
          dataBindings: [],
          eventBindings: []
        }
      ]
    };

    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={multiElementContract}
          experienceId="test-exp-1"
        />
      );
    });

    await waitFor(() => {
      const components = screen.getAllByTestId('mock-component');
      expect(components).toHaveLength(2);
    });
  });

  it('handles empty contract elements', async () => {
    const emptyContract = {
      ...mockContract,
      elements: []
    };

    act(() => {
      render(
        <DynamicExperienceRenderer
          contract={emptyContract}
          experienceId="test-exp-1"
        />
      );
    });

    await waitFor(() => {
      const container = screen.getByTestId('dynamic-experience-container');
      expect(container).toHaveClass('dynamic-experience-container');
    });
  });
});