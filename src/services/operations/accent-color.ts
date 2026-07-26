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

/** Mixes a color toward black (negative amount) or white (positive). */
function shifted(rgb: [number, number, number], amount: number): string {
  const target = amount >= 0 ? 255 : 0;
  const strength = Math.abs(amount);
  return `#${rgb
    .map((channel) =>
      Math.round(channel + (target - channel) * strength)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * One background color derives the whole surface family: panels step away
 * from the background, borders step further, and the text flips dark or
 * light by luma. How any color scheme becomes a coherent theme.
 */
export function backgroundVariables(hex: string): Record<string, string> {
  const rgb = channels(hex);
  const [r, g, b] = rgb;
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  const dark = luma < 145;
  // On light backgrounds surfaces darken; on dark ones they lighten.
  const step = (amount: number) => shifted(rgb, dark ? amount : -amount);
  return {
    '--der-bg': hex,
    '--der-chrome': step(0.03),
    '--der-surface': step(0.05),
    '--der-surface-2': step(0.09),
    '--der-surface-3': step(0.13),
    '--der-border': step(0.18),
    '--der-border-strong': step(0.26),
    '--der-border-strong-hover': step(0.34),
    '--der-text': dark ? '#eef1f6' : '#1c212b',
  };
}
