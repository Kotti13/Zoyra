import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { View } from 'react-native';

import { Button, Icon, Row, Sheet, T } from '../components';
import type { IconName } from '../components';
import { formatBytes } from '../lib/downloads';
import { describeConnection, formatMbps, slowness, useSpeedTest } from '../lib/network';
import { STREAM_KBPS } from '../lib/usage';
import { useDownloads } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

function Item({ icon, title, value, tone = colors.accentLight }: { icon: IconName; title: string; value: string; tone?: string }) {
  return (
    <Row gap={12} style={{ minHeight: 52 }} accessible accessibilityLabel={`${title}, ${value}`}>
      <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: withAlpha(tone, 0.16), alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={18} color={tone} />
      </View>
      <T size={15} weight={500} style={{ flex: 1 }}>
        {title}
      </T>
      <T size={13} color={colors.textSecondary}>
        {value}
      </T>
    </Row>
  );
}

export default function SlowNet() {
  const net = useNetInfo();
  const c = describeConnection(net);
  const { last } = useSpeedTest();
  const slow = slowness(net, last);
  const dl = useDownloads();
  const player = usePlayerPick();
  const count = dl.list.length;

  const playDownloads = () => {
    if (!count) return router.replace('/offline-home');
    player.playTracks(
      dl.list.map((e) => e.track),
      0,
      'Downloads',
    );
    router.replace('/player');
  };

  return (
    <Sheet gap={14}>
      <View style={{ gap: 4, paddingTop: 4 }}>
        <Row gap={10}>
          <Icon name="wifiOff" size={22} color={colors.warning} />
          <T variant="title" size={22} accessibilityRole="header">
            {slow.slow || !c.online ? 'Slow connection' : 'Connection looks fine'}
          </T>
        </Row>
        <T size={14} color={colors.textSecondary}>
          {[c.label, slow.reason ?? c.detail].filter(Boolean).join(' · ')}
          {slow.slow ? ' · playback may stutter' : ''}
        </T>
      </View>

      <View>
        <Item icon="speaker" title="Stream quality" value={`${STREAM_KBPS} kbps (fixed)`} />
        <Item icon="bolt" title="Last speed test" value={last ? `${formatMbps(last.mbps)} Mbps · ${last.pingMs} ms` : 'Not run yet'} tone={colors.warning} />
        <Item
          icon="download"
          title="Downloads ready offline"
          value={count ? `${count} ${count === 1 ? 'song' : 'songs'} · ${formatBytes(dl.totalBytes)}` : 'None yet'}
          tone={colors.success}
        />
        {dl.wifiOnly && net.type === 'cellular' ? <Item icon="clock" title="New downloads" value="wait for Wi-Fi" tone={colors.info} /> : null}
      </View>

      <T size={13} color={colors.textSecondary} lineHeight={19}>
        Our music source only offers one quality, so Zoyra can’t lower the bitrate. Downloaded songs play with no connection at all.
      </T>

      <View style={{ gap: 10 }}>
        <Button label="Keep listening" onPress={() => router.back()} />
        <Button label={count ? 'Play downloads only' : 'Offline mode'} variant="glass" onPress={playDownloads} />
        <Button label="Connection and data" variant="secondary" onPress={() => router.replace('/net-status')} />
      </View>
    </Sheet>
  );
}
