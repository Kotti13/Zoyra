import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { IconBadge } from './IconBadge';

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

/** YouTube thumbnails (16:9) rather than square album art. */
export const isWideThumb = (uri: string | null | undefined): uri is string => !!uri && uri.includes('i.ytimg.com/');
/** Width a 16:9 thumbnail needs to fill a slot of this height without cropping. */
export const wideWidth = (height: number) => Math.round((height * 16) / 9);

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
  fit = 'cover',
  adapt,
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
  /** `auto`: small cards/rows show a 16:9 thumbnail whole; big/full-bleed slots crop as before. `cover` always crops. `contain` always shows the whole image (blurred copy behind any spare space). */
  fit?: 'auto' | 'cover' | 'contain';
  /**
   * Fit the card to the image instead of the image to the card: keep `height` (or `width`) and take the other side
   * from the picture's real aspect ratio once it has loaded (16:9 for a video thumbnail and square for album art until
   * then), so the image fills the card exactly, never cropped, zoomed or barred.
   */
  adapt?: 'width' | 'height';
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  // Real ratio of the loaded image, remembered per source so a new picture starts from its expected shape again.
  const [natural, setNatural] = useState<{ src: string; ratio: number } | null>(null);
  // Not every video has an hq720 image: when it fails, retry once with the always-present 320x180 one.
  const [failed, setFailed] = useState<string | null>(null);
  const picked = uri ?? pickArt(artwork, Math.max(width ?? size, height ?? size));
  const src = picked && failed === picked ? picked.replace(/\/(hq720|hqdefault|sddefault|maxresdefault)\.jpg/, '/mqdefault.jpg') : picked;
  // A 16:9 thumbnail in a small slot of another shape (a square card or row) is shown whole on a blurred copy of
  // itself instead of being cropped. Hero and full-screen slots (over 240 px) keep the edge-to-edge crop.
  const wide = isWideThumb(src);
  let slotW = width ?? size;
  let slotH = height ?? size;
  if (adapt) {
    const ratio = Math.min(2.4, Math.max(0.5, natural && natural.src === src ? natural.ratio : wide ? 16 / 9 : 1));
    if (adapt === 'height') slotH = Math.round(slotW / ratio);
    else slotW = Math.round(slotH * ratio);
  }
  // `contain` keeps any image whole: a square cover in a 16:9 card (or a 16:9 thumbnail in a square one) sits on a
  // blurred copy of itself instead of being zoomed in. Source ratio: 16:9 for YouTube video thumbs, else square.
  const slotRatio = slotW / slotH;
  const letterbox = !adapt && !!src && (fit === 'contain' ? Math.abs(slotRatio - (wide ? 16 / 9 : 1)) > 0.08 : fit === 'auto' && wide && Math.max(slotW, slotH) <= 240 && Math.abs(slotRatio - 16 / 9) > 0.25);
  const fill = { position: 'absolute', inset: 0 } as const;
  return (
    <Art art={artFor(id)} size={size} width={adapt ? slotW : width} height={adapt ? slotH : height} radius={r} rotate={rotate} sticker={sticker} style={[{ overflow: 'hidden' }, style]}>
      {src && letterbox ? (
        <>
          <Image source={{ uri: src }} style={fill} contentFit="cover" blurRadius={24} cachePolicy="memory-disk" accessibilityIgnoresInvertColors />
          <View style={[fill, { backgroundColor: 'rgba(0,0,0,0.3)' }]} />
          <Image source={{ uri: src }} style={fill} contentFit="contain" transition={200} cachePolicy="memory-disk" onError={() => setFailed(picked ?? null)} accessibilityIgnoresInvertColors />
        </>
      ) : src ? (
        <Image source={{ uri: src }} style={fill} contentFit={fit === 'contain' ? 'contain' : 'cover'} transition={200} cachePolicy="memory-disk" onLoad={adapt ? (e) => e.source.width > 0 && e.source.height > 0 && setNatural({ src, ratio: e.source.width / e.source.height }) : undefined} onError={() => setFailed(picked ?? null)} accessibilityIgnoresInvertColors />
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
  artFit,
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
  artFit?: 'auto' | 'cover' | 'contain';
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
        <Cover artwork={track.artwork} id={track.id} size={artSize} height={artSize} radius={artRadius} fit={artFit}>
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
 * Stale-while-revalidate cache for `useAsync`: reopening a screen shows the last result instantly while a fresh
 * load runs quietly behind it. Opt-in per call with a stable name — `useAsync(loader, deps, 'home.trending')` —
 * because function source text cannot be used as a key (in release builds every function's text is identical).
 * `{ id, persist: true }` also saves the result on the device so the next app launch opens with data at once;
 * only use that for plain-JSON results. Cleared on sign-out / account switch (`clearAsyncCache`).
 */
type CacheOpt = string | { id: string; persist?: boolean };
const asyncCache = new Map<string, unknown>();
const persistKeys = new Set<string>();
const ASYNC_CACHE_MAX = 150;
const PERSIST_KEY = 'zoyra.asyncCache.v2';
const PERSIST_TTL_MS = 3 * 24 * 3600_000;
const PERSIST_MAX_BYTES = 150_000;
let hydrated = false;
const hydration: Promise<void> = AsyncStorage.getItem(PERSIST_KEY)
  .then((raw) => {
    if (!raw) return;
    const rows = JSON.parse(raw) as { k: string; v: unknown; t: number }[];
    for (const r of rows) {
      if (Date.now() - r.t < PERSIST_TTL_MS && !asyncCache.has(r.k)) {
        asyncCache.set(r.k, r.v);
        persistKeys.add(r.k);
      }
    }
  })
  .catch(() => undefined)
  .finally(() => {
    hydrated = true;
  });
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const rows: { k: string; v: unknown; t: number }[] = [];
      for (const k of persistKeys) {
        if (!asyncCache.has(k)) continue;
        const v = asyncCache.get(k);
        if (JSON.stringify(v).length <= PERSIST_MAX_BYTES) rows.push({ k, v, t: Date.now() });
      }
      void AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(rows)).catch(() => undefined);
    } catch {
      // Not serialisable: skip, memory cache still works.
    }
  }, 1500);
}
export function clearAsyncCache() {
  asyncCache.clear();
  persistKeys.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  void AsyncStorage.removeItem(PERSIST_KEY).catch(() => undefined);
}
function cacheKey(opt: CacheOpt | undefined, deps: unknown[]): string | null {
  if (!opt) return null;
  try {
    const d = JSON.stringify(deps);
    if (d.length > 1500) return null;
    return `${typeof opt === 'string' ? opt : opt.id}|${d}`;
  } catch {
    return null;
  }
}

/** Run an async loader on mount / when deps change; exposes loading + error + reload. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[], cache?: CacheOpt): AsyncState<T> {
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
    const key = cacheKey(cache, deps);
    const persist = typeof cache === 'object' && !!cache.persist;
    const hit = key !== null && asyncCache.has(key);
    let completed = false;
    if (hit && !quiet) {
      // Show the cached result at once; the fresh load below replaces it when it lands.
      setData(asyncCache.get(key as string) as T);
      setLoading(false);
      setError(null);
    } else if (!quiet) {
      setLoading(true);
      setError(null);
    }
    // First launch: the saved copy loads from disk a moment later; show it if the network hasn't answered yet.
    if (key !== null && persist && !hydrated && !hit && !quiet) {
      void hydration.then(() => {
        if (alive && !completed && asyncCache.has(key)) {
          setData(asyncCache.get(key) as T);
          setLoading(false);
        }
      });
    }
    ref
      .current()
      .then((d) => {
        if (!alive) return;
        completed = true;
        if (key !== null) {
          if (asyncCache.size >= ASYNC_CACHE_MAX) asyncCache.delete(asyncCache.keys().next().value as string);
          asyncCache.set(key, d);
          if (persist) {
            persistKeys.add(key);
            schedulePersist();
          }
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
      <IconBadge icon={icon} size={56} />
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
