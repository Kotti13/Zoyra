import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';

import { Button, ChipRow, EmptyState, ErrorState, go, Icon, IconButton, Loading, Row, Sheet, T, Tap, useAsync } from '../components';
import { confirmAction, useBlocks } from '../lib/social';
import { ChannelAvatar } from '../lib/video-ui';
import {
  compactCount,
  deleteZoyraComment,
  fetchComments,
  hasTimestamp,
  listZoyraComments,
  postZoyraComment,
  splitTimestamps,
  timeAgo,
  videoBus,
  YouTubeError,
  youtubeErrorMessage,
  ZOYRA_COMMENT_MAX,
  type YouTubeComment,
  type ZoyraComment,
} from '../lib/youtube';
import { useAuth } from '../state/auth';
import { colors, fonts } from '../theme/tokens';

const TABS = ['Top', 'Newest', 'Timestamps', 'On Zoyra'] as const;
type Tab = (typeof TABS)[number];

/**
 * VideoComments sheet (`/video-comments?id=&d=<duration sec>`).
 * YouTube comments are read-only (posting to YouTube needs Google OAuth, which Zoyra doesn't use).
 * The composer posts Zoyra comments (video_comments) shown under "On Zoyra". Tapping a timestamp
 * seeks the open player through the shared video bus.
 */
export default function VideoComments() {
  const params = useLocalSearchParams<{ id?: string; d?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const duration = Number(params.d) > 0 ? Number(params.d) : null;
  const [tab, setTab] = useState<Tab>('Top');

  const seek = useCallback(
    (sec: number) => {
      videoBus.seek(id, sec);
      go('back');
    },
    [id],
  );

  return (
    <Sheet gap={12} maxHeight={720}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T variant="section" size={18} accessibilityRole="header">
          Comments
        </T>
        <IconButton icon="close" label="Close comments" onPress={() => go('back')} />
      </Row>
      <ChipRow options={[...TABS]} onChange={(i) => setTab(TABS[i])} />
      {!id ? (
        <ErrorState message="No video selected." />
      ) : tab === 'On Zoyra' ? (
        <ZoyraTab videoId={id} duration={duration} onSeek={seek} />
      ) : (
        <YouTubeTab key={tab} videoId={id} tab={tab} duration={duration} onSeek={seek} onZoyra={() => setTab('On Zoyra')} />
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ YouTube (read-only) */

function YouTubeTab({ videoId, tab, duration, onSeek, onZoyra }: { videoId: string; tab: Exclude<Tab, 'On Zoyra'>; duration: number | null; onSeek: (s: number) => void; onZoyra: () => void }) {
  const order = tab === 'Newest' ? 'time' : 'relevance';
  const [more, setMore] = useState<YouTubeComment[]>([]);
  const [token, setToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const res = useAsync<{ comments: YouTubeComment[]; disabled: boolean }>(async () => {
    try {
      const page = await fetchComments(videoId, order);
      setToken(page.nextPageToken);
      return { comments: page.comments, disabled: false };
    } catch (e) {
      if (e instanceof YouTubeError && e.code === 'comments_disabled') return { comments: [], disabled: true };
      throw new Error(youtubeErrorMessage(e, 'Could not load comments'));
    }
  }, [videoId, order], 'app/video-comments:79');

  const loadMore = async () => {
    if (!token || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await fetchComments(videoId, order, token);
      setMore((m) => [...m, ...page.comments]);
      setToken(page.nextPageToken);
    } catch (e) {
      setMoreError(youtubeErrorMessage(e, 'Could not load more comments'));
    } finally {
      setLoadingMore(false);
    }
  };

  const addOnZoyra = (
    <Tap onPress={onZoyra} accessibilityLabel="Add a comment on Zoyra" style={{ minHeight: 48, justifyContent: 'center' }}>
      <Row gap={10} style={{ height: 48, paddingHorizontal: 18, borderRadius: 32, borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: colors.iconGhost }}>
        <Icon name="edit" size={18} color={colors.textSecondary} />
        <T size={14} color={colors.textSecondary} style={{ flex: 1 }}>
          Add a comment on Zoyra…
        </T>
      </Row>
    </Tap>
  );

  if (res.loading) return <Loading label="Loading comments" />;
  if (res.error) return <ErrorState message={res.error} onRetry={res.reload} />;
  if (res.data?.disabled)
    return (
      <>
        <EmptyState icon="mail" title="Comments are off on YouTube" body="The owner turned comments off. You can still talk about it with people on Zoyra." />
        {addOnZoyra}
      </>
    );

  const all = [...(res.data?.comments ?? []), ...more];
  const shown = tab === 'Timestamps' ? all.filter((c) => hasTimestamp(c.text, duration)) : all;

  return (
    <>
      {addOnZoyra}
      <T size={12} color={colors.textTertiary}>
        {tab === 'Timestamps' ? 'Comments that mention a moment. Tap a time to jump there.' : 'From YouTube (read-only).'}
      </T>
      {!shown.length ? (
        <EmptyState icon="mail" title={tab === 'Timestamps' ? 'No timestamps yet' : 'No comments yet'} body={tab === 'Timestamps' && token ? 'Load more comments to look further.' : undefined} />
      ) : (
        shown.map((c) => (
          <CommentRow
            key={c.id}
            name={c.author}
            avatar={c.authorAvatar}
            when={timeAgo(c.publishedAt)}
            text={c.text}
            duration={duration}
            onSeek={onSeek}
            footer={[c.likes ? `${compactCount(c.likes)} likes` : null, c.replies ? `${compactCount(c.replies)} replies on YouTube` : null].filter(Boolean).join(' · ')}
          />
        ))
      )}
      {moreError ? <ErrorState message={moreError} onRetry={() => void loadMore()} /> : null}
      {token ? loadingMore ? <Loading height={50} /> : <Button label="Load more" variant="glass" height={44} onPress={() => void loadMore()} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ On Zoyra */

function ZoyraTab({ videoId, duration, onSeek }: { videoId: string; duration: number | null; onSeek: (s: number) => void }) {
  const { user } = useAuth();
  const me = user?.id;
  const blocks = useBlocks(me);
  const list = useAsync(() => listZoyraComments(videoId), [videoId], 'app/video-comments:163');
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    if (posting) return;
    setPosting(true);
    setError(null);
    try {
      await postZoyraComment(videoId, draft);
      setDraft('');
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post your comment');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (c: ZoyraComment) => {
    if (!(await confirmAction('Delete comment?', 'This removes your comment from Zoyra.', 'Delete'))) return;
    try {
      await deleteZoyraComment(c.id);
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the comment');
    }
  };

  const block = async (c: ZoyraComment) => {
    try {
      if (await blocks.block(c.user_id, c.author?.display_name ?? 'this person')) list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not block');
    }
  };

  const shown = (list.data ?? []).filter((c) => !blocks.blocked.has(c.user_id));
  const left = ZOYRA_COMMENT_MAX - draft.length;

  return (
    <>
      {me ? (
        <View style={{ gap: 6 }}>
          <Row gap={8} style={{ minHeight: 48, paddingLeft: 18, paddingRight: 4, borderRadius: 32, borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: colors.iconGhost }}>
            <TextInput
              accessibilityLabel="Write a comment on Zoyra"
              value={draft}
              onChangeText={(t) => setDraft(t.slice(0, ZOYRA_COMMENT_MAX))}
              placeholder="Add a comment…"
              placeholderTextColor={colors.textTertiary}
              multiline
              maxLength={ZOYRA_COMMENT_MAX}
              style={{ flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 15, paddingVertical: 10, maxHeight: 110 }}
            />
            <IconButton
              icon="arrowRight"
              label="Post comment"
              bg={draft.trim() && !posting ? colors.accent : colors.bgTertiary}
              color={colors.onAccent}
              size={40}
              iconSize={20}
              onPress={draft.trim() && !posting ? () => void post() : undefined}
            />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={11} color={colors.textTertiary}>
              Posts on Zoyra only, not on YouTube.
            </T>
            {draft.length > ZOYRA_COMMENT_MAX - 100 ? (
              <T size={11} color={left < 20 ? colors.error : colors.textTertiary}>
                {left}
              </T>
            ) : null}
          </Row>
        </View>
      ) : (
        <Button label="Sign in to comment" variant="glass" height={44} onPress={() => router.push('/login')} />
      )}
      {error ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      {list.loading ? (
        <Loading label="Loading Zoyra comments" />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !shown.length ? (
        <EmptyState icon="mail" title="No one on Zoyra has commented yet" body="Be the first to say something about this video." />
      ) : (
        shown.map((c) => (
          <CommentRow
            key={c.id}
            name={c.author?.display_name ?? 'Zoyra listener'}
            avatar={c.author?.avatar_url ?? null}
            when={timeAgo(c.created_at)}
            text={c.body}
            duration={duration}
            onSeek={onSeek}
            action={
              c.user_id === me ? (
                <IconButton icon="trash" label="Delete your comment" iconSize={18} color={colors.textSecondary} onPress={() => void remove(c)} />
              ) : me ? (
                <IconButton icon="shield" label={`Block ${c.author?.display_name ?? 'this person'}`} iconSize={18} color={colors.textSecondary} onPress={() => void block(c)} />
              ) : null
            }
          />
        ))
      )}
    </>
  );
}

/* ------------------------------------------------------------------ row */

function CommentRow({
  name,
  avatar,
  when,
  text,
  duration,
  onSeek,
  footer,
  action,
}: {
  name: string;
  avatar: string | null;
  when: string;
  text: string;
  duration: number | null;
  onSeek: (s: number) => void;
  footer?: string;
  action?: ReactNode;
}) {
  const parts = splitTimestamps(text, duration);
  return (
    <Row gap={12} align="flex-start" style={{ paddingVertical: 6 }}>
      <ChannelAvatar name={name} uri={avatar} size={38} />
      <View style={{ flex: 1, gap: 4 }}>
        <T size={12} color={colors.textSecondary} numberOfLines={1}>
          {[name, when].filter(Boolean).join(' · ')}
        </T>
        <T size={14} lineHeight={20}>
          {parts.map((p, i) =>
            p.seconds !== undefined ? (
              <T key={i} size={14} weight={600} color={colors.accentLight} onPress={() => onSeek(p.seconds ?? 0)} accessibilityRole="link" accessibilityLabel={`Jump to ${p.text}`}>
                {p.text}
              </T>
            ) : (
              p.text
            ),
          )}
        </T>
        {footer ? (
          <T size={12} color={colors.textTertiary}>
            {footer}
          </T>
        ) : null}
      </View>
      {action}
    </Row>
  );
}
