import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';

import { ChipRow, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, ToggleBurst, useAsync } from '../components';
import { ChatAvatar } from '../lib/chat-ui';
import { loadTrackDetail } from '../lib/premieres';
import { confirmAction } from '../lib/social';
import {
  ago,
  clock,
  countTrackComments,
  deleteTrackComment,
  editTrackComment,
  listTrackComments,
  listTrackReplies,
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

/** Replies of one comment: what has loaded, whether there are more, and whether a page is loading. */
type Thread = { items: TrackComment[]; more: boolean; loading: boolean };
/** What the composer is doing besides writing a new comment. */
type Context = { kind: 'reply'; rootId: string; name: string; mention: string } | { kind: 'edit'; comment: TrackComment } | null;
type Like = { liked: boolean; count: number };

/**
 * Track comments (`/track-comments?id=<track id>`), opened from Track detail. Comments can be pinned to a moment
 * of the song (tap the moment to jump there). Each comment has likes, Reply (replies sit under their comment, one
 * level deep: replying to a reply keeps the thread and adds an @mention), and a menu: Edit / Copy / Delete for your
 * own, Copy / Report (hides it for you) for others. New comments from others arrive live.
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
  const [likeOverride, setLikeOverride] = useState<Record<string, Like>>({});
  const [bodyOverride, setBodyOverride] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<Record<string, Thread>>({});
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  /** Replies added or removed here since the list loaded (so the "N replies" count stays right without a reload). */
  const [replyDelta, setReplyDelta] = useState<Record<string, number>>({});
  const [context, setContext] = useState<Context>(null);
  const { track: current, playTrack, seekTo } = usePlayerPick('track');

  const detail = useAsync(() => (id ? loadTrackDetail(id) : Promise.resolve(null)), [id], 'app/track-comments:53');
  const list = useAsync(async () => (id ? listTrackComments(id, sort) : { comments: [], more: false }), [id, sort], 'app/track-comments:54');
  const total = useAsync(async () => (id ? countTrackComments(id) : 0), [id], 'app/track-comments:total');
  const key = `${id}|${sort}`;
  const comments = [...(list.data?.comments ?? []), ...(extra?.key === key ? extra.items : [])].filter((c) => !gone.has(c.id));
  const hasMore = extra?.key === key ? extra.more : !!list.data?.more;
  const track = detail.data?.track;

  /** Load a thread's replies: from the start, or (`offset` > 0) the next page after the ones already shown. */
  const loadThread = useCallback(async (rootId: string, offset = 0) => {
    setThreads((t) => ({ ...t, [rootId]: { items: offset > 0 ? (t[rootId]?.items ?? []) : [], more: false, loading: true } }));
    try {
      const r = await listTrackReplies(rootId, offset);
      setThreads((t) => ({ ...t, [rootId]: { items: [...(offset > 0 ? (t[rootId]?.items ?? []) : []), ...r.replies], more: r.more, loading: false } }));
    } catch (e) {
      setThreads((t) => ({ ...t, [rootId]: { items: t[rootId]?.items ?? [], more: false, loading: false } }));
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not load replies' });
    }
  }, []);

  // Live: reload when someone else posts on this song (and the open thread a reply belongs to).
  const reload = list.refresh;
  const reloadTotal = total.refresh;
  const openRef = useRef(openThreads);
  useEffect(() => {
    openRef.current = openThreads;
  }, [openThreads]);
  useEffect(() => {
    if (!id) return;
    const ch = supabase
      .channel(`track-comments:${id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'track_comments', filter: `track_id=eq.${id}` }, (payload) => {
        const parent = (payload.new as { parent_id?: string | null }).parent_id;
        void reload();
        void reloadTotal();
        if (parent && openRef.current.has(parent)) void loadThread(parent);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [id, reload, reloadTotal, loadThread]);

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

  const toggleThread = (rootId: string) => {
    const opening = !openThreads.has(rootId);
    setOpenThreads((s) => {
      const n = new Set(s);
      if (opening) n.add(rootId);
      else n.delete(rootId);
      return n;
    });
    if (opening && !threads[rootId]) void loadThread(rootId);
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
    const isReply = !!c.parent_id;
    const ok = await confirmAction(isReply ? 'Delete reply?' : 'Delete comment?', isReply ? 'This removes your reply for everyone.' : 'This removes your comment, and any replies to it, for everyone.', 'Delete');
    if (!ok) return;
    try {
      await deleteTrackComment(c.id);
      setGone((g) => new Set(g).add(c.id));
      if (c.parent_id) setReplyDelta((d) => ({ ...d, [c.parent_id as string]: (d[c.parent_id as string] ?? 0) - 1 }));
      void reloadTotal();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not delete' });
    }
  };

  const report = async (c: TrackComment, reason: ReportReason) => {
    setOpenMenu(null);
    try {
      await reportTrackComment(c.id, reason);
      setGone((g) => new Set(g).add(c.id));
      setNote({ ok: true, text: 'Reported. You will not see this again.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not send the report' });
    }
  };

  const copy = async (c: TrackComment) => {
    setOpenMenu(null);
    await Clipboard.setStringAsync(bodyOverride[c.id] ?? c.body).catch(() => undefined);
    setNote({ ok: true, text: 'Copied' });
  };

  const replyTo = (c: TrackComment) => {
    setOpenMenu(null);
    const rootId = c.parent_id ?? c.id;
    // Replying to a reply keeps the thread and mentions the person.
    setContext({ kind: 'reply', rootId, name: c.author.display_name, mention: c.parent_id ? `@${c.author.display_name} ` : '' });
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

  const onPosted = (info: { rootId?: string; editedId?: string; editedBody?: string }) => {
    setContext(null);
    if (info.editedId && info.editedBody !== undefined) {
      setBodyOverride((m) => ({ ...m, [info.editedId as string]: info.editedBody as string }));
      return;
    }
    if (info.rootId) {
      const root = info.rootId;
      setReplyDelta((d) => ({ ...d, [root]: (d[root] ?? 0) + 1 }));
      setOpenThreads((s) => new Set(s).add(root));
      void loadThread(root);
    } else {
      void list.refresh();
    }
    void total.refresh();
  };

  if (!id) {
    return (
      <Screen top={4}>
        <ScreenHeader title="Comments" />
        <EmptyState icon="mail" title="No song selected" body="Open comments from a song's page." />
      </Screen>
    );
  }

  const count = total.data ?? null;
  const itemProps = { me, likeOverride, bodyOverride, openMenu, onLike: toggleLike, onReply: replyTo, onMenu: (cid: string) => setOpenMenu((m) => (m === cid ? null : cid)), onJump: jump, onEdit: (c: TrackComment) => { setOpenMenu(null); setContext({ kind: 'edit', comment: c }); }, onCopy: copy, onDelete: remove, onReport: report };

  return (
    <Screen
      top={4}
      gap={14}
      scroll
      onRefresh={() => Promise.all([list.refresh(), total.refresh()])}
      backdrop={{ pattern: 'none', mesh: 'coral' }}
      footer={
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <Composer
            key={context ? (context.kind === 'edit' ? `edit:${context.comment.id}` : `reply:${context.rootId}:${context.mention}`) : 'new'}
            trackId={id}
            signedIn={!!me}
            context={context}
            initialText={context?.kind === 'edit' ? (bodyOverride[context.comment.id] ?? context.comment.body) : (context?.mention ?? '')}
            onCancelContext={() => setContext(null)}
            onPosted={onPosted}
            onError={(t) => setNote({ ok: false, text: t })}
          />
        </KeyboardAvoidingView>
      }
    >
      <ScreenHeader title="" />
      <View style={{ gap: 2 }}>
        <Row gap={8}>
          <T variant="title" accessibilityRole="header">
            Comments
          </T>
          {count !== null && count > 0 ? (
            <View style={{ height: 24, paddingHorizontal: 9, borderRadius: 12, backgroundColor: colors.accentTint, justifyContent: 'center' }}>
              <T size={12} weight={700} color={colors.accentLight}>
                {String(count)}
              </T>
            </View>
          ) : null}
        </Row>
        <T size={13} color={colors.textSecondary} numberOfLines={1}>
          {track ? `${track.title} · ${track.artist.name}` : ' '}
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
        const replies = Math.max(0, c.reply_count + (replyDelta[c.id] ?? 0));
        const open = openThreads.has(c.id);
        const thread = threads[c.id];
        const visible = (thread?.items ?? []).filter((r) => !gone.has(r.id));
        return (
          <View key={c.id} style={{ borderRadius: 20, padding: 12, gap: 10, backgroundColor: withAlpha(colors.white, 0.05), borderWidth: 1, borderColor: colors.glassBorder }}>
            <CommentRow c={c} {...itemProps} />
            {replies > 0 || open ? (
              <Tap onPress={() => toggleThread(c.id)} accessibilityLabel={open ? 'Hide replies' : `View ${replies} ${replies === 1 ? 'reply' : 'replies'}`} accessibilityState={{ expanded: open }} style={{ minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 52 }}>
                <View style={{ width: 22, height: 1.5, backgroundColor: withAlpha(colors.white, 0.25) }} />
                <T size={13} weight={600} color={colors.accentLight}>
                  {open ? 'Hide replies' : `View ${replies} ${replies === 1 ? 'reply' : 'replies'}`}
                </T>
                <Icon name={open ? 'chevronUp' : 'chevronDown'} size={14} color={colors.accentLight} glow={false} />
              </Tap>
            ) : null}
            {open ? (
              <View style={{ gap: 12, paddingLeft: 52 }}>
                {thread?.loading && visible.length === 0 ? <Loading height={48} label="Loading replies" /> : null}
                {visible.map((r) => (
                  <CommentRow key={r.id} c={r} reply {...itemProps} />
                ))}
                {thread?.more && !thread.loading ? (
                  <Tap onPress={() => void loadThread(c.id, visible.length)} accessibilityLabel="Show more replies" style={{ minHeight: 36, justifyContent: 'center' }}>
                    <T size={13} weight={600} color={colors.accentLight}>
                      Show more replies
                    </T>
                  </Tap>
                ) : null}
              </View>
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

type RowProps = {
  c: TrackComment;
  reply?: boolean;
  me?: string;
  likeOverride: Record<string, Like>;
  bodyOverride: Record<string, string>;
  openMenu: string | null;
  onLike: (c: TrackComment) => void;
  onReply: (c: TrackComment) => void;
  onMenu: (id: string) => void;
  onJump: (sec: number) => void;
  onEdit: (c: TrackComment) => void;
  onCopy: (c: TrackComment) => void;
  onDelete: (c: TrackComment) => void;
  onReport: (c: TrackComment, reason: ReportReason) => void;
};

/** One comment or reply: avatar, name · moment · time, text, then Like · Reply · menu. */
const CommentRow = memo(function CommentRow({ c, reply, me, likeOverride, bodyOverride, openMenu, onLike, onReply, onMenu, onJump, onEdit, onCopy, onDelete, onReport }: RowProps) {
  const mine = c.user_id === me;
  const like = likeOverride[c.id] ?? { liked: c.liked, count: c.like_count };
  const body = bodyOverride[c.id] ?? c.body;
  const edited = c.edited || bodyOverride[c.id] !== undefined;
  const size = reply ? 28 : 40;
  return (
    <View style={{ gap: 6 }}>
      <Row gap={10} style={{ alignItems: 'flex-start' }}>
        <ChatAvatar person={c.author} size={size} radius={size / 2} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            <T size={14} weight={700} numberOfLines={1} style={{ flexShrink: 1 }}>
              {c.author.display_name}
            </T>
            {mine ? (
              <View style={{ height: 18, paddingHorizontal: 6, borderRadius: 9, backgroundColor: colors.accentTint, justifyContent: 'center' }}>
                <T size={10} weight={700} color={colors.accentLight}>
                  YOU
                </T>
              </View>
            ) : null}
            {c.at_seconds !== null ? (
              <Tap onPress={() => onJump(c.at_seconds as number)} accessibilityLabel={`Jump to ${clock(c.at_seconds)} in the song`} style={{ minHeight: 24, paddingHorizontal: 8, borderRadius: 12, justifyContent: 'center', backgroundColor: withAlpha(colors.accent, 0.22) }}>
                <T size={12} weight={600} color={colors.accentLight} style={{ fontFamily: fonts.mono }}>
                  {clock(c.at_seconds)}
                </T>
              </Tap>
            ) : null}
            <T size={12} color={colors.textTertiary}>
              {ago(c.created_at)}
              {edited ? ' · edited' : ''}
            </T>
          </Row>
          <T size={15} lineHeight={21}>
            {body}
          </T>
          <Row gap={4} style={{ marginLeft: -8 }}>
            <Tap onPress={() => onLike(c)} accessibilityLabel={like.liked ? 'Unlike' : 'Like'} accessibilityState={{ selected: like.liked }} style={{ minHeight: 40, minWidth: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 8 }}>
              <ToggleBurst active={like.liked} kind="like" size={28}>
                <Icon name="heart" size={17} filled={like.liked} color={like.liked ? colors.like : colors.textSecondary} />
              </ToggleBurst>
              {like.count > 0 ? (
                <T size={12} weight={600} color={like.liked ? colors.like : colors.textSecondary}>
                  {String(like.count)}
                </T>
              ) : null}
            </Tap>
            <Tap onPress={() => onReply(c)} accessibilityLabel={`Reply to ${c.author.display_name}`} style={{ minHeight: 40, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Icon name="chat" size={15} color={colors.textSecondary} glow={false} />
              <T size={12} weight={600} color={colors.textSecondary}>
                Reply
              </T>
            </Tap>
            <IconButton icon="more" label="Comment options" size={36} iconSize={18} color={colors.textSecondary} onPress={() => onMenu(c.id)} />
          </Row>
        </View>
      </Row>
      {openMenu === c.id ? (
        <Row gap={8} style={{ flexWrap: 'wrap', paddingLeft: size + 10 }}>
          {mine ? <MenuChip label="Edit" onPress={() => onEdit(c)} /> : null}
          <MenuChip label="Copy" onPress={() => onCopy(c)} />
          {mine ? (
            <MenuChip label="Delete" danger onPress={() => onDelete(c)} />
          ) : (
            <>
              <T size={12} color={colors.textSecondary}>
                Report as
              </T>
              <MenuChip label="Spam" onPress={() => onReport(c, 'spam')} />
              <MenuChip label="Abusive" onPress={() => onReport(c, 'abuse')} />
              <MenuChip label="Hate" onPress={() => onReport(c, 'hate')} />
            </>
          )}
        </Row>
      ) : null}
    </View>
  );
});

function MenuChip({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) {
  return (
    <Tap onPress={onPress} accessibilityLabel={label} style={{ minHeight: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: danger ? withAlpha(colors.error, 0.16) : colors.chipGhost }}>
      <T size={13} weight={600} color={danger ? colors.error : colors.text}>
        {label}
      </T>
    </Tap>
  );
}

/**
 * Bottom bar. New comment: "0:14  Add a comment at this moment". Replying: a "Replying to Name" bar above the field.
 * Editing: an "Editing your comment" bar and Save. Reads the playback position here so the list does not re-render.
 * It is keyed by the context, so switching between new / reply / edit starts the field fresh with `initialText`.
 */
function Composer({ trackId, signedIn, context, initialText, onCancelContext, onPosted, onError }: { trackId: string; signedIn: boolean; context: Context; initialText: string; onCancelContext: () => void; onPosted: (info: { rootId?: string; editedId?: string; editedBody?: string }) => void; onError: (t: string) => void }) {
  const { track } = usePlayerPick('track');
  const { position } = usePlaybackProgress();
  const [text, setText] = useState(initialText);
  const [pin, setPin] = useState(true);
  const [busy, setBusy] = useState(false);
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const isReply = context?.kind === 'reply';
  const isEdit = context?.kind === 'edit';
  const here = track?.id === trackId; // only this song's playback gives a meaningful moment
  const at = here && pin && !isReply && !isEdit ? Math.floor(position) : null;
  const ok = signedIn && text.trim().length > 0 && !busy && (!isEdit || text.trim() !== context.comment.body);
  const left = TRACK_COMMENT_MAX - text.length;

  useEffect(() => {
    if (context) input.current?.focus();
  }, [context]);

  const send = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (isEdit) {
        await editTrackComment(context.comment.id, text);
        onPosted({ editedId: context.comment.id, editedBody: text.trim() });
      } else if (isReply) {
        await postTrackComment(trackId, text, null, context.rootId);
        onPosted({ rootId: context.rootId });
      } else {
        await postTrackComment(trackId, text, at);
        onPosted({});
      }
      setText('');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not post your comment');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.divider, backgroundColor: colors.bg }}>
      {context ? (
        <Row gap={8} style={{ paddingHorizontal: 16, paddingTop: 8, minHeight: 40 }}>
          <Icon name={isEdit ? 'edit' : 'chat'} size={14} color={colors.accentLight} glow={false} />
          <T size={13} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
            {isEdit ? 'Editing your comment' : `Replying to ${context.name}`}
          </T>
          <Tap onPress={onCancelContext} accessibilityLabel={isEdit ? 'Cancel editing' : 'Cancel reply'} style={{ minHeight: 36, minWidth: 36, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} color={colors.textSecondary} glow={false} />
          </Tap>
        </Row>
      ) : null}
      <Row gap={10} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 }}>
        {here && !context ? (
          <Tap onPress={() => setPin((p) => !p)} accessibilityLabel={pin ? 'Comment is pinned to this moment. Tap to unpin.' : 'Pin the comment to this moment'} accessibilityState={{ selected: pin }} style={{ minHeight: 44, paddingHorizontal: 10, borderRadius: 22, justifyContent: 'center', backgroundColor: pin ? withAlpha(colors.accent, 0.22) : colors.chipGhost }}>
            <T size={13} weight={600} color={pin ? colors.accentLight : colors.textSecondary} style={{ fontFamily: fonts.mono }}>
              {clock(position)}
            </T>
          </Tap>
        ) : null}
        <View style={{ flex: 1 }}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            placeholder={signedIn ? (isReply ? `Reply to ${context.name}` : isEdit ? 'Edit your comment' : at !== null ? 'Add a comment at this moment' : 'Add a comment') : 'Sign in to comment'}
            placeholderTextColor={colors.textTertiary}
            editable={signedIn}
            maxLength={TRACK_COMMENT_MAX}
            multiline
            accessibilityLabel={isReply ? 'Write a reply' : isEdit ? 'Edit your comment' : 'Write a comment'}
            style={{ minHeight: 44, maxHeight: 110, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
          />
          {left <= 60 ? (
            <T size={11} weight={600} color={left <= 10 ? colors.warning : colors.textSecondary} style={{ position: 'absolute', right: 14, bottom: -2 }}>
              {String(left)}
            </T>
          ) : null}
        </View>
        <IconButton icon={isEdit ? 'check' : 'send'} label={isEdit ? 'Save change' : isReply ? 'Post reply' : 'Post comment'} size={44} bg={ok ? colors.accent : colors.chipGhost} color={ok ? colors.onAccent : colors.textTertiary} onPress={() => void send()} />
      </Row>
    </View>
  );
}
