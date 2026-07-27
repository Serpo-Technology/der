/**
 * The video element's embed driver policy: which urls render as a hosted
 * embed player instead of a media file. The allowlist is exact https
 * prefixes, so a bound src can never turn the player into a browser; both
 * renderer faces enforce the same list.
 */

const EMBED_PLAYER_PREFIXES = [
  'https://www.youtube-nocookie.com/embed/',
  'https://www.youtube.com/embed/',
];

export function isEmbedPlayerUrl(src: unknown): boolean {
  return (
    typeof src === 'string' &&
    EMBED_PLAYER_PREFIXES.some((prefix) => src.startsWith(prefix))
  );
}
