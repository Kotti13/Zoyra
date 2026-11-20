import { useNetInfo } from '@react-native-community/netinfo';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button, Glass, Icon, ProgressBar, Row, Screen, ScreenHeader, T } from '../components';
import { SectionLabel } from '../components/settings-ui';
import { TIERS, formatAgo, formatMbps, speedTest, streamVerdict, supports, useSpeedTest } from '../lib/network';
import { STREAM_KBPS } from '../lib/usage';
import { colors, withAlpha } from '../theme/tokens';

const PHASE_LABEL = { idle: 'Ready', preparing: 'Finding a test file…', ping: 'Measuring ping…', download: 'Measuring download…', done: 'Done', error: 'Test failed' } as const;

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, borderRadius: 22, backgroundColor: colors.iconGhost, padding: 12, gap: 2 }} accessible accessibilityLabel={`${label} ${value}`}>
      <T size={18} weight={700} numberOfLines={1}>
        {value}
      </T>
      <T size={12} color={colors.textSecondary}>
        {label}
      </T>
    </View>
  );
}

export default function SpeedTest() {
  const net = useNetInfo();
  const s = useSpeedTest();
  const [error, setError] = useState<string>();
  const busy = s.phase === 'preparing' || s.phase === 'ping' || s.phase === 'download';
  const unmetered = net.type === 'wifi' || net.type === 'ethernet';

  const run = () => {
    if (busy) return;
    setError(undefined);
    speedTest.run().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Speed test failed'));
  };

  // Start automatically on Wi-Fi / Ethernet (the test downloads a few MB). On mobile data, wait for a tap.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || net.isConnected === null || !unmetered) return;
    started.current = true;
    speedTest.run().catch((e: unknown) => setError(e instanceof Error ? e.message : 'Speed test failed'));
  }, [net.isConnected, unmetered]);

  // Cancel a running test when leaving the screen.
  useEffect(() => () => speedTest.cancel(), []);

  const r = s.last;
  const shown = busy ? s.liveMbps : (r?.mbps ?? null);
  const verdict = r && !busy ? streamVerdict(r) : null;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'peach' }}>
      <ScreenHeader title="Speed test" />

      <Glass padding={20}>
        <View style={{ alignItems: 'center', gap: 4 }} accessibilityLiveRegion="polite">
          <T size={56} weight={700} tracking={-1} accessibilityLabel={shown != null ? `${formatMbps(shown)} megabits per second download` : 'No result yet'}>
            {shown != null ? formatMbps(shown) : '—'}
          </T>
          <T size={14} color={colors.textSecondary}>
            Mbps download
          </T>
          <T size={12} color={colors.textSecondary} style={{ marginTop: 4 }}>
            {busy ? PHASE_LABEL[s.phase] : r ? `Measured ${formatAgo(r.at)} on ${r.connection === 'wifi' ? 'Wi-Fi' : r.connection === 'cellular' ? 'mobile data' : r.connection}` : 'Not tested yet'}
          </T>
        </View>
        {busy ? <ProgressBar value={s.progress} style={{ marginTop: 16 }} /> : null}
        <Row gap={8} style={{ marginTop: 16 }}>
          <Stat value={r && !busy ? `${r.pingMs} ms` : '—'} label="Ping" />
          <Stat value={r && !busy ? `${r.jitterMs} ms` : '—'} label="Jitter" />
          <Stat value="—" label="Upload not tested" />
        </Row>
      </Glass>

      {verdict ? (
        <Glass padding={14}>
          <Row gap={12} align="flex-start">
            <Icon name={verdict.ok ? 'check' : 'info'} size={20} color={verdict.ok ? colors.success : colors.warning} />
            <T size={14} color={colors.textSecondary} lineHeight={21} style={{ flex: 1 }}>
              {verdict.text}
            </T>
          </Row>
        </Glass>
      ) : null}

      {error ? (
        <T size={14} color={colors.error} align="center" accessibilityLiveRegion="assertive">
          {error}
        </T>
      ) : null}

      <View style={{ gap: 8 }}>
        <SectionLabel>What your speed supports</SectionLabel>
        <Glass padding={4}>
        {TIERS.map((t, i) => {
          const ok = r ? supports(r.mbps, t.kbps) : null;
          const available = t.kbps === STREAM_KBPS;
          const tone = ok == null ? colors.textSecondary : ok ? colors.success : colors.error;
          return (
            <Row key={t.key} gap={12} style={[{ minHeight: 60, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: withAlpha(tone, 0.16), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={ok === false ? 'close' : 'check'} size={16} color={tone} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T size={16} weight={500}>
                  {t.label}
                </T>
                <T size={13} color={colors.textSecondary}>
                  {available ? `${t.detail} · what every song uses` : `${t.detail} · not offered by our music source`}
                </T>
              </View>
            </Row>
          );
        })}
      </Glass>
      </View>

      <T size={12} color={colors.textSecondary} lineHeight={18}>
        Times a real download of up to 4.5 MB from our music servers, plus five small requests for ping. On mobile data this uses that much of your plan.
      </T>

      <Row gap={12}>
        <Button label={busy ? 'Testing…' : r ? 'Run again' : 'Start test'} icon="repeat" variant={busy ? 'disabled' : 'glass'} style={{ flex: 1 }} onPress={run} />
        <Button label="Done" style={{ flex: 1 }} href="back" />
      </Row>
    </Screen>
  );
}
