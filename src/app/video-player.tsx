import { router, useFocusEffect, useIsFocused, useLocalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, useWindowDimensions, View } from 'react-native';
import type { YoutubeIframeRef } from 'react-native-youtube-iframe';

import { Image } from 'expo-image';
import { Avatar, artFor, Button, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, Toast, Toggle, useAsync, ToggleBurst } from '../components';
import { usePlayPref } from '../lib/play-prefs';
import { playerErrorText, useVideoAutoStart, VideoFrame, VideoRow } from '../lib/video-ui';
import {
  channelUrl,
  compactCount,
  fetchComments,
  fetchRelated,
  fetchVideo,
  isChannelFollowed,
  isVideoSaved,
  openOnYouTube,
  setChannelFollowed,
  setVideoSaved,
  shareVideo,
  splitTimestamps,
  timeAgo,
  useVideoBus,
  videoBus,
  videoMeta,
  YouTubeError,
  youtubeErrorMessage,
  type YouTubeComment,
} from '../lib/youtube';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, glow } from '../theme/tokens';

/** Sheets that open over this screen; the video keeps playing under them. */
const OUR_SHEETS = new Set(['/video-comments', '/video-options']);

/**
 * VideoPlayer (`/video-player?id=&t=`). YouTube's official IFrame player at the top — never covered,
 * foreground only — then real metadata from the YouTube Data API, Zoyra save/follow, comments preview
 * and Up next (a search on the title and channel).
 */
export default function VideoPlayerScreen() {
  const params = useLocalSearchParams<{ id?: string; t?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const startAt = Number(params.t) > 0 ? Number(params.t) : 0;
  const { width } = useWindowDimensions();
  const { user } = useAuth();
  const me = user?.id;
  const audio = usePlayerPick('playing', 'track');
  const bus = useVideoBus();
  const ref = useRef<YoutubeIframeRef>(null);

  // Pause when another screen covers this one (but not under our own sheets).
  const focused = useIsFocused();
  const pathname = usePathname();
  const active = focused || OUR_SHEETS.has(pathname);
  const [wantPlay, setWantPlay] = useState(true);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Settings › Video › Autoplay next (also switchable here); held back on mobile data with Wi-Fi only previews.
  const [autoplay, setAutoplay] = usePlayPref('video.autoplayNext');
  const autoNext = useVideoAutoStart('next');
  const [descOpen, setDescOpen] = useState(false);
  // Captions are a player var: changing them reloads the player at the current position.
  const [frame, setFrame] = useState({ captions: bus.captions, start: startAt, n: 0 });

  const info = useAsync(() => fetchVideo(id), [id], 'app/video-player:68');
  const video = info.data?.video;
  const channel = info.data?.channel;
  const related = useAsync(() => (video ? fetchRelated(video) : Promise.resolve({ videos: [] })), [video?.id], 'app/video-player:71');
  const preview = useAsync<{ comment: YouTubeComment | null; disabled: boolean }>(async () => {
    if (!id) return { comment: null, disabled: false };
    try {
      const page = await fetchComments(id, 'relevance');
      return { comment: page.comments[0] ?? null, disabled: false };
    } catch (e) {
      if (e instanceof YouTubeError && e.code === 'comments_disabled') return { comment: null, disabled: true };
      throw new Error(youtubeErrorMessage(e, 'Could not load comments'));
    }
  }, [id], 'app/video-player:72');

  const saved = useAsync(() => (me && id ? isVideoSaved(me, id) : Promise.resolve(false)), [me, id], 'app/video-player:83');
  const following = useAsync(() => (me && video?.channelId ? isChannelFollowed(me, video.channelId) : Promise.resolve(false)), [me, video?.channelId], 'app/video-player:84');
  const [busy, setBusy] = useState<'save' | 'follow' | null>(null);

  useEffect(() => {
    videoBus.set({ videoId: id });
  }, [id]);

  // Captions toggled in the options sheet → reload the player where it was.
  useEffect(() => {
    if (bus.captions === frame.captions) return;
    const cur = ref.current;
    (cur ? cur.getCurrentTime().catch(() => 0) : Promise.resolve(0)).then((sec) => setFrame((f) => ({ captions: bus.captions, start: sec, n: f.n + 1 })));
  }, [bus.captions, frame.captions]);

  // Timestamp tapped in the comments sheet.
  useEffect(() => {
    let seen = videoBus.get().seek?.n ?? 0;
    return videoBus.subscribe(() => {
      const s = videoBus.get().seek;
      if (!s || s.n === seen) return;
      seen = s.n;
      if (s.videoId !== id) return;
      ref.current?.seekTo(s.seconds, true);
      setWantPlay(true);
    });
  }, [id]);

  // Back from the full-screen view: continue where it left off.
  useFocusEffect(
    useCallback(() => {
      const r = videoBus.get().resume;
      if (r && r.videoId === id) {
        videoBus.set({ resume: null });
        ref.current?.seekTo(r.seconds, true);
        setWantPlay(true);
      }
    }, [id]),
  );

  const onState = useCallback(
    (s: string) => {
      if (s === 'playing') {
        setWantPlay(true);
        // One thing at a time: a starting video pauses Zoyra's audio player.
        if (audio.playing) audio.pause();
      } else if (s === 'paused') setWantPlay(false);
      else if (s === 'ended') {
        setWantPlay(false);
        const next = related.data?.videos[0];
        if (autoNext.allowed && next) router.replace({ pathname: '/video-player', params: { id: next.id } });
        else if (autoplay && next && autoNext.reason) setNote('Wi-Fi only previews is on, so the next video won’t start by itself on mobile data.');
      }
    },
    [audio, autoplay, autoNext.allowed, autoNext.reason, related.data],
  );

  const onReady = useCallback(() => {
    ref.current
      ?.getAvailablePlaybackRates()
      .then((rates) => rates.length && videoBus.set({ rates }))
      .catch(() => undefined);
  }, []);

  const openFull = async () => {
    const sec = await (ref.current?.getCurrentTime().catch(() => 0) ?? Promise.resolve(0));
    router.push({ pathname: '/video-full', params: { id, t: String(Math.floor(sec)) } });
  };

  const toggleSave = async () => {
    if (!video) return;
    if (!me) return setNote('Sign in to save videos.');
    setBusy('save');
    try {
      await setVideoSaved(me, video, !saved.data);
      saved.reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not update My list');
    } finally {
      setBusy(null);
    }
  };

  const toggleFollow = async () => {
    if (!video?.channelId) return;
    if (!me) return setNote('Sign in to follow channels.');
    setBusy('follow');
    try {
      await setChannelFollowed(me, { id: video.channelId, title: channel?.title ?? video.channel, thumbnail: channel?.thumbnail ?? null }, !following.data);
      following.reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not update following');
    } finally {
      setBusy(null);
    }
  };

  const watchOnYouTube = async () => {
    const sec = await (ref.current?.getCurrentTime().catch(() => 0) ?? Promise.resolve(0));
    setWantPlay(false);
    if (!(await openOnYouTube(id, sec))) setNote('Could not open YouTube.');
  };

  const playerH = Math.max(200, Math.round((width * 9) / 16));

  if (!id) {
    return (
      <Screen top={4}>
        <ScreenHeader title="Video" />
        <ErrorState message="No video selected." />
      </Screen>
    );
  }

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }}>
      <ScreenHeader title="" right={<IconButton icon="more" label="Video options" onPress={() => router.push({ pathname: '/video-options', params: { id } })} />} />
      {audio.track ? (
        // Song / Video switch (PlayerVideo board): Song goes back to the audio player.
        <Glass radius={22} padding={4} style={{ flexDirection: 'row', gap: 4 }}>
          <Tap
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/player'))}
            accessibilityRole="tab"
            accessibilityState={{ selected: false }}
            accessibilityLabel="Song"
            style={{ flex: 1, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }}
          >
            <T size={13} weight={600} color={colors.textSecondary}>
              Song
            </T>
          </Tap>
          <View accessibilityRole="tab" accessibilityState={{ selected: true }} style={{ flex: 1, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent }}>
            <T size={13} weight={700}>
              Video
            </T>
          </View>
        </Glass>
      ) : null}

      {/* The player: full width, nothing drawn over it. */}
      <View style={{ marginHorizontal: -16 }}>
        <VideoFrame
          key={`${id}:${frame.n}`}
          ref={ref}
          videoId={id}
          width={width}
          height={playerH}
          start={frame.start}
          captions={frame.captions}
          play={active && wantPlay}
          rate={bus.rate}
          onState={onState}
          onReady={onReady}
          onError={(e) => setPlayerError(playerErrorText(e))}
        />
      </View>
      {playerError ? <Toast icon="info" iconColor={colors.amber} message={playerError} action="YouTube" onAction={() => void watchOnYouTube()} /> : null}
      {note ? <Toast icon="info" iconColor={colors.accentLight} message={note} action="OK" onAction={() => setNote(null)} /> : null}

      {info.loading ? (
        <Loading label="Loading video details" />
      ) : info.error || !video ? (
        <ErrorState message={info.error ?? 'Could not load this video.'} onRetry={info.reload} />
      ) : (
        <>
          <View style={{ gap: 6 }}>
            <T size={22} weight={500} lineHeight={26} tracking={-0.4} accessibilityRole="header">
              {video.title}
            </T>
            <T size={13} color={colors.textSecondary}>
              {[videoMeta(video), ...video.tags.slice(0, 2).map((t) => `#${t.replace(/\s+/g, '')}`)].filter(Boolean).join(' · ')}
            </T>
          </View>

          {/* Actions */}
          <Row gap={8} style={{ flexWrap: 'wrap' }}>
            <Pill primary icon="heart" filled={!!saved.data} label={saved.data ? 'Saved' : 'Save'} busy={busy === 'save'} onPress={() => void toggleSave()} a11y={saved.data ? 'Remove from My list' : 'Save to My list'} />
            <Pill icon="share" label="Share" onPress={() => void shareVideo(video).catch(() => setNote('Could not open the share sheet.'))} a11y="Share video" />
            <Pill icon="chevronUp" label="Full screen" onPress={() => void openFull()} a11y="Watch full screen" />
            <Pill icon="link" label="Watch on YouTube" onPress={() => void watchOnYouTube()} a11y="Watch on YouTube" />
          </Row>
          {video.likes !== null ? (
            <T size={12} color={colors.textTertiary}>
              {compactCount(video.likes)} likes on YouTube
            </T>
          ) : null}

          {/* Channel */}
          <Row gap={12}>
            <Tap
              onPress={() => video.channelId && void Linking.openURL(channelUrl(video.channelId)).catch(() => setNote('Could not open YouTube.'))}
              accessibilityLabel={`${video.channel} on YouTube`}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
              <SquareAvatar name={channel?.title ?? video.channel} uri={channel?.thumbnail ?? null} size={46} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={15} weight={600} numberOfLines={1}>
                  {channel?.title ?? video.channel}
                </T>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {channel?.subscribers !== null && channel?.subscribers !== undefined ? `${compactCount(channel.subscribers)} subscribers on YouTube` : 'YouTube channel'}
                </T>
              </View>
            </Tap>
            {video.channelId ? (
              <Button
                label={following.data ? 'Following' : 'Follow'}
                variant={following.data ? 'glass' : 'light'}
                height={40}
                onPress={busy ? undefined : () => void toggleFollow()}
              />
            ) : null}
          </Row>

          {video.description ? (
            <Tap onPress={() => setDescOpen((o) => !o)} accessibilityLabel={descOpen ? 'Show less description' : 'Show full description'}>
              <Glass padding={14} radius={32}>
                <T size={13} color={colors.textSecondary} lineHeight={19} numberOfLines={descOpen ? undefined : 3}>
                  {video.description}
                </T>
                <T size={13} weight={600} color={colors.accentLight} style={{ marginTop: 6 }}>
                  {descOpen ? 'Less' : 'More'}
                </T>
              </Glass>
            </Tap>
          ) : null}

          {/* Comments preview */}
          <Tap
            onPress={() => router.push({ pathname: '/video-comments', params: { id, d: String(video.durationSec ?? 0) } })}
            accessibilityLabel="Open comments"
          >
            <Glass padding={14} radius={32} style={{ gap: 8 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T size={15} weight={600}>
                  Comments{video.comments !== null ? ` · ${compactCount(video.comments)}` : ''}
                </T>
                <Icon name="chevronDown" size={18} color={colors.textSecondary} />
              </Row>
              {preview.loading ? (
                <Loading height={40} />
              ) : preview.error ? (
                <T size={13} color={colors.textSecondary}>
                  {preview.error}
                </T>
              ) : preview.data?.disabled || video.commentsHidden ? (
                <T size={13} color={colors.textSecondary}>
                  Comments are turned off on YouTube. You can still talk about it on Zoyra.
                </T>
              ) : preview.data?.comment ? (
                <Row gap={10} align="flex-start">
                  <SquareAvatar name={preview.data.comment.author} uri={preview.data.comment.authorAvatar} size={34} />
                  <T size={13} lineHeight={19} numberOfLines={2} style={{ flex: 1 }}>
                    {splitTimestamps(preview.data.comment.text, video.durationSec).map((p, i) =>
                      p.seconds !== undefined ? (
                        <T key={i} size={13} weight={600} color={colors.accentLight}>
                          {p.text}
                        </T>
                      ) : (
                        p.text
                      ),
                    )}
                  </T>
                </Row>
              ) : (
                <T size={13} color={colors.textSecondary}>
                  No comments yet.
                </T>
              )}
            </Glass>
          </Tap>

          {/* Up next */}
          <View style={{ gap: 8 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T size={18} weight={500} accessibilityRole="header">
                Up next
              </T>
              <Row gap={4}>
                <T size={12} color={colors.textSecondary}>
                  Autoplay
                </T>
                <Toggle value={autoplay} onChange={setAutoplay} label="Autoplay next video" />
              </Row>
            </Row>
            {related.loading ? (
              <Loading height={80} />
            ) : related.error ? (
              <ErrorState message={related.error} onRetry={related.reload} />
            ) : !related.data?.videos.length ? (
              <T size={14} color={colors.textSecondary}>
                Nothing else to suggest right now.
              </T>
            ) : (
              related.data.videos.slice(0, 10).map((v) => (
                <VideoRow
                  key={v.id}
                  video={v}
                  meta={[v.channel, v.views !== null ? compactCount(v.views) : null, timeAgo(v.publishedAt) || null].filter(Boolean).join(' · ')}
                  onPress={() => router.replace({ pathname: '/video-player', params: { id: v.id } })}
                />
              ))
            )}
          </View>

          <T size={11} color={colors.textTertiary} align="center">
            Played by YouTube. Views, likes and comments are from YouTube; Save, Follow and “On Zoyra” comments stay in Zoyra.
          </T>
        </>
      )}
    </Screen>
  );
}

function Pill({ icon, label, onPress, a11y, filled, busy, primary }: { primary?: boolean; icon: 'heart' | 'share' | 'chevronUp' | 'link'; label: string; onPress: () => void; a11y: string; filled?: boolean; busy?: boolean }) {
  return (
    <Tap onPress={busy ? undefined : onPress} accessibilityLabel={a11y} accessibilityState={{ busy: !!busy }} style={{ minHeight: 44, justifyContent: 'center' }}>
      <Row
        gap={8}
        style={[
          { height: 40, paddingHorizontal: 16, borderRadius: 28, borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: colors.iconGhost, opacity: busy ? 0.6 : 1 },
          primary && filled && { backgroundColor: colors.accent, borderColor: colors.accent, ...glow(colors.accent, 11, 0.4) },
        ]}
      >
        {filled !== undefined ? (
          <ToggleBurst active={filled} kind="save" size={28}>
            <Icon name={icon} size={16} color={primary && filled ? colors.white : filled ? colors.accentLight : colors.text} filled={filled} />
          </ToggleBurst>
        ) : (
          <Icon name={icon} size={16} color={colors.text} />
        )}
        <T size={13} weight={600}>
          {label}
        </T>
      </Row>
    </Tap>
  );
}

/** Channel / commenter picture as a rounded square (design: radius ~ size / 3). */
function SquareAvatar({ name, uri, size }: { name: string; uri: string | null; size: number }) {
  if (!uri) return <Avatar initial={(name.trim()[0] ?? '?').toUpperCase()} art={artFor(name)} size={size} radius={Math.round(size / 3)} />;
  return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: Math.round(size / 3), backgroundColor: colors.bgTertiary }} contentFit="cover" accessibilityIgnoresInvertColors />;
}
