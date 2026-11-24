import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, TextInput, View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, Icon, ListRow, Loading, Row, Screen, ScreenHeader, Segmented, T, Tap, useAsync, useDebounced, ToggleBurst } from '../components';
import { PersonAvatar } from '../features/profile-ui';
import { cancelFollowRequest, followUser, myPendingRequestIds, useFollowRequestCount } from '../lib/follow-requests';
import { loadAvatarArts } from '../lib/profile';
import { chatPeerParams } from '../lib/chat';
import { startChat } from '../lib/dm';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, fonts } from '../theme/tokens';
import { FLASH, flash } from '../lib/flash';

type Person = { id: string; display_name: string; username: string | null; avatar_url: string | null };
type FollowRow = { follower: Person | null; following: Person | null };

const PROFILE_COLS = 'id, display_name, username, avatar_url';
const NO_ARTS = new Map<string, string>();

function FollowButton({ name, on, requested, onPress }: { name: string; on: boolean; requested?: boolean; onPress: () => void }) {
  return (
    <Tap
      onPress={onPress}
      accessibilityLabel={on ? `Unfollow ${name}` : requested ? `Withdraw follow request to ${name}` : `Follow ${name}`}
      accessibilityState={{ selected: on }}
      style={{ height: 44, justifyContent: 'center' }}
    >
      <ToggleBurst active={on}>
        <View
          style={[
            { height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center' },
            on || requested ? { borderWidth: 1, borderColor: colors.border } : { backgroundColor: colors.accent },
          ]}
        >
          <T size={13} weight={600} color={on || requested ? colors.text : colors.onAccent}>
            {on ? 'Following' : requested ? 'Requested' : 'Follow'}
          </T>
        </View>
      </ToggleBurst>
    </Tap>
  );
}

/** Strip characters that would break a PostgREST `or=` filter. */
const cleanQuery = (q: string) => q.replace(/[,()%*\\]/g, ' ').trim();

export default function Followers() {
  const { user, profile } = useAuth();
  const me = user?.id;
  const { tab: tabParam } = useLocalSearchParams<{ tab?: string }>();
  const startTab = tabParam === 'following' ? 1 : 0;
  const [tab, setTab] = useState(startTab);
  const [pulling, setPulling] = useState(false);
  const [followers, setFollowers] = useState<Person[]>([]);
  const [following, setFollowing] = useState<Person[]>([]);
  const [followingIds, setFollowingIds] = useState<Set<string>>(new Set());
  /** Private profiles I asked to follow that haven't accepted yet. */
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());
  const { count: requestCount } = useFollowRequestCount(me);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebounced(cleanQuery(query));
  const [found, setFound] = useState<{ key: string; list: Person[] } | null>(null);
  const results = q && me && found?.key === q ? found.list : null;
  const searching = !!q && !!me && found?.key !== q;
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { blocked, block, unblock } = useBlocks(me);
  const [blockBusy, setBlockBusy] = useState<string | null>(null);

  // State is only set after the first await, so this is safe to start from an effect.
  const load = useCallback(async () => {
    if (!me) return;
    try {
      const [a, b] = await Promise.all([
        supabase.from('follows').select(`follower:profiles!follows_follower_id_fkey(${PROFILE_COLS})`).eq('following_id', me).order('created_at', { ascending: false }),
        supabase.from('follows').select(`following:profiles!follows_following_id_fkey(${PROFILE_COLS})`).eq('follower_id', me).order('created_at', { ascending: false }),
      ]);
      if (a.error) throw new Error(a.error.message);
      if (b.error) throw new Error(b.error.message);
      const fr = (a.data as unknown as FollowRow[]).map((r) => r.follower).filter((p): p is Person => !!p);
      const fg = (b.data as unknown as FollowRow[]).map((r) => r.following).filter((p): p is Person => !!p);
      setFollowers(fr);
      setFollowing(fg);
      setFollowingIds(new Set(fg.map((p) => p.id)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load people');
    } finally {
      setLoading(false);
    }
  }, [me]);

  useEffect(() => {
    // Start after the effect returns (load only sets state once its queries resolve).
    let alive = true;
    void Promise.resolve().then(() => (alive ? load() : undefined));
    return () => {
      alive = false;
    };
  }, [load]);

  const retry = () => {
    setLoading(true);
    setError(null);
    void load();
  };

  useEffect(() => {
    if (!q || !me) return;
    let alive = true;
    supabase
      .from('profiles')
      .select(PROFILE_COLS)
      .or(`display_name.ilike.%${q}%,username.ilike.%${q}%`)
      .neq('id', me)
      .limit(25)
      .then(
        ({ data, error: e }) => {
          if (!alive) return;
          if (e) setNote(e.message);
          const list = e ? [] : ((data ?? []) as Person[]);
          setFound({ key: q, list });
          if (me && list.length) {
            void myPendingRequestIds(me, list.map((x) => x.id)).then((ids) => {
              if (alive) setRequestedIds((prev) => new Set([...prev, ...ids]));
            });
          }
        },
        (e: unknown) => {
          if (!alive) return;
          setNote(friendlySocialError(e, 'Search failed. Check your connection.'));
          setFound({ key: q, list: [] });
        },
      );
    return () => {
      alive = false;
    };
  }, [q, me]);

  const toggleFollow = async (p: Person) => {
    if (!me) return;
    setNote(null);
    const was = followingIds.has(p.id);
    const wasRequested = requestedIds.has(p.id);
    try {
      if (wasRequested) {
        // Withdraw a pending request.
        await cancelFollowRequest(me, p.id);
        setRequestedIds((prev) => {
          const n = new Set(prev);
          n.delete(p.id);
          return n;
        });
        flash('Request withdrawn');
      } else if (was) {
        const next = new Set(followingIds);
        next.delete(p.id);
        setFollowingIds(next);
        setFollowing((list) => list.filter((x) => x.id !== p.id));
        const { error: e } = await supabase.from('follows').delete().eq('follower_id', me).eq('following_id', p.id);
        if (e) throw e;
        flash(FLASH.unfollowed);
      } else {
        // A private profile only gets a request until they accept.
        const outcome = await followUser(p.id);
        if (outcome === 'requested') {
          setRequestedIds((prev) => new Set(prev).add(p.id));
          flash('Follow request sent');
        } else {
          setFollowingIds((prev) => new Set(prev).add(p.id));
          setFollowing((list) => [p, ...list.filter((x) => x.id !== p.id)]);
          flash(`${FLASH.followed} ${p.display_name ?? ''}`.trim());
        }
      }
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not update follow'));
      void load();
    }
  };

  const openChat = async (p: Person) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const { id, request } = await startChat(p.id);
      if (request) flash('Sent as a request');
      router.push({ pathname: '/chat-pro', params: { id, ...chatPeerParams(p) } });
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not start a conversation'));
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    setPulling(true);
    await load();
    setPulling(false);
  };

  const toggleBlock = async (p: Person) => {
    if (blockBusy) return;
    setBlockBusy(p.id);
    setNote(null);
    try {
      if (blocked.has(p.id)) {
        await unblock(p.id, p.display_name);
      } else if (await block(p.id, p.display_name)) {
        // block_user also removed follows both ways.
        setFollowers((l) => l.filter((x) => x.id !== p.id));
        setFollowing((l) => l.filter((x) => x.id !== p.id));
        setFollowingIds((ids) => {
          const next = new Set(ids);
          next.delete(p.id);
          return next;
        });
        setSelected(null);
      }
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not update block'));
    } finally {
      setBlockBusy(null);
    }
  };

  // People you blocked never show in your follower lists (search still finds them, marked Blocked).
  const shownFollowers = useMemo(() => followers.filter((p) => !blocked.has(p.id)), [followers, blocked]);
  const shownFollowing = useMemo(() => following.filter((p) => !blocked.has(p.id)), [following, blocked]);
  const followerIds = useMemo(() => new Set(shownFollowers.map((p) => p.id)), [shownFollowers]);
  const list = results ?? (tab === 0 ? shownFollowers : shownFollowing);
  const listIds = list.map((p) => p.id).join(',');
  const arts = useAsync(() => loadAvatarArts(listIds ? listIds.split(',') : []), [listIds], 'app/followers:209').data ?? NO_ARTS;

  return (
    <Screen
      backdrop={{ pattern: 'dots', mesh: 'rose' }}
      top={4}
      gap={20}
      refreshControl={me ? <RefreshControl refreshing={pulling} onRefresh={() => void onRefresh()} tintColor={colors.accent} colors={[colors.accent]} progressBackgroundColor={colors.bgTertiary} /> : undefined}
    >
      <ScreenHeader title={profile?.display_name ?? 'People'} />
      {me && requestCount > 0 ? (
        <ListRow
          title={`Follow requests · ${requestCount}`}
          subtitle="People waiting for you to accept"
          onPress={() => router.push('/follow-requests')}
          leading={<Icon name="users" size={22} color={colors.accent} />}
          right={<Icon name="chevronRight" size={18} color={colors.textSecondary} />}
        />
      ) : null}
      {!me ? <EmptyState icon="users" title="Sign in to see your people" body="Followers, following and people search need an account." action="Sign in" href="/login" /> : null}
      <Segmented options={[`Followers ${shownFollowers.length}`, `Following ${shownFollowing.length}`]} initial={startTab} onChange={(i) => setTab(i)} />

      <Glass radius={24} style={{ height: 48 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 14 }}>
        <Icon name="search" size={20} color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Find people"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Find people"
          autoCapitalize="none"
          autoCorrect={false}
          style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 16 }}
        />
        {query ? (
          <Tap onPress={() => setQuery('')} accessibilityLabel="Clear search" hitSlop={12}>
            <Icon name="close" size={18} color={colors.textSecondary} />
          </Tap>
        ) : null}
      </View>
      </Glass>

      {note ? (
        <Tap onPress={() => setNote(null)}>
          <T size={13} color={colors.error} align="center">
            {note}
          </T>
        </Tap>
      ) : null}

      {!me ? null : loading && !results ? (
        <Loading />
      ) : error && !results ? (
        <ErrorState message={error} onRetry={retry} />
      ) : searching && !results ? (
        <Loading label="Searching" />
      ) : list.length === 0 ? (
        results ? (
          <EmptyState icon="search" title="No one found" body={`No listeners match “${query.trim()}”.`} />
        ) : tab === 0 ? (
          <EmptyState icon="users" title="No followers yet" body="Share your profile and listening rooms so friends can find you." />
        ) : (
          <EmptyState icon="users" title="Not following anyone" body="Search for friends above to see what they're playing." />
        )
      ) : (
        <Glass padding={4}>
          {list.map((p, i) => (
            <View key={`${results ? 's' : tab}-${p.id}`}>
              <ListRow
                divider={i > 0}
                minHeight={64}
                title={p.display_name}
                subtitle={[p.username ? `@${p.username}` : null, blocked.has(p.id) ? 'Blocked' : followerIds.has(p.id) ? 'Follows you' : null].filter(Boolean).join(' · ') || undefined}
                onPress={() => setSelected((s) => (s === p.id ? null : p.id))}
                leading={
                  <Tap
                    accessibilityLabel={`Open ${p.display_name}'s profile`}
                    onPress={() => router.push({ pathname: '/public-profile', params: { id: p.id } })}
                  >
                    <PersonAvatar id={p.id} name={p.display_name} uri={p.avatar_url} preset={arts.get(p.id)} size={48} />
                  </Tap>
                }
                right={blocked.has(p.id) ? false : <FollowButton name={p.display_name} on={followingIds.has(p.id)} requested={requestedIds.has(p.id)} onPress={() => void toggleFollow(p)} />}
              />
              {selected === p.id ? (
                <View style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}>
                  <Button
                    label="View profile"
                    icon="user"
                    variant="glass"
                    height={40}
                    onPress={() => router.push({ pathname: '/public-profile', params: { id: p.id } })}
                  />
                  {blocked.has(p.id) ? null : (
                    <Row gap={8}>
                      <Button label={busy ? 'Opening…' : 'Message'} icon="mail" variant="glass" height={40} style={{ flex: 1 }} onPress={() => void openChat(p)} />
                      <Button
                        label="Taste match"
                        icon="heart"
                        variant="glass"
                        height={40}
                        style={{ flex: 1 }}
                        onPress={() => router.push({ pathname: '/taste-compare', params: { user: p.id } })}
                      />
                    </Row>
                  )}
                  <Button
                    label={blockBusy === p.id ? 'Working…' : blocked.has(p.id) ? `Unblock ${p.display_name}` : `Block ${p.display_name}`}
                    variant={blockBusy === p.id ? 'disabled' : blocked.has(p.id) ? 'secondary' : 'destructive'}
                    height={40}
                    onPress={() => void toggleBlock(p)}
                  />
                </View>
              ) : null}
            </View>
          ))}
        </Glass>
      )}
    </Screen>
  );
}
