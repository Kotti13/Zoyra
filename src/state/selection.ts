import { useEffect, useSyncExternalStore } from 'react';

import type { CatalogTrack } from '../lib/catalog';

/**
 * The track a sheet acts on (song options, add to playlist, share, dedicate, credits).
 * Set it right before opening the sheet; sheets fall back to the now-playing track when empty.
 */
let sheetTrack: CatalogTrack | null = null;
const listeners = new Set<() => void>();

export function setSheetTrack(track: CatalogTrack | null) {
  sheetTrack = track;
  listeners.forEach((l) => l());
}

/** Read the sheet's track; pass `clearOnClose` from the sheet route so a stale selection never leaks into the next sheet. */
export function useSheetTrack(fallback: CatalogTrack | null, clearOnClose = true): CatalogTrack | null {
  useEffect(() => (clearOnClose ? () => setSheetTrack(null) : undefined), [clearOnClose]);
  const t = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sheetTrack,
  );
  return t ?? fallback;
}
