import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar, useWindowDimensions, View } from 'react-native';
import type { YoutubeIframeRef } from 'react-native-youtube-iframe';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { go, IconButton, Row, T, useAsync } from '../components';
import { playerErrorText, VideoFrame } from '../lib/video-ui';
import { fetchVideo, openOnYouTube, useVideoBus, videoBus } from '../lib/youtube';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

/**
 * VideoFull (`/video-full?id=&t=`). Big playback with minimal chrome. The app is portrait-locked and
 * expo-screen-orientation isn't installed, so "Landscape" turns the player container 90°; YouTube's own
 * fullscreen button also works. Nothing is drawn over the player, so its controls and branding stay visible.
 */
export default function VideoFull() {
  const params = useLocalSearchParams<{ id?: string; t?: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const start = Number(params.t) > 0 ? Number(params.t) : 0;
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const audio = usePlayerPick('playing');
  const bus = useVideoBus();
  const ref = useRef<YoutubeIframeRef>(null);
  const last = useRef(start);
  const [landscape, setLandscape] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const info = useAsync(() => fetchVideo(id), [id], 'app/video-full:30');

  // Remember the position so the player screen resumes there.
  useEffect(() => {
    const t = setInterval(() => {
      ref.current
        ?.getCurrentTime()
        .then((s) => {
          last.current = s;
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      clearInterval(t);
      videoBus.set({ resume: { videoId: id, seconds: last.current } });
    };
  }, [id]);

  const onState = useCallback(
    (s: string) => {
      if (s === 'playing' && audio.playing) audio.pause();
    },
    [audio],
  );

  // Chrome rows above and below the player (never on top of it).
  const chrome = 56;
  const availH = height - insets.top - insets.bottom - chrome * 2;
  const frameW = landscape ? Math.max(200, availH) : width;
  const frameH = landscape ? Math.max(200, Math.min(width, Math.round((frameW * 9) / 16))) : Math.max(200, Math.round((width * 9) / 16));

  return (
    <View style={{ flex: 1, backgroundColor: colors.black, paddingTop: insets.top, paddingBottom: insets.bottom }}>
      <StatusBar hidden />
      <Row gap={8} style={{ height: chrome, paddingHorizontal: 8 }}>
        <IconButton icon="close" label="Close full screen" onPress={() => go('back')} />
        <View style={{ flex: 1 }}>
          <T size={16} weight={600} numberOfLines={1}>
            {info.data?.video.title ?? ' '}
          </T>
          <T size={12} color={colors.peach} numberOfLines={1}>
            {info.data?.video.channel ?? ''}
          </T>
        </View>
        <IconButton icon="repeat" label={landscape ? 'Show upright' : 'Show in landscape'} onPress={() => setLandscape((l) => !l)} />
      </Row>

      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {id ? (
          <View style={landscape ? { width: frameW, height: frameH, transform: [{ rotate: '90deg' }] } : undefined}>
            <VideoFrame
              ref={ref}
              videoId={id}
              width={frameW}
              height={frameH}
              fill
              start={start}
              captions={bus.captions}
              rate={bus.rate}
              play
              onState={onState}
              onError={(e) => setError(playerErrorText(e))}
            />
          </View>
        ) : (
          <T color={colors.textSecondary}>No video selected.</T>
        )}
      </View>

      <Row gap={8} style={{ height: chrome, paddingHorizontal: 16, justifyContent: 'space-between' }}>
        {error ? (
          <T size={12} color={colors.amber} style={{ flex: 1 }} numberOfLines={2} accessibilityLiveRegion="polite">
            {error}
          </T>
        ) : (
          <T size={11} color={colors.textTertiary} style={{ flex: 1 }} numberOfLines={2}>
            Played by YouTube. Use the player’s own fullscreen button for the system player.
          </T>
        )}
        <IconButton icon="link" label="Watch on YouTube" onPress={() => void openOnYouTube(id, last.current).then((ok) => !ok && setError('Could not open YouTube.'))} />
      </Row>
    </View>
  );
}
