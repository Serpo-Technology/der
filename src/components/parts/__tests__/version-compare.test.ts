/**
 * Registry update badges hinge on this comparison: only a strictly newer
 * registry version may offer an update.
 */

import { describe, it, expect } from 'vitest';
import { versionNewer } from '../PartsView';

describe('versionNewer', () => {
  it('flags strictly newer versions', () => {
    expect(versionNewer('1.1.2', '1.1.1')).toBe(true);
    expect(versionNewer('1.2.0', '1.1.9')).toBe(true);
    expect(versionNewer('2.0.0', '1.9.9')).toBe(true);
    expect(versionNewer('1.10.0', '1.9.0')).toBe(true);
  });

  it('rejects equal and older versions', () => {
    expect(versionNewer('1.1.1', '1.1.1')).toBe(false);
    expect(versionNewer('1.0.9', '1.1.0')).toBe(false);
    expect(versionNewer('1.1', '1.1.0')).toBe(false);
  });

  it('treats missing segments as zero', () => {
    expect(versionNewer('1.1.1', '1.1')).toBe(true);
    expect(versionNewer('1', '1.0.0')).toBe(false);
  });
});
