import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Chip, Cover, go, Icon, ListRow, Loading, Row, Sheet, T, Tap, TextField, useAsync, useDebounced } from '../components';
import type { IconName } from '../components/icons';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { chatError, createJam, myLiveSession, sendMessage, uploadMediaForMessage, type NewMessage } from '../lib/chat';
import { routeIfSetupRequired } from '../lib/chat-e2ee';
import { fetchLyrics, sourceLines } from '../lib/lyrics';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

type Mode = 'grid' | 'song' | 'playlist' | 'lyric' | 'poll';

/**
 * Attach sheet (`/chat-attach?id=<conversation>[&mode=lyric]`), the composer's + button. Every tile
 * sends something real: song, playlist, lyric card (from LRCLIB lyrics of what's playing), photo
 * (private chat-media bucket), voice note, poll, jam (a new group listening room) and an invite to
 * my live session. Rows: Chat tools, share what's playing and schedule a message (Chat tools sheet).
 */
export default function ChatAttach() {
  const params = useLocalSearchParams<{ id?: string; mode?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const initial: Mode = params.mode === 'lyric' || params.mode === 'song' || params.mode === 'poll' ? params.mode : 'grid';
  const { user, profile } = useAuth();
  const me = user?.id;
  const { track: nowPlaying } = usePlayerPick('track');
  const lib = useLibrary();
  const [mode, setMode] = useState<Mode>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  type Outgoing = NewMessage & { requireEncrypted?: boolean };
  const send = async (key: string, m: Outgoing | (() => Promise<Outgoing | null>), after?: () => void) => {
    if (!cid || !me || busy) return;
    setBusy(key);
    setNote(null);
    try {
      const msg = typeof m === 'function' ? await m() : m;
      if (!msg) return;
      const { requireEncrypted, ...rest } = msg;
      await sendMessage(cid, me, rest, { requireEncrypted });
      if (after) after();
      else go('back');
    } catch (e) {
      if (routeIfSetupRequired(e, `/chat-pro?id=${encodeURIComponent(cid)}`)) return;
      setNote({ ok: false, text: chatError(e, 'Not sent') });
    } finally {
      setBusy(null);
    }
  };

  if (!cid || !me) {
    return (
      <Sheet>
        <T variant="section">Share in chat</T>
        <T size={14} color={colors.textSecondary}>
          {me ? 'Open a chat first.' : 'Sign in to share in chat.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  const pickPhoto = () =>
    send('photo', async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('Photo library access is needed to share a photo.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return null;
      const a = res.assets[0];
      const mime = a.mimeType && a.mimeType.startsWith('image/') ? a.mimeType : 'image/jpeg';
      const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : mime === 'image/heic' ? 'heic' : 'jpg';
      // Encrypted before upload when the chat is end-to-end encrypted (meta.media carries path + file key).
      const up = await uploadMediaForMessage(cid, me, a.uri, mime, ext, 'photo', { width: a.width, height: a.height });
      return { kind: 'photo', meta: up.meta, requireEncrypted: up.requireEncrypted };
    });

  const startJam = () => {
    let roomId = '';
    void send(
      'jam',
      async () => {
        const jam = await createJam(me, `${profile?.display_name ?? 'My'}'s jam`);
        roomId = jam.room_id;
        return { kind: 'jam', meta: jam };
      },
      () => router.replace({ pathname: '/group-listening', params: { id: roomId } }),
    );
  };

  const inviteLive = () =>
    send('live', async () => {
      const live = await myLiveSession(me);
      if (!live) {
        router.replace('/go-live');
        return null;
      }
      return { kind: 'live', meta: live, body: '' };
    });

  const tiles: { key: string; label: string; icon: IconName; bg: string; onPress: () => void }[] = [
    { key: 'song', label: 'Song', icon: 'music', bg: colors.accent, onPress: () => setMode('song') },
    { key: 'playlist', label: 'Playlist', icon: 'library', bg: colors.indigo, onPress: () => setMode('playlist') },
    { key: 'lyric', label: 'Lyric card', icon: 'file', bg: colors.orange, onPress: () => setMode('lyric') },
    { key: 'photo', label: 'Photo', icon: 'image', bg: PHOTO_BLUE, onPress: () => void pickPhoto() },
    { key: 'voice', label: 'Voice', icon: 'mic', bg: colors.accentLight, onPress: () => router.replace({ pathname: '/chat-voice', params: { id: cid } }) },
    { key: 'poll', label: 'Poll', icon: 'target', bg: colors.gold, onPress: () => setMode('poll') },
    { key: 'jam', label: 'Jam', icon: 'headphones', bg: JAM_VIOLET, onPress: startJam },
    { key: 'live', label: 'Invite to live', icon: 'broadcast', bg: LIVE_GREEN, onPress: () => void inviteLive() },
  ];

  const back = (title: string) => (
    <Row style={{ justifyContent: 'space-between' }}>
      <T variant="section" accessibilityRole="header">
        {title}
      </T>
      {initial === 'grid' ? (
        <Tap onPress={() => setMode('grid')} accessibilityLabel="Back to attachments">
          <T size={14} color={colors.accentLight}>
            Back
          </T>
        </Tap>
      ) : null}
    </Row>
  );

  const noteView = note ? (
    <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
      {note.text}
    </T>
  ) : null;

  if (mode === 'song') {
    return (
      <Sheet gap={10}>
        {back('Share a song')}
        <SongPicker busy={busy} onPick={(t) => void send(`s${t.id}`, { kind: 'track', track: t })} />
        {noteView}
      </Sheet>
    );
  }

  if (mode === 'playlist') {
    const list = lib.playlists;
    return (
      <Sheet gap={10}>
        {back('Share a playlist')}
        {!list.length ? (
          <T size={14} color={colors.textSecondary}>
            You have no playlists yet. Create one in your library.
          </T>
        ) : (
          <ScrollView style={{ maxHeight: 380 }}>
            {list.map((p, i) => {
              const priv = p.visibility === 'private';
              return (
                <ListRow
                  key={p.id}
                  divider={i > 0}
                  title={p.title}
                  subtitle={priv ? 'Private: make it public to share' : p.track_count !== undefined ? `${p.track_count} songs` : p.visibility}
                  leading={<Cover uri={p.cover_url} id={p.id} size={44} radius={12} />}
                  right={busy === p.id ? <T size={13} color={colors.textSecondary}>Sending…</T> : priv ? false : undefined}
                  onPress={priv ? undefined : () => void send(p.id, { kind: 'playlist', meta: { id: p.id, title: p.title, cover_url: p.cover_url, track_count: p.track_count } })}
                />
              );
            })}
          </ScrollView>
        )}
        {noteView}
      </Sheet>
    );
  }

  if (mode === 'lyric') {
    return (
      <Sheet gap={10}>
        {back('Send a lyric card')}
        {nowPlaying ? (
          <LyricPicker track={nowPlaying} busy={busy} onPick={(line) => void send('lyric', { kind: 'lyric', track: nowPlaying, meta: { line } })} />
        ) : (
          <T size={14} color={colors.textSecondary}>
            Play a song first. Lyric cards use the lyrics of what’s playing.
          </T>
        )}
        {noteView}
      </Sheet>
    );
  }

  if (mode === 'poll') {
    return (
      <Sheet gap={10}>
        {back('Create a poll')}
        <PollComposer busy={busy === 'poll'} onSend={(question, options) => void send('poll', { kind: 'poll', meta: { question, options } })} />
        {noteView}
      </Sheet>
    );
  }

  return (
    <Sheet gap={12}>
      <T size={18} weight={600} accessibilityRole="header">
        Share in chat
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 }}>
        {tiles.map((t) => {
          const working = busy === t.key;
          return (
            <Tap
              key={t.key}
              onPress={t.onPress}
              disabled={!!busy && !working}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityState={{ busy: working, disabled: !!busy && !working }}
              style={{ width: '25%', paddingHorizontal: 4, alignItems: 'center', gap: 8 }}
            >
              <View style={{ width: 60, height: 60, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg, opacity: busy && !working ? 0.5 : 1 }}>
                <Icon name={t.icon} size={26} color={colors.onAccent} />
              </View>
              <T size={12} weight={600} align="center" numberOfLines={1}>
                {working ? 'Working…' : t.label}
              </T>
            </Tap>
          );
        })}
      </View>

      <View style={{ borderRadius: 36, paddingVertical: 4, paddingHorizontal: 16, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <AttachRow title="Chat tools" subtitle="Blend, song swap, shared queue, more" icon="grid" solid onPress={() => router.replace({ pathname: '/chat-tools', params: { id: cid } })} />
        <AttachRow
          divider
          title="Now playing"
          subtitle={busy === 'now' ? 'Sending…' : nowPlaying ? `Share ${nowPlaying.title} instantly` : 'Play a song to share it instantly'}
          icon="play"
          onPress={nowPlaying ? () => void send('now', { kind: 'track', track: nowPlaying }) : undefined}
        />
        <AttachRow divider title="Schedule message" subtitle="Send later at a set time" icon="clock" onPress={() => router.replace({ pathname: '/chat-tools', params: { id: cid, mode: 'schedule' } })} />
      </View>
      {noteView}
      <Tap
        onPress={() => go('back')}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={{ height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
      >
        <T size={15} weight={600}>
          Cancel
        </T>
      </Tap>
    </Sheet>
  );
}

/** Design tile colours without a theme token. */
const PHOTO_BLUE = '#2B6BFF';
const JAM_VIOLET = '#8A4BFF';
const LIVE_GREEN = '#1FBF8F';

/** Row in the sheet's glass card: 40 px icon (solid accent for Chat tools, tinted otherwise), chevron. */
function AttachRow({ title, subtitle, icon, onPress, divider, solid }: { title: string; subtitle: string; icon: IconName; onPress?: () => void; divider?: boolean; solid?: boolean }) {
  return (
    <Tap
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={onPress ? undefined : { disabled: true }}
      pressScale={0.98}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68 }, divider ? { borderTopWidth: 1, borderTopColor: colors.divider } : null]}
    >
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: solid ? colors.accent : colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={solid ? colors.white : colors.accentLight} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500}>
          {title}
        </T>
        <T size={14} color={colors.textSecondary} numberOfLines={1}>
          {subtitle}
        </T>
      </View>
      <Icon name="chevronRight" size={16} color={onPress ? colors.textSecondary : colors.textTertiary} />
    </Tap>
  );
}

/* ------------------------------------------------------------------ pickers */

function SongPicker({ busy, onPick }: { busy: string | null; onPick: (t: CatalogTrack) => void }) {
  const { user } = useAuth();
  const { track: nowPlaying } = usePlayerPick('track');
  const [q, setQ] = useState('');
  const query = useDebounced(q.trim(), 300);
  const recent = useAsync<CatalogTrack[]>(async () => {
    if (!user) return [];
    const { data, error } = await supabase.from('play_history').select('track').eq('user_id', user.id).order('played_at', { ascending: false }).limit(60);
    if (error) throw new Error(error.message);
    const seen = new Set<string>();
    const out: CatalogTrack[] = [];
    for (const r of (data ?? []) as { track: CatalogTrack }[]) {
      if (!r.track?.id || seen.has(r.track.id)) continue;
      seen.add(r.track.id);
      out.push(r.track);
    }
    return out.slice(0, 20);
  }, [user?.id], 'app/chat-attach:302');
  const results = useAsync<CatalogTrack[]>(() => (query ? catalog.searchTracks(query, { limit: 20 }) : Promise.resolve([])), [query], 'app/chat-attach:315');

  const list = query ? results : recent;
  const tracks = (query ? [] : nowPlaying ? [nowPlaying] : []).concat((list.data ?? []).filter((t) => t.id !== nowPlaying?.id || !!query));

  return (
    <>
      <TextField label="Search songs" hideLabel placeholder="Search songs" icon="search" value={q} onChangeText={setQ} returnKeyType="search" />
      {!query ? (
        <T variant="overline" color={colors.textSecondary}>
          RECENTLY PLAYED
        </T>
      ) : null}
      {list.loading ? (
        <Loading height={120} />
      ) : list.error ? (
        <T size={13} color={colors.error}>
          {list.error}
        </T>
      ) : !tracks.length ? (
        <T size={14} color={colors.textSecondary}>
          {query ? 'No songs found.' : 'Play something or search above.'}
        </T>
      ) : (
        <ScrollView style={{ maxHeight: 360 }} keyboardShouldPersistTaps="handled">
          {tracks.map((t, i) => (
            <ListRow
              key={`${t.id}-${i}`}
              divider={i > 0}
              title={t.title}
              subtitle={t.artist.name}
              leading={<Cover artwork={t.artwork} id={t.id} size={44} radius={12} />}
              right={busy === `s${t.id}` ? <T size={13} color={colors.textSecondary}>Sending…</T> : <Icon name="arrowRight" size={18} color={colors.textSecondary} />}
              onPress={() => onPick(t)}
            />
          ))}
        </ScrollView>
      )}
    </>
  );
}

function LyricPicker({ track, busy, onPick }: { track: CatalogTrack; busy: string | null; onPick: (line: string) => void }) {
  const lyrics = useAsync(() => fetchLyrics(track), [track.id], 'app/chat-attach:358');
  const lines = lyrics.data ? [...new Set(sourceLines(lyrics.data).map((l) => l.trim()).filter(Boolean))] : [];
  return (
    <>
      <Row gap={10}>
        <Cover artwork={track.artwork} id={track.id} size={40} radius={12} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={14} weight={600} numberOfLines={1}>
            {track.title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {track.artist.name} · tap a line to send it
          </T>
        </View>
      </Row>
      {lyrics.loading ? (
        <Loading height={120} />
      ) : lyrics.error ? (
        <T size={13} color={colors.error}>
          {lyrics.error}
        </T>
      ) : lyrics.data?.instrumental ? (
        <T size={14} color={colors.textSecondary}>
          This track is instrumental.
        </T>
      ) : !lines.length ? (
        <T size={14} color={colors.textSecondary}>
          No lyrics found for this song.
        </T>
      ) : (
        <ScrollView style={{ maxHeight: 380 }}>
          {lines.map((l) => (
            <Tap key={l} onPress={() => onPick(l)} accessibilityLabel={`Send lyric: ${l}`} style={{ paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
              <T size={16} weight={300} color={busy === 'lyric' ? colors.textSecondary : colors.text}>
                {l}
              </T>
            </Tap>
          ))}
        </ScrollView>
      )}
    </>
  );
}

function PollComposer({ busy, onSend }: { busy: boolean; onSend: (q: string, options: string[]) => void }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const clean = options.map((o) => o.trim()).filter(Boolean);
  const ok = question.trim().length > 0 && clean.length >= 2 && new Set(clean).size === clean.length;
  return (
    <>
      <TextField label="Question" placeholder="Opening song for Saturday?" value={question} onChangeText={setQuestion} maxLength={140} />
      {options.map((o, i) => (
        <TextField
          key={i}
          label={`Option ${i + 1}`}
          hideLabel
          placeholder={`Option ${i + 1}`}
          value={o}
          maxLength={60}
          onChangeText={(t) => setOptions((xs) => xs.map((x, j) => (j === i ? t : x)))}
        />
      ))}
      <Row gap={8}>
        {options.length < 4 ? <Chip label="+ Add option" onPress={() => setOptions((xs) => [...xs, ''])} /> : null}
        {options.length > 2 ? <Chip label="Remove last" onPress={() => setOptions((xs) => xs.slice(0, -1))} /> : null}
      </Row>
      <Button label={busy ? 'Sending…' : 'Send poll'} icon="target" variant={ok && !busy ? 'primary' : 'disabled'} onPress={() => onSend(question.trim(), clean)} />
    </>
  );
}
