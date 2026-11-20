import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Glass, Icon, ProgressBar, Row, Screen, T } from '../components';
import { SectionLabel } from '../components/settings-ui';
import { formatBytes } from '../lib/downloads';
import { describeConnection, formatAgo, formatMbps, lastOutageInfo, useSpeedTest } from '../lib/network';
import { useDownloads } from '../state/downloads';
import { colors, withAlpha } from '../theme/tokens';

const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

function duration(ms: number) {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export default function BackOnline() {
  const net = useNetInfo();
  const c = describeConnection(net);
  const { last } = useSpeedTest();
  const dl = useDownloads();
  const [outage] = useState(lastOutageInfo);
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();

  const speed = last && last.connection === net.type ? `${formatMbps(last.mbps)} Mbps` : c.linkSpeedMbps ? `${c.linkSpeedMbps} Mbps link` : null;
  const active = Object.values(dl.active);
  const pending = active.length + dl.queued.length;

  const check = async () => {
    if (checking) return;
    setChecking(true);
    setError(undefined);
    try {
      await NetInfo.refresh();
      setCheckedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the connection');
    } finally {
      setChecking(false);
    }
  };

  return (
    <Screen top={24} gap={16} backdrop={{ pattern: 'dots', mesh: 'gold' }}>
      <View style={{ alignItems: 'center', gap: 10, paddingTop: 16 }} accessibilityLiveRegion="polite">
        <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: withAlpha(c.online ? colors.success : colors.error, 0.18), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={c.online ? 'check' : 'wifiOff'} size={36} color={c.online ? colors.success : colors.error} />
        </View>
        <T variant="display" align="center" accessibilityRole="header">
          {c.online ? 'Back online' : 'Still offline'}
        </T>
        <T size={15} color={colors.textSecondary} align="center">
          {c.online ? [c.label, speed].filter(Boolean).join(' · ') : 'Check Wi-Fi or mobile data and try again.'}
        </T>
      </View>

      {outage ? (
        <Glass padding={16}>
          <Row gap={12}>
            <Icon name="clock" size={20} color={colors.accentLight} />
            <T size={14} style={{ flex: 1 }}>
              {`You were offline for ${duration(outage.to - outage.from)}, back ${formatAgo(outage.to)}.`}
            </T>
          </Row>
        </Glass>
      ) : null}

      <View style={{ gap: 8 }}>
        <SectionLabel>Downloads</SectionLabel>
        <Glass padding={4}>
        {pending ? (
          <View style={{ padding: 12, gap: 12 }}>
            {active.map((a) => (
              <View key={a.trackId} style={{ gap: 6 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={15} weight={500} numberOfLines={1} style={{ flex: 1 }}>
                    {a.title}
                  </T>
                  <T mono size={12} color={colors.textSecondary}>
                    {Math.round(a.progress * 100)}%
                  </T>
                </Row>
                <ProgressBar value={a.progress} height={4} />
              </View>
            ))}
            {dl.queued.length ? (
              <T size={13} color={colors.textSecondary}>
                {`${dl.queued.length} more ${dl.queued.length === 1 ? 'song' : 'songs'} queued${dl.wifiOnly && net.type === 'cellular' ? ' · waiting for Wi-Fi' : ''}`}
              </T>
            ) : null}
          </View>
        ) : (
          <View style={{ padding: 12, gap: 2 }}>
            <T size={15} weight={500}>
              {dl.list.length ? `${dl.list.length} ${dl.list.length === 1 ? 'song' : 'songs'} saved offline` : 'No downloads yet'}
            </T>
            <T size={13} color={colors.textSecondary}>
              {dl.list.length ? `${formatBytes(dl.totalBytes)} · nothing downloading right now` : 'Download songs to keep music playing without a connection.'}
            </T>
          </View>
        )}
      </Glass>
      </View>

      <Glass padding={14}>
        <Row gap={12} align="flex-start">
          <Icon name="info" size={20} color={colors.accentLight} />
          <T size={13} color={colors.textSecondary} lineHeight={19} style={{ flex: 1 }}>
            Likes, playlists and history save straight to your account. Zoyra doesn’t queue changes made with no connection, so redo anything that failed while you were offline.
          </T>
        </Row>
      </Glass>

      <T size={12} color={error ? colors.error : colors.textSecondary} align="center">
        {error ?? `Last checked ${formatAgo(checkedAt)}`}
      </T>

      <Row gap={12}>
        <Button label={checking ? 'Checking…' : 'Check again'} icon="repeat" variant={checking ? 'disabled' : 'glass'} style={{ flex: 1 }} onPress={() => void check()} />
        <Button label="Back to music" style={{ flex: 1 }} onPress={leave} />
      </Row>
    </Screen>
  );
}
