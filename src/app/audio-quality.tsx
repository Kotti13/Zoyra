import { View } from 'react-native';

import { Icon, Row, Screen, Sticker, T } from '../components';
import { BigHeader, IconChip, Panel, PanelRow, SectionLabel } from '../components/settings-ui';
import { formatBytes } from '../lib/downloads';
import { useConnection } from '../lib/network';
import { STREAM_KBPS } from '../lib/usage';
import { colors, withAlpha } from '../theme/tokens';

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
      <BigHeader title="Audio quality" />

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Streaming</SectionLabel>
        <Panel padding={{ v: 14, h: 16 }} radius={32} style={{ borderWidth: 1.5, borderColor: colors.accent, backgroundColor: withAlpha(colors.accent, 0.16) }}>
          <View style={{ gap: 14 }}>
            <Row gap={12}>
              <IconChip icon="speaker" size={44} />
              <View style={{ flex: 1, gap: 2 }}>
                <Row gap={8}>
                  <T size={16} weight={600}>
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
        </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Downloads</SectionLabel>
        <Panel padding={{ v: 4, h: 16 }}>
          <PanelRow title="Download quality" subtitle={`Same ${STREAM_KBPS} kbps file you stream`} icon="download" chevron={false} />
          <PanelRow title="Downloads" subtitle="Songs saved on this phone" icon="storage" href="/downloads" divider />
        </Panel>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel size={12} tracking={1.2}>Data</SectionLabel>
        <Panel padding={16} radius={32}>
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
        </Panel>
        <Panel padding={{ v: 4, h: 16 }}>
          <PanelRow title="Data usage" subtitle="What you streamed this month" icon="chart" href="/data-usage" />
          <PanelRow title="Wi-Fi only streaming" subtitle="Data and storage" icon="wifi" href="/storage" divider />
          <PanelRow title="Equalizer" subtitle="Shape the sound" icon="sliders" href="/equalizer" divider />
        </Panel>
      </View>

      <Panel padding={14} radius={32}>
        <Row gap={10} align="flex-start">
          <Icon name="info" size={18} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }}>
            Lossless, Hi-Res, spatial audio and Dolby Atmos aren’t available: the catalogue doesn’t publish those formats.
          </T>
        </Row>
      </Panel>
    </Screen>
  );
}
