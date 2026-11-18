import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Cover, EmptyState, ErrorState, Gradient, Icon, Loading, SongPicker, T, Tap, flash, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { chatPeerParams, sendChatMessage } from '../lib/chat';
import { startChat } from '../lib/dm';
import { profileShareUrl, shareContent } from '../lib/share-links';
import { deleteStory, loadStoryGroups, loadStoryLikes, loadStoryStats, markStoryViewed, postStory, setStoryLiked, storyAge, type Story, type StoryGroup } from '../lib/stories';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

const STORY_MS = 5000;

/**
 * Stories (`/stories?user=<id>[&compose=1]`): full-screen 24-hour stories from people you follow and your own.
 * Tap the right side for next, the left for back, hold to pause. Reply sends a chat message, like and share
 * work, and your own stories show views, likes and Delete. The composer posts a story (text + optional song).
 */
export default function Stories() {
  const params = useLocalSearchParams<{ user?: string; compose?: string }>();
  const { user } = useAuth();
  const me = user?.id;
  const insets = useSafeAreaInsets();
  const res = useAsync<StoryGroup[]>(() => (me ? loadStoryGroups(me) : Promise.resolve([])), [me]);
  const [nonce, setNonce] = useState(0);
  const [composing, setComposing] = useState(params.compose === '1');
  const close = useCallback(() => (router.canGoBack() ? router.back() : router.replace('/')), []);

  const composer = (
    <Composer
      visible={composing}
      onClose={() => setComposing(false)}
      onPosted={async () => {
        setComposing(false);
        await res.reload();
        setNonce((n) => n + 1);
        flash('Story posted for 24 hours');
      }}
    />
  );

  if ((res.loading && !res.data) || !me) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 24, paddingHorizontal: 16 }}>
        <Loading />
      </View>
    );
  }
  if (res.error) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 24, paddingHorizontal: 16 }}>
        <ErrorState message={res.error} onRetry={res.reload} />
      </View>
    );
  }
  const groups = res.data ?? [];
  if (!groups.length) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top + 12, paddingHorizontal: 16, gap: 16 }}>
        <Tap onPress={close} accessibilityLabel="Close" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={22} color={colors.text} />
        </Tap>
        <EmptyState icon="users" title="No stories right now" body="Stories from people you follow show up here for 24 hours. Post one of your own." />
        <Button label="Post a story" icon="plus" onPress={() => setComposing(true)} />
        {composer}
      </View>
    );
  }
  return (
    <>
      <Viewer key={nonce} groups={groups} me={me} startUser={typeof params.user === 'string' ? params.user : undefined} close={close} onAdd={() => setComposing(true)} onChanged={async () => (await res.reload(), setNonce((n) => n + 1))} paused={composing} />
      {composer}
    </>
  );
}

function Viewer({ groups, me, startUser, close, onAdd, onChanged, paused }: { groups: StoryGroup[]; me: string; startUser?: string; close: () => void; onAdd: () => void; onChanged: () => Promise<void>; paused: boolean }) {
  const [pos, setPos] = useState(() => {
    const want = startUser ? groups.findIndex((g) => g.author.id === startUser) : -1;
    return { gi: want >= 0 ? want : Math.max(0, groups.findIndex((g) => !g.seen && !g.mine)), si: 0 };
  });
  const group = groups[pos.gi];
  const story = group?.stories[pos.si];

  const next = useCallback(() => {
    setPos((p) => {
      const g = groups[p.gi];
      if (g && p.si < g.stories.length - 1) return { gi: p.gi, si: p.si + 1 };
      if (p.gi < groups.length - 1) return { gi: p.gi + 1, si: 0 };
      queueMicrotask(close);
      return p;
    });
  }, [groups, close]);
  const prev = useCallback(() => {
    setPos((p) => (p.si > 0 ? { gi: p.gi, si: p.si - 1 } : p.gi > 0 ? { gi: p.gi - 1, si: 0 } : p));
  }, []);

  if (!group || !story) return null;
  return <Frame key={story.id} group={group} story={story} index={pos.si} me={me} next={next} prev={prev} close={close} onAdd={onAdd} onChanged={onChanged} externalPause={paused} />;
}

function Frame({ group, story, index, me, next, prev, close, onAdd, onChanged, externalPause }: { group: StoryGroup; story: Story; index: number; me: string; next: () => void; prev: () => void; close: () => void; onAdd: () => void; onChanged: () => Promise<void>; externalPause: boolean }) {
  const insets = useSafeAreaInsets();
  const { width: W } = useWindowDimensions();
  const mine = group.mine;
  const [held, setHeld] = useState(false);
  const [typing, setTyping] = useState(false);
  const [liked, setLiked] = useState(false);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [stats, setStats] = useState<{ views: number; likes: number } | null>(null);
  const [prog] = useState(() => new Animated.Value(0));
  const paused = held || typing || externalPause;

  useEffect(() => {
    let on = true;
    if (!mine) void markStoryViewed(story.id).catch(() => undefined);
    else void loadStoryStats(story.id).then((s) => on && setStats(s)).catch(() => undefined);
    void loadStoryLikes([story.id], me).then((s) => on && setLiked(s.has(story.id)));
    return () => {
      on = false;
    };
  }, [story.id, me, mine]);

  // Timer: runs while not paused (resumes from where it stopped); finishing advances.
  useEffect(() => {
    if (paused) return;
    let cur = 0;
    const id = prog.addListener(({ value }) => (cur = value));
    // addListener only fires on change, so read the resting value once.
    cur = (prog as unknown as { __getValue: () => number }).__getValue();
    const anim = Animated.timing(prog, { toValue: 1, duration: Math.max(200, STORY_MS * (1 - cur)), easing: Easing.linear, useNativeDriver: false });
    anim.start(({ finished }) => finished && next());
    return () => {
      prog.removeListener(id);
      anim.stop();
    };
  }, [paused, next, prog]);

  const toggleLike = async () => {
    const on = !liked;
    setLiked(on);
    try {
      await setStoryLiked(story.id, me, on);
    } catch {
      setLiked(!on);
      flash('Could not update your like');
    }
  };

  const share = async () => {
    await shareContent({ url: profileShareUrl({ id: group.author.id }), title: `${group.author.display_name} on Zoyra`, message: `${group.author.display_name} on Zoyra: “${story.body.slice(0, 80)}”` }).catch(() => undefined);
  };

  const sendReply = async () => {
    const text = reply.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const { id } = await startChat(group.author.id);
      await sendChatMessage(id, `Replying to your story: “${story.body.slice(0, 80)}”\n${text}`);
      setReply('');
      setTyping(false);
      flash('Reply sent');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not send your reply');
    } finally {
      setSending(false);
    }
  };

  const openChat = async () => {
    try {
      const { id } = await startChat(group.author.id);
      router.push({ pathname: '/chat-pro', params: { id, ...chatPeerParams(group.author) } });
    } catch {
      flash('Could not open the chat');
    }
  };

  const remove = async () => {
    try {
      await deleteStory(story.id);
      flash('Story deleted');
      await onChanged();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not delete the story');
    }
  };

  const round = { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.12) } as const;
  return (
    <View style={{ flex: 1, backgroundColor: '#050505' }}>
      {story.track ? <Cover artwork={story.track.artwork} id={story.track.id} width={W} height={Math.round(W * 2.1)} radius={0} style={{ position: 'absolute', top: 0, left: 0, opacity: 0.55 }} /> : null}
      <Gradient colors={[withAlpha(colors.accent, 0.5), '#050505', '#050505']} angle={180} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: story.track ? 0.75 : 1 }} />

      {/* Tap zones: left = back, right = next, hold = pause. */}
      <View style={{ position: 'absolute', top: insets.top + 90, left: 0, right: 0, bottom: 200, flexDirection: 'row' }}>
        <Pressable accessibilityLabel="Previous story" onPress={prev} onPressIn={() => setHeld(true)} onPressOut={() => setHeld(false)} style={{ flex: 1 }} />
        <Pressable accessibilityLabel="Next story" onPress={next} onPressIn={() => setHeld(true)} onPressOut={() => setHeld(false)} style={{ flex: 2 }} />
      </View>

      <View pointerEvents="box-none" style={{ flex: 1, paddingTop: insets.top + 8, paddingHorizontal: 16 }}>
        <View accessibilityLabel={`Story ${index + 1} of ${group.stories.length}`} style={{ flexDirection: 'row', gap: 4 }}>
          {group.stories.map((s, i) => (
            <View key={s.id} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: withAlpha(colors.white, 0.28), overflow: 'hidden' }}>
              <Animated.View style={{ height: 3, backgroundColor: colors.white, width: i < index ? '100%' : i === index ? prog.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '0%' }} />
            </View>
          ))}
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <Cover uri={group.author.avatar_url} id={group.author.id} size={40} radius={20} style={{ alignItems: 'center', justifyContent: 'center' }}>
            {group.author.avatar_url ? null : (
              <T size={15} weight={600} color={colors.white}>
                {(group.author.display_name[0] ?? '?').toUpperCase()}
              </T>
            )}
          </Cover>
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {mine ? 'Your story' : group.author.display_name}
            </T>
            <T size={12} color={withAlpha(colors.white, 0.7)}>{`Story · ${storyAge(story.created_at)}`}</T>
          </View>
          {mine ? (
            <Tap onPress={onAdd} accessibilityLabel="Add to your story" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" size={22} color={colors.white} />
            </Tap>
          ) : null}
          <Tap onPress={close} accessibilityLabel="Close" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.12) }}>
            <Icon name="close" size={20} color={colors.white} />
          </Tap>
        </View>

        <View pointerEvents="none" style={{ flex: 1, justifyContent: 'flex-end', paddingBottom: 16, gap: 10 }}>
          {story.kicker ? (
            <T variant="overline" color={colors.accentLight}>
              {story.kicker.toUpperCase()}
            </T>
          ) : null}
          <T style={{ fontFamily: fonts.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.5 }}>{story.body}</T>
          {story.track ? (
            <T size={13} color={withAlpha(colors.white, 0.75)} numberOfLines={1}>{`♪ ${story.track.title} · ${story.track.artist.name}`}</T>
          ) : null}
        </View>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 12 }}>
        {mine ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, minHeight: 48, borderRadius: 24, paddingHorizontal: 18, justifyContent: 'center', borderWidth: 1, borderColor: withAlpha(colors.white, 0.3) }}>
              <T size={14} color={withAlpha(colors.white, 0.85)}>
                {stats ? `${stats.views} ${stats.views === 1 ? 'view' : 'views'} · ${stats.likes} ${stats.likes === 1 ? 'like' : 'likes'}` : 'Counting views…'}
              </T>
            </View>
            <Tap onPress={() => void remove()} accessibilityLabel="Delete story" style={round}>
              <Icon name="trash" size={20} color={colors.white} />
            </Tap>
            <Tap onPress={() => void share()} accessibilityLabel="Share" style={round}>
              <Icon name="share" size={20} color={colors.white} />
            </Tap>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <TextInput
              value={reply}
              onChangeText={setReply}
              onFocus={() => setTyping(true)}
              onBlur={() => setTyping(false)}
              onSubmitEditing={() => void sendReply()}
              placeholder="Send a message"
              placeholderTextColor={withAlpha(colors.white, 0.6)}
              returnKeyType="send"
              maxLength={500}
              accessibilityLabel="Reply to this story"
              style={{ flex: 1, minHeight: 48, borderRadius: 24, paddingHorizontal: 18, color: colors.white, fontFamily: fonts.regular, fontSize: 15, borderWidth: 1, borderColor: withAlpha(colors.white, 0.35) }}
            />
            {reply.trim() ? (
              <Tap onPress={() => void sendReply()} accessibilityLabel="Send reply" style={[round, { backgroundColor: colors.accent }]}>
                <Icon name="send" size={20} color={colors.white} />
              </Tap>
            ) : (
              <>
                <Tap onPress={() => void toggleLike()} accessibilityLabel={liked ? 'Unlike' : 'Like'} accessibilityState={{ selected: liked }} style={round}>
                  <Icon name="heart" size={22} color={liked ? colors.like : colors.white} />
                </Tap>
                <Tap onPress={() => void share()} accessibilityLabel="Share" style={round}>
                  <Icon name="share" size={20} color={colors.white} />
                </Tap>
                <Tap onPress={() => void openChat()} accessibilityLabel="Open chat" style={round}>
                  <Icon name="chat" size={20} color={colors.white} />
                </Tap>
              </>
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

function Composer({ visible, onClose, onPosted }: { visible: boolean; onClose: () => void; onPosted: () => Promise<void> }) {
  const insets = useSafeAreaInsets();
  const [kicker, setKicker] = useState('');
  const [body, setBody] = useState('');
  const [track, setTrack] = useState<CatalogTrack | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postStory({ kicker, body, track });
      setKicker('');
      setBody('');
      setTrack(null);
      setPicking(false);
      await onPosted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post your story');
    } finally {
      setBusy(false);
    }
  };

  const input = { borderRadius: 20, paddingHorizontal: 16, color: colors.text, fontFamily: fonts.regular, fontSize: 16, backgroundColor: colors.bgTertiary } as const;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, backgroundColor: colors.scrim }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ maxHeight: '88%', padding: 16, paddingBottom: insets.bottom + 16, gap: 12, borderTopLeftRadius: 32, borderTopRightRadius: 32, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.glassBorder }}>
          <T variant="section" accessibilityRole="header">
            New story
          </T>
          <T size={13} color={colors.textSecondary} style={{ marginTop: -6 }}>
            People who follow you can see it for 24 hours.
          </T>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <TextInput value={kicker} onChangeText={setKicker} maxLength={32} placeholder="Label, e.g. Behind the song" placeholderTextColor={colors.textTertiary} accessibilityLabel="Story label" style={[input, { height: 48 }]} />
            <TextInput value={body} onChangeText={setBody} maxLength={280} multiline placeholder="What do you want to say?" placeholderTextColor={colors.textTertiary} accessibilityLabel="Story text" style={[input, { minHeight: 110, paddingTop: 14, textAlignVertical: 'top' }]} />
            <T size={12} color={colors.textTertiary} align="right">{`${body.length}/280`}</T>
            {track ? (
              <Tap onPress={() => setTrack(null)} accessibilityLabel={`Remove ${track.title}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Cover artwork={track.artwork} id={track.id} size={44} radius={12} />
                  <T size={14} numberOfLines={1} style={{ flex: 1 }}>{`${track.title} · ${track.artist.name}`}</T>
                  <Icon name="close" size={18} color={colors.textSecondary} />
                </View>
              </Tap>
            ) : (
              <Button label={picking ? 'Hide songs' : 'Add a song'} icon="music" variant="secondary" onPress={() => setPicking((p) => !p)} />
            )}
            {picking && !track ? <SongPicker onPick={(t) => (setTrack(t), setPicking(false))} maxHeight={280} /> : null}
          </ScrollView>
          {error ? (
            <T size={13} color={colors.error} accessibilityRole="alert">
              {error}
            </T>
          ) : null}
          <Button label={busy ? 'Posting…' : 'Post story'} variant={busy || !body.trim() ? 'disabled' : 'primary'} onPress={() => void post()} />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
