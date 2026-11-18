import { View } from 'react-native';

import { Chip, Glass, ListGroup, ListRow, Overline, Screen, ScreenHeader, T, Toggle } from '../components';
import { CAPTION_LANGS, usePlayPref } from '../lib/play-prefs';
import { videoBus } from '../lib/youtube';
import { useDownloads } from '../state/downloads';
import { colors } from '../theme/tokens';

/**
 * Settings › Video. Device prefs read by the video player (autoplay next, captions), the shorts pager
 * (autoplay on scroll) and both for "Wi-Fi only previews" (NetInfo connection type).
 */
export default function VideoSettings() {
  const [autoNext, setAutoNext] = usePlayPref('video.autoplayNext');
  const [shorts, setShorts] = usePlayPref('video.autoplayShorts');
  const [wifiOnly, setWifiOnly] = usePlayPref('video.wifiOnlyPreviews');
  const [captions, setCaptions] = usePlayPref('video.captions');
  const [lang, setLang] = usePlayPref('video.captionLang');
  const { connection, online } = useDownloads();

  const changeCaptions = (on: boolean) => {
    setCaptions(on);
    videoBus.set({ captions: on }); // an open player reloads with the new setting
  };
  const net = !online ? 'offline' : connection === 'wifi' || connection === 'ethernet' ? 'on Wi-Fi' : connection === 'unknown' ? 'on an unknown network' : 'on mobile data';

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'lines', mesh: 'none', glows: [{ x: 0.9, y: 0.1, color: colors.accent, opacity: 0.3 }] }}>
      <ScreenHeader title="Video" />

      <ListGroup title="AUTOPLAY">
        <ListRow
          title="Autoplay next video"
          subtitle="Start the first Up next video when one ends"
          minHeight={72}
          right={<Toggle value={autoNext} onChange={setAutoNext} label="Autoplay next video" />}
        />
        <ListRow
          title="Autoplay shorts on scroll"
          subtitle="Each short starts as you swipe to it"
          minHeight={72}
          divider
          right={<Toggle value={shorts} onChange={setShorts} label="Autoplay shorts on scroll" />}
        />
        <ListRow
          title="Wi-Fi only autoplay"
          subtitle={`Nothing starts by itself on mobile data. You’re ${net} now.`}
          minHeight={72}
          divider
          right={<Toggle value={wifiOnly} onChange={setWifiOnly} label="Wi-Fi only autoplay" />}
        />
      </ListGroup>

      <View style={{ gap: 8 }}>
        <ListGroup title="CAPTIONS">
          <ListRow
            title="Captions"
            subtitle="Show YouTube captions when the video has them"
            minHeight={72}
            right={<Toggle value={captions} onChange={changeCaptions} label="Captions" />}
          />
        </ListGroup>
        <Overline color={colors.textSecondary}>CAPTION LANGUAGE</Overline>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {CAPTION_LANGS.map((l) => (
            <Chip key={l.code || 'device'} label={l.label} active={lang === l.code} onPress={() => setLang(l.code)} />
          ))}
        </View>
        <T size={12} color={colors.textTertiary} lineHeight={17}>
          YouTube uses this language when the video has captions in it, and falls back to what it has. Applies to the next video you open.
        </T>
      </View>

      <Glass padding={16} style={{ gap: 6 }}>
        <T size={15} weight={500}>
          Quality, audio only and background play
        </T>
        <T size={13} color={colors.textSecondary} lineHeight={18}>
          Videos play in YouTube’s own player, which picks the quality for your connection. YouTube’s terms don’t allow apps to force a quality, play audio only or keep playing in the background, so these aren’t offered.
        </T>
      </Glass>
    </Screen>
  );
}
