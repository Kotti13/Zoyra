import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Icon, Loading, Sheet, T, Tap, Toast, useAsync } from '../components';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors, fonts } from '../theme/tokens';

type Note = { message: string; error?: boolean };

export default function AddToPlaylist() {
  const player = usePlayerPick('track');
  const track = useSheetTrack(player.track);
  const { user } = useAuth();
  const { playlists, createPlaylist, addToPlaylist } = useLibrary();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    if (!note || !note.error) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  // Playlists that already contain this song.
  const contains = useAsync(async () => {
    if (!track || !user) return new Set<string>();
    const { data, error } = await supabase.from('playlist_tracks').select('playlist_id').eq('track_id', track.id);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r) => r.playlist_id as string));
  }, [track?.id, user?.id]);

  const mine = useMemo(() => playlists.filter((p) => p.owner_id === user?.id), [playlists, user?.id]);
  const q = query.trim().toLowerCase();
  const visible = mine.filter((p) => p.title.toLowerCase().includes(q));

  if (!track) {
    return (
      <Sheet>
        <EmptyState title="No song selected" body="Pick a song first, then add it to a playlist." />
      </Sheet>
    );
  }
  if (!user) {
    return (
      <Sheet>
        <EmptyState icon="music" title="Sign in to use playlists" body="Create an account to save songs to your own playlists." action="Sign in" href="/login" />
      </Sheet>
    );
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const create = async () => {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const p = await createPlaylist({ title, visibility: 'private' });
      setSelected((s) => new Set(s).add(p.id));
      setNewTitle('');
      setCreating(false);
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not create the playlist', error: true });
    } finally {
      setBusy(false);
    }
  };

  const done = async () => {
    if (busy) return;
    if (!selected.size) {
      router.back();
      return;
    }
    setBusy(true);
    try {
      const ids = [...selected];
      await Promise.all(ids.map((id) => addToPlaylist(id, [track])));
      const name = ids.length === 1 ? mine.find((p) => p.id === ids[0])?.title ?? 'playlist' : `${ids.length} playlists`;
      setNote({ message: `Added to ${name}` });
      setTimeout(() => router.canGoBack() && router.back(), 900);
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not add the song', error: true });
      setBusy(false);
    }
  };

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Add to playlist
      </T>
      <T size={14} color={colors.textSecondary} numberOfLines={1} style={{ marginTop: -8 }}>
        {`${track.title} · ${track.artist.name}`}
      </T>

      {/* Search */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 48, borderRadius: 24, backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find a playlist"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Find a playlist"
          style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
      </View>

      {creating ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: colors.bgTertiary, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus" size={24} color={colors.accentLight} />
          </View>
          <TextInput
            value={newTitle}
            onChangeText={setNewTitle}
            autoFocus
            maxLength={100}
            placeholder="Playlist name"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="New playlist name"
            returnKeyType="done"
            onSubmitEditing={create}
            style={{ flex: 1, minWidth: 0, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16, borderBottomWidth: 1, borderBottomColor: colors.accent }}
          />
          <Tap onPress={create} accessibilityLabel="Create playlist" style={{ height: 44, justifyContent: 'center', paddingHorizontal: 8 }}>
            <T size={15} weight={600} color={newTitle.trim() ? colors.accentLight : colors.textTertiary}>
              {busy ? 'Creating…' : 'Create'}
            </T>
          </Tap>
        </View>
      ) : (
        <Tap onPress={() => setCreating(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
          <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: colors.bgTertiary, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus" size={24} color={colors.accentLight} />
          </View>
          <T size={16} weight={600}>
            New playlist
          </T>
        </Tap>
      )}

      {contains.loading ? (
        <Loading height={80} />
      ) : contains.error ? (
        <ErrorState message={contains.error} onRetry={contains.reload} />
      ) : visible.length === 0 ? (
        <T size={14} color={colors.textSecondary} style={{ paddingVertical: 12 }}>
          {mine.length ? 'No playlists match your search.' : 'You have no playlists yet. Create one above.'}
        </T>
      ) : (
        visible.map((p) => {
          const already = contains.data?.has(p.id) ?? false;
          const on = already || selected.has(p.id);
          return (
            <Tap
              key={p.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: already }}
              accessibilityLabel={already ? `${p.title}, already added` : p.title}
              onPress={already ? undefined : () => toggle(p.id)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}
            >
              <Cover uri={p.cover_url} id={p.id} size={48} radius={14} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={16} numberOfLines={1}>
                  {p.title}
                </T>
                <T size={12} color={colors.textSecondary}>
                  {already ? 'Already added' : `${p.track_count ?? 0} ${p.track_count === 1 ? 'song' : 'songs'}`}
                </T>
              </View>
              <View
                style={[
                  { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
                  on ? { backgroundColor: already ? colors.textTertiary : colors.accent } : { borderWidth: 2, borderColor: colors.textTertiary },
                ]}
              >
                {on ? <Icon name="check" size={14} color={colors.onAccent} /> : null}
              </View>
            </Tap>
          );
        })
      )}

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}

      <Button label={busy && !creating ? 'Adding…' : selected.size ? `Done · add to ${selected.size}` : 'Done'} onPress={done} />
    </Sheet>
  );
}
