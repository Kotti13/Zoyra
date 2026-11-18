import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, ScrollView, TextInput, View } from 'react-native';

import { Button, Chip, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, PopRing, Row, Screen, ScreenHeader, T, Tap, usePop } from '../components';
import {
  addComment,
  createPost,
  deleteComment,
  deletePost,
  followingIds,
  fromPostTrack,
  loadComments,
  loadFeed,
  loadPost,
  myLikes,
  PAGE,
  POST_MAX,
  setLiked,
  timeAgo,
  type Author,
  type Comment,
  type FeedFilter,
  type Post,
} from '../lib/community';
import { confirmAction } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { isLocalTrack, usePlayerPick, usePlayerSelector } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

type Tab = { key: string; label: string; filter: (me: string, following: string[]) => FeedFilter };

const BASE_TABS: Tab[] = [
  { key: 'all', label: 'For you', filter: () => ({ kind: 'all' }) },
  { key: 'following', label: 'Following', filter: (_me, ids) => ({ kind: 'following', ids }) },
  { key: 'mine', label: 'My posts', filter: (me) => ({ kind: 'mine', me }) },
];

const errMsg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

const matches = (f: FeedFilter, p: Pick<Post, 'user_id' | 'artist_id'>) =>
  f.kind === 'all' || (f.kind === 'mine' && p.user_id === f.me) || (f.kind === 'following' && f.ids.includes(p.user_id)) || (f.kind === 'artist' && p.artist_id === f.id);

function Face({ a, id, size = 40 }: { a: Author | null; id: string; size?: number }) {
  return (
    <Cover uri={a?.avatar_url} id={id} size={size} radius={size / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
      {a?.avatar_url ? null : (
        <T size={Math.round(size * 0.36)} weight={600} color={colors.white}>
          {(a?.display_name || '?').charAt(0).toUpperCase()}
        </T>
      )}
    </Cover>
  );
}

function LikeButton({ liked, count, onPress, busy }: { liked: boolean; count: number; onPress: () => void; busy: boolean }) {
  const scale = usePop(liked);
  return (
    <Tap onPress={busy ? undefined : onPress} accessibilityLabel={liked ? `Unlike, ${count} likes` : `Like, ${count} likes`} accessibilityState={{ selected: liked, busy }} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Row gap={6}>
        <View style={{ width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
          <PopRing active={liked} size={30} color={colors.like} glyph="♥" count={8} />
          <Animated.View style={{ transform: [{ scale }] }}>
            <Icon name="heart" size={20} filled={liked} color={liked ? colors.like : colors.textSecondary} />
          </Animated.View>
        </View>
        <T mono size={13} color={colors.textSecondary}>
          {count.toLocaleString('en-US')}
        </T>
      </Row>
    </Tap>
  );
}

/* ------------------------------------------------------------------ replies */

function Thread({ post, me }: { post: Post; me: string }) {
  const [items, setItems] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const load = useCallback(() => {
    loadComments(post.id)
      .then((list) => {
        setError(null);
        setItems(list);
      })
      .catch((e: unknown) => setError(errMsg(e, 'Could not load replies')));
  }, [post.id]);

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`community-comments:${post.id}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'community_comments', filter: `post_id=eq.${post.id}` }, () => load())
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [post.id, load]);

  const send = async () => {
    setSending(true);
    setSendError(null);
    try {
      const c = await addComment(post.id, text);
      setItems((l) => (l && !l.some((x) => x.id === c.id) ? [...l, c] : l));
      setText('');
    } catch (e) {
      setSendError(errMsg(e, 'Could not reply'));
    } finally {
      setSending(false);
    }
  };

  const remove = async (c: Comment) => {
    if (!(await confirmAction('Delete reply?', 'This removes your reply for everyone.', 'Delete'))) return;
    try {
      await deleteComment(c.id);
      setItems((l) => l?.filter((x) => x.id !== c.id) ?? l);
    } catch (e) {
      setSendError(errMsg(e, 'Could not delete the reply'));
    }
  };

  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 10 }}>
      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !items ? (
        <ActivityIndicator color={colors.accent} accessibilityLabel="Loading replies" />
      ) : items.length === 0 ? (
        <T size={13} color={colors.textSecondary}>
          No replies yet.
        </T>
      ) : (
        items.map((c) => (
          <Row key={c.id} gap={10} align="flex-start">
            <Face a={c.author} id={c.user_id} size={28} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={13} weight={600}>
                {c.user_id === me ? 'You' : (c.author?.display_name ?? 'Listener')}{' '}
                <T size={12} color={colors.textSecondary}>
                  · {timeAgo(c.created_at)}
                </T>
              </T>
              <T size={14} lineHeight={20}>
                {c.body}
              </T>
            </View>
            {c.user_id === me ? <IconButton icon="trash" label="Delete reply" size={32} iconSize={16} color={colors.textSecondary} onPress={() => void remove(c)} /> : null}
          </Row>
        ))
      )}
      <Row gap={8}>
        <TextInput
          value={text}
          onChangeText={setText}
          maxLength={POST_MAX}
          placeholder="Write a reply"
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel="Write a reply"
          style={{ flex: 1, minHeight: 40, borderRadius: 20, paddingHorizontal: 14, color: colors.text, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.chipOutline }}
        />
        {sending ? <ActivityIndicator color={colors.accent} /> : <IconButton icon="arrowRight" label="Send reply" size={40} iconSize={20} bg={text.trim() ? colors.accent : undefined} onPress={text.trim() ? () => void send() : undefined} />}
      </Row>
      {sendError ? (
        <T size={12} color={colors.error}>
          {sendError}
        </T>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------------ post card */

function PostCard({
  post,
  me,
  liked,
  likeBusy,
  onLike,
  onDelete,
  onClub,
}: {
  post: Post;
  me: string;
  liked: boolean;
  likeBusy: boolean;
  onLike: () => void;
  onDelete: () => void;
  onClub: (id: string, name: string) => void;
}) {
  const { playTrack } = usePlayerPick();
  // Feed rows re-render only when *this* post's song starts/stops being the current track.
  const isCurrent = usePlayerSelector((s) => !!post.track && s.track?.id === post.track.id);
  const [open, setOpen] = useState(false);
  const mine = post.user_id === me;
  const name = mine ? 'You' : (post.author?.display_name ?? 'Listener');

  return (
    <Glass padding={16}>
      <View style={{ gap: 12 }}>
        <Row gap={12}>
          <Tap onPress={() => router.push({ pathname: '/public-profile', params: { id: post.user_id } })} accessibilityLabel={`Open ${name}'s profile`}>
            <Face a={post.author} id={post.user_id} />
          </Tap>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {name}
            </T>
            <Row gap={0}>
              {post.artist_id && post.artist_name ? (
                <Tap onPress={() => onClub(post.artist_id as string, post.artist_name as string)} accessibilityLabel={`Show the ${post.artist_name} fan club`}>
                  <T size={12} color={colors.accentLight} numberOfLines={1}>
                    {post.artist_name} fan club
                  </T>
                </Tap>
              ) : null}
              <T size={12} color={colors.textSecondary}>
                {post.artist_id && post.artist_name ? ' · ' : ''}
                {timeAgo(post.created_at)}
              </T>
            </Row>
          </View>
          {mine ? <IconButton icon="trash" label="Delete post" size={36} iconSize={18} color={colors.textSecondary} onPress={onDelete} /> : null}
        </Row>

        <T size={15} lineHeight={22}>
          {post.body}
        </T>

        {post.track ? (
          <Tap onPress={() => post.track && playTrack(fromPostTrack(post.track), 'Community')} accessibilityLabel={`Play ${post.track.title} by ${post.track.artist.name}`}>
            <Row gap={12} style={{ padding: 8, borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.06) }}>
              <Cover artwork={post.track.artwork} id={post.track.id} size={44} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={14} weight={600} numberOfLines={1}>
                  {post.track.title}
                </T>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {post.track.artist.name}
                </T>
              </View>
              <Icon name={isCurrent ? 'speaker' : 'play'} size={20} color={colors.accentLight} />
            </Row>
          </Tap>
        ) : null}

        <Row gap={20}>
          <LikeButton liked={liked} count={post.like_count} onPress={onLike} busy={likeBusy} />
          <Tap onPress={() => setOpen((o) => !o)} accessibilityLabel={`${open ? 'Hide' : 'Show'} replies, ${post.comment_count}`} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Row gap={6}>
              <Icon name="mail" size={20} color={open ? colors.text : colors.textSecondary} />
              <T mono size={13} color={colors.textSecondary}>
                {post.comment_count.toLocaleString('en-US')}
              </T>
            </Row>
          </Tap>
        </Row>

        {open ? <Thread post={post} me={me} /> : null}
      </View>
    </Glass>
  );
}

/* ------------------------------------------------------------------ composer */

function Composer({ onPosted }: { onPosted: (p: Post) => void }) {
  const { track } = usePlayerPick('track');
  const [text, setText] = useState('');
  const [attach, setAttach] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachable = track && !isLocalTrack(track) ? track : null;

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      onPosted(await createPost(text, attach ? attachable : null));
      setText('');
    } catch (e) {
      setError(errMsg(e, 'Could not post'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass padding={14}>
      <View style={{ gap: 10 }}>
        <TextInput
          value={text}
          onChangeText={setText}
          maxLength={POST_MAX}
          multiline
          placeholder="Share something with other fans"
          placeholderTextColor={colors.textTertiary}
          accessibilityLabel="New post"
          style={{ minHeight: 64, maxHeight: 160, color: colors.text, fontSize: 15, textAlignVertical: 'top' }}
        />
        {attachable ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Chip label={attach ? `With ${attachable.title}` : 'Attach now playing'} active={attach} onPress={() => setAttach((a) => !a)} />
          </ScrollView>
        ) : null}
        <Row style={{ justifyContent: 'space-between' }}>
          <T mono size={12} color={text.length > POST_MAX - 30 ? colors.warning : colors.textSecondary}>
            {text.length}/{POST_MAX}
          </T>
          {busy ? <ActivityIndicator color={colors.accent} /> : <Button label="Post" height={40} variant={text.trim() ? 'primary' : 'disabled'} onPress={text.trim() ? () => void post() : undefined} />}
        </Row>
        {error ? (
          <T size={12} color={colors.error}>
            {error}
          </T>
        ) : null}
      </View>
    </Glass>
  );
}

/* ------------------------------------------------------------------ screen */

export default function Community() {
  const { user } = useAuth();
  const me = user?.id;
  const params = useLocalSearchParams<{ artist?: string; name?: string }>();
  const [clubs, setClubs] = useState<{ id: string; name: string }[]>(() => (params.artist && params.name ? [{ id: params.artist, name: params.name }] : []));
  const [tab, setTab] = useState<string>(params.artist ? `artist:${params.artist}` : 'all');
  const [following, setFollowing] = useState<string[] | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [liked, setLikedSet] = useState<ReadonlySet<string>>(() => new Set());
  const [likeBusy, setLikeBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<'idle' | 'loading' | 'end'>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const filter = useMemo<FeedFilter | null>(() => {
    if (!me || following === null) return null;
    if (tab.startsWith('artist:')) return { kind: 'artist', id: tab.slice(7) };
    return (BASE_TABS.find((t) => t.key === tab) ?? BASE_TABS[0]).filter(me, following);
  }, [tab, me, following]);
  const filterRef = useRef(filter);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  // Who you follow (for the Following tab and live inserts).
  useEffect(() => {
    if (!me) return;
    let alive = true;
    followingIds(me)
      .then((ids) => alive && setFollowing(ids))
      .catch(() => alive && setFollowing([]));
    return () => {
      alive = false;
    };
  }, [me]);

  const addClubs = useCallback((list: Post[]) => {
    setClubs((c) => {
      const next = [...c];
      for (const p of list) if (p.artist_id && p.artist_name && !next.some((x) => x.id === p.artist_id) && next.length < 8) next.push({ id: p.artist_id, name: p.artist_name });
      return next.length === c.length ? c : next;
    });
  }, []);

  // Load the feed for the current tab.
  useEffect(() => {
    if (!filter || !me) return;
    let alive = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    setMore('idle');
    (async () => {
      const list = await loadFeed(filter);
      const mine = await myLikes(me, list.map((p) => p.id));
      if (!alive) return;
      setPosts(list);
      setLikedSet(mine);
      setMore(list.length < PAGE ? 'end' : 'idle');
      addClubs(list);
    })()
      .catch((e: unknown) => alive && setError(errMsg(e, 'Could not load the feed')))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [filter, me, nonce, addClubs]);

  // Live: new posts, deleted posts, and like / reply counts.
  useEffect(() => {
    if (!me) return;
    const ch = supabase
      .channel(`community-feed:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_posts' }, (payload) => {
        const row = payload.new as Post;
        const f = filterRef.current;
        if (!f || !matches(f, row)) return;
        loadPost(row.id)
          .then((p) => p && setPosts((l) => (l.some((x) => x.id === p.id) ? l : [p, ...l])))
          .catch(() => undefined);
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'community_posts' }, (payload) => {
        const row = payload.new as Pick<Post, 'id' | 'like_count' | 'comment_count'>;
        setPosts((l) => l.map((p) => (p.id === row.id ? { ...p, like_count: row.like_count, comment_count: row.comment_count } : p)));
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'community_posts' }, (payload) => {
        const id = (payload.old as { id?: string }).id;
        if (id) setPosts((l) => l.filter((p) => p.id !== id));
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [me]);

  // Pull to refresh: re-fetch the first page of the current tab in place (posts stay on screen meanwhile).
  const refreshFeed = async () => {
    if (!filter || !me) return;
    try {
      const list = await loadFeed(filter);
      const mine = await myLikes(me, list.map((p) => p.id));
      if (filterRef.current !== filter) return; // tab changed mid-refresh; its own load wins
      setPosts(list);
      setLikedSet(mine);
      setMore(list.length < PAGE ? 'end' : 'idle');
      addClubs(list);
      setError(null);
    } catch (e) {
      setActionError(errMsg(e, 'Could not refresh the feed'));
    }
  };

  const loadMore = async () => {
    if (!filter || !me || more !== 'idle' || !posts.length) return;
    setMore('loading');
    try {
      const list = await loadFeed(filter, posts[posts.length - 1].created_at);
      const mine = await myLikes(me, list.map((p) => p.id));
      setPosts((l) => [...l, ...list.filter((p) => !l.some((x) => x.id === p.id))]);
      setLikedSet((s) => new Set([...s, ...mine]));
      addClubs(list);
      setMore(list.length < PAGE ? 'end' : 'idle');
    } catch (e) {
      setActionError(errMsg(e, 'Could not load more posts'));
      setMore('idle');
    }
  };

  const toggleLike = async (p: Post) => {
    if (!me || likeBusy.has(p.id)) return;
    const on = !liked.has(p.id);
    setActionError(null);
    setLikeBusy((s) => new Set(s).add(p.id));
    setLikedSet((s) => {
      const n = new Set(s);
      if (on) n.add(p.id);
      else n.delete(p.id);
      return n;
    });
    setPosts((l) => l.map((x) => (x.id === p.id ? { ...x, like_count: Math.max(0, x.like_count + (on ? 1 : -1)) } : x)));
    try {
      await setLiked(p.id, me, on);
    } catch (e) {
      // Roll back.
      setLikedSet((s) => {
        const n = new Set(s);
        if (on) n.delete(p.id);
        else n.add(p.id);
        return n;
      });
      setPosts((l) => l.map((x) => (x.id === p.id ? { ...x, like_count: Math.max(0, x.like_count + (on ? -1 : 1)) } : x)));
      setActionError(errMsg(e, 'Could not update the like'));
    } finally {
      setLikeBusy((s) => {
        const n = new Set(s);
        n.delete(p.id);
        return n;
      });
    }
  };

  const remove = async (p: Post) => {
    if (!(await confirmAction('Delete post?', 'This removes the post and its replies for everyone.', 'Delete'))) return;
    setActionError(null);
    try {
      await deletePost(p.id);
      setPosts((l) => l.filter((x) => x.id !== p.id));
    } catch (e) {
      setActionError(errMsg(e, 'Could not delete the post'));
    }
  };

  const tabs = [...BASE_TABS.map((t) => ({ key: t.key, label: t.label })), ...clubs.map((c) => ({ key: `artist:${c.id}`, label: c.name }))];

  return (
    <Screen onRefresh={me ? refreshFeed : undefined} top={4} gap={16} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Community
        </T>
        <T size={15} color={colors.textSecondary}>
          Fan posts, fan clubs and the songs people share
        </T>
      </View>

      {!me ? (
        <EmptyState icon="users" title="Sign in to join the community" action="Sign in" href="/login" />
      ) : (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {tabs.map((t) => (
              <Chip key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
            ))}
          </ScrollView>

          <Composer
            onPosted={(p) => {
              addClubs([p]);
              if (filter && matches(filter, p)) setPosts((l) => (l.some((x) => x.id === p.id) ? l : [p, ...l]));
            }}
          />

          {actionError ? (
            <T size={13} color={colors.error} align="center">
              {actionError}
            </T>
          ) : null}

          {loading && !posts.length ? (
            <Loading label="Loading the feed" height={320} />
          ) : error ? (
            <ErrorState message={error} onRetry={() => setNonce((n) => n + 1)} />
          ) : !posts.length ? (
            <EmptyState
              icon="users"
              title={tab === 'following' ? 'Nothing from people you follow yet' : tab === 'mine' ? 'You haven’t posted yet' : 'No posts yet'}
              body={tab === 'following' ? 'Follow more listeners to fill this tab.' : 'Be the first: write something above.'}
              action={tab === 'following' ? 'Find friends' : undefined}
              href={tab === 'following' ? '/friends' : undefined}
            />
          ) : (
            <>
              {posts.map((p) => (
                <PostCard
                  key={p.id}
                  post={p}
                  me={me}
                  liked={liked.has(p.id)}
                  likeBusy={likeBusy.has(p.id)}
                  onLike={() => void toggleLike(p)}
                  onDelete={() => void remove(p)}
                  onClub={(id, name) => {
                    setClubs((c) => (c.some((x) => x.id === id) ? c : [...c, { id, name }]));
                    setTab(`artist:${id}`);
                  }}
                />
              ))}
              {more === 'idle' ? <Button label="Load more" variant="glass" onPress={() => void loadMore()} /> : more === 'loading' ? <ActivityIndicator color={colors.accent} accessibilityLabel="Loading more posts" /> : null}
            </>
          )}

          <T size={12} color={colors.textSecondary} align="center" lineHeight={16}>
            Posts are public to everyone signed in. People you block, and people who block you, are hidden both ways. Up to 10 posts every 10 minutes.
          </T>
        </>
      )}
    </Screen>
  );
}
