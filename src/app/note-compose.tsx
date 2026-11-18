import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Cover, ErrorState, flash, Glass, Icon, ListRow, Overline, Row, Screen, ScreenHeader, SongPicker, T, Tap } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { confirmDialog } from '../lib/dialog';
import { isLocalTrack } from '../lib/local-music';
import { NoteFace } from '../lib/inbox-ui';
import { ClipPicker } from '../lib/note-clip';
import { clipLenFor, defaultClipStart, noteClip, useNotePreview } from '../lib/note-preview';
import { deleteNote, listNotes, NOTE_MAX, noteSongLine, noteTrackOf, postNote, withClip, type NoteTrack, type UserNote } from '../lib/notes';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, fonts, radius, withAlpha } from '../theme/tokens';

/**
 * Compose / edit your inbox note (Instagram Notes, MsgNoteCompose): up to 60 characters and/or a song, visible
 * to mutual followers (people you follow who follow you back) for 24 hours. Posting replaces your current
 * note (and starts its views / reactions over). Layout: close · "Your note" · Share, live preview bubble,
 * TEXT (20 / 60), SONG CLIP · 30 SECONDS (song + Change, then the always-open ClipPicker "0:42 to 1:12 ·
 * drag to pick", saved as track.clip_start / clip_len), "Visible to · Mutuals" and "Disappears · 24 h"
 * (fixed), Delete note. Opened from the "Your note" bubble / my NoteSheet in Messages
 * (`?fresh=1` = "New note": starts empty instead of filling in the current note).
 */

/** Small pill action (Add current song / Pick a song). */
function Pill({ icon, label, onPress, active, hint }: { icon: 'music' | 'search' | 'close'; label: string; onPress: () => void; active?: boolean; hint?: string }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} accessibilityHint={hint} accessibilityState={active !== undefined ? { selected: active } : undefined} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Row gap={6} style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: active ? colors.text : withAlpha(colors.white, 0.1) }}>
        <Icon name={icon} size={15} color={active ? colors.onLight : colors.text} strokeWidth={2} />
        <T size={13} weight={600} color={active ? colors.onLight : colors.text} numberOfLines={1}>
          {label}
        </T>
      </Row>
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

  const previewText = clean ? clean : track ? null : 'Share a thought…';
  const counterColor = over ? colors.error : clean.length >= NOTE_MAX - 10 ? colors.gold : colors.textSecondary;

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader
        title={existing && !startEmpty ? 'Your note' : 'New note'}
        backIcon="close"
        right={
          loading || loadError ? null : (
            <Tap
              onPress={() => void share()}
              disabled={!canShare}
              accessibilityLabel={busy === 'share' ? 'Sharing' : existing ? (unchanged ? 'Share again' : 'Update note') : 'Share note'}
              accessibilityState={{ disabled: !canShare, busy: busy === 'share' }}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <View style={{ height: 40, paddingHorizontal: 20, borderRadius: 20, justifyContent: 'center', backgroundColor: canShare ? colors.accent : withAlpha(colors.white, 0.1) }}>
                <T size={14} weight={700} color={canShare ? colors.onAccent : colors.textTertiary}>
                  {busy === 'share' ? 'Sharing…' : 'Share'}
                </T>
              </View>
            </Tap>
          )
        }
      />

      {loading ? (
        <View style={{ height: 200, alignItems: 'center', justifyContent: 'center' }} accessibilityRole="progressbar" accessibilityLabel="Loading your note">
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={retry} />
      ) : (
        <>
          {/* Live preview, like the inbox strip. */}
          <View style={{ alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <NoteFace id={me} name={profile?.display_name ?? 'You'} uri={profile?.avatar_url} note={previewText} song={track?.title} songLine={noteSongLine(track)} add={empty} muted={empty} caption="Your note" accessibilityLabel="Preview" />
          </View>

          <View style={{ paddingHorizontal: 4 }}>
            <Overline color={colors.textSecondary}>Text</Overline>
          </View>
          <Glass radius={32} padding={0} style={{ paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'flex-end', gap: 10, borderWidth: 1.5, borderColor: over ? colors.error : withAlpha(colors.accent, 0.6) }}>
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
              style={{ flex: 1, minHeight: 30, color: colors.text, fontFamily: fonts.regular, fontSize: 16, lineHeight: 22, textAlignVertical: 'top', padding: 0 }}
            />
            <T size={12} weight={600} color={counterColor} accessibilityLabel={`${clean.length} of ${NOTE_MAX} characters`} accessibilityLiveRegion={over ? 'polite' : 'none'} style={{ fontVariant: ['tabular-nums'] }}>
              {clean.length} / {NOTE_MAX}
            </T>
          </Glass>

          <View style={{ gap: 10 }}>
            <View style={{ paddingHorizontal: 4 }}>
              <Overline color={colors.textSecondary}>{clip && clip.len < 30 ? 'Song clip · whole song' : 'Song clip · 30 seconds'}</Overline>
            </View>
            {track ? (
              <Glass radius={22} padding={10} style={{ gap: 12 }}>
                <Row gap={12}>
                  <Cover artwork={track.artwork} id={track.id} size={48} radius={22} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight={600} numberOfLines={1}>
                      {track.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={1}>
                      {track.artist?.name ?? ''}
                    </T>
                  </View>
                  <Tap onPress={() => setPicking((p) => !p)} accessibilityLabel={`Change song, ${track.title}`} accessibilityState={{ expanded: picking }} style={{ minHeight: 44, paddingHorizontal: 6, justifyContent: 'center' }}>
                    <T size={12} weight={700} color={colors.accentLight}>
                      Change
                    </T>
                  </Tap>
                  <Tap
                    onPress={() => {
                      preview.stop();
                      setTrack(null);
                    }}
                    accessibilityLabel={`Remove ${track.title} from note`}
                    style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="close" size={18} color={colors.textSecondary} />
                  </Tap>
                </Row>
              </Glass>
            ) : null}
            {track ? <ClipPicker key={track.id} track={track} preview={preview} onChange={changeClip} /> : null}
            {!track || (nowTrack && !nowIsPicked && !isLocalTrack(nowTrack)) ? (
              <Row gap={8} style={{ flexWrap: 'wrap' }}>
                {nowTrack && !nowIsPicked && !isLocalTrack(nowTrack) ? <Pill icon="music" label="Add current song" hint={`${nowTrack.title}`} onPress={() => pickSong(nowTrack)} /> : null}
                {!track ? <Pill icon="search" label="Pick a song" active={picking} onPress={() => setPicking((p) => !p)} /> : null}
              </Row>
            ) : null}
            {picking ? (
              <Glass radius={radius.card} padding={12} style={{ gap: 10 }}>
                <SongPicker onPick={pickSong} selectedId={track?.id ?? null} maxHeight={320} />
              </Glass>
            ) : null}
          </View>

          {error ? (
            <T size={13} color={colors.error} accessibilityLiveRegion="polite">
              {error}
            </T>
          ) : null}

          <Glass radius={36} padding={0} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
            <ListRow title="Visible to" subtitle="Friends who follow each other" icon="users" right={<T size={13} color={colors.textSecondary}>Mutuals</T>} />
            <ListRow title="Disappears" subtitle="After 24 hours" icon="clock" divider right={<T size={13} color={colors.textSecondary}>24 h</T>} />
          </Glass>

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
