/**
 * Free-form accent colors: the model may set styling.accent to any hex color
 * when the palette lacks the requested hue. One base color derives the full
 * accent trio the themes consume, so a hex accent styles exactly like a
 * named one.
 */

export const HEX_ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isHexAccent(value: string): boolean {
  return HEX_ACCENT_PATTERN.test(value);
}

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** The CSS variables a hex accent sets inline, matching the named classes. */
export function hexAccentVariables(hex: string): Record<string, string> {
  const [r, g, b] = channels(hex);
  const strong = `#${[r, g, b]
    .map((channel) => Math.round(channel * 0.85).toString(16).padStart(2, '0'))
    .join('')}`;
  // YIQ luma decides whether dark or light text sits on the accent.
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  const onAccent = luma >= 145 ? '#111111' : '#ffffff';
  return {
    '--der-accent': hex,
    '--der-accent-strong': strong,
    '--der-on-accent': onAccent,
    '--der-accent-soft': `rgba(${r}, ${g}, ${b}, 0.15)`,
  };
}
