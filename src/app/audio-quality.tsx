import { View } from 'react-native';

import { Glass, Icon, ListGroup, ListRow, Overline, Row, Screen, ScreenHeader, Sticker, T } from '../components';
import { formatBytes } from '../lib/downloads';
import { useConnection } from '../lib/network';
import { STREAM_KBPS } from '../lib/usage';
import { colors } from '../theme/tokens';

/** Bytes for `seconds` of audio at `kbps`. */
const bytesFor = (kbps: number, seconds: number) => (kbps * 1000 * seconds) / 8;
const PER_HOUR = bytesFor(STREAM_KBPS, 3600);
const PER_SONG = bytesFor(STREAM_KBPS, 4 * 60);
const PER_DAY_HOUR_MONTH = PER_HOUR * 30;

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <T size={20} weight={600}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

export default function AudioQuality() {
  const conn = useConnection();
  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral' }}>
      <ScreenHeader title="Audio quality" />

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>STREAMING</Overline>
        <Glass padding={16} radius={28}>
          <View style={{ gap: 14 }}>
            <Row gap={12}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="speaker" size={22} color={colors.accentLight} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Row gap={8}>
                  <T size={17} weight={600}>
                    High
                  </T>
                  <Sticker label={`${STREAM_KBPS} KBPS`} bg={colors.accent} rotate={0} />
                </Row>
                <T size={13} color={colors.textSecondary}>
                  MP3, the quality every song in the catalogue is published at
                </T>
              </View>
              <Icon name="check" size={20} color={colors.accentLight} />
            </Row>
            <T size={13} color={colors.textSecondary}>
              Zoyra streams each song at the single quality its catalogue (Audius) provides, on Wi-Fi and mobile data alike. There’s no lower or higher setting to pick, so the sound never drops when your
              connection does; songs just take a moment longer to start.
            </T>
          </View>
        </Glass>
      </View>

      <ListGroup title="DOWNLOADS">
        <ListRow title="Download quality" subtitle={`Same ${STREAM_KBPS} kbps file you stream`} icon="download" right={false} minHeight={60} />
        <ListRow title="Downloads" subtitle="Songs saved on this phone" icon="storage" href="/downloads" divider />
      </ListGroup>

      <View style={{ gap: 8 }}>
        <Overline color={colors.textSecondary}>DATA</Overline>
        <Glass padding={16}>
          <View style={{ gap: 12 }}>
            <Row gap={12}>
              <Stat value={formatBytes(PER_SONG)} label="per 4-minute song" />
              <Stat value={formatBytes(PER_HOUR)} label="per hour" />
              <Stat value={formatBytes(PER_DAY_HOUR_MONTH)} label="an hour a day, 30 days" />
            </Row>
            <T size={12} color={colors.textTertiary}>
              {STREAM_KBPS} kbps × 3,600 s ÷ 8 bits. Downloaded songs play with no data.
              {conn.known ? ` You’re on ${conn.label.toLowerCase()} right now.` : ''}
            </T>
          </View>
        </Glass>
        <Glass padding={4}>
          <ListRow title="Data usage" subtitle="What you streamed this month" icon="chart" href="/data-usage" />
          <ListRow title="Wi-Fi only streaming" subtitle="Data and storage" icon="wifi" href="/storage" divider />
          <ListRow title="Equalizer" subtitle="Shape the sound" icon="sliders" href="/equalizer" divider />
        </Glass>
      </View>

      <Glass padding={14}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            Lossless, Hi-Res, spatial audio and Dolby Atmos aren’t available: the catalogue doesn’t publish those formats.
          </T>
        </Row>
      </Glass>
    </Screen>
  );
}
