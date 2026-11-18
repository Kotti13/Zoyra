import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, Glass, Icon, IconButton, Row, Screen, ScreenHeader, T, Tap, Toast, useAsync } from '../components';
import { catalog, formatDuration, type CatalogTrack } from '../lib/catalog';
import { fetchLyrics, activeLine } from '../lib/lyrics';
import { shareContent, trackShareUrl } from '../lib/share-links';
import { clock } from '../lib/track-comments';
import { useLibrary } from '../state/library';
import { usePlayerPick } from '../state/player';
import { setSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Best catalogue song for what was heard: same title and a matching artist first, then the closest title. */
function pick(tracks: CatalogTrack[], title: string, artist: string): CatalogTrack | null {
  const t = norm(title);
  const a = norm(artist);
  const score = (x: CatalogTrack) => {
    const xt = norm(x.title);
    const xa = norm(x.artist.name);
    return (xt === t ? 4 : xt.includes(t) || t.includes(xt) ? 2 : 0) + (a && (xa === a || a.includes(xa) || xa.includes(a)) ? 3 : 0);
  };
  const best = [...tracks].sort((p, q) => score(q) - score(p))[0];
  return best && score(best) >= 4 ? best : null;
}

/**
 * Identify result (`/identify-result?title=&artist=[&album=&offsetMs=&score=&mode=]`). Shows the match, plays it
 * from the catalogue, and (when the server says where in the song the clip was) the moment you heard and the lyric
 * line sung there. Everything shown comes from the match or the catalogue; nothing is invented.
 */
export default function IdentifyResult() {
  const p = useLocalSearchParams<{ title?: string; artist?: string; album?: string; offsetMs?: string; score?: string; mode?: string }>();
  const title = typeof p.title === 'string' ? p.title : '';
  const artist = typeof p.artist === 'string' ? p.artist : '';
  const album = typeof p.album === 'string' ? p.album : '';
  const offset = Number(p.offsetMs);
  const heardAt = Number.isFinite(offset) && p.offsetMs !== undefined && offset >= 0 ? offset / 1000 : null;
  const score = Number(p.score);
  const pct = Number.isFinite(score) && p.score !== undefined && score > 0 ? Math.min(100, Math.round(score)) : null;

  const { playTrack, track: current, playing, toggle, seekTo } = usePlayerPick('track', 'playing');
  const { isLiked, toggleLike } = useLibrary();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const found = useAsync(async () => {
    if (!title) return null;
    const list = await catalog.searchTracks(`${title} ${artist}`.trim(), { limit: 10 }).catch(() => [] as CatalogTrack[]);
    return pick(list, title, artist);
  }, [title, artist]);
  const track = found.data ?? null;

  const lyrics = useAsync(async () => (track && heardAt !== null ? fetchLyrics(track) : null), [track?.id, heardAt]);
  const line = (() => {
    const synced = lyrics.data?.synced ?? [];
    if (heardAt === null || !synced.length || lyrics.data?.timingMismatch) return null;
    const i = activeLine(synced, heardAt);
    return i >= 0 ? synced[i].text.trim() || null : null;
  })();

  if (!title) {
    return (
      <Screen top={4}>
        <ScreenHeader title="Identify" />
        <T color={colors.textSecondary}>Nothing to show. Start from Identify.</T>
        <Button label="Identify a song" onPress={() => router.replace('/identify')} />
      </Screen>
    );
  }

  const isCurrent = !!track && current?.id === track.id;
  const liked = !!track && isLiked(track.id);
  const url = track ? trackShareUrl(track) : null;

  const onPlay = () => {
    if (!track) return;
    if (isCurrent) return toggle();
    const res = playTrack(track, track.title);
    if (!res.played) setNote({ ok: false, text: res.reason ?? 'This song cannot be played right now.' });
  };
  const onPlayMoment = () => {
    if (!track || heardAt === null) return;
    if (isCurrent) return seekTo(heardAt);
    const res = playTrack(track, track.title);
    if (!res.played) return setNote({ ok: false, text: res.reason ?? 'This song cannot be played right now.' });
    setTimeout(() => seekTo(heardAt), 900); // the player ignores seeks before the song can seek
  };
  const onLike = async () => {
    if (!track) return;
    try {
      await toggleLike(track);
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not update your likes' });
    }
  };
  const openSheet = (href: '/add-to-playlist') => {
    if (!track) return;
    setSheetTrack(track);
    router.push(href);
  };
  const share = () => {
    if (!track || !url) return;
    void shareContent({ url, title: track.title, message: `${track.title} by ${track.artist.name} on Zoyra` }).catch(() => setNote({ ok: false, text: 'Could not open the share sheet' }));
  };

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="" backIcon="close" />

      <View style={{ alignItems: 'center', gap: 16 }}>
        <View style={{ alignSelf: 'center', height: 30, paddingHorizontal: 14, borderRadius: 15, justifyContent: 'center', backgroundColor: withAlpha(colors.accent, 0.22) }}>
          <T size={12} weight={700} color={colors.accentLight}>
            {pct ? `Match found · ${pct}%` : 'Match found'}
          </T>
        </View>
        <Cover artwork={track?.artwork} id={track?.id ?? title} width={240} height={240} radius={28} />
        <View style={{ alignItems: 'center', gap: 4 }}>
          <T size={26} weight={700} align="center" numberOfLines={3} accessibilityRole="header">
            {track?.title ?? title}
          </T>
          <T size={15} color={colors.textSecondary} align="center" numberOfLines={2}>
            {track?.artist.name ?? artist}
            {album ? ` · ${album}` : ''}
          </T>
        </View>
      </View>

      {found.loading && !found.data ? (
        <T size={13} color={colors.textSecondary} align="center">
          Finding it in Zoyra…
        </T>
      ) : track ? (
        <Row gap={10}>
          <Button label={isCurrent && playing ? 'Pause' : 'Play'} icon={isCurrent && playing ? 'pause' : 'play'} onPress={onPlay} style={{ flex: 1 }} />
          <IconButton icon="heart" filled={liked} color={liked ? colors.like : colors.text} label={liked ? 'Remove from liked songs' : 'Like song'} glass size={48} onPress={() => void onLike()} />
          <IconButton icon="plus" label="Add to playlist" glass size={48} onPress={() => openSheet('/add-to-playlist')} />
          <IconButton icon="share" label="Share song" glass size={48} onPress={share} />
        </Row>
      ) : (
        <Glass radius={24} padding={16} style={{ gap: 10 }}>
          <T size={14} color={colors.textSecondary}>
            This song isn&apos;t in the Zoyra catalogue yet, so it can&apos;t be played here.
          </T>
          <Button label="Search for it" variant="secondary" onPress={() => router.push('/search')} />
        </Glass>
      )}

      {heardAt !== null ? (
        <Glass radius={26} padding={16} style={{ gap: 12 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={11} weight={700} color={colors.textSecondary} style={{ letterSpacing: 1.5 }}>
              {`HEARD AT ${clock(heardAt)}`}
            </T>
            {track ? (
              <Tap onPress={onPlayMoment} accessibilityLabel={`Play from ${clock(heardAt)}`} style={{ minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name="play" size={14} color={colors.accentLight} />
                <T size={12} weight={600} color={colors.accentLight}>
                  Play from here
                </T>
              </Tap>
            ) : null}
          </Row>
          {track?.duration ? (
            <View style={{ height: 4, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.12) }} accessibilityLabel={`${clock(heardAt)} of ${formatDuration(track.duration)}`}>
              <View style={{ width: `${Math.min(100, (heardAt / track.duration) * 100)}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
            </View>
          ) : null}
          {line ? (
            <View style={{ gap: 4 }}>
              <T size={12} color={colors.textSecondary}>
                Lyrics at this moment
              </T>
              <T size={18} weight={600} lineHeight={25}>
                {`“${line}”`}
              </T>
            </View>
          ) : null}
        </Glass>
      ) : null}

      {track && url ? (
        <Tap onPress={share} accessibilityLabel="Send to a friend" pressScale={0.98}>
          <Glass radius={26} padding={16} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Icon name="send" size={20} color={colors.accentLight} />
            <View style={{ flex: 1, gap: 2 }}>
              <T size={15} weight={600}>
                Send to a friend
              </T>
              <T size={13} color={colors.textSecondary}>
                Share a link to this song
              </T>
            </View>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </Glass>
        </Tap>
      ) : null}

      <Button label="Identify another" variant="secondary" onPress={() => router.replace({ pathname: '/identify', params: p.mode === 'hum' ? { mode: 'hum' } : {} })} />

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.amber} message={note.text} /> : null}
    </Screen>
  );
}
