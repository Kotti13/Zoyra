/** Shared UI bits for the Chat Pro screens (voice note player, photo, waveform, avatar). */
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, View } from 'react-native';

import { Cover, Gradient, Icon, Row, SkeletonBlock, T, Tap } from '../components';
import type { CatalogTrack } from './catalog';
import { usePlayerPick } from '../state/player';
import { colors, shadow, withAlpha } from '../theme/tokens';
import { capsuleDateLabel, countdownParts, type CapsuleRow, type WhisperView } from './chat-extras';
import {
  blendMeta,
  capsuleMeta,
  formatMs,
  jamMeta,
  liveMeta,
  locationMeta,
  lyricMeta,
  mapsUrl,
  playlistMeta,
  swapMeta,
  trackArtist,
  useChatMediaUrl,
  type ChatMessage,
  type ChatPerson,
  type PhotoMeta,
  type PollMeta,
  type VoiceMeta,
  type Vote,
} from './chat';
import { decryptErrorOf } from './chat-e2ee';
import { isImageUri } from './profile';

/**
 * The other person's avatar. While they're unknown (chat still loading) a neutral skeleton circle; without
 * a photo, the first letter of their name (or username), else a user icon. Never a "?".
 */
export function ChatAvatar({
  person,
  size = 36,
  radius,
}: {
  person: (Pick<ChatPerson, 'id' | 'display_name' | 'avatar_url'> & { username?: string | null }) | null;
  size?: number;
  radius?: number;
}) {
  const r = radius ?? size / 2;
  if (!person) return <SkeletonBlock width={size} height={size} r={r} />;
  const uri = isImageUri(person.avatar_url) ? person.avatar_url : null;
  const initial = (person.display_name?.trim() || person.username?.trim() || '').charAt(0);
  return (
    <Cover uri={uri} id={person.id} size={size} radius={r} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {uri ? null : initial ? (
        <T size={Math.round(size * 0.36)} weight={700} color={colors.white}>
          {initial.toUpperCase()}
        </T>
      ) : (
        <Icon name="user" size={Math.round(size * 0.46)} color={colors.white} />
      )}
    </Cover>
  );
}

/** Bars from real recorded metering levels (0..1). Without levels, a flat progress line. */
export function Waveform({ levels, progress, color, dim, height = 28 }: { levels?: number[]; progress: number; color: string; dim: string; height?: number }) {
  if (!levels?.length) {
    return (
      <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: dim, overflow: 'hidden' }}>
        <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, backgroundColor: color }} />
      </View>
    );
  }
  return (
    <Row gap={2} style={{ flex: 1, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {levels.map((l, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(3, Math.round(l * height)),
            borderRadius: 2,
            backgroundColor: i / levels.length < progress ? color : dim,
          }}
        />
      ))}
    </Row>
  );
}

/** Plays a voice note from chat-media (signed URL). Pauses the music while it plays. */
export function VoiceNote({ meta, mine }: { meta: VoiceMeta; mine: boolean }) {
  const media = useChatMediaUrl(meta.path, meta.key, meta.mime);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  // Play state is only read when the voice note starts: no re-render of every chat row on play/pause.
  const music = usePlayerPick();

  useEffect(() => {
    if (media.url) player.replace({ uri: media.url }); // expo-audio players don't loop by default
  }, [media.url, player]);

  // Finished: stop and rewind. Pause BEFORE seeking: seeking a player that still "wants" to play restarts
  // it, which made voice notes loop. It stays stopped until the user taps play again.
  useEffect(() => {
    if (!status.didJustFinish) return;
    player.pause();
    void player.seekTo(0).catch(() => undefined);
  }, [status.didJustFinish, player]);

  const fg = mine ? colors.onAccent : colors.text;
  const durationMs = status.duration > 0 ? status.duration * 1000 : meta.duration_ms;
  const progress = durationMs > 0 ? Math.min(1, (status.currentTime * 1000) / durationMs) : 0;

  const toggle = () => {
    if (!media.url) return;
    if (status.playing) {
      player.pause();
    } else {
      if (music.getState().playing) music.pause();
      player.play();
    }
  };

  return (
    <Row gap={10} style={{ alignSelf: 'stretch' }}>
      <Tap
        onPress={toggle}
        accessibilityLabel={status.playing ? 'Pause voice note' : `Play voice note, ${formatMs(meta.duration_ms)}`}
        hitSlop={5}
        style={{ width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: mine ? withAlpha(colors.white, 0.22) : colors.accent }}
      >
        {media.loading ? <ActivityIndicator size="small" color={colors.white} /> : <Icon name={status.playing ? 'pause' : 'play'} size={18} color={colors.white} filled />}
      </Tap>
      {media.error ? (
        <T size={12} color={fg} style={{ flex: 1 }}>
          Couldn’t load voice note
        </T>
      ) : (
        <Waveform levels={meta.levels} progress={progress} color={fg} dim={withAlpha(fg, 0.3)} />
      )}
      <T size={11} color={fg} style={{ fontVariant: ['tabular-nums'] }}>
        {formatMs(status.playing || status.currentTime > 0 ? status.currentTime * 1000 : durationMs)}
      </T>
    </Row>
  );
}

export function PhotoBubble({ meta, onPress, onLongPress }: { meta: PhotoMeta; onPress?: () => void; onLongPress?: () => void }) {
  const media = useChatMediaUrl(meta.path, meta.key, meta.mime);
  const ratio = meta.width && meta.height ? Math.min(1.6, Math.max(0.6, meta.width / meta.height)) : 1;
  const w = 220;
  return (
    <Tap onPress={onPress} onLongPress={onLongPress} delayLongPress={300} accessibilityLabel="Photo" accessibilityHint={onLongPress ? 'Opens the photo. Long press for message options' : undefined} style={{ width: w, height: Math.round(w / ratio), borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }}>
      {media.url ? (
        <Image source={{ uri: media.url }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={150} accessibilityIgnoresInvertColors />
      ) : media.error ? (
        <T size={12} color={colors.textSecondary}>
          Couldn’t load photo
        </T>
      ) : (
        <ActivityIndicator color={colors.textSecondary} />
      )}
    </Tap>
  );
}

/* ================================================================== shared cards (group chat; chat-pro keeps its own copies) */

const CARD_BG = withAlpha(colors.white, 0.06);
const CARD_BORDER = withAlpha(colors.white, 0.12);

/** Glass card bubble (polls, songs, playlists, jams…): 260 wide, 32 radius, as in the ChatPro design. */
export function ChatCard({
  mine,
  children,
  onPress,
  onLongPress,
  label,
  width = 260,
  padding = 12,
  gap = 10,
}: {
  mine: boolean;
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  label?: string;
  width?: number;
  padding?: number;
  gap?: number;
}) {
  return (
    <Tap
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityLabel={label}
      pressScale={0.98}
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width, maxWidth: '100%', borderRadius: 32, padding, backgroundColor: CARD_BG, borderWidth: 1, borderColor: CARD_BORDER, gap }}
    >
      {children}
    </Tap>
  );
}

function PlayDot() {
  return (
    <View style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }, shadow.sticker]}>
      <Icon name="play" size={16} color={colors.onAccent} filled />
    </View>
  );
}

/** Poll card: options fill with the share of votes; tap an option to vote (again to change). */
export function PollCard({
  poll,
  votes,
  me,
  mine,
  onVote,
  onLongPress,
}: {
  poll: PollMeta;
  votes: Vote[];
  me: string | undefined;
  mine: boolean;
  onVote: (option: number) => void;
  onLongPress?: () => void;
}) {
  const myVote = votes.find((x) => x.user_id === me)?.option;
  return (
    <ChatCard mine={mine} onLongPress={onLongPress} padding={14} gap={8}>
      <T size={11} weight={700} tracking={0.8} color={colors.accentLight}>
        POLL
      </T>
      <T size={15} weight={600}>
        {poll.question}
      </T>
      {poll.options.map((o, i) => {
        const n = votes.filter((x) => x.option === i).length;
        const pct = votes.length ? Math.round((n / votes.length) * 100) : 0;
        const chosen = myVote === i;
        return (
          <Tap
            key={i}
            onPress={() => onVote(i)}
            accessibilityLabel={`${o}, ${pct} percent${chosen ? ', your vote' : ''}`}
            accessibilityState={{ selected: chosen }}
            hitSlop={4}
            style={{ height: 36, borderRadius: 18, overflow: 'hidden', backgroundColor: withAlpha(colors.white, 0.08), borderWidth: chosen ? 1 : 0, borderColor: colors.accent, justifyContent: 'center' }}
          >
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: withAlpha(colors.accent, 0.45) }} />
            <Row style={{ paddingHorizontal: 14, justifyContent: 'space-between' }}>
              <T size={13} weight={600} numberOfLines={1} style={{ flex: 1 }}>
                {o}
              </T>
              <T size={13} weight={600}>
                {votes.length ? `${pct}%` : ''}
              </T>
            </Row>
          </Tap>
        );
      })}
      <T size={11} color={colors.textSecondary} accessibilityHint={myVote === undefined ? 'Tap an option to vote' : 'Tap another option to change your vote'}>
        {votes.length === 1 ? '1 vote' : `${votes.length} votes`}
      </T>
    </ChatCard>
  );
}

function IconDisc({ icon, tint = colors.accentLight, bg = colors.accentTint }: { icon: 'users' | 'cast' | 'pin'; tint?: string; bg?: string }) {
  return (
    <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={22} color={tint} />
    </View>
  );
}

/** True when RichMessageCard renders something for this message. */
export function hasRichCard(m: ChatMessage): boolean {
  return !!(lyricMeta(m) || blendMeta(m) || playlistMeta(m) || jamMeta(m) || liveMeta(m) || locationMeta(m) || swapMeta(m) || m.track);
}

/**
 * Rich (non-text) message content: lyric card, Blend / playlist, song swap (as a song card), jam / live
 * invite, location, or a shared song. Returns null for plain text, voice notes, photos and polls.
 * `from` is who shared it ("you" or their name), used for the player context.
 */
export function RichMessageCard({ m, mine, from, onLongPress, onError }: { m: ChatMessage; mine: boolean; from: string; onLongPress?: () => void; onError?: (msg: string) => void }) {
  const { playTrack } = usePlayerPick();
  const play = (t: CatalogTrack, ctx: string) => {
    playTrack(t, ctx);
    router.push('/player');
  };
  const ly = lyricMeta(m);
  if (ly) {
    return (
      <ChatCard mine={mine} onPress={() => play(ly.track, `Lyric card from ${from}`)} onLongPress={onLongPress} label={`Lyric card: ${ly.line}. Play ${ly.track.title}`}>
        <T size={18} weight={300} lineHeight={25}>
          “{ly.line}”
        </T>
        <Row gap={10}>
          <Cover artwork={ly.track.artwork} id={ly.track.id} size={36} radius={10} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={13} weight={600} numberOfLines={1}>
              {ly.track.title}
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={1}>
              {trackArtist(ly.track)}
            </T>
          </View>
          <PlayDot />
        </Row>
      </ChatCard>
    );
  }
  const blend = blendMeta(m);
  const pl = playlistMeta(m);
  if (blend || pl) {
    const id = blend?.playlist_id ?? pl?.id ?? '';
    const title = blend?.title ?? pl?.title ?? 'Playlist';
    const count = blend?.count ?? pl?.track_count;
    return (
      <ChatCard mine={mine} onPress={() => router.push({ pathname: '/playlist', params: { id } })} onLongPress={onLongPress} label={`Open playlist ${title}`}>
        <Row gap={12}>
          <Cover uri={pl?.cover_url ?? null} id={id} size={52} radius={14} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T variant="overline" color={colors.accentLight}>
              {blend ? 'BLEND' : 'PLAYLIST'}
            </T>
            <T size={15} weight={600} numberOfLines={1}>
              {title}
            </T>
            {typeof count === 'number' ? (
              <T size={12} color={colors.textSecondary}>
                {count === 1 ? '1 song' : `${count} songs`}
              </T>
            ) : null}
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </Row>
      </ChatCard>
    );
  }
  const jam = jamMeta(m);
  if (jam) {
    return (
      <ChatCard mine={mine} onPress={() => router.push({ pathname: '/group-listening', params: { id: jam.room_id } })} onLongPress={onLongPress} label={`Join jam ${jam.name}`}>
        <Row gap={12}>
          <IconDisc icon="users" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {jam.name}
            </T>
            <T size={12} color={colors.textSecondary}>
              {mine ? 'You started a jam' : `${from} started a jam`}
              {jam.code ? ` · ${jam.code}` : ''}
            </T>
          </View>
          <T size={13} weight={600} color={colors.accentLight}>
            Join
          </T>
        </Row>
      </ChatCard>
    );
  }
  const live = liveMeta(m);
  if (live) {
    return (
      <ChatCard mine={mine} onPress={() => router.push({ pathname: '/live-room', params: { id: live.session_id } })} onLongPress={onLongPress} label={`Tune in to ${live.title}`}>
        <Row gap={12}>
          <IconDisc icon="cast" tint={colors.live} bg={withAlpha(colors.live, 0.18)} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {live.title}
            </T>
            <T size={12} color={colors.textSecondary}>
              Live listening session
            </T>
          </View>
          <T size={13} weight={600} color={colors.accentLight}>
            Tune in
          </T>
        </Row>
      </ChatCard>
    );
  }
  const loc = locationMeta(m);
  if (loc) {
    return (
      <ChatCard mine={mine} onPress={() => void Linking.openURL(mapsUrl(loc)).catch(() => onError?.('Could not open maps.'))} onLongPress={onLongPress} label="Open shared location in maps">
        <Row gap={12}>
          <IconDisc icon="pin" />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600}>
              Location
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={1}>
              {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
              {loc.accuracy_m ? ` · ±${Math.round(loc.accuracy_m)} m` : ''}
            </T>
          </View>
          <Icon name="link" size={18} color={colors.textSecondary} />
        </Row>
      </ChatCard>
    );
  }
  const swap = swapMeta(m);
  const t = swap?.track ?? m.track;
  if (t) {
    const artist = trackArtist(t);
    return (
      <ChatCard mine={mine} width={250} onPress={() => play(t, `Shared by ${from}`)} onLongPress={onLongPress} label={`Play ${t.title}${artist ? ` by ${artist}` : ''}`}>
        {swap ? (
          <T variant="overline" color={colors.accentLight}>
            SONG SWAP
          </T>
        ) : null}
        <Row gap={12}>
          <Cover artwork={t.artwork} id={t.id} size={56} radius={26} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={14} weight={600} numberOfLines={1}>
              {t.title}
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={1}>
              {artist}
            </T>
          </View>
          <PlayDot />
        </Row>
      </ChatCard>
    );
  }
  return null;
}

/** Group photo, or up to three member avatars stacked (rounded squares, as in the GroupChat design). */
export function GroupAvatar({
  avatarUrl,
  members,
  size = 34,
  title,
}: {
  avatarUrl?: string | null;
  members: (Pick<ChatPerson, 'id' | 'display_name' | 'avatar_url'> & { username?: string | null })[];
  size?: number;
  title?: string;
}) {
  const r = Math.round(size / 3);
  if (avatarUrl && isImageUri(avatarUrl)) return <Cover uri={avatarUrl} id={title} size={size} radius={r} />;
  const shown = members.slice(0, 3);
  if (!shown.length) return <SkeletonBlock width={size} height={size} r={r} />;
  return (
    <Row gap={0} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {shown.map((p, i) => (
        <View key={p.id} style={{ marginLeft: i ? -Math.round(size * 0.4) : 0, borderRadius: r + 2, borderWidth: 2, borderColor: colors.bg }}>
          <ChatAvatar person={p} size={size} radius={r} />
        </View>
      ))}
    </Row>
  );
}

/** Three blinking dots for a typing bubble (static with Reduce Motion). */
export function TypingDots({ reduce, color = '#D4D4D4' }: { reduce: boolean; color?: string }) {
  const [t] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [t, reduce]);
  return (
    <>
      {[0, 0.2, 0.4].map((d) => (
        <Animated.View
          key={d}
          style={{
            width: 7,
            height: 7,
            borderRadius: 4,
            backgroundColor: color,
            opacity: reduce ? 1 : t.interpolate({ inputRange: [0, d, d + 0.25, d + 0.5, 1], outputRange: [1, 1, 0.25, 1, 1], extrapolate: 'clamp' }),
          }}
        />
      ))}
    </>
  );
}

/* ================================================================== time capsule + whisper (chat-pro, group-chat) */

const CAPSULE = '#8A4BFF';
const CAPSULE_LIGHT = '#C9A7FF';

/** Current time, re-rendering every second until `until` has passed (countdowns). */
function useNow(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const end = until ? Date.parse(until) : 0;
  const running = !!until && now <= end + 1000;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

/**
 * Time capsule bubble. Sealed for the recipient (no key yet) → locked card with the open date and a live
 * countdown; at zero `onDue()` (the chat re-decrypts it: the server releases the key at the date). Opened, or my
 * own → the text and song, revealed with a short unlock animation when it opens on screen.
 */
export function CapsuleCard({
  m,
  mine,
  row,
  from,
  reduce,
  onDue,
  onLongPress,
}: {
  m: ChatMessage;
  mine: boolean;
  row: CapsuleRow | undefined;
  from: string;
  reduce: boolean;
  onDue: () => void;
  onLongPress?: () => void;
}) {
  const { playTrack } = usePlayerPick();
  const meta = capsuleMeta(m);
  const opensAt = row?.opens_at ?? meta?.opens_at ?? null;
  const locked = !meta || !!decryptErrorOf(m);
  const now = useNow(opensAt);
  const cd = opensAt ? countdownParts(opensAt, now) : null;
  const due = !!cd?.done;
  const dueFired = useRef(false);
  useEffect(() => {
    if (locked && due && !dueFired.current) {
      dueFired.current = true;
      onDue();
    }
  }, [locked, due, onDue]);
  // Unlock animation when a locked capsule opens while on screen.
  const wasLocked = useRef(locked);
  const [anim] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (wasLocked.current && !locked && !reduce) {
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, speed: 8, bounciness: 10 }).start();
    }
    wasLocked.current = locked;
  }, [locked, reduce, anim]);
  const dateText = opensAt ? capsuleDateLabel(opensAt).toUpperCase() : '';
  const clock = cd && !cd.done ? (cd.d > 0 ? `${cd.d}d ${cd.h}h ${cd.m}m` : `${String(cd.h).padStart(2, '0')}:${String(cd.m).padStart(2, '0')}:${String(cd.s).padStart(2, '0')}`) : null;
  const card = (children: ReactNode, label: string, onPress?: () => void) => (
    <Animated.View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', width: 280, maxWidth: '88%', opacity: anim, transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }] }}>
      <Tap onPress={onPress} onLongPress={onLongPress} delayLongPress={300} accessibilityLabel={label} pressScale={0.98} style={{ borderRadius: 32, padding: 16, gap: 10, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(CAPSULE, 0.5) }}>
        <Gradient colors={[withAlpha(CAPSULE, 0.3), 'rgba(20,20,20,0.7)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        {children}
      </Tap>
    </Animated.View>
  );
  if (locked) {
    const first = from.split(' ')[0];
    return card(
      <>
        <Row gap={8}>
          <Icon name="lock" size={14} color={CAPSULE_LIGHT} />
          <T size={12} weight={700} tracking={0.8} color={CAPSULE_LIGHT}>
            {due ? 'READY TO OPEN' : opensAt ? `OPENS ${dateText}` : 'TIME CAPSULE'}
          </T>
        </Row>
        <T size={16} weight={600}>
          {mine ? 'Your time capsule' : `A time capsule from ${first}`}
        </T>
        {clock ? (
          <T size={22} weight={300} tracking={1} style={{ fontVariant: ['tabular-nums'] }} accessibilityLiveRegion="none">
            {clock}
          </T>
        ) : (
          <T size={13} color={colors.textSecondary}>
            {due ? 'Tap to open' : 'Sealed until the day it opens'}
          </T>
        )}
      </>,
      due ? 'Time capsule ready. Tap to open' : `Locked time capsule${opensAt ? `, opens ${capsuleDateLabel(opensAt)}` : ''}`,
      due ? onDue : undefined,
    );
  }
  const t = m.track;
  const open = !opensAt || due;
  return card(
    <>
      <Row gap={8}>
        <Icon name={open ? 'clock' : 'lock'} size={14} color={CAPSULE_LIGHT} />
        <T size={12} weight={700} tracking={0.8} color={CAPSULE_LIGHT}>
          {open ? `OPENED ${dateText}` : `OPENS ${dateText}`}
        </T>
        {!open && clock ? (
          <T size={12} color={CAPSULE_LIGHT} style={{ marginLeft: 'auto', fontVariant: ['tabular-nums'] }}>
            {clock}
          </T>
        ) : null}
      </Row>
      {m.body ? (
        <T size={17} lineHeight={24}>
          {m.body}
        </T>
      ) : null}
      {t ? (
        <Tap
          onPress={() => {
            playTrack(t, `Time capsule from ${from}`);
            router.push('/player');
          }}
          accessibilityLabel={`Play ${t.title}`}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.08) }}
        >
          <Cover artwork={t.artwork} id={t.id} size={40} radius={20} />
          <T size={13} weight={600} numberOfLines={1} style={{ flex: 1 }}>
            {t.title}
            {trackArtist(t) ? ` · ${trackArtist(t)}` : ''}
          </T>
          <Icon name="play" size={16} color={colors.text} filled />
        </Tap>
      ) : null}
      {mine && !open ? (
        <T size={11} color={colors.textSecondary}>
          {row?.hide === false ? 'They can read it now; it opens on the day' : `Sealed · ${from.split(' ')[0]} sees a locked card until then`}
        </T>
      ) : null}
    </>,
    `Time capsule${m.body ? `: ${m.body}` : ''}`,
  );
}

/**
 * View once photo bubble. Mine: status (Delivered / Opened / Screenshot taken). Theirs: "Tap to view" until I
 * open it, then "Opened" (the key and file are gone).
 */
export function WhisperCard({ mine, view, onOpen, onLongPress }: { mine: boolean; view: WhisperView | undefined; onOpen?: () => void; onLongPress?: () => void }) {
  const opened = !!view?.viewed_at;
  const label = mine ? (view?.screenshot_at ? 'Screenshot taken' : opened ? 'Opened' : 'Delivered') : opened ? 'Opened' : 'Tap to view';
  const active = !mine && !opened && !!onOpen;
  return (
    <Tap
      onPress={active ? onOpen : undefined}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityLabel={`View once photo. ${label}`}
      pressScale={0.98}
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingLeft: 10, paddingRight: 16, borderRadius: 26, backgroundColor: active ? withAlpha('#2B6BFF', 0.22) : withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: active ? withAlpha('#2B6BFF', 0.6) : withAlpha(colors.white, 0.12) }}
    >
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: opened ? withAlpha(colors.white, 0.1) : '#2B6BFF', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={opened ? 'check' : 'eye'} size={18} color={colors.white} />
      </View>
      <View style={{ gap: 1 }}>
        <T size={14} weight={600}>
          Photo · View once
        </T>
        <T size={12} color={view?.screenshot_at && mine ? colors.amber : colors.textSecondary}>
          {label}
        </T>
      </View>
    </Tap>
  );
}
