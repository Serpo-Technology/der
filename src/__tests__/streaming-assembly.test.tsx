/**
 * Live-assembly safety net, driven by a real generated task-list response:
 * every streamed prefix must yield a render-ready preview (or null), and the
 * standalone window's renderer must survive the whole preview sequence plus
 * the validated final contract without tripping an error boundary.
 */

import { describe, it, expect } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LiveExperienceRenderer } from '../components/runtime/LiveExperienceRenderer';
import { extractStreamingContract } from '../services/ai-interpreter/partial-json';
import { normalizeContract } from '../schemas/contract';
import type { Contract } from '../types/contract';

const composed = JSON.parse(
  readFileSync(join(__dirname, '../test/fixtures-task-list-composed.json'), 'utf8')
);
const FULL = JSON.stringify(composed, null, 1);

class WindowBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <div data-testid="window-crash">{String(this.state.error)}</div>;
    }
    return this.props.children;
  }
}

describe('streaming assembly previews', () => {
  it('every prefix yields a normalizable, layout-complete preview or null', () => {
    for (let cut = 1; cut <= FULL.length; cut += 3) {
      const preview = extractStreamingContract(FULL.slice(0, cut));
      if (!preview) continue;
      expect(preview.layout).toBeDefined();
      expect(() => normalizeContract(preview as never)).not.toThrow();
    }
  });

  it('the window renderer survives the preview sequence and the final contract', async () => {
    const previews: Contract[] = [];
    let lastSerialized = '';
    for (let cut = 1; cut <= FULL.length; cut += 97) {
      const preview = extractStreamingContract(FULL.slice(0, cut));
      if (!preview) continue;
      const serialized = JSON.stringify(preview);
      if (serialized === lastSerialized) continue;
      lastSerialized = serialized;
      previews.push(preview as unknown as Contract);
    }
    expect(previews.length).toBeGreaterThan(3);

    const harness = (contract: Contract) => (
      <WindowBoundary>
        <LiveExperienceRenderer
          initialContract={contract}
          experienceId="stream-live"
          enableRealTimeUpdates={true}
        />
      </WindowBoundary>
    );

    const view = render(harness(previews.shift()!));
    for (const preview of previews) {
      await act(async () => {
        view.rerender(harness(preview));
      });
      expect(view.queryByTestId('window-crash')).toBeNull();
    }

    await act(async () => {
      view.rerender(harness(composed.contract as Contract));
    });
    await waitFor(() => {
      expect(view.queryByTestId('window-crash')).toBeNull();
      expect(view.container.textContent).toContain('left');
    });
  });
});
