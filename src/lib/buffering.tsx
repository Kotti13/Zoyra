/**
 * Player buffering state + a drop-in notice for the player screen.
 *
 * `usePlayer().buffering` mirrors expo-audio's `isBuffering`. It flickers on every track start and
 * seek, so the notice only appears after it has stayed true for SHOW_AFTER_MS while the user wants
 * music to play. expo-audio does not report how far ahead it has buffered, so no buffered range is shown.
 */
import { useNetInfo } from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Glass, Icon, Row, T } from '../components';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';
import { describeConnection, slowness, useSpeedTest } from './network';
import { STREAM_KBPS } from './usage';

const SHOW_AFTER_MS = 1200;

export type BufferingState = {
  /** True once buffering has lasted SHOW_AFTER_MS while playback is wanted. */
  stalled: boolean;
  /** Epoch ms when the current stall started (null when not buffering). */
  since: number | null;
};

export function useBuffering(): BufferingState {
  const { buffering, playing, track } = usePlayerPick('track', 'playing', 'buffering');
  const active = buffering && playing && !!track;
  const [since, setSince] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active) {
      const t0 = setTimeout(() => {
        setSince(null);
        setStalled(false);
      }, 0);
      return () => clearTimeout(t0);
    }
    const start = Date.now();
    const t1 = setTimeout(() => setSince(start), 0);
    const t2 = setTimeout(() => setStalled(true), SHOW_AFTER_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [active]);
  return { stalled, since };
}

/** One-line reason for the stall, from NetInfo and the last speed test. */
export function useBufferingReason(): string {
  const net = useNetInfo();
  const { last } = useSpeedTest();
  const c = describeConnection(net);
  if (!c.known) return 'Checking your connection';
  if (!c.online) return 'No internet connection';
  const slow = slowness(net, last);
  if (slow.slow) return `${slow.reason} · ${c.label}`;
  return `${c.label} · ${c.detail}`;
}

/**
 * Glass notice shown while the stream is stalled. Renders nothing otherwise, so it can sit
 * permanently in the player layout: `<BufferingNotice />`.
 */
export function BufferingNotice({ always = false }: { always?: boolean }) {
  const { stalled } = useBuffering();
  const reason = useBufferingReason();
  if (!stalled && !always) return null;
  return (
    <Glass padding={14}>
      <View style={{ gap: 12 }} accessibilityLiveRegion="polite">
        <Row gap={12}>
          {stalled ? <ActivityIndicator color={colors.warning} /> : <Icon name="check" size={20} color={colors.success} />}
          <View style={{ flex: 1, gap: 2 }}>
            <T size={15} weight={600}>
              {stalled ? 'Buffering…' : 'Playing smoothly'}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={2}>
              {`${reason} · ${STREAM_KBPS} kbps stream`}
            </T>
          </View>
        </Row>
        <Row gap={10}>
          <Button label="Play downloads" icon="download" variant="glass" height={40} style={{ flex: 1 }} href="/offline-home" />
          <Button label="Connection" variant="glass" height={40} style={{ flex: 1 }} href="/net-status" />
        </Row>
      </View>
    </Glass>
  );
}
