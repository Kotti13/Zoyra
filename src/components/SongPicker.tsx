import { useState } from 'react';
import { ScrollView } from 'react-native';

import { catalog, type CatalogTrack } from '../lib/catalog';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerSelector } from '../state/player';
import { colors } from '../theme/tokens';
import { Chip, TextField } from './controls';
import { ListRow } from './layout';
import { Cover, Loading, useAsync, useDebounced } from './media';
import { Icon, Row, T } from './primitives';

type Source = 'recent' | 'liked';

/** Recently played tracks (newest first, unique), from `play_history`. */
async function loadRecent(uid: string | undefined): Promise<CatalogTrack[]> {
  if (!uid) return [];
  const { data, error } = await supabase.from('play_history').select('track').eq('user_id', uid).order('played_at', { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  const seen = new Set<string>();
  const out: CatalogTrack[] = [];
  for (const r of (data ?? []) as { track: CatalogTrack }[]) {
    if (!r.track?.id || seen.has(r.track.id)) continue;
    seen.add(r.track.id);
    out.push(r.track);
  }
  return out.slice(0, 20);
}

/**
 * Pick a song: catalog search (same API as the Search tab), plus Now playing + Recently played and
 * Liked songs quick lists when the query is empty.
 */
export function SongPicker({
  onPick,
  busyId,
  busyLabel = 'Sending…',
  selectedId,
  maxHeight = 360,
}: {
  onPick: (t: CatalogTrack) => void;
  /** Track id currently being acted on (shows `busyLabel`, disables rows). */
  busyId?: string | null;
  busyLabel?: string;
  /** Marks the currently chosen track. */
  selectedId?: string | null;
  maxHeight?: number;
}) {
  const { user } = useAuth();
  const nowPlaying = usePlayerSelector((s) => s.track);
  const { liked } = useLibrary();
  const [q, setQ] = useState('');
  const [source, setSource] = useState<Source>('recent');
  const query = useDebounced(q.trim(), 300);

  const recent = useAsync<CatalogTrack[]>(() => loadRecent(user?.id), [user?.id]);
  const results = useAsync<CatalogTrack[]>(() => (query ? catalog.searchTracks(query, { limit: 20 }) : Promise.resolve([])), [query]);

  const state = query ? results : source === 'recent' ? recent : { data: liked, loading: false, error: null };
  const base = state.data ?? [];
  const tracks = !query && source === 'recent' && nowPlaying ? [nowPlaying, ...base.filter((t) => t.id !== nowPlaying.id)] : base;
  const empty = query ? 'No songs found.' : source === 'liked' ? 'Songs you like show up here.' : 'Play something or search above.';

  return (
    <>
      <TextField label="Search songs" hideLabel placeholder="Search songs" icon="search" value={q} onChangeText={setQ} returnKeyType="search" autoCorrect={false} />
      {!query ? (
        <Row gap={8} accessibilityRole="tablist">
          <Chip label={nowPlaying ? 'Now playing + recent' : 'Recently played'} active={source === 'recent'} onPress={() => setSource('recent')} />
          <Chip label="Liked" active={source === 'liked'} onPress={() => setSource('liked')} />
        </Row>
      ) : null}
      {state.loading ? (
        <Loading height={120} />
      ) : state.error ? (
        <T size={13} color={colors.error}>
          {state.error}
        </T>
      ) : !tracks.length ? (
        <T size={14} color={colors.textSecondary}>
          {empty}
        </T>
      ) : (
        <ScrollView style={{ maxHeight }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {tracks.map((t, i) => {
            const selected = t.id === selectedId;
            return (
              <ListRow
                key={`${t.id}-${i}`}
                divider={i > 0}
                title={t.title}
                subtitle={`${t.artist.name}${!query && source === 'recent' && i === 0 && nowPlaying?.id === t.id ? ' · Now playing' : ''}`}
                leading={<Cover artwork={t.artwork} id={t.id} size={44} radius={12} />}
                right={
                  busyId === t.id ? (
                    <T size={13} color={colors.textSecondary}>
                      {busyLabel}
                    </T>
                  ) : (
                    <Icon name={selected ? 'check' : 'arrowRight'} size={18} color={selected ? colors.accentLight : colors.textSecondary} />
                  )
                }
                onPress={busyId ? undefined : () => onPick(t)}
              />
            );
          })}
        </ScrollView>
      )}
    </>
  );
}
