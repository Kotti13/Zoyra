import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, View } from 'react-native';

import { Button, Chip, Glass, go, ListRow, Row, Sheet, T, Toggle, useAsync } from '../components';
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
  const info = useAsync(() => (id ? fetchVideo(id) : Promise.resolve(null)), [id], 'app/video-options:20');
  const [note, setNote] = useState<string | null>(null);

  const report = () => {
    const v = info.data?.video ?? { id, title: id };
    Linking.openURL(reportVideoUrl(v)).catch(() => setNote(`No mail app found. Email ${REPORT_EMAIL} with video id ${id}.`));
  };

  return (
    <Sheet gap={12}>
      <T variant="section" size={18} accessibilityRole="header">
        Playback settings
      </T>

      <Glass padding={4}>
        <ListRow
          icon="clock"
          title="Playback speed"
          subtitle={rateLabel(bus.rate)}
          minHeight={64}
          right={
            <T size={13} color={colors.textSecondary}>
              {bus.rate}x
            </T>
          }
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8, paddingHorizontal: 12, paddingBottom: 6 }}>
          {bus.rates.map((r) => (
            <Chip key={r} label={rateLabel(r)} active={bus.rate === r} onPress={() => videoBus.set({ rate: r })} />
          ))}
        </View>
        <ListRow
          icon="file"
          title="Captions"
          subtitle="YouTube captions in your language when available. The video reloads where it was."
          minHeight={64}
          divider
          right={<Toggle value={bus.captions} onChange={(v) => videoBus.set({ captions: v })} label="Captions" />}
        />
      </Glass>

      {note ? (
        <T size={13} color={colors.amber} accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}

      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Videos play in YouTube’s own player, so audio-only, background play, quality, data saver and casting aren’t available here. YouTube picks the quality for your connection.
      </T>

      <Row gap={10}>
        <Button label="Watch on YouTube" icon="link" variant="glass" height={48} style={{ flex: 1 }} onPress={() => void openOnYouTube(id).then((ok) => !ok && setNote('Could not open YouTube.'))} />
        <Button label="Done" height={48} style={{ flex: 1 }} onPress={() => go('back')} />
      </Row>
      <Button label="Report this video" icon="shield" variant="destructive" height={44} onPress={report} />
    </Sheet>
  );
}
