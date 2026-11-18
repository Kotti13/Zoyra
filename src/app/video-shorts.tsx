import { router, useIsFocused, useLocalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, View, type LayoutChangeEvent } from 'react-native';
import type { YoutubeIframeRef } from 'react-native-youtube-iframe';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';

import { Button, Chip, EmptyState, ErrorState, Icon, IconButton, Loading, PopRing, Row, T, Tap, useAsync, usePop } from '../components';
import { ChannelAvatar, playerErrorText, useVideoAutoStart, VideoFrame } from '../lib/video-ui';
import {
  compactCount,
  fetchShorts,
  fetchUploads,
  listFollowedChannels,
  listSavedVideos,
  openOnYouTube,
  setChannelFollowed,
  setVideoSaved,
  shareVideo,
  useVideoBus,
  videoBus,
  youtubeErrorMessage,
  type YouTubeVideo,
} from '../lib/youtube';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

type Tab = 'following' | 'foryou';
const INFO_H = 150;
/** Must be a stable object: FlatList throws if viewabilityConfig changes between renders. */
const VIEWABILITY = { itemVisiblePercentThreshold: 60 };
const OUR_SHEETS = new Set(['/video-comments', '/video-options']);

/**
 * VideoShorts. A vertical pager of embeddable music shorts (≤ 3 min). Only the visible item mounts
 * YouTube's IFrame player; the rest show thumbnails. Stats sit under the player, never over it.
 * "Following" = recent shorts from channels followed in Zoyra (followed_channels).
 */
export default function VideoShorts() {
  const params = useLocalSearchParams<{ start?: string; index?: string }>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const me = user?.id;
  const audio = usePlayerPick('playing');
  const bus = useVideoBus();
  const focused = useIsFocused();
  const pathname = usePathname();
  const active = focused || OUR_SHEETS.has(pathname);

  const [tab, setTab] = useState<Tab>('foryou');
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [visible, setVisible] = useState(Math.max(0, Number(params.index) || 0));
  const [paused, setPaused] = useState(false);
  /**
   * Settings › Video: "Autoplay shorts on scroll" and "Wi-Fi only previews". When auto-start isn't
   * allowed, a short plays only after the user starts it (YouTube's play button, a tap, or a seek).
   */
  const autoStart = useVideoAutoStart('shorts');
  const [manual, setManual] = useState(false);
  const visibleRef = useRef(visible);
  /** YouTube's real player state for the current short ('playing', 'paused', 'buffering', 'unstarted', 'ended', …). */
  const [ytState, setYtState] = useState('unstarted');
  const [note, setNote] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ref = useRef<YoutubeIframeRef>(null);

  // For you: music shorts search, paged.
  const [more, setMore] = useState<YouTubeVideo[]>([]);
  const [token, setToken] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const forYou = useAsync(async () => {
    const page = await fetchShorts().catch((e: unknown) => {
      throw new Error(youtubeErrorMessage(e));
    });
    setToken(page.nextPageToken);
    return page.videos;
  }, []);

  const followed = useAsync(() => (me ? listFollowedChannels(me) : Promise.resolve([])), [me]);
  const followedIds = useMemo(() => new Set((followed.data ?? []).map((c) => c.id)), [followed.data]);
  const followingFeed = useAsync(
    () =>
      tab === 'following' && followed.data?.length
        ? fetchUploads(followed.data.map((c) => c.id).slice(0, 10), true)
            .then((p) => p.videos)
            .catch((e: unknown) => {
              throw new Error(youtubeErrorMessage(e));
            })
        : Promise.resolve<YouTubeVideo[]>([]),
    [tab, followed.data],
  );

  const saved = useAsync(() => (me ? listSavedVideos(me) : Promise.resolve([])), [me]);
  const savedIds = useMemo(() => new Set((saved.data ?? []).map((v) => v.id)), [saved.data]);

  const items = useMemo(() => {
    if (tab === 'following') return followingFeed.data ?? [];
    const first = forYou.data ?? [];
    return [...first, ...more.filter((v) => !first.some((x) => x.id === v.id))];
  }, [tab, followingFeed.data, forYou.data, more]);
  const current = items[visible];

  const loadMore = async () => {
    if (tab !== 'foryou' || !token || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchShorts(undefined, token);
      setMore((m) => [...m, ...page.videos]);
      setToken(page.nextPageToken);
    } catch (e) {
      setNote(youtubeErrorMessage(e, 'Could not load more shorts'));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    if (current) videoBus.set({ videoId: current.id });
  }, [current]);

  // Timestamp tapped in the comments sheet for the visible short.
  const currentId = current?.id;
  useEffect(() => {
    let seen = videoBus.get().seek?.n ?? 0;
    return videoBus.subscribe(() => {
      const s = videoBus.get().seek;
      if (!s || s.n === seen) return;
      seen = s.n;
      if (s.videoId !== currentId) return;
      ref.current?.seekTo(s.seconds, true);
      setPaused(false);
      setManual(true);
    });
  }, [currentId]);

  const onViewable = useCallback(({ viewableItems }: { viewableItems: { index?: number | null; isViewable: boolean }[] }) => {
    const first = viewableItems.find((v) => v.isViewable);
    if (first?.index !== null && first?.index !== undefined) {
      if (first.index !== visibleRef.current) setManual(false);
      visibleRef.current = first.index;
      setVisible(first.index);
      setYtState('unstarted');
      setPaused(false);
    }
  }, []);

  const onState = useCallback(
    (s: string) => {
      setYtState(s);
      if (s === 'playing') {
        setPaused(false);
        setManual(true);
        if (audio.playing) audio.pause();
      } else if (s === 'paused') setPaused(true);
    },
    [audio],
  );

  const toggleSave = async (v: YouTubeVideo) => {
    if (!me) return setNote('Sign in to save videos.');
    try {
      await setVideoSaved(me, v, !savedIds.has(v.id));
      saved.reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not update My list');
    }
  };

  const toggleFollow = async (v: YouTubeVideo) => {
    if (!v.channelId) return;
    if (!me) return setNote('Sign in to follow channels.');
    try {
      await setChannelFollowed(me, { id: v.channelId, title: v.channel, thumbnail: null }, !followedIds.has(v.channelId));
      followed.reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not update following');
    }
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    visibleRef.current = 0;
    setManual(false);
    setVisible(0);
  };

  const loading = tab === 'foryou' ? forYou.loading : followed.loading || followingFeed.loading;
  const error = tab === 'foryou' ? forYou.error : (followed.error ?? followingFeed.error);
  const startIndex = tab === 'foryou' && params.start ? Math.max(0, items.findIndex((v) => v.id === params.start)) : 0;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    if (!size || size.w !== w || size.h !== h) setSize({ w, h });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.black, paddingTop: insets.top }}>
      <Row gap={4} style={{ height: 52, paddingHorizontal: 8 }}>
        <IconButton icon="back" label="Back" href="back" />
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 4 }}>
          <Chip label="Following" active={tab === 'following'} onPress={() => switchTab('following')} />
          <Chip label="For you" active={tab === 'foryou'} onPress={() => switchTab('foryou')} />
        </View>
        <View style={{ width: 44 }} />
      </Row>
      {autoStart.reason && !manual && !note ? (
        <T size={12} color={colors.textSecondary} style={{ paddingHorizontal: 16, paddingVertical: 4 }} accessibilityLiveRegion="polite">
          {autoStart.reason}
        </T>
      ) : null}
      {note ? (
        <Tap onPress={() => setNote(null)} accessibilityLabel={`${note}. Dismiss`} style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
          <T size={13} color={colors.amber}>
            {note}
          </T>
        </Tap>
      ) : null}

      <View style={{ flex: 1 }} onLayout={onLayout}>
        {loading ? (
          <Loading label="Loading shorts" />
        ) : error ? (
          <ErrorState message={error} onRetry={tab === 'foryou' ? forYou.reload : followingFeed.reload} />
        ) : tab === 'following' && !me ? (
          <EmptyState icon="users" title="Sign in to follow channels" action="Sign in" href="/login" />
        ) : tab === 'following' && !followed.data?.length ? (
          <EmptyState icon="users" title="You don't follow any channels yet" body="Tap Follow on a short or on a video's channel, and their latest shorts show up here." action="Browse For you" onAction={() => switchTab('foryou')} />
        ) : !items.length ? (
          <EmptyState
            icon="search"
            title="No shorts here yet"
            body={tab === 'following' ? 'The channels you follow have not posted short music videos recently.' : 'YouTube returned no music shorts right now.'}
          />
        ) : size ? (
          <FlatList
            key={tab}
            data={items}
            keyExtractor={(v) => v.id}
            pagingEnabled
            showsVerticalScrollIndicator={false}
            decelerationRate="fast"
            getItemLayout={(_d, i) => ({ length: size.h, offset: size.h * i, index: i })}
            initialScrollIndex={Math.min(startIndex || visible, items.length - 1)}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={VIEWABILITY}
            onEndReached={() => void loadMore()}
            onEndReachedThreshold={2}
            windowSize={3}
            initialNumToRender={2}
            maxToRenderPerBatch={2}
            ListFooterComponent={loadingMore ? <Loading height={60} /> : undefined}
            renderItem={({ item, index }) => {
              const playerH = size.h - INFO_H;
              const isCurrent = index === visible;
              return (
                <View style={{ width: size.w, height: size.h }}>
                  <View style={{ width: size.w, height: playerH, backgroundColor: colors.black, overflow: 'hidden' }}>
                    {/* Poster fills the whole frame (shorts are vertical); the player sits on top once this short is current. */}
                    {item.thumbnail ? (
                      <Image source={{ uri: item.thumbnail }} style={{ position: 'absolute', width: size.w, height: playerH }} contentFit="cover" accessibilityIgnoresInvertColors />
                    ) : null}
                    {isCurrent ? (
                      // The WebView would swallow vertical drags and trap the pager on one short, so it gets no touches;
                      // tapping the video toggles play/pause through the player API instead. Nothing is drawn over the video.
                      <View pointerEvents={ytState === 'playing' || ytState === 'buffering' ? 'none' : 'auto'} style={{ position: 'absolute', width: size.w, height: playerH }}>
                        <VideoFrame
                          ref={ref}
                          key={item.id}
                          videoId={item.id}
                          width={size.w}
                          height={playerH}
                          fill
                          hideControls
                          captions={bus.captions}
                          rate={bus.rate}
                          play={active && !paused && (autoStart.allowed || manual)}
                          loop
                          onState={onState}
                          onError={(e) => setErrors((m) => ({ ...m, [item.id]: playerErrorText(e) }))}
                        />
                      </View>
                    ) : null}
                    {isCurrent && ytState !== 'playing' && ytState !== 'buffering' ? (
                      // App play button. It ignores touches so the tap reaches YouTube's player underneath:
                      // a real tap is what lets the video start where autoplay is blocked.
                      <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, width: size.w, height: playerH, alignItems: 'center', justifyContent: 'center' }}>
                        <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon name="play" size={34} color={colors.white} filled />
                        </View>
                      </View>
                    ) : null}
                    {!isCurrent || ytState === 'playing' || ytState === 'buffering' ? (
                    <Tap
                      onPress={() => {
                        if (isCurrent) return setPaused((p) => !p);
                        visibleRef.current = index;
                        setManual(true);
                        setVisible(index);
                      }}
                      accessibilityLabel={isCurrent ? (paused ? `Play ${item.title}` : `Pause ${item.title}`) : `Play ${item.title}`}
                      style={{ position: 'absolute', top: 0, left: 0, width: size.w, height: playerH, alignItems: 'center', justifyContent: 'center' }}
                    >
                      {!isCurrent ? (
                        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon name="play" size={30} color={colors.white} filled />
                        </View>
                      ) : null}
                    </Tap>
                    ) : null}
                  </View>
                  <ShortInfo
                    video={item}
                    error={errors[item.id]}
                    saved={savedIds.has(item.id)}
                    following={!!item.channelId && followedIds.has(item.channelId)}
                    onSave={() => void toggleSave(item)}
                    onFollow={() => void toggleFollow(item)}
                    onShare={() => void shareVideo(item).catch(() => setNote('Could not open the share sheet.'))}
                    onComments={() => router.push({ pathname: '/video-comments', params: { id: item.id, d: String(item.durationSec ?? 0) } })}
                    onYouTube={() => void openOnYouTube(item.id).then((ok) => !ok && setNote('Could not open YouTube.'))}
                  />
                </View>
              );
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function ShortInfo({
  video,
  error,
  saved,
  following,
  onSave,
  onFollow,
  onShare,
  onComments,
  onYouTube,
}: {
  video: YouTubeVideo;
  error?: string;
  saved: boolean;
  following: boolean;
  onSave: () => void;
  onFollow: () => void;
  onShare: () => void;
  onComments: () => void;
  onYouTube: () => void;
}) {
  return (
    <View style={{ height: INFO_H, paddingHorizontal: 16, paddingTop: 10, gap: 8 }}>
      <Row gap={10}>
        <ChannelAvatar name={video.channel} uri={null} size={32} />
        <T size={14} weight={600} numberOfLines={1} style={{ flex: 1 }}>
          {video.channel}
        </T>
        {video.channelId ? <Button label={following ? 'Following' : 'Follow'} variant={following ? 'glass' : 'light'} height={32} onPress={onFollow} /> : null}
      </Row>
      <T size={13} numberOfLines={2} lineHeight={18}>
        {error ?? video.title}
      </T>
      <Row gap={4} style={{ justifyContent: 'space-between' }}>
        <Stat icon="eye" label={video.views !== null ? compactCount(video.views) : '–'} a11y={`${video.views ?? 'Unknown'} views`} />
        <Stat icon="heart" label={video.likes !== null ? compactCount(video.likes) : '–'} a11y={`${video.likes ?? 'Unknown'} likes on YouTube`} />
        <Stat icon="mail" label={video.comments !== null ? compactCount(video.comments) : 'Comments'} a11y="Open comments" onPress={onComments} />
        <Stat icon="share" label="Share" a11y="Share short" onPress={onShare} />
        <Stat icon={saved ? 'check' : 'plus'} label={saved ? 'Saved' : 'Save'} a11y={saved ? 'Remove from My list' : 'Save to My list'} onPress={onSave} accent={saved} />
        <Stat icon="link" label="YouTube" a11y="Watch on YouTube" onPress={onYouTube} />
      </Row>
    </View>
  );
}

function Stat({ icon, label, a11y, onPress, accent }: { icon: 'eye' | 'heart' | 'mail' | 'share' | 'check' | 'plus' | 'link'; label: string; a11y: string; onPress?: () => void; accent?: boolean }) {
  const pop = usePop(accent);
  const body = (
    <View style={{ alignItems: 'center', gap: 2, minWidth: 48, minHeight: 44, justifyContent: 'center' }}>
      <PopRing active={!!accent} size={34} color={colors.accentLight} />
      <Animated.View style={{ transform: [{ scale: pop }] }}>
        <Icon name={icon} size={20} color={accent ? colors.accentLight : colors.text} />
      </Animated.View>
      <T size={11} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
  return onPress ? (
    <Tap onPress={onPress} accessibilityLabel={a11y}>
      {body}
    </Tap>
  ) : (
    <View accessible accessibilityLabel={a11y}>
      {body}
    </View>
  );
}
