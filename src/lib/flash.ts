/**
 * App-wide confirmation messages ("Added to Liked songs", "You are now following"…).
 * Dependency-free so state and libs can call `flash()` without import cycles; `<FlashHost />`
 * in `src/components/flash.tsx` (mounted once in the root layout) renders them.
 */
type Listener = (msg: string) => void;
const listeners = new Set<Listener>();

export function flash(message: string) {
  listeners.forEach((l) => l(message));
}

export function onFlash(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export const FLASH = {
  liked: 'Added to Liked songs',
  unliked: 'Removed from Liked songs',
  followed: 'You are now following',
  unfollowed: 'Unfollowed',
  saved: 'Saved to your library',
  unsaved: 'Removed from library',
} as const;
