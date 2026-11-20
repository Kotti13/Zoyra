import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ChipRow,
  Cover,
  EmptyState,
  ErrorState,
  AppleSeparator,
  AppleTitle,
  AppleTrackList,
  APPLE,
  Art,
  Gradient,
  Icon,
  IconButton,
  LinkText,
  Loading,
  Row,
  Screen,
  SectionHeader,
  Sticker,
  T,
  Tap,
  Toast,
  useAsync,
  useDebounced,
} from '../../components';
import type { IconName } from '../../components';
import { MOOD_MAP, catalog, formatCount, type Artist, type CatalogTrack, type Collection } from '../../lib/catalog';
import { useContentFilter } from '../../lib/content-filter';
import { appPathFromShareUrl } from '../../lib/share-links';
import { supabase } from '../../lib/supabase';
import { VideoEntryCard } from '../../lib/video-ui';
import { useVoiceSearch } from '../../lib/voice';
import { useAuth } from '../../state/auth';
import { usePlayerActions, usePlayerSelector } from '../../state/player';
import { art, artCycle, colors, fonts, shadow, tile, withAlpha } from '../../theme/tokens';
import { searchFilters, useSearchFilters, type SearchFilterState } from '../filter-sort';

const filters = ['All', 'Songs', 'Artists', 'Albums', 'Playlists', 'Lyrics', 'Podcasts'] as const;
type Filter = (typeof filters)[number];

const genres: { label: string; bg: string; icon: IconName; filled?: boolean }[] = [
  { label: 'Electronic', bg: tile.coral, icon: 'sliders' },
  { label: 'Pop', bg: tile.rose, icon: 'star' },
  { label: 'Alternative', bg: tile.bronze, icon: 'bolt' },
  { label: 'Hip-Hop/Rap', bg: tile.gold, icon: 'mic' },
  { label: 'R&B/Soul', bg: tile.blue, icon: 'heart', filled: false },
  { label: 'Lo-Fi', bg: tile.green, icon: 'music' },
];

type HistoryRow = { id: number; query: string; created_at: string };

/** Last 5 distinct searches for a user. */
async function fetchRecent(uid: string): Promise<string[]> {
  const { data } = await supabase.from('search_history').select('id, query, created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(40);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of (data ?? []) as HistoryRow[]) {
    const k = r.query.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r.query.trim());
    if (out.length === 5) break;
  }
  return out;
}
type Results = { tracks: CatalogTrack[]; artists: Artist[]; collections: Collection[] };

function applyTrackFilters(list: CatalogTrack[], f: SearchFilterState) {
  let out = list;
  if (f.genres.length) out = out.filter((t) => !!t.genre && f.genres.includes(t.genre));
  if (f.moods.length) {
    const allowed = new Set(f.moods.flatMap((m) => MOOD_MAP[m] ?? [m]));
    out = out.filter((t) => !!t.mood && allowed.has(t.mood));
  }
  const time = (t: CatalogTrack) => (t.releaseDate ? Date.parse(t.releaseDate) || 0 : 0);
  if (f.sort === 'Newest') out = [...out].sort((a, b) => time(b) - time(a));
  else if (f.sort === 'Most played') out = [...out].sort((a, b) => b.plays - a.plays);
  else if (f.sort === 'Alphabetical') out = [...out].sort((a, b) => a.title.localeCompare(b.title));
  return out;
}

function useNote() {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(id);
  }, [note]);
  return { note, show: setNote };
}

function ArtistRow({ a, onOpen }: { a: Artist; onOpen: () => void }) {
  return (
    <Tap accessibilityLabel={`Artist ${a.name}`} onPress={onOpen} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Cover artwork={a.image} id={a.id} size={56} radius={28} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {a.name}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          Artist · {formatCount(a.followers)} followers
        </T>
      </View>
      <Icon name="chevronRight" size={20} color={colors.textSecondary} />
    </Tap>
  );
}

function CollectionRow({ c, onOpen }: { c: Collection; onOpen: () => void }) {
  return (
    <Tap accessibilityLabel={`${c.isAlbum ? 'Album' : 'Playlist'} ${c.title}`} onPress={onOpen} style={{ minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Cover artwork={c.artwork} id={c.id} size={56} radius={10} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="bodyStrong" numberOfLines={1}>
          {c.title}
        </T>
        <T variant="small" color={colors.textSecondary} numberOfLines={1}>
          {c.isAlbum ? 'Album' : 'Playlist'} · {c.artist.name}
        </T>
      </View>
      <Icon name="chevronRight" size={20} color={colors.textSecondary} />
    </Tap>
  );
}

/* ------------------------------------------------------------------ QR scanner */

/** Turn a scanned code into an action. Zoyra share link / zoyra:// → in-app route; audius.co → catalogue search. */
function parseCode(data: string): { kind: 'route'; path: string } | { kind: 'search'; query: string } | null {
  const v = data.trim();
  const shared = appPathFromShareUrl(v);
  if (shared) return { kind: 'route', path: shared };
  const zoyra = /^zoyra:\/\/\/?(.*)$/i.exec(v);
  if (zoyra) return { kind: 'route', path: `/${zoyra[1]}` };
  const audius = /^https?:\/\/(?:www\.)?audius\.co\/([^?#]+)/i.exec(v);
  if (audius) {
    const parts = audius[1].split('/').filter(Boolean);
    const slug = parts[parts.length - 1] ?? '';
    let decoded = slug;
    try {
      decoded = decodeURIComponent(slug);
    } catch {
      /* keep raw slug */
    }
    const query = decoded.replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim();
    return query ? { kind: 'search', query } : null;
  }
  return null;
}

function QrScanner({ onClose, onCode }: { onClose: () => void; onCode: (data: string) => boolean }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [hint, setHint] = useState<string | null>(null);
  const locked = useRef(false);

  // Mounted only while scanning, so hint/lock start fresh each time.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.granted]);

  const onScan = (r: BarcodeScanningResult) => {
    if (locked.current) return;
    locked.current = true;
    if (onCode(r.data)) return;
    setHint('That code is not a Zoyra or Audius link.');
    setTimeout(() => (locked.current = false), 1500);
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {permission?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
        ) : null}
        <View style={{ flex: 1, paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24, paddingHorizontal: 16, justifyContent: 'space-between' }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={18} weight={700}>
              Scan a code
            </T>
            <IconButton icon="close" label="Close scanner" bg={colors.chipGhost} onPress={onClose} />
          </Row>
          {!permission ? (
            <Loading label="Opening camera" />
          ) : !permission.granted ? (
            <View style={{ gap: 12, alignItems: 'center' }}>
              <T size={16} align="center">
                Camera access is needed to scan QR codes.
              </T>
              <LinkText
                label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'}
                onPress={() => (permission.canAskAgain ? void requestPermission() : void Linking.openSettings().catch(() => {}))}
              />
            </View>
          ) : (
            <View style={{ alignSelf: 'center', width: 240, height: 240, borderRadius: 36, borderWidth: 4, borderColor: colors.accent }} />
          )}
          <View style={{ gap: 8 }}>
            {hint ? <Toast icon="info" iconColor={colors.amber} message={hint} /> : null}
            <T size={13} color={colors.textSecondary} align="center">
              Point at a Zoyra share code or an Audius link.
            </T>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function Search() {
  const { user } = useAuth();
  const uid = user?.id;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('All');
  const debounced = useDebounced(query.trim(), 300);
  const f = useSearchFilters();
  const { note, show } = useNote();
  const [scanning, setScanning] = useState(false);
  // Older links open Search with ?recognize=1: forward them to the Identify screen.
  const { recognize } = useLocalSearchParams<{ recognize?: string }>();
  useEffect(() => {
    if (recognize !== '1') return;
    router.setParams({ recognize: undefined });
    router.push({ pathname: '/identify', params: { auto: '1' } });
  }, [recognize]);

  const handleCode = (data: string) => {
    const code = parseCode(data);
    if (!code) return false;
    setScanning(false);
    if (code.kind === 'route') router.push(code.path as Href);
    else setQuery(code.query);
    return true;
  };

  /* ---------------- recent searches (search_history) */
  const [recentRows, setRecent] = useState<string[]>([]);
  const recent = uid ? recentRows : [];
  const loadRecent = useCallback(() => {
    if (!uid) return Promise.resolve();
    return fetchRecent(uid)
      .then(setRecent)
      .catch(() => {});
  }, [uid]);
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    fetchRecent(uid)
      .then((r) => alive && setRecent(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid]);

  const saveQuery = useCallback(
    (q: string) => {
      const v = q.trim();
      if (!uid || !v) return;
      setRecent((r) => [v, ...r.filter((x) => x.toLowerCase() !== v.toLowerCase())].slice(0, 5));
      void supabase.from('search_history').insert({ user_id: uid, query: v }).then(undefined, () => undefined);
    },
    [uid],
  );

  const removeRecent = async (q: string) => {
    if (!uid) return;
    setRecent((l) => l.filter((x) => x !== q));
    const { error } = await supabase.from('search_history').delete().eq('user_id', uid).ilike('query', q);
    if (error) {
      show('Could not remove that search');
      void loadRecent();
    }
  };

  /* Save the query when a search result starts playing. */
  const playing = usePlayerSelector((x) => x.track);
  const playContext = usePlayerSelector((x) => x.context);
  const { pause, getState: playerState } = usePlayerActions();
  useEffect(() => {
    if (!uid || !playing || !playContext?.startsWith('Search: ')) return;
    const v = playContext.slice(8).trim();
    if (!v) return;
    let alive = true;
    void (async () => {
      await supabase.from('search_history').insert({ user_id: uid, query: v });
      const r = await fetchRecent(uid);
      if (alive) setRecent(r);
    })().catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playContext]);

  /* ---------------- voice search */
  const voiceSearch = useVoiceSearch({
    onPartial: setQuery,
    onFinal: (text) => {
      setQuery(text);
      saveQuery(text);
    },
    onBeforeStart: () => {
      if (playerState().playing) pause(); // keep our own music out of the mic
    },
  });
  const { voice, listening } = voiceSearch;

  /* ---------------- trending searches */
  const trending = useAsync(() => catalog.trending({ limit: 4 }), [], 'app/(tabs)/search:314');

  /* ---------------- results */
  const singleGenre = f.genres.length === 1 ? f.genres[0] : undefined;
  const results = useAsync<Results | null>(async () => {
    if (!debounced) return null;
    if (filter === 'Podcasts') {
      const tracks = await catalog.searchTracks(debounced, { genre: 'Podcasts', limit: 40 });
      return { tracks, artists: [], collections: [] };
    }
    const wantTracks = filter === 'All' || filter === 'Songs';
    const wantArtists = filter === 'All' || filter === 'Artists';
    const wantCollections = filter === 'All' || filter === 'Albums' || filter === 'Playlists';
    const [tracks, artists, collections] = await Promise.all([
      wantTracks ? catalog.searchTracks(debounced, { genre: singleGenre, limit: filter === 'All' ? 25 : 40 }) : Promise.resolve([]),
      wantArtists ? catalog.searchArtists(debounced, filter === 'All' ? 5 : 20) : Promise.resolve([]),
      wantCollections ? catalog.searchCollections(debounced, filter === 'All' ? 10 : 25) : Promise.resolve([]),
    ]);
    return { tracks, artists, collections };
  }, [debounced, filter, singleGenre], 'app/(tabs)/search:318');

  // Content controls: hidden songs/artists and (kid-safe) explicit songs stay out of results.
  const { filter: hideFilter, hiddenArtists } = useContentFilter();
  const trendingList = trending.data ? hideFilter(trending.data) : undefined;
  const shown = useMemo(() => {
    const r = results.data;
    if (!r) return null;
    const tracks = applyTrackFilters(hideFilter(r.tracks), f);
    const collections = r.collections.filter((c) => (filter === 'Albums' ? c.isAlbum : filter === 'Playlists' ? !c.isAlbum : true));
    return {
      tracks: filter === 'All' ? tracks.slice(0, 6) : tracks,
      artists: r.artists.filter((a) => !hiddenArtists.has(a.id)),
      collections: filter === 'All' ? collections.slice(0, 5) : collections,
    };
  }, [results.data, f, filter, hideFilter, hiddenArtists]);

  /* Pull to refresh: results (when searching), else trending + recent searches. */
  const refresh = () => (debounced ? results.refresh() : Promise.all([trending.refresh(), loadRecent()]));

  const openArtist = (a: Artist) => {
    saveQuery(query);
    router.push({ pathname: '/artist', params: { id: a.id } });
  };
  const openCollection = (c: Collection) => {
    saveQuery(query);
    if (c.isAlbum) router.push({ pathname: '/album', params: { id: c.id } });
    else router.push({ pathname: '/playlist', params: { catalog: c.id } });
  };

  // LRCLIB (our lyrics source) only indexes titles/artists, not lyric text; searching inside lyrics needs a licensed lyrics search API.
  const unsupported = filter === 'Lyrics' ? 'Searching by a line of lyrics needs a lyrics search service (such as Musixmatch) that Zoyra is not connected to. Search by song title or artist instead.' : null;
  const filtersOn = searchFilters.isActive(f);
  const { width: winW } = useWindowDimensions();
  const tileW = Math.floor((winW - APPLE.side * 2 - APPLE.gap) / 2);
  const empty = shown && !shown.tracks.length && !shown.artists.length && !shown.collections.length;

  return (
    <Screen tabbed gap={APPLE.section - 8} backdrop={{ pattern: 'lines', mesh: 'amber' }} onRefresh={refresh}>
      <AppleTitle title="Search" />

      {/* Search field: rounded pill */}
      <Row gap={8} style={{ height: 46, paddingLeft: 14, paddingRight: 4, borderRadius: 23, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          accessibilityLabel="Search"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={() => saveQuery(query)}
          placeholder="Artists, songs, lyrics and more"
          placeholderTextColor={colors.textTertiary}
          returnKeyType="search"
          autoCorrect={false}
          style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
        {query ? (
          <IconButton icon="close" label="Clear search" iconSize={18} color={colors.textSecondary} onPress={() => setQuery('')} />
        ) : (
          <IconButton icon="qr" label="Scan QR code" onPress={() => setScanning(true)} />
        )}
        <IconButton
          icon={listening ? 'pause' : 'mic'}
          label={listening ? 'Stop listening and search' : 'Voice search'}
          bg={listening ? colors.like : colors.accent}
          color={colors.onAccent}
          onPress={() => (listening ? voiceSearch.stop() : void voiceSearch.start())}
        />
      </Row>

      {voice.state === 'starting' || voice.state === 'listening' ? (
        <Toast
          icon="mic"
          iconColor={colors.accent}
          message={voice.state === 'starting' ? 'Starting the microphone…' : voice.transcript ? `Listening… "${voice.transcript}"` : 'Listening… say a song, artist or album'}
          action="Cancel"
          onAction={voiceSearch.cancel}
        />
      ) : voice.state === 'error' ? (
        <Toast icon="info" iconColor={colors.amber} message={voice.message} action="Dismiss" onAction={voiceSearch.dismiss} />
      ) : null}

      {note ? <Toast icon="info" iconColor={colors.amber} message={note} /> : null}

      {scanning ? <QrScanner onClose={() => setScanning(false)} onCode={handleCode} /> : null}

      <ChipRow options={[...filters]} onChange={(i) => setFilter(filters[i])} />

      {debounced ? null : <VideoEntryCard title="Browse videos" subtitle="Music videos, live sets and shorts" />}

      {debounced ? (
        /* ---------------- results */
        <View style={{ gap: 8 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={13} color={colors.textSecondary} style={{ flex: 1 }} numberOfLines={1}>
              {filtersOn ? [f.sort !== 'Relevance' ? f.sort : null, ...f.genres, ...f.moods].filter(Boolean).join(' · ') : 'No filters'}
            </T>
            {filtersOn ? <LinkText label="Clear" size={13} onPress={searchFilters.reset} /> : null}
            <LinkText label="Filters" icon="filter" size={13} href="/filter-sort" />
          </Row>
          {unsupported ? (
            <EmptyState icon="search" title="Lyrics search is not connected" body={unsupported} />
          ) : results.loading ? (
            <Loading label="Searching" />
          ) : results.error ? (
            <ErrorState message={results.error} onRetry={results.reload} />
          ) : empty || !shown ? (
            <EmptyState icon="search" title={`No results for "${debounced}"`} body={filtersOn ? 'Try clearing your filters.' : 'Check the spelling or try another search.'} />
          ) : (
            <>
              {shown.tracks.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Songs" /> : null}
                  <AppleTrackList tracks={shown.tracks} context={`Search: ${debounced}`} subtitle={(t) => `Song · ${t.artist.name}`} />
                </View>
              ) : null}
              {shown.artists.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Artists" /> : null}
                  {shown.artists.map((a, i) => (
                    <View key={a.id}>
                      {i > 0 ? <AppleSeparator /> : null}
                      <ArtistRow a={a} onOpen={() => openArtist(a)} />
                    </View>
                  ))}
                </View>
              ) : null}
              {shown.collections.length ? (
                <View>
                  {filter === 'All' ? <SectionHeader title="Albums and playlists" /> : null}
                  {shown.collections.map((c, i) => (
                    <View key={c.id}>
                      {i > 0 ? <AppleSeparator /> : null}
                      <CollectionRow c={c} onOpen={() => openCollection(c)} />
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          )}
        </View>
      ) : (
        <>
          {/* Song recognition */}
          <Tap
            accessibilityLabel="What is playing? Tap to identify a song around you"
            onPress={() => router.push('/identify')}
            style={[{ borderRadius: 20 }, shadow.sticker]}
          >
            <Gradient colors={art.orange} style={{ borderRadius: 20, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.22), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="mic" size={26} color={colors.white} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={18} weight={700} color={colors.white}>
                  What is playing?
                </T>
                <T size={14} color={colors.white} style={{ opacity: 0.9 }}>
                  Tap to identify a song around you
                </T>
              </View>
              <Icon name="chevronRight" size={22} color={colors.white} />
            </Gradient>
          </Tap>

          {/* Recent */}
          {recent.length ? (
            <>
              <SectionHeader title="Recent" />
              <View style={{ marginTop: -8 }}>
                {recent.map((r) => (
                  <Row key={r} style={{ minHeight: 48 }}>
                    <Tap accessibilityLabel={`Search ${r}`} onPress={() => setQuery(r)} style={{ flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                      <Icon name="clock" size={20} color={colors.textSecondary} />
                      <T size={16} style={{ flex: 1 }} numberOfLines={1}>
                        {r}
                      </T>
                    </Tap>
                    <IconButton icon="close" label={`Remove ${r}`} iconSize={18} color={colors.textSecondary} onPress={() => void removeRecent(r)} />
                  </Row>
                ))}
              </View>
            </>
          ) : null}

          {/* Trending */}
          <SectionHeader title="Trending searches" />
          <View style={{ marginTop: -8 }}>
            {trending.loading && !trending.data ? (
              <Loading height={80} />
            ) : trending.error ? (
              <ErrorState message={trending.error} onRetry={trending.reload} />
            ) : !trendingList?.length ? (
              <T size={14} color={colors.textSecondary}>
                Nothing trending right now.
              </T>
            ) : (
              trendingList.map((t, i) => (
                <Tap key={t.id} onPress={() => setQuery(t.title)} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <T mono size={14} color={colors.textSecondary}>
                    {i + 1}
                  </T>
                  <T size={16} style={{ flex: 1 }} numberOfLines={1}>
                    {t.title.toLowerCase()}
                  </T>
                  {i === 0 ? <Sticker label="HOT" bg={colors.like} rotate={3} /> : null}
                </Tap>
              ))
            )}
          </View>

          {/* Browse categories */}
          <View style={{ gap: 12 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={22} weight={700} tracking={-0.4} accessibilityRole="header">
                Browse categories
              </T>
              <LinkText label={filtersOn ? 'Filters on' : 'Filters'} icon="filter" size={13} href="/filter-sort" />
            </Row>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: APPLE.gap }}>
              {genres.map((g, i) => (
                <Tap
                  key={g.label}
                  accessibilityLabel={g.label}
                  onPress={() => router.push({ pathname: '/genre', params: { name: g.label } })}
                  style={{ width: tileW, height: Math.round(tileW / 1.78), borderRadius: 14, padding: 12, backgroundColor: g.bg, overflow: 'hidden', justifyContent: 'flex-end' }}
                >
                  <View pointerEvents="none" style={{ position: 'absolute', right: -10, bottom: -8, transform: [{ rotate: i % 2 ? '-18deg' : '18deg' }] }}>
                    <Art art={artCycle[i % artCycle.length]} size={64} radius={8} style={{ alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name={g.icon} size={28} color={colors.white} filled={g.filled} />
                    </Art>
                  </View>
                  <T size={16} weight={700} color={colors.white} numberOfLines={2} style={{ maxWidth: tileW - 24 }}>
                    {g.label}
                  </T>
                </Tap>
              ))}
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}
