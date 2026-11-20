import { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { View } from 'react-native';

import { Button, Glass, Icon, LinkText, Row, Sheet, T } from '../components';
import type { IconName } from '../components';
import { formatBytes } from '../lib/downloads';
import { describeConnection, formatMbps, slowness, useSpeedTest } from '../lib/network';
import { STREAM_KBPS } from '../lib/usage';
import { useDownloads } from '../state/downloads';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

function Item({ icon, title, value, tone = colors.success }: { icon: IconName; title: string; value: string; tone?: string }) {
  return (
    <Row gap={12} style={{ minHeight: 44 }} accessible accessibilityLabel={`${title}, ${value}`}>
      <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: tone, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={13} color={colors.black} />
      </View>
      <T size={15} style={{ flex: 1 }}>
        {title}
      </T>
      <T size={12} color={colors.textSecondary}>
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
      <T variant="section" accessibilityRole="header">
        {slow.slow || !c.online ? 'Slow connection' : 'Connection looks fine'}
      </T>
      <Row gap={14}>
        <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: withAlpha(colors.amber, 0.18), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="wifiOff" size={26} color={colors.amber} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T size={16} weight={600}>
            {c.label}
          </T>
          <T size={14} color={colors.textSecondary}>
            {slow.reason ?? c.detail ?? (slow.slow ? 'Playback may stutter' : 'Playback should be smooth')}
            {slow.slow && slow.reason ? ' · playback may stutter' : ''}
          </T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 20 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[6, 11, 16, 21].map((h, i) => (
            <View key={h} style={{ width: 5, height: h, borderRadius: 2, backgroundColor: i === 0 || !slow.slow ? colors.amber : colors.track }} />
          ))}
        </View>
      </Row>

      <Glass padding={14}>
        <Item icon="speaker" title="Stream quality" value={`${STREAM_KBPS} kbps (fixed)`} />
        <Item icon="bolt" title="Last speed test" value={last ? `${formatMbps(last.mbps)} Mbps · ${last.pingMs} ms` : 'Not run yet'} />
        <Item
          icon="download"
          title="Downloads ready offline"
          value={count ? `${count} ${count === 1 ? 'song' : 'songs'} · ${formatBytes(dl.totalBytes)}` : 'None yet'}
        />
        {dl.wifiOnly && net.type === 'cellular' ? <Item icon="clock" title="New downloads" value="wait for Wi-Fi" /> : null}
      </Glass>

      <T size={13} color={colors.textSecondary} lineHeight={19}>
        Our music source only offers one quality, so Zoyra can’t lower the bitrate. Downloaded songs play with no connection at all.
      </T>

      <View style={{ gap: 10 }}>
        <Button label="Keep listening" onPress={() => router.back()} />
        <Button label={count ? 'Play downloads only' : 'Offline mode'} variant="glass" onPress={playDownloads} />
        <View style={{ alignItems: 'center' }}>
          <LinkText label="Connection and data" onPress={() => router.replace('/net-status')} />
        </View>
      </View>
    </Sheet>
  );
}
