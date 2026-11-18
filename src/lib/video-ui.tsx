import { Image } from 'expo-image';
import { forwardRef, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import YoutubePlayer, { type YoutubeIframeRef } from 'react-native-youtube-iframe';

import { Avatar, artFor, Gradient, Icon, LiveDot, Row, T, Tap, type NavTarget } from '../components';
import { colors, radius, withAlpha } from '../theme/tokens';
import { downloads } from './downloads';
import { captionLang, usePlayPref } from './play-prefs';
import { formatDuration, type YouTubeVideo } from './youtube';

/**
 * Shared video UI. Every player is YouTube's official IFrame player, always visible, never covered
 * (no overlays on top of the player rect), with YouTube's own controls and branding.
 */

/* ------------------------------------------------------------------ settings (Settings › Video) */

/** On a metered link (mobile data etc.); Wi-Fi, Ethernet and unknown count as unmetered, like Wi-Fi-only streaming. */
const meteredNow = () => {
  const s = downloads.getSnapshot();
  return s.online && s.connection !== 'wifi' && s.connection !== 'ethernet' && s.connection !== 'unknown';
};

/**
 * Whether a video may start on its own (shorts on scroll, the next video after one ends).
 * Off when the matching Settings › Video toggle is off, or when "Wi-Fi only previews" is on and the
 * device is on mobile data (NetInfo via the downloads store).
 */
export function useVideoAutoStart(kind: 'shorts' | 'next'): { allowed: boolean; reason: string | null } {
  const [shorts] = usePlayPref('video.autoplayShorts');
  const [next] = usePlayPref('video.autoplayNext');
  const [wifiOnly] = usePlayPref('video.wifiOnlyPreviews');
  const metered = useSyncExternalStore(downloads.subscribe, meteredNow, meteredNow);
  if (!(kind === 'shorts' ? shorts : next)) return { allowed: false, reason: null };
  if (wifiOnly && metered) return { allowed: false, reason: 'Wi-Fi only previews: tap play to start on mobile data.' };
  return { allowed: true, reason: null };
}

/* ------------------------------------------------------------------ entry card (Home + Search) */

/** "Music videos · Watch, shorts and live sets" style entry card linking to the video hub. */
export function VideoEntryCard({ title, subtitle, href = '/videos' }: { title: string; subtitle: string; href?: NavTarget }) {
  return (
    <Tap href={href} accessibilityLabel={`${title}. ${subtitle}`} style={styles.entry}>
      <Gradient colors={ENTRY_FILL} style={StyleSheet.absoluteFill} />
      <View style={styles.entryIcon}>
        <Icon name="play" size={24} color={colors.onAccent} filled />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T size={18} weight={700}>
          {title}
        </T>
        <T size={14} color={colors.text} style={{ opacity: 0.85 }} numberOfLines={1}>
          {subtitle}
        </T>
      </View>
      <Icon name="chevronRight" size={18} color={colors.text} />
    </Tap>
  );
}

/* ------------------------------------------------------------------ thumbnails */

/** 16:9 thumbnail with duration / LIVE badge. */
export function VideoThumb({ video, width, radius: r = radius.sm, style }: { video: Pick<YouTubeVideo, 'thumbnail' | 'durationSec' | 'live'>; width: number; radius?: number; style?: StyleProp<ViewStyle> }) {
  const height = Math.round((width * 9) / 16);
  const dur = formatDuration(video.durationSec);
  return (
    <View style={[{ width, height, borderRadius: r, overflow: 'hidden', backgroundColor: colors.bgTertiary }, style]}>
      {video.thumbnail ? <Image source={{ uri: video.thumbnail }} style={StyleSheet.absoluteFill} contentFit="cover" transition={150} /> : null}
      {video.live ? (
        <View style={[styles.badge, { left: 6, top: 6, right: undefined, bottom: undefined }]}>
          <LiveDot />
        </View>
      ) : dur ? (
        <View style={styles.badge}>
          <T mono size={11} color={colors.white}>
            {dur}
          </T>
        </View>
      ) : null}
    </View>
  );
}

/** Row item: thumbnail on the left, title + meta on the right. */
export function VideoRow({ video, meta, onPress, right }: { video: YouTubeVideo; meta: string; onPress: () => void; right?: ReactNode }) {
  return (
    <Row gap={12} style={{ minHeight: 72 }}>
      <Tap onPress={onPress} accessibilityLabel={`Play ${video.title} by ${video.channel}`} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <VideoThumb video={video} width={128} />
        <View style={{ flex: 1, gap: 4 }}>
          <T size={14} weight={600} numberOfLines={2}>
            {video.title}
          </T>
          <T size={12} color={colors.textSecondary} numberOfLines={1}>
            {meta}
          </T>
        </View>
      </Tap>
      {right}
    </Row>
  );
}

/** Channel / commenter picture from YouTube, or an initial on a gradient when there is none. */
export function ChannelAvatar({ name, uri, size }: { name: string; uri: string | null; size: number }) {
  if (!uri) return <Avatar initial={(name.trim()[0] ?? '?').toUpperCase()} art={artFor(name)} size={size} />;
  return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colors.bgTertiary }} contentFit="cover" accessibilityIgnoresInvertColors />;
}

/* ------------------------------------------------------------------ the IFrame player */

export type FrameProps = {
  videoId: string;
  width: number;
  height: number;
  /** Start offset in seconds (initial only; change `key` to apply a new one). */
  start?: number;
  captions?: boolean;
  play: boolean;
  rate?: number;
  onState?: (s: string) => void;
  onReady?: () => void;
  onError?: (e: string) => void;
  loop?: boolean;
  /**
   * Fill the whole frame instead of a 16:9 strip. react-native-youtube-iframe's page wraps the player in a
   * fixed 16:9 box (`padding-bottom: 56.25%`) pinned to the top, so in a tall frame a vertical short played
   * as a small strip at the top. This injects CSS that makes the box fill the WebView; YouTube then fits the
   * video (portrait shorts fill the screen, landscape videos letterbox in the middle).
   */
  fill?: boolean;
  /**
   * Hide YouTube's own control layer (player parameter `controls=0`). Used by Shorts, where the app draws
   * its own play button and info, so YouTube's title/channel row and Shorts play icon don't appear twice.
   * Tapping the video still plays/pauses inside YouTube's player.
   */
  hideControls?: boolean;
};

const FILL_CSS =
  "html,body{height:100%;margin:0;background:#000}.container{height:100vh!important;padding-bottom:0!important}.container>div,.container iframe{width:100%!important;height:100%!important}";
const FILL_JS = `(function(){var s=document.createElement('style');s.innerHTML=${JSON.stringify(FILL_CSS)};(document.head||document.documentElement).appendChild(s);})();true;`;

/** YouTube's official IFrame player (react-native-youtube-iframe). Captions use cc_load_policy / cc_lang_pref (Settings › Video language). */
export const VideoFrame = forwardRef<YoutubeIframeRef, FrameProps>(function VideoFrame(
  { videoId, width, height, start, captions, play, rate = 1, onState, onReady, onError, loop, fill, hideControls },
  ref,
) {
  usePlayPref('video.captionLang'); // re-render when the caption language changes
  const lang = captionLang();
  return (
    <View style={{ width, height, backgroundColor: colors.black }}>
      <YoutubePlayer
        ref={ref as React.MutableRefObject<YoutubeIframeRef | null>}
        videoId={videoId}
        width={width}
        height={height}
        play={play}
        playbackRate={rate}
        onChangeState={onState}
        onReady={onReady}
        onError={onError}
        forceAndroidAutoplay
        initialPlayerParams={{
          start: start && start > 0 ? Math.floor(start) : undefined,
          showClosedCaptions: !!captions,
          cc_lang_pref: captions ? lang : undefined,
          rel: false,
          loop,
          ...(hideControls ? { controls: false, iv_load_policy: 3, modestbranding: true, preventFullScreen: true } : null),
        }}
        webViewProps={{
          allowsFullscreenVideo: true,
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
          ...(fill ? { injectedJavaScript: FILL_JS, injectedJavaScriptBeforeContentLoaded: FILL_JS, style: { backgroundColor: colors.black } } : null),
        }}
      />
    </View>
  );
});

/** Message shown in place of the player when YouTube refuses to play a video in apps. */
export function playerErrorText(e: string): string {
  if (e === 'embed_not_allowed') return 'The owner doesn’t allow this video to play outside YouTube. Use “Watch on YouTube”.';
  if (e === 'video_not_found') return 'This video is private or was removed.';
  return 'YouTube couldn’t play this video right now.';
}

const ENTRY_FILL = [withAlpha(colors.accent, 0.35), colors.frost] as const;

const styles = StyleSheet.create({
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 32,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.chipOutline,
    backgroundColor: colors.bgSecondary,
  },
  entryIcon: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: 6, bottom: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: colors.shade },
});
