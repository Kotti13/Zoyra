import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { ChipRow, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, ToggleBurst, useAsync } from '../components';
import { ChatAvatar } from '../lib/chat-ui';
import { loadTrackDetail } from '../lib/premieres';
import { confirmAction } from '../lib/social';
import {
  ago,
  clock,
  deleteTrackComment,
  listTrackComments,
  postTrackComment,
  reportTrackComment,
  setTrackCommentLiked,
  TRACK_COMMENT_MAX,
  type CommentSort,
  type ReportReason,
  type TrackComment,
} from '../lib/track-comments';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlaybackProgress, usePlayerPick } from '../state/player';
import { colors, fonts, withAlpha } from '../theme/tokens';

const SORTS: { label: string; value: CommentSort }[] = [
  { label: 'Newest', value: 'new' },
  { label: 'Top', value: 'top' },
  { label: 'In the song', value: 'moment' },
];

/**
 * Track comments (`/track-comments?id=<track id>`), opened from Track detail. Comments can be pinned to a moment
 * of the song (the playback position when you write, if this song is playing); tapping a moment jumps there.
 * Likes, delete (own) and report (others; hides it for you) are real; new comments from others arrive live.
 */
export default function TrackComments() {
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const { user } = useAuth();
  const me = user?.id;
  const [sortIdx, setSortIdx] = useState(0);
  const sort = SORTS[sortIdx].value;
  const [extra, setExtra] = useState<{ key: string; items: TrackComment[]; more: boolean } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [likeOverride, setLikeOverride] = useState<Record<string, { liked: boolean; count: number }>>({});
  const { track: current, playTrack, seekTo } = usePlayerPick('track');

  const detail = useAsync(() => (id ? loadTrackDetail(id) : Promise.resolve(null)), [id], 'app/track-comments:53');
  const list = useAsync(async () => (id ? listTrackComments(id, sort) : { comments: [], more: false }), [id, sort], 'app/track-comments:54');
  const key = `${id}|${sort}`;
  const comments = [...(list.data?.comments ?? []), ...(extra?.key === key ? extra.items : [])].filter((c) => !gone.has(c.id));
  const hasMore = extra?.key === key ? extra.more : !!list.data?.more;
  const track = detail.data?.track;

  // Live: reload the first page when someone else posts on this song.
  const reload = list.refresh;
  useEffect(() => {
    if (!id) return;
    const ch = supabase
      .channel(`track-comments:${id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'track_comments', filter: `track_id=eq.${id}` }, () => void reload())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [id, reload]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const have = comments.length;
      const r = await listTrackComments(id, sort, have);
      setExtra((e) => ({ key, items: [...(e?.key === key ? e.items : []), ...r.comments.filter((c) => !comments.some((x) => x.id === c.id))], more: r.more }));
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not load more' });
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleLike = async (c: TrackComment) => {
    if (!me) return;
    const cur = likeOverride[c.id] ?? { liked: c.liked, count: c.like_count };
    const next = { liked: !cur.liked, count: Math.max(0, cur.count + (cur.liked ? -1 : 1)) };
    setLikeOverride((m) => ({ ...m, [c.id]: next }));
    try {
      await setTrackCommentLiked(c.id, me, next.liked);
    } catch (e) {
      setLikeOverride((m) => ({ ...m, [c.id]: cur }));
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not update your like' });
    }
  };

  const remove = async (c: TrackComment) => {
    setOpenMenu(null);
    if (!(await confirmAction('Delete comment?', 'This removes your comment for everyone.', 'Delete'))) return;
    try {
      await deleteTrackComment(c.id);
      setGone((g) => new Set(g).add(c.id));
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not delete' });
    }
  };

  const report = async (c: TrackComment, reason: ReportReason) => {
    setOpenMenu(null);
    try {
      await reportTrackComment(c.id, reason);
      setGone((g) => new Set(g).add(c.id));
      setNote({ ok: true, text: 'Reported. You will not see this comment again.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not send the report' });
    }
  };

  const jump = (sec: number) => {
    if (current?.id === id) {
      seekTo(sec);
      return;
    }
    if (!track) return;
    const res = playTrack(track, track.title);
    if (!res.played) return setNote({ ok: false, text: res.reason ?? 'This song cannot be played right now.' });
    // Seek once the song has started (the player ignores seeks before it can seek).
    setTimeout(() => seekTo(sec), 900);
  };

  if (!id) {
    return (
      <Screen top={4}>
        <ScreenHeader title="Comments" />
        <EmptyState icon="mail" title="No song selected" body="Open comments from a song's page." />
      </Screen>
    );
  }

  return (
    <Screen
      top={4}
      gap={14}
      scroll
      onRefresh={() => list.refresh()}
      backdrop={{ pattern: 'none', mesh: 'coral' }}
      footer={
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Composer trackId={id} signedIn={!!me} onPosted={() => void list.refresh()} onError={(t) => setNote({ ok: false, text: t })} />
        </KeyboardAvoidingView>
      }
    >
      <ScreenHeader title="" />
      <View style={{ gap: 2 }}>
        <T variant="title" accessibilityRole="header">
          Comments
        </T>
        <T size={13} color={colors.textSecondary} numberOfLines={1}>
          {track ? `${track.title} · ${track.artist.name}` : ' '}
          {list.data && !hasMore ? ` · ${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}` : ''}
        </T>
      </View>
      <ChipRow options={SORTS.map((s) => s.label)} initial={sortIdx} onChange={(i) => { setSortIdx(i); setExtra(null); }} />

      {note ? (
        <T size={13} color={note.ok ? colors.accentLight : colors.error} accessibilityLiveRegion="polite" onPress={() => setNote(null)}>
          {note.text}
        </T>
      ) : null}

      {list.loading && !list.data ? <Loading height={260} label="Loading comments" /> : null}
      {list.error && !list.data ? <ErrorState message={list.error} onRetry={list.reload} /> : null}
      {list.data && comments.length === 0 ? <EmptyState icon="mail" title="No comments yet" body="Be the first to say what you felt. Pin it to a moment of the song." /> : null}

      {comments.map((c) => {
        const mine = c.user_id === me;
        const like = likeOverride[c.id] ?? { liked: c.liked, count: c.like_count };
        return (
          <View key={c.id} style={{ gap: 8 }}>
            <Row gap={12} style={{ alignItems: 'flex-start' }}>
              <ChatAvatar person={c.author} size={40} radius={20} />
              <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                <Row gap={8}>
                  <T size={14} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
                    {c.author.display_name}
                  </T>
                  {c.at_seconds !== null ? (
                    <Tap onPress={() => jump(c.at_seconds as number)} accessibilityLabel={`Jump to ${clock(c.at_seconds)} in the song`} style={{ minHeight: 28, paddingHorizontal: 8, borderRadius: 14, justifyContent: 'center', backgroundColor: withAlpha(colors.accent, 0.22) }}>
                      <T size={12} weight={600} color={colors.accentLight} style={{ fontFamily: fonts.mono }}>
                        {clock(c.at_seconds)}
                      </T>
                    </Tap>
                  ) : null}
                  <T size={12} color={colors.textTertiary}>
                    {ago(c.created_at)}
                  </T>
                </Row>
                <T size={15} lineHeight={21}>
                  {c.body}
                </T>
              </View>
              <View style={{ alignItems: 'center' }}>
                <Tap onPress={() => void toggleLike(c)} accessibilityLabel={like.liked ? 'Unlike comment' : 'Like comment'} accessibilityState={{ selected: like.liked }} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
                  <ToggleBurst active={like.liked} kind="like" size={40}>
                    <Icon name="heart" size={20} filled={like.liked} color={like.liked ? colors.like : colors.textSecondary} />
                  </ToggleBurst>
                </Tap>
                {like.count > 0 ? (
                  <T size={11} color={colors.textSecondary} style={{ marginTop: -8 }}>
                    {like.count}
                  </T>
                ) : null}
              </View>
              <IconButton icon="more" label="Comment options" size={36} iconSize={18} color={colors.textSecondary} onPress={() => setOpenMenu(openMenu === c.id ? null : c.id)} />
            </Row>
            {openMenu === c.id ? (
              <Row gap={8} style={{ flexWrap: 'wrap', paddingLeft: 52 }}>
                {mine ? (
                  <MenuChip label="Delete" danger onPress={() => void remove(c)} />
                ) : (
                  <>
                    <T size={12} color={colors.textSecondary}>
                      Report as
                    </T>
                    <MenuChip label="Spam" onPress={() => void report(c, 'spam')} />
                    <MenuChip label="Abusive" onPress={() => void report(c, 'abuse')} />
                    <MenuChip label="Hate" onPress={() => void report(c, 'hate')} />
                  </>
                )}
              </Row>
            ) : null}
          </View>
        );
      })}

      {hasMore ? (
        <Tap onPress={() => void loadMore()} accessibilityLabel="Show more comments" style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          <T size={14} weight={600} color={colors.accentLight}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </T>
        </Tap>
      ) : null}
    </Screen>
  );
}

function MenuChip({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} style={{ minHeight: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: danger ? withAlpha(colors.error, 0.16) : colors.chipGhost }}>
      <T size={13} weight={600} color={danger ? colors.error : colors.text}>
        {label}
      </T>
    </Tap>
  );
}

/** Bottom bar: "0:14  Add a comment at this moment". Reads the playback position here so the list does not re-render. */
function Composer({ trackId, signedIn, onPosted, onError }: { trackId: string; signedIn: boolean; onPosted: () => void; onError: (t: string) => void }) {
  const { track } = usePlayerPick('track');
  const { position } = usePlaybackProgress();
  const [text, setText] = useState('');
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const here = track?.id === trackId; // only this song's playback gives a meaningful moment
  const at = here && pin ? Math.floor(position) : null;
  const frozen = useRef<number | null>(null);
  const ok = signedIn && text.trim().length > 0 && !busy;

  const send = useCallback(async () => {
    if (!ok) return;
    setBusy(true);
    frozen.current = at;
    try {
      await postTrackComment(trackId, text, frozen.current);
      setText('');
      onPosted();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not post your comment');
    } finally {
      setBusy(false);
    }
  }, [ok, at, trackId, text, onPosted, onError]);

  return (
    <Row gap={10} style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.bg }}>
      {here ? (
        <Tap onPress={() => setPin((p) => !p)} accessibilityLabel={pin ? 'Comment is pinned to this moment. Tap to unpin.' : 'Pin the comment to this moment'} accessibilityState={{ selected: pin }} style={{ minHeight: 44, paddingHorizontal: 10, borderRadius: 22, justifyContent: 'center', backgroundColor: pin ? withAlpha(colors.accent, 0.22) : colors.chipGhost }}>
          <T size={13} weight={600} color={pin ? colors.accentLight : colors.textSecondary} style={{ fontFamily: fonts.mono }}>
            {clock(position)}
          </T>
        </Tap>
      ) : null}
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={signedIn ? (at !== null ? 'Add a comment at this moment' : 'Add a comment') : 'Sign in to comment'}
        placeholderTextColor={colors.textTertiary}
        editable={signedIn}
        maxLength={TRACK_COMMENT_MAX}
        multiline
        accessibilityLabel="Write a comment"
        style={{ flex: 1, minHeight: 44, maxHeight: 110, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
      />
      <IconButton icon="send" label="Post comment" size={44} bg={ok ? colors.accent : colors.chipGhost} color={ok ? colors.onAccent : colors.textTertiary} onPress={() => void send()} />
    </Row>
  );
}

