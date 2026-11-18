import { Image } from 'expo-image';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';

import { formatDuration, type Artwork, type CatalogTrack } from '../lib/catalog';
import { setSheetTrack } from '../state/selection';
import { usePlayerActions, usePlayerSelector } from '../state/player';
import { artCycle, colors, radius, type ArtName } from '../theme/tokens';
import { SkeletonRows } from './Skeleton';
import { Button, IconButton, Tap, type NavTarget } from './controls';
import { Art, Icon, Row, T } from './primitives';

/** Stable gradient fallback per id, so a cover without artwork keeps the same colour. */
export function artFor(id: string | undefined): ArtName {
  if (!id) return 'coral';
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return artCycle[Math.abs(h) % artCycle.length];
}

export function pickArt(a: Artwork | undefined, size: number) {
  if (!a) return undefined;
  return size <= 80 ? a.small ?? a.medium : size <= 240 ? a.medium ?? a.large : a.large ?? a.medium;
}

/** Real artwork (cached by expo-image) over the design's gradient placeholder. */
export function Cover({
  artwork,
  uri,
  id,
  size = 48,
  width,
  height,
  radius: r = radius.sm,
  rotate,
  sticker,
  style,
  children,
}: {
  artwork?: Artwork;
  uri?: string | null;
  id?: string;
  size?: number;
  width?: number;
  height?: number;
  radius?: number;
  rotate?: number;
  sticker?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const src = uri ?? pickArt(artwork, Math.max(width ?? size, height ?? size));
  return (
    <Art art={artFor(id)} size={size} width={width} height={height} radius={r} rotate={rotate} sticker={sticker} style={[{ overflow: 'hidden' }, style]}>
      {src ? (
        <Image source={{ uri: src }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={200} cachePolicy="memory-disk" accessibilityIgnoresInvertColors />
      ) : null}
      {children}
    </Art>
  );
}

/**
 * Track row for real catalogue data. Tapping plays `list` from this row (so next/previous follow the list);
 * the ⋯ button opens the song options sheet for this track.
 */
export const TrackItem = memo(function TrackItem({
  track,
  list,
  index,
  showIndex,
  context,
  right,
  showDuration = true,
  artSize = 48,
  artRadius = radius.sm,
  subtitle,
}: {
  track: CatalogTrack;
  list?: CatalogTrack[];
  index?: number;
  showIndex?: boolean;
  context?: string;
  right?: ReactNode;
  showDuration?: boolean;
  artSize?: number;
  artRadius?: number;
  subtitle?: string;
}) {
  const { playTracks } = usePlayerActions();
  // 0 = not current, 1 = current & paused, 2 = current & playing: only the affected rows re-render.
  const status = usePlayerSelector((s) => (s.track?.id !== track.id ? 0 : s.playing ? 2 : 1));
  const active = status !== 0;
  const playing = status === 2;
  return (
    <Tap
      accessibilityLabel={`Play ${track.title} by ${track.artist.name}`}
      onPress={() => {
        const l = list ?? [track];
        playTracks(l, Math.max(0, l.findIndex((t) => t.id === track.id)), context);
      }}
      style={{ minHeight: 64 }}
    >
      <Row style={{ minHeight: 64 }}>
        {showIndex && index !== undefined ? (
          <T mono size={13} color={active ? colors.accentLight : colors.textSecondary} align="center" style={{ width: 20 }}>
            {index + 1}
          </T>
        ) : null}
        <Cover artwork={track.artwork} id={track.id} size={artSize} radius={artRadius}>
          {active ? (
            <View style={{ position: 'absolute', inset: 0, backgroundColor: colors.shade, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={playing ? 'pause' : 'play'} size={20} color={colors.white} />
            </View>
          ) : null}
        </Cover>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="bodyStrong" numberOfLines={1} color={active ? colors.accentLight : colors.text}>
            {track.title}
          </T>
          <T variant="small" color={colors.textSecondary} numberOfLines={1}>
            {subtitle ?? track.artist.name}
          </T>
        </View>
        {showDuration ? (
          <T mono size={12} color={colors.textSecondary}>
            {formatDuration(track.duration)}
          </T>
        ) : null}
        {right ?? <MoreButton track={track} />}
      </Row>
    </Tap>
  );
});

export function MoreButton({ track, color = colors.textSecondary, href = '/song-options' }: { track: CatalogTrack; color?: string; href?: NavTarget }) {
  return <IconButton icon="more" label="More options" color={color} href={href} onPress={() => setSheetTrack(track)} />;
}

/* ------------------------------------------------------------------ async data */

export type AsyncState<T> = {
  data: T | undefined;
  loading: boolean;
  error: string | null;
  /** Re-run the loader. The returned promise settles once that reload finishes (never rejects), so pull-to-refresh can await it. */
  reload: () => Promise<void>;
  /** Pull-to-refresh: like `reload` but keeps `loading` false, so the current content stays on screen while it re-fetches. */
  refresh: () => Promise<void>;
};

/**
 * Stale-while-revalidate memory cache for `useAsync`: reopening a screen shows the last result instantly while a
 * fresh load runs quietly behind it. Keyed by the loader's source text + serialised deps (skipped when deps cannot
 * be serialised). Memory only; cleared on sign-out / account switch (`clearAsyncCache`).
 */
const asyncCache = new Map<string, unknown>();
const ASYNC_CACHE_MAX = 150;
export function clearAsyncCache() {
  asyncCache.clear();
}
function cacheKey(loader: () => unknown, deps: unknown[]): string | null {
  try {
    const d = JSON.stringify(deps);
    if (d.length > 1500) return null;
    return `${loader.toString()}|${d}`;
  } catch {
    return null;
  }
}

/** Run an async loader on mount / when deps change; exposes loading + error + reload. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const ref = useRef(loader);
  const waiters = useRef<(() => void)[]>([]);
  const silent = useRef(false);
  useLayoutEffect(() => {
    ref.current = loader;
  });

  useEffect(() => {
    let alive = true;
    // Reset to the loading state before each (re)load; the result arrives asynchronously below.
    const quiet = silent.current;
    silent.current = false;
    // A quiet refresh keeps the current content (and any error) up until the new result lands.
    const key = cacheKey(ref.current, deps);
    const hit = key !== null && asyncCache.has(key);
    if (hit && !quiet) {
      // Show the cached result at once; the fresh load below replaces it when it lands.
      setData(asyncCache.get(key as string) as T);
      setLoading(false);
      setError(null);
    } else if (!quiet) {
      setLoading(true);
      setError(null);
    }
    ref
      .current()
      .then((d) => {
        if (!alive) return;
        if (key !== null) {
          if (asyncCache.size >= ASYNC_CACHE_MAX) asyncCache.delete(asyncCache.keys().next().value as string);
          asyncCache.set(key, d);
        }
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Something went wrong'))
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        const done = waiters.current;
        waiters.current = [];
        done.forEach((resolve) => resolve());
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  // Resolves when the next load settles (success or error). Unmounting mid-load leaves it pending;
  // callers that await it (useRefresh) cap the wait.
  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        setNonce((n) => n + 1);
      }),
    [],
  );
  const refresh = useCallback(() => {
    silent.current = true;
    return reload();
  }, [reload]);
  return { data, loading, error, reload, refresh };
}

/** Debounced value (search-as-you-type, 300 ms). */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/* ------------------------------------------------------------------ states */

export function Loading({ label, height = 120 }: { label?: string; height?: number }) {
  // Content-sized areas get skeleton rows (feels instant); small inline spots (list footers…) keep a spinner.
  if (height >= 100) {
    return (
      <View style={{ minHeight: height, paddingVertical: 8 }} accessibilityLabel={label ?? 'Loading'}>
        <SkeletonRows rows={Math.max(2, Math.min(6, Math.round(height / 62)))} />
      </View>
    );
  }
  return (
    <View style={{ height, alignItems: 'center', justifyContent: 'center', gap: 8 }} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
      <ActivityIndicator color={colors.accent} />
      {label ? (
        <T size={13} color={colors.textSecondary}>
          {label}
        </T>
      ) : null}
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={{ paddingVertical: 24, alignItems: 'center', gap: 12 }}>
      <Icon name="wifiOff" size={28} color={colors.textSecondary} />
      <T size={14} color={colors.textSecondary} align="center">
        {message}
      </T>
      {onRetry ? <Button label="Try again" variant="glass" height={44} onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({ icon = 'music', title, body, action, onAction, href }: { icon?: 'music' | 'heart' | 'search' | 'users' | 'download' | 'clock' | 'mail'; title: string; body?: string; action?: string; onAction?: () => void; href?: NavTarget }) {
  return (
    <View style={{ paddingVertical: 32, alignItems: 'center', gap: 10 }}>
      <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={26} color={colors.accentLight} />
      </View>
      <T variant="bodyStrong" align="center">
        {title}
      </T>
      {body ? (
        <T size={14} color={colors.textSecondary} align="center" lineHeight={20} style={{ maxWidth: 280 }}>
          {body}
        </T>
      ) : null}
      {action ? <Button label={action} height={44} onPress={onAction} href={href} style={{ marginTop: 6 }} /> : null}
    </View>
  );
}
