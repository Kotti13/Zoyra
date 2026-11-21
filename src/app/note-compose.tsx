import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Avatar, Button, Cover, ErrorState, flash, Glass, Gradient, Icon, Overline, Row, Screen, ScreenHeader, SongPicker, T, Tap, artFor } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { confirmDialog } from '../lib/dialog';
import { isLocalTrack } from '../lib/local-music';
import { ClipPicker } from '../lib/note-clip';
import { clipLenFor, defaultClipStart, noteClip, useNotePreview } from '../lib/note-preview';
import { deleteNote, listNotes, NOTE_MAX, noteTrackOf, postNote, withClip, type NoteTrack, type UserNote } from '../lib/notes';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, fonts, radius, withAlpha } from '../theme/tokens';

/**
 * Compose / edit your inbox note: up to 60 characters and/or a song, visible to mutual followers for 24 hours.
 * Posting replaces your current note (and starts its views / reactions over). Layout: a large live preview card
 * (avatar, speech bubble with the text and the song, "Mutuals · 24 h"), the text box with a character ring,
 * "Add a song" (now playing / search, then the song card and the 30-second ClipPicker, saved as track.clip_start /
 * clip_len), Delete note, and a pinned Share button. Opened from the "Your note" bubble / my NoteSheet in Messages
 * (`?fresh=1` = "New note": starts empty instead of filling in the current note).
 */

const AVATAR = 76;

/** Ring that fills as the 60 characters are used; shows how many are left near the limit. */
function CountRing({ count, max }: { count: number; max: number }) {
  const size = 34;
  const r = 14;
  const c = 2 * Math.PI * r;
  const over = count > max;
  const color = over ? colors.error : count >= max - 10 ? colors.gold : colors.accent;
  const left = max - count;
  return (
    <View accessible accessibilityLabel={`${count} of ${max} characters`} accessibilityLiveRegion={over ? 'polite' : 'none'} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={withAlpha(colors.white, 0.14)} strokeWidth={3} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color}
          strokeWidth={3}
          fill="none"
          strokeDasharray={`${c} ${c}`}
          strokeDashoffset={c * (1 - Math.min(1, count / max))}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {count >= max - 10 ? (
        <T size={11} weight={700} color={color} style={{ fontVariant: ['tabular-nums'] }}>
          {String(left)}
        </T>
      ) : null}
    </View>
  );
}

/** What your note will look like: your avatar under a speech bubble holding the text and the song. */
function PreviewCard({ name, uri, id, text, track, empty }: { name: string; uri?: string | null; id?: string; text: string | null; track: NoteTrack | null; empty: boolean }) {
  return (
    <View style={{ borderRadius: 28, overflow: 'hidden', borderWidth: 1, borderColor: colors.glassBorder }} accessible accessibilityLabel={`Preview of your note. ${text ?? ''}${track ? ` Song: ${track.title}` : ''}`}>
      <Gradient colors={[withAlpha(colors.accent, 0.3), withAlpha(colors.white, 0.04)]} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <View style={{ alignItems: 'center', paddingTop: 22, paddingBottom: 18, paddingHorizontal: 18, gap: 12 }}>
        <Overline color={colors.textSecondary}>Preview</Overline>

        {/* Speech bubble with a small tail pointing at the avatar */}
        <View style={{ alignItems: 'center', maxWidth: '100%' }}>
          <View style={{ minWidth: 120, maxWidth: '100%', paddingHorizontal: 18, paddingVertical: 12, borderRadius: 24, backgroundColor: colors.glassStrong, borderWidth: 1, borderColor: colors.glassBorder, gap: 8 }}>
            {track ? (
              <Row gap={10}>
                <Cover artwork={track.artwork} id={track.id} size={36} radius={10} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={13} weight={700} color={colors.accentLight} numberOfLines={1}>
                    {`♪ ${track.title}`}
                  </T>
                  <T size={11} color={colors.textSecondary} numberOfLines={1}>
                    {track.artist?.name ?? ''}
                  </T>
                </View>
              </Row>
            ) : null}
            {text || !track ? (
              <T size={text ? 19 : 17} weight={text ? 600 : 500} lineHeight={text ? 25 : 23} align="center" color={text ? colors.text : colors.textTertiary}>
                {text ?? 'Share a thought…'}
              </T>
            ) : null}
          </View>
          <View style={{ width: 14, height: 14, marginTop: -7, backgroundColor: colors.glassStrong, borderRightWidth: 1, borderBottomWidth: 1, borderColor: colors.glassBorder, transform: [{ rotate: '45deg' }] }} />
        </View>

        <View style={{ opacity: empty ? 0.6 : 1 }}>
          {uri ? <Cover uri={uri} id={id} size={AVATAR} radius={AVATAR / 2} /> : <Avatar initial={(name.trim()[0] ?? '?').toUpperCase()} art={artFor(id ?? name)} size={AVATAR} ringColor={colors.bg} />}
        </View>
        <T size={13} weight={600} color={colors.textSecondary}>
          Your note
        </T>

        <Row gap={8}>
          {[
            { icon: 'users' as const, label: 'Mutuals' },
            { icon: 'clock' as const, label: 'Disappears in 24 h' },
          ].map((c) => (
            <Row key={c.label} gap={6} style={{ height: 28, paddingHorizontal: 12, borderRadius: 14, backgroundColor: withAlpha(colors.white, 0.08) }}>
              <Icon name={c.icon} size={13} color={colors.textSecondary} glow={false} />
              <T size={11} weight={600} color={colors.textSecondary}>
                {c.label}
              </T>
            </Row>
          ))}
        </Row>
      </View>
    </View>
  );
}

/** Big tappable card for adding a song: icon or cover, a title and one line of hint. */
function SongAction({ icon, cover, title, sub, onPress, active, label }: { icon?: 'music' | 'search'; cover?: NoteTrack; title: string; sub: string; onPress: () => void; active?: boolean; label: string }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} accessibilityState={active !== undefined ? { selected: active } : undefined} style={{ flex: 1 }}>
      <Glass radius={20} padding={12} style={{ gap: 10, minHeight: 112, borderColor: active ? withAlpha(colors.accent, 0.7) : undefined }}>
        {cover ? (
          <Cover artwork={cover.artwork} id={cover.id} size={44} radius={12} />
        ) : (
          <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon ?? 'music'} size={20} color={colors.text} glow={false} />
          </View>
        )}
        <View style={{ gap: 1 }}>
          <T size={14} weight={700} numberOfLines={1}>
            {title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {sub}
          </T>
        </View>
      </Glass>
    </Tap>
  );
}

export default function NoteCompose() {
  const { user, profile } = useAuth();
  const me = user?.id;
  const { track: nowTrack } = usePlayerPick('track');
  const { fresh } = useLocalSearchParams<{ fresh?: string }>();
  const startEmpty = fresh === '1';
  const preview = useNotePreview();
  const [existing, setExisting] = useState<UserNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [track, setTrack] = useState<NoteTrack | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<'share' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Load attempt (bumped by Retry). My current note fills the form once the request settles. */
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!me) return;
    let alive = true;
    listNotes()
      .then((list) => {
        if (!alive) return;
        const mine = list.find((n) => n.mine) ?? null;
        setExisting(mine);
        if (mine && !startEmpty) {
          setText(mine.text ?? '');
          setTrack(mine.track);
        }
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : 'Could not load your note'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [me, attempt, startEmpty]);

  const retry = () => {
    setLoading(true);
    setLoadError(null);
    setAttempt((n) => n + 1);
  };

  const clean = text.replace(/\s+/g, ' ').trim();
  const over = clean.length > NOTE_MAX;
  const empty = !clean && !track;
  const unchanged =
    !!existing && clean === (existing.text ?? '') && (track?.id ?? null) === (existing.track?.id ?? null) && (track?.clip_start ?? null) === (existing.track?.clip_start ?? null);
  // Re-sharing an unchanged note is allowed: it restarts the 24 hours.
  const canShare = !empty && !over && !busy;
  const nowIsPicked = !!nowTrack && track?.id === nowTrack.id;

  const pickSong = (t: CatalogTrack) => {
    if (isLocalTrack(t)) {
      setError('Songs from your device can’t be added to a note.');
      return;
    }
    preview.stop();
    const dur = t.duration > 0 ? t.duration : 0;
    setTrack(withClip(noteTrackOf(t), defaultClipStart(dur), clipLenFor(dur)));
    setPicking(false);
    setError(null);
  };

  const changeClip = useCallback((start: number, len: number) => setTrack((cur) => (cur ? withClip(cur, start, len) : cur)), []);
  const clip = track ? noteClip(track) : null;

  const share = async () => {
    if (!canShare) return;
    setBusy('share');
    setError(null);
    try {
      await postNote({ text: clean, track });
      flash(existing ? 'Note updated' : 'Note shared');
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not share your note');
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
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete your note');
    } finally {
      setBusy(null);
    }
  };

  const previewText = clean ? clean : null;
  const shareLabel = busy === 'share' ? 'Sharing…' : existing ? (unchanged ? 'Share again' : 'Update note') : 'Share note';
  const showNow = !!nowTrack && !nowIsPicked && !isLocalTrack(nowTrack);

  return (
    <Screen
      top={4}
      gap={18}
      bottom={16}
      backdrop={{ pattern: 'none', mesh: 'coral' }}
      footer={
        loading || loadError ? undefined : (
          <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 8 }}>
            {error ? (
              <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
                {error}
              </T>
            ) : null}
            <Button label={shareLabel} height={52} variant={canShare ? 'primary' : 'disabled'} onPress={canShare ? () => void share() : undefined} />
          </View>
        )
      }
    >
      <ScreenHeader title={existing && !startEmpty ? 'Edit note' : 'New note'} backIcon="close" />

      {loading ? (
        <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="progressbar" accessibilityLabel="Loading your note">
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={retry} />
      ) : (
        <>
          <PreviewCard name={profile?.display_name ?? 'You'} uri={profile?.avatar_url} id={me} text={previewText} track={track} empty={empty} />

          {/* Text */}
          <View style={{ gap: 8 }}>
            <Overline color={colors.textSecondary}>{'What’s on your mind'}</Overline>
            <Glass radius={22} padding={0} style={{ paddingLeft: 16, paddingRight: 12, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: over ? colors.error : withAlpha(colors.accent, 0.55) }}>
              <TextInput
                value={text}
                onChangeText={(v) => {
                  setText(v.replace(/[\r\n]+/g, ' '));
                  setError(null);
                }}
                placeholder="Share a thought…"
                placeholderTextColor={colors.textTertiary}
                maxLength={NOTE_MAX + 20}
                multiline
                blurOnSubmit
                returnKeyType="done"
                accessibilityLabel="Note text"
                accessibilityHint={`Up to ${NOTE_MAX} characters`}
                style={{ flex: 1, minHeight: 28, color: colors.text, fontFamily: fonts.regular, fontSize: 16, lineHeight: 22, textAlignVertical: 'top', padding: 0 }}
              />
              <CountRing count={clean.length} max={NOTE_MAX} />
            </Glass>
          </View>

          {/* Song */}
          <View style={{ gap: 10 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Overline color={colors.textSecondary}>Add a song</Overline>
              <T size={12} color={colors.textSecondary}>
                {clip && clip.len < 30 ? 'Whole song' : '30-second clip'}
              </T>
            </Row>

            {track ? (
              <Glass radius={22} padding={12} style={{ gap: 12 }}>
                <Row gap={12}>
                  <Cover artwork={track.artwork} id={track.id} size={60} radius={14} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={16} weight={700} numberOfLines={1}>
                      {track.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={1}>
                      {track.artist?.name ?? ''}
                    </T>
                  </View>
                </Row>
                <Row gap={8}>
                  <Tap onPress={() => setPicking((p) => !p)} accessibilityLabel={`Change song, ${track.title}`} accessibilityState={{ expanded: picking }} style={{ flex: 1 }}>
                    <Row gap={6} style={{ height: 40, borderRadius: 20, justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.1) }}>
                      <Icon name="search" size={15} color={colors.text} glow={false} />
                      <T size={13} weight={600}>
                        Change
                      </T>
                    </Row>
                  </Tap>
                  <Tap
                    onPress={() => {
                      preview.stop();
                      setTrack(null);
                    }}
                    accessibilityLabel={`Remove ${track.title} from note`}
                    style={{ flex: 1 }}
                  >
                    <Row gap={6} style={{ height: 40, borderRadius: 20, justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder }}>
                      <Icon name="close" size={15} color={colors.textSecondary} glow={false} />
                      <T size={13} weight={600} color={colors.textSecondary}>
                        Remove
                      </T>
                    </Row>
                  </Tap>
                </Row>
              </Glass>
            ) : (
              <Row gap={10} align="stretch">
                {showNow && nowTrack ? <SongAction cover={nowTrack} title="Now playing" sub={nowTrack.title} label={`Add current song, ${nowTrack.title}`} onPress={() => pickSong(nowTrack)} /> : null}
                <SongAction icon="search" title="Search songs" sub="Pick any song" active={picking} label="Pick a song" onPress={() => setPicking((p) => !p)} />
              </Row>
            )}

            {track ? <ClipPicker key={track.id} track={track} preview={preview} onChange={changeClip} /> : null}
            {track && showNow && nowTrack ? (
              <Tap onPress={() => pickSong(nowTrack)} accessibilityLabel={`Use the current song instead, ${nowTrack.title}`} style={{ minHeight: 44, justifyContent: 'center' }}>
                <T size={13} weight={600} color={colors.accentLight}>
                  Use the song playing now instead
                </T>
              </Tap>
            ) : null}

            {picking ? (
              <Glass radius={radius.card} padding={12} style={{ gap: 10 }}>
                <SongPicker onPick={pickSong} selectedId={track?.id ?? null} maxHeight={320} />
              </Glass>
            ) : null}
          </View>

          {existing ? (
            <Tap
              onPress={() => void remove()}
              disabled={!!busy}
              accessibilityLabel="Delete note"
              style={{ height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder, opacity: busy ? 0.6 : 1 }}
            >
              <Icon name="trash" size={16} color={colors.accentLight} />
              <T size={14} weight={600} color={colors.accentLight}>
                {busy === 'delete' ? 'Deleting…' : 'Delete note'}
              </T>
            </Tap>
          ) : null}
        </>
      )}
    </Screen>
  );
}
