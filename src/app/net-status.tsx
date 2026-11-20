import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import { useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Glass, Icon, IconButton, ListRow, Row, Screen, ScreenHeader, T, Toggle } from '../components';
import { SectionLabel } from '../components/settings-ui';
import { downloads, formatBytes } from '../lib/downloads';
import { NETWORK_ALERTS_PREF, describeConnection, formatAgo, formatMbps, slowness, useDevicePref, useSpeedTest } from '../lib/network';
import { STREAM_KBPS, monthKey, streamedBytes, usage } from '../lib/usage';
import { useDownloads } from '../state/downloads';
import { colors, withAlpha } from '../theme/tokens';

function Bars({ bars, color }: { bars: number; color: string }) {
  return (
    <Row gap={3} align="flex-end" style={{ height: 22 }} accessibilityLabel={`Signal ${bars} of 4 bars`}>
      {[6, 11, 16, 21].map((h, i) => (
        <View key={h} style={{ width: 5, height: h, borderRadius: 2, backgroundColor: i < bars ? color : colors.track }} />
      ))}
    </Row>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, borderRadius: 22, backgroundColor: colors.iconGhost, padding: 12, gap: 2 }} accessible accessibilityLabel={`${value} ${label}`}>
      <T size={20} weight={700} numberOfLines={1}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary} numberOfLines={1}>
        {label}
      </T>
    </View>
  );
}

export default function NetStatus() {
  const net = useNetInfo();
  const c = describeConnection(net);
  const { last } = useSpeedTest();
  const dl = useDownloads();
  const usageSnap = useSyncExternalStore(usage.subscribe, usage.getSnapshot, usage.getSnapshot);
  const month = usageSnap.months[monthKey()];
  const [alerts, setAlerts] = useDevicePref(NETWORK_ALERTS_PREF, true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();

  const sameConn = last && last.connection === net.type ? last : null;
  const slow = slowness(net, last);
  const tone = !c.known ? colors.textSecondary : !c.online ? colors.error : slow.slow ? colors.warning : colors.success;
  const title = !c.known ? 'Checking…' : !c.online ? (net.isConnected ? 'No internet' : 'Offline') : `${c.label} connected`;
  const sub = slow.slow ? `${slow.reason} · playback may stutter` : c.detail;

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await NetInfo.refresh();
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : 'Could not refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const details: [string, string][] = [];
  if (c.ssid) details.push(['Network', c.ssid]);
  if (c.carrier) details.push(['Carrier', c.carrier]);
  if (c.linkSpeedMbps) details.push(['Link speed', `${c.linkSpeedMbps} Mbps`]);
  if (c.frequencyMhz) details.push(['Band', c.frequencyMhz >= 5000 ? `5 GHz (${c.frequencyMhz} MHz)` : `2.4 GHz (${c.frequencyMhz} MHz)`]);
  if (c.ipAddress) details.push(['IP address', c.ipAddress]);
  if (c.expensive != null) details.push(['Metered', c.expensive ? 'Yes' : 'No']);

  const cache = downloads.cacheBytes();

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'amber' }}>
      <ScreenHeader
        title="Connection"
        right={refreshing ? <ActivityIndicator color={colors.accent} style={{ width: 44, height: 44 }} /> : <IconButton icon="repeat" label="Refresh connection" onPress={() => void refresh()} />}
      />

      <Glass padding={16}>
        <Row gap={14}>
          <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: withAlpha(tone, 0.18), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={c.online ? 'globe' : 'wifiOff'} size={26} color={tone} />
          </View>
          <View style={{ flex: 1, gap: 2 }} accessibilityLiveRegion="polite">
            <T size={20} weight={700} numberOfLines={1}>
              {title}
            </T>
            <T size={14} color={colors.textSecondary} numberOfLines={2}>
              {sub}
            </T>
          </View>
          {c.bars != null && c.online ? <Bars bars={c.bars} color={tone} /> : null}
        </Row>
        <Row gap={8} style={{ marginTop: 16 }}>
          <Stat value={sameConn ? formatMbps(sameConn.mbps) : '—'} label="Mbps down" />
          <Stat value={sameConn ? String(sameConn.pingMs) : '—'} label="ms ping" />
          <Stat value="High" label={`${STREAM_KBPS} kbps`} />
        </Row>
        <T size={12} color={colors.textSecondary} style={{ marginTop: 10 }}>
          {sameConn ? `From your speed test ${formatAgo(sameConn.at)}` : 'Run a speed test to measure this connection.'}
        </T>
        {refreshError ? (
          <T size={13} color={colors.error} style={{ marginTop: 6 }}>
            {refreshError}
          </T>
        ) : null}
      </Glass>

      <Glass padding={14}>
        <Row gap={12} align="flex-start">
          <Icon name="info" size={20} color={colors.accentLight} />
          <T size={14} color={colors.textSecondary} lineHeight={21} style={{ flex: 1 }}>
            {`Every song streams as a ${STREAM_KBPS} kbps MP3; our music source has no lower bitrate. On a weak signal Zoyra can’t step quality down, so play your downloads for gap-free music.`}
          </T>
        </Row>
      </Glass>

      <View style={{ gap: 8 }}>
        <SectionLabel>Smart network</SectionLabel>
        <Glass padding={4}>
        <ListRow
          title="Connection alerts"
          subtitle="Tell me when the network is slow or back"
          icon="bell"
          right={<Toggle value={alerts} onChange={setAlerts} label="Connection alerts" />}
        />
        <ListRow
          title="Wi-Fi only downloads"
          subtitle="Save mobile data"
          icon="download"
          divider
          right={<Toggle value={dl.wifiOnly} onChange={downloads.setWifiOnly} label="Wi-Fi only downloads" />}
        />
      </Glass>
      </View>

      {details.length ? (
        <View style={{ gap: 8 }}>
          <SectionLabel>DETAILS</SectionLabel>
          <Glass padding={16}>
            <View style={{ gap: 10 }}>
              {details.map(([k, v]) => (
                <Row key={k} style={{ justifyContent: 'space-between' }}>
                  <T size={14} color={colors.textSecondary}>
                    {k}
                  </T>
                  <T mono size={13} numberOfLines={1} style={{ flexShrink: 1 }}>
                    {v}
                  </T>
                </Row>
              ))}
            </View>
          </Glass>
        </View>
      ) : null}

      <View style={{ gap: 8 }}>
        <SectionLabel>Tools</SectionLabel>
        <Glass padding={4}>
        <ListRow
          title="Speed test"
          subtitle={last ? `${formatMbps(last.mbps)} Mbps · ${last.pingMs} ms · ${formatAgo(last.at)}` : 'Check what quality works'}
          icon="bolt"
          href="/speed-test"
        />
        <ListRow
          title="Data usage"
          subtitle={usageSnap.ready ? `≈ ${formatBytes(Math.round(month ? streamedBytes(month) : 0))} this month` : 'Loading…'}
          icon="sliders"
          href="/data-usage"
          divider
        />
        <ListRow title="Cache and prefetch" subtitle={`${formatBytes(cache)} cache · ${formatBytes(dl.totalBytes)} downloads`} icon="storage" href="/cache" divider />
        <ListRow title="Offline mode" subtitle="Play your downloads only" icon="wifiOff" href="/offline-home" divider />
      </Glass>
      </View>
    </Screen>
  );
}
