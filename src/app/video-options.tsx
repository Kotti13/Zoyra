import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';

import { Button, Chip, go, Icon, Row, Sheet, T, Toggle, useAsync } from '../components';
import { fetchVideo, openOnYouTube, REPORT_EMAIL, reportVideoUrl, useVideoBus, videoBus } from '../lib/youtube';
import { colors } from '../theme/tokens';

const rateLabel = (r: number) => (r === 1 ? 'Normal' : `${r}x`);

/**
 * VideoOptions sheet (`/video-options?id=`). Only settings the YouTube IFrame API really supports:
 * playback speed (setPlaybackRate) and captions (cc_load_policy, applied by reloading the player).
 * Audio-only, background play, quality, data saver and casting are not offered (see the note).
 */
export default function VideoOptions() {
  const params = useLocalSearchParams<{ id?: string }>();
  const bus = useVideoBus();
  const id = typeof params.id === 'string' ? params.id : (bus.videoId ?? '');
  const info = useAsync(() => (id ? fetchVideo(id) : Promise.resolve(null)), [id]);
  const [note, setNote] = useState<string | null>(null);

  const report = () => {
    const v = info.data?.video ?? { id, title: id };
    Linking.openURL(reportVideoUrl(v)).catch(() => setNote(`No mail app found. Email ${REPORT_EMAIL} with video id ${id}.`));
  };

  return (
    <Sheet gap={14}>
      <T variant="section" accessibilityRole="header">
        Playback settings
      </T>

      <View style={{ gap: 6 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Row gap={10}>
            <Icon name="clock" size={20} color={colors.textSecondary} />
            <T size={15} weight={500}>
              Playback speed
            </T>
          </Row>
          <T size={14} color={colors.textSecondary}>
            {rateLabel(bus.rate)}
          </T>
        </Row>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
          {bus.rates.map((r) => (
            <Chip key={r} label={rateLabel(r)} active={bus.rate === r} onPress={() => videoBus.set({ rate: r })} />
          ))}
        </View>
      </View>

      <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
        <Row gap={10} style={{ flex: 1 }}>
          <Icon name="file" size={20} color={colors.textSecondary} />
          <View style={{ flex: 1 }}>
            <T size={15} weight={500}>
              Captions
            </T>
            <T size={12} color={colors.textSecondary}>
              YouTube captions in your language when available. The video reloads where it was.
            </T>
          </View>
        </Row>
        <Toggle value={bus.captions} onChange={(v) => videoBus.set({ captions: v })} label="Captions" />
      </Row>

      <Button label="Watch on YouTube" icon="link" variant="glass" height={44} onPress={() => void openOnYouTube(id).then((ok) => !ok && setNote('Could not open YouTube.'))} />
      <Button label="Report this video" icon="shield" variant="destructive" height={44} onPress={report} />

      {note ? (
        <T size={13} color={colors.amber} accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Videos play in YouTube’s own player, so audio-only, background play, quality, data saver and casting aren’t available here. YouTube picks the quality for your connection.
      </T>

      <Button label="Done" height={44} onPress={() => go('back')} />
    </Sheet>
  );
}
