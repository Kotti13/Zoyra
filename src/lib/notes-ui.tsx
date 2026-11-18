/**
 * Note sheet (Messages › "Now playing with friends"), a glass bottom sheet in a Modal (same look as `Sheet`
 * / EmojiPickerSheet); respects Reduce Motion.
 *  - Friend's note (MsgNoteView): "2h ago · expires in 22h", the text, the song clip ("0:12 / 0:30 clip"),
 *    a reaction row (❤️ 🔥 😂 😮 👏 🎶, one per person, tap again to clear), a reply field that sends a DM
 *    ("Replied to your note: …", end-to-end encrypted like other messages) and "More notes" (other friends'
 *    notes, "1 of 4"); swipe left / right to page between notes. Opening a note records a view.
 *  - My note (MsgNoteMine): "Posted 2h ago · Mutuals · 22h left", a "Live" badge while the clip plays,
 *    "Seen by N · likes · replies" (→ /note-viewers), Edit / New note / Delete note.
 * The clip plays in `useNotePreview` (src/lib/note-preview.ts), not the main queue; it stops when the
 * sheet closes or the note changes.
 */
import { ForeverRing, ForeverTag } from '../components/forever';
import { useForeverIds } from './forever';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Cover, flash, Icon, Row, T, Tap, TopHighlight, useReduceMotion } from '../components';
import { catalog, formatDuration } from './catalog';
import { chatPeerParams } from './chat';
import { routeIfSetupRequired } from './chat-e2ee';
import { confirmDialog } from './dialog';
import { ONLINE_GREEN, RoundFace } from './inbox-ui';
import { clipKey, noteClip, useNotePreview, type NotePreview } from './note-preview';
import {
  deleteNote,
  NOTE_REACTIONS,
  noteAgo,
  noteExpiresIn,
  noteInsights,
  noteLeft,
  playableNoteTrack,
  reactToNote,
  replyToNote,
  viewNote,
  type NoteInsights,
  type NoteReaction,
  type NoteTrack,
  type UserNote,
} from './notes';
import { friendlySocialError } from './social';
import { usePlayerActions } from '../state/player';
import { colors, fonts, glow, shadow, withAlpha } from '../theme/tokens';

const REPLY_MAX = 500;

/** Ring around a friend's note avatar (unseen notes; seen ones are grey). */
const RING = [colors.accent, colors.orange] as const;

/**
 * A note's song: cover, "title · artist", a progress bar and "0:12 / 0:30 clip", and an accent Play/Pause
 * button for its clip (preview player). `onFullSong` adds "Play full song" (main player).
 */
export function NoteSongCard({ track, preview, onFullSong, fullBusy }: { track: NoteTrack; preview: NotePreview; onFullSong?: () => void; fullBusy?: boolean }) {
  const { start, len } = noteClip(track);
  const active = preview.activeKey === clipKey(track.id, start);
  const playing = active && preview.playing;
  const loading = active && preview.loading;
  const artist = track.artist?.name ?? '';
  const song = artist ? `${track.title} · ${artist}` : track.title;
  const toggle = () => preview.toggle(track, start, len);
  const label = playing ? `Pause, ${song}` : `Play ${len} second clip, ${song}`;
  const elapsed = active ? Math.max(0, len - preview.remaining) : 0;
  const status = active && loading ? 'Loading clip…' : `${formatDuration(elapsed)} / ${formatDuration(len)} clip${active ? '' : ` · from ${formatDuration(start)}`}`;
  return (
    <View style={{ borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.07), padding: 10 }}>
      <Row gap={12}>
        <Tap onPress={toggle} accessibilityLabel={label} pressScale={0.98} style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Cover artwork={track.artwork} id={track.id} size={56} radius={22} />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <T size={14} weight={600} numberOfLines={1}>
              {song}
            </T>
            <View style={{ height: 4, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.18), overflow: 'hidden' }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
              <View style={{ height: 4, borderRadius: 2, width: `${active ? Math.round(preview.progress * 1000) / 10 : 0}%`, backgroundColor: colors.accent }} />
            </View>
            <T size={11} color={colors.textSecondary} numberOfLines={1} style={{ fontVariant: ['tabular-nums'] }}>
              {status}
            </T>
          </View>
        </Tap>
        {onFullSong ? (
          <Tap onPress={onFullSong} disabled={fullBusy} accessibilityLabel={`Play full song, ${song}`} accessibilityHint="Plays it in the music player" style={{ width: 36, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="headphones" size={20} color={fullBusy ? colors.textTertiary : colors.textSecondary} />
          </Tap>
        ) : null}
        <Tap
          onPress={toggle}
          accessibilityLabel={label}
          accessibilityState={{ busy: loading }}
          style={[{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent }, glow(colors.accent, 12, 0.55)]}
        >
          <TopHighlight radius={22} color={withAlpha(colors.white, 0.45)} />
          <Icon name={playing ? 'pause' : 'play'} size={18} color={colors.onAccent} filled />
        </Tap>
      </Row>
    </View>
  );
}

/** Round avatar inside a thin accent → orange ring (grey once seen). */
function RingFace({ id, name, uri, size, seen }: { id: string; name: string; uri: string | null; size: number; seen?: boolean }) {
  return (
    <View style={{ width: size + 4, height: size + 4, borderRadius: (size + 4) / 2, padding: 2, overflow: 'hidden' }}>
      {seen ? <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.white, 0.25) }]} /> : <LinearGradient colors={RING} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
      <RoundFace id={id} name={name} uri={uri} size={size} />
    </View>
  );
}

/** Stacked faces for "Seen by". */
function Faces({ faces }: { faces: NoteInsights['faces'] }) {
  if (!faces.length) {
    return (
      <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.08) }}>
        <Icon name="eye" size={18} color={colors.textSecondary} />
      </View>
    );
  }
  return (
    <Row gap={0}>
      {faces.slice(0, 4).map((f, i) => (
        <View key={f.id} style={{ marginLeft: i ? -8 : 0, borderWidth: 2, borderColor: '#1C1C1E', borderRadius: 18 }}>
          <RoundFace id={f.id} name={f.display_name} uri={f.avatar_url} size={28} />
        </View>
      ))}
    </Row>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function NoteSheet({
  notes,
  index = 0,
  me,
  onClose,
  onDeleted,
  onReacted,
}: {
  /** Notes to page through (friends' notes, or just my own). */
  notes: UserNote[];
  /** Which one opens first. */
  index?: number;
  me: string | undefined;
  onClose: () => void;
  onDeleted?: () => void;
  /** My reaction on a friend's note changed (keeps the inbox list in sync). */
  onReacted?: (owner: string, emoji: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const { playTrack } = usePlayerActions();
  const preview = useNotePreview();
  const [y] = useState(() => new Animated.Value(600));
  const [slide] = useState(() => new Animated.Value(0));
  const [idx, setIdx] = useState(() => Math.max(0, Math.min(notes.length - 1, index)));
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState<'reply' | 'play' | 'delete' | 'react' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** My reactions by note owner (optimistic; seeded from list_notes().my_reaction). */
  const [reactions, setReactions] = useState<Record<string, string | null>>(() => Object.fromEntries(notes.map((n) => [n.user_id, n.my_reaction ?? null])));
  const [insights, setInsights] = useState<NoteInsights | null>(null);
  const note: UserNote | undefined = notes[idx] ?? notes[0];
  const mine = !!note && (note.mine || note.user_id === me);
  const owner = note?.user_id ?? null;

  // Spring up once.
  useEffect(() => {
    if (reduce) y.setValue(0);
    else {
      y.setValue(600);
      Animated.spring(y, { toValue: 0, damping: 22, stiffness: 220, mass: 0.9, useNativeDriver: true }).start();
    }
  }, [reduce, y]);

  // Opening a friend's note records a view (once per note per sheet).
  const viewed = useRef(new Set<string>());
  useEffect(() => {
    if (!owner || mine || viewed.current.has(owner)) return;
    viewed.current.add(owner);
    void viewNote(owner).catch(() => undefined);
  }, [owner, mine]);

  // My note: "Seen by N · likes · replies".
  useEffect(() => {
    if (!mine) return;
    let alive = true;
    noteInsights()
      .then((i) => alive && setInsights(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [mine]);

  const stopPreview = preview.stop;
  const close = useCallback(
    (after?: () => void) => {
      Keyboard.dismiss();
      stopPreview();
      const done = () => {
        onClose();
        after?.();
      };
      if (reduce) return done();
      Animated.timing(y, { toValue: 600, duration: 200, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => done());
    },
    [reduce, y, onClose, stopPreview],
  );

  const [scrim] = useState(() => y.interpolate({ inputRange: [0, 600], outputRange: [1, 0], extrapolate: 'clamp' }));

  /** Page to another note (slides in from the side it came from). */
  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next >= notes.length || next === idx) return;
      stopPreview();
      setReply('');
      setError(null);
      setIdx(next);
      if (reduce) slide.setValue(0);
      else {
        slide.setValue(next > idx ? 60 : -60);
        Animated.spring(slide, { toValue: 0, damping: 20, stiffness: 260, useNativeDriver: true }).start();
      }
    },
    [notes.length, idx, stopPreview, reduce, slide],
  );

  // Horizontal swipe between notes (only clearly horizontal drags; taps and the text field still work).
  const goRef = useRef({ goTo, idx, count: notes.length });
  useEffect(() => {
    goRef.current = { goTo, idx, count: notes.length };
  });
  // eslint-disable-next-line react-hooks/refs -- the ref is only read inside gesture callbacks
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => goRef.current.count > 1 && Math.abs(g.dx) > 14 && Math.abs(g.dx) > 2 * Math.abs(g.dy),
      onPanResponderMove: (_e, g) => slide.setValue(g.dx * 0.5),
      onPanResponderRelease: (_e, g) => {
        const { goTo: go, idx: i, count } = goRef.current;
        if ((g.dx < -60 || g.vx < -0.6) && i < count - 1) go(i + 1);
        else if ((g.dx > 60 || g.vx > 0.6) && i > 0) go(i - 1);
        else Animated.spring(slide, { toValue: 0, damping: 20, stiffness: 260, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(slide, { toValue: 0, damping: 20, stiffness: 260, useNativeDriver: true }).start(),
    }),
  );

  if (!note) return null;
  const first = note.display_name.split(' ')[0] || 'them';
  const clipPlaying = !!note.track && preview.playing && preview.activeKey === clipKey(note.track.id, noteClip(note.track).start);
  const myReaction = reactions[note.user_id] ?? null;

  const playFull = async () => {
    if (!note.track || busy) return;
    preview.stop();
    setBusy('play');
    setError(null);
    try {
      // Refresh from the catalog (stream info); fall back to the saved copy.
      const full = await catalog.track(note.track.id).catch(() => playableNoteTrack(note.track!));
      const r = playTrack(full, `${first}'s note`);
      if (!r.played) setError(r.reason ?? 'Could not play this song.');
      else close();
    } catch {
      setError('Could not play this song.');
    } finally {
      setBusy(null);
    }
  };

  const react = async (emoji: NoteReaction) => {
    if (busy === 'react') return;
    const before = myReaction;
    const next = before === emoji ? null : emoji;
    setReactions((r) => ({ ...r, [note.user_id]: next }));
    setBusy('react');
    setError(null);
    try {
      await reactToNote(note.user_id, next);
      onReacted?.(note.user_id, next);
      if (next) flash(`Reacted ${next} to ${first}'s note`);
    } catch (e) {
      setReactions((r) => ({ ...r, [note.user_id]: before }));
      setError(e instanceof Error ? e.message : 'Could not react to this note');
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!me || busy || !reply.trim()) return;
    setBusy('reply');
    setError(null);
    try {
      const chat = await replyToNote(note, me, reply);
      flash(chat.request ? `Reply sent as a message request` : `Reply sent to ${first}`);
      close(() => router.push({ pathname: '/chat-pro', params: { id: chat.id, ...chatPeerParams({ id: note.user_id, display_name: note.display_name, avatar_url: note.avatar_url }) } }));
    } catch (e) {
      if (routeIfSetupRequired(e)) {
        close();
        return;
      }
      setError(friendlySocialError(e, 'Reply not sent'));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    const ok = await confirmDialog('Delete note?', 'Your note will disappear for everyone.', 'Delete');
    if (!ok) return;
    setBusy('delete');
    setError(null);
    try {
      await deleteNote();
      flash('Note deleted');
      onDeleted?.();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your note');
    } finally {
      setBusy(null);
    }
  };

  const compose = (fresh: boolean) => close(() => router.push(fresh ? { pathname: '/note-compose', params: { fresh: '1' } } : '/note-compose'));

  const canSend = !!reply.trim() && !busy;
  const others = notes.map((n, i) => ({ n, i })).filter(({ i }) => i !== idx);
  const ago = noteAgo(note.created_at);
  const views = insights?.views ?? 0;

  return (
    <Modal visible transparent animationType="none" statusBarTranslucent navigationBarTranslucent onRequestClose={() => close()}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: scrim }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={mine ? 'Close your note' : 'Close note'} onPress={() => close()} style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} />
        </Animated.View>
        <Animated.View style={[styles.sheet, shadow.float, { paddingBottom: Math.max(16, insets.bottom), transform: [{ translateY: y }] }]} accessibilityViewIsModal>
          {Platform.OS === 'ios' ? <BlurView tint="dark" intensity={50} style={StyleSheet.absoluteFill} /> : null}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.sheet }]} />
          <TopHighlight radius={36} color={withAlpha(colors.white, 0.22)} />
          <View style={{ paddingTop: 12, paddingBottom: 4, alignItems: 'center' }}>
            <View style={styles.handle} />
          </View>

          <Animated.View {...pan.panHandlers} style={{ paddingHorizontal: 20, gap: 14, transform: [{ translateX: slide }] }}>
            <Row gap={12}>
              <View>
                <ForeverRing uid={mine ? null : note.user_id} radius={15}>
                  <RoundFace id={note.user_id} name={note.display_name} uri={note.avatar_url} size={44} radius={15} />
                </ForeverRing>
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Row gap={6}>
                  <T size={16} weight={700} numberOfLines={1} accessibilityRole="header" style={{ flexShrink: 1 }}>
                    {mine ? 'Your note' : note.display_name}
                  </T>
                  {!mine ? <ForeverNameTag uid={note.user_id} /> : null}
                </Row>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {mine ? `Posted ${ago} · Mutuals · ${noteLeft(note.expires_at)}` : `${ago} · ${noteExpiresIn(note.expires_at).toLowerCase()}`}
                </T>
              </View>
              {mine && clipPlaying ? (
                <View accessibilityLabel="Live: your clip is playing" style={{ height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: withAlpha(ONLINE_GREEN, 0.15), justifyContent: 'center' }}>
                  <T size={11} weight={700} color={ONLINE_GREEN}>
                    Live
                  </T>
                </View>
              ) : null}
              <Pressable onPress={() => close()} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} style={{ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.14) }}>
                <Icon name="close" size={18} color={colors.text} />
              </Pressable>
            </Row>

            {note.text ? (
              <T size={22} weight={600} lineHeight={29} style={{ paddingVertical: 4 }}>
                {note.text}
              </T>
            ) : null}

            {note.track ? <NoteSongCard track={note.track} preview={preview} onFullSong={mine ? undefined : () => void playFull()} fullBusy={busy === 'play'} /> : null}

            {mine ? (
              <Tap
                onPress={() => close(() => router.push('/note-viewers'))}
                disabled={!views}
                pressScale={0.98}
                accessibilityLabel={views ? `Seen by ${views}. ${plural(insights?.likes ?? 0, 'like')}, ${plural(insights?.replies ?? 0, 'reply', 'replies')}` : 'No views yet'}
                accessibilityHint={views ? 'Shows who saw, liked and replied' : undefined}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.07) }}
              >
                <Faces faces={insights?.faces ?? []} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={14} weight={600}>
                    {insights === null ? 'Seen by…' : views ? `Seen by ${views}` : 'No views yet'}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {views ? `${plural(insights?.likes ?? 0, 'like')} · ${plural(insights?.replies ?? 0, 'reply', 'replies')}` : 'Friends who open your note show up here'}
                  </T>
                </View>
                {views ? <Icon name="chevronRight" size={18} color={colors.textSecondary} /> : null}
              </Tap>
            ) : (
              <Row gap={0} style={{ justifyContent: 'space-between' }} accessibilityRole="radiogroup" accessibilityLabel="React to this note">
                {NOTE_REACTIONS.map((e) => {
                  const on = myReaction === e;
                  return (
                    <Tap
                      key={e}
                      onPress={() => void react(e)}
                      pressScale={0.88}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      accessibilityLabel={on ? `${e}, your reaction. Tap to remove` : `React ${e}`}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: on ? withAlpha(colors.accent, 0.22) : withAlpha(colors.white, 0.08),
                        borderWidth: 1.5,
                        borderColor: on ? colors.accent : 'transparent',
                      }}
                    >
                      <T size={22} maxFontSizeMultiplier={1.2}>
                        {e}
                      </T>
                    </Tap>
                  );
                })}
              </Row>
            )}

            {error || preview.error ? (
              <T size={13} color={colors.error} accessibilityLiveRegion="polite">
                {error ?? preview.error}
              </T>
            ) : null}

            {mine ? (
              <View style={{ gap: 4 }}>
                <Row gap={8}>
                  <Tap
                    onPress={() => compose(false)}
                    disabled={!!busy}
                    accessibilityLabel="Edit note"
                    accessibilityHint="Change the text or song"
                    style={[{ flex: 1, height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: colors.accent }, glow(colors.accent, 10, 0.45)]}
                  >
                    <Icon name="edit" size={17} color={colors.onAccent} strokeWidth={2} />
                    <T size={14} weight={700} color={colors.onAccent}>
                      Edit
                    </T>
                  </Tap>
                  <Tap
                    onPress={() => compose(true)}
                    disabled={!!busy}
                    accessibilityLabel="New note"
                    accessibilityHint="Start over with an empty note"
                    style={{ flex: 1, height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder }}
                  >
                    <Icon name="plus" size={17} color={colors.text} strokeWidth={2} />
                    <T size={14} weight={600}>
                      New note
                    </T>
                  </Tap>
                </Row>
                <Tap onPress={() => void remove()} disabled={!!busy} accessibilityLabel="Delete note" style={{ height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  <Icon name="trash" size={16} color={colors.accentLight} />
                  <T size={14} weight={600} color={colors.accentLight}>
                    {busy === 'delete' ? 'Deleting…' : 'Delete note'}
                  </T>
                </Tap>
              </View>
            ) : (
              <Row gap={8}>
                <Row gap={8} style={{ flex: 1, minHeight: 46, paddingLeft: 16, paddingRight: 8, borderRadius: 23, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder }}>
                  <Icon name="chat" size={16} color={colors.textSecondary} />
                  <TextInput
                    value={reply}
                    onChangeText={setReply}
                    placeholder={`Reply to ${first}’s note`}
                    placeholderTextColor={colors.textSecondary}
                    maxLength={REPLY_MAX}
                    returnKeyType="send"
                    onSubmitEditing={() => void send()}
                    accessibilityLabel={`Reply to ${note.display_name}'s note`}
                    accessibilityHint="Sends a direct message"
                    style={{ flex: 1, minHeight: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 14, paddingVertical: 10 }}
                  />
                </Row>
                <Tap
                  onPress={() => void send()}
                  disabled={!canSend}
                  accessibilityLabel="Send reply"
                  accessibilityState={{ disabled: !canSend, busy: busy === 'reply' }}
                  style={[{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: canSend ? colors.accent : withAlpha(colors.white, 0.1) }, canSend ? glow(colors.accent, 10, 0.5) : null]}
                >
                  <Icon name="send" size={18} color={canSend ? colors.onAccent : colors.textTertiary} strokeWidth={2} />
                </Tap>
              </Row>
            )}

            {!mine && notes.length > 1 ? (
              <Row gap={10} style={{ minHeight: 44 }}>
                <T size={12} color={colors.text}>
                  More notes
                </T>
                <Row gap={8} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                  {others.slice(0, 4).map(({ n, i }) => (
                    <Tap key={n.user_id} onPress={() => goTo(i)} pressScale={0.92} accessibilityLabel={`${n.display_name}'s note`} accessibilityHint="Opens this note">
                      <RingFace id={n.user_id} name={n.display_name} uri={n.avatar_url} size={32} seen={n.seen} />
                    </Tap>
                  ))}
                </Row>
                <T size={11} color={colors.textSecondary} accessibilityLabel={`Note ${idx + 1} of ${notes.length}. Swipe left or right for more`} style={{ fontVariant: ['tabular-nums'] }}>
                  {idx + 1} of {notes.length}
                </T>
              </Row>
            ) : null}
          </Animated.View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 36, borderTopRightRadius: 36, overflow: 'hidden', borderWidth: 1, borderBottomWidth: 0, borderColor: colors.glassBorder },
  handle: { width: 40, height: 5, borderRadius: 3, backgroundColor: colors.handle },
});

/** ∞ Forever chip after a friend's name (only for Forever friends). */
function ForeverNameTag({ uid }: { uid: string }) {
  const ids = useForeverIds();
  return ids.has(uid) ? <ForeverTag /> : null;
}
