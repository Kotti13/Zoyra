import { Image } from 'expo-image';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { Button, Glass, ListRow, Row, Screen, ScreenHeader, T, Toast, Toggle } from '../components';
import { usePref } from '../lib/prefs';
import { downloads, formatBytes } from '../lib/downloads';
import { STREAM_KBPS, monthKey, streamedBytes, usage } from '../lib/usage';
import { useDownloads } from '../state/downloads';
import { colors } from '../theme/tokens';

/** Device-only preference (shared live store in `prefs.ts`). */
function useDevicePref<V>(key: string, fallback: V) {
  return usePref<V>(key, fallback);
}

const WEEKS = ['W1', 'W2', 'W3', 'W4'];

export default function Storage() {
  // Real sizes on disk, measured with expo-file-system.
  const dl = useDownloads();
  const [measureTick, setMeasureTick] = useState(0);
  const measure = useCallback(() => setMeasureTick((n) => n + 1), []);
  const downloadedBytes = dl.totalBytes;
  const sizes: { downloads: number; cache: number } | null = useMemo(() => {
    void downloadedBytes; // re-measure when downloads change…
    void measureTick; // …or after clearing a cache
    return { downloads: downloads.diskBytes(), cache: downloads.cacheBytes() };
  }, [downloadedBytes, measureTick]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [wifiStreaming, setWifiStreaming] = useDevicePref('wifiOnlyStreaming', false);
  const usageSnap = useSyncExternalStore(usage.subscribe, usage.getSnapshot, usage.getSnapshot);
  const month = usageSnap.months[monthKey()];
  const streamed = month ? streamedBytes(month) : 0;
  const weekMax = Math.max(1, ...(month?.weeks ?? [0]));
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [usageNote, setUsageNote] = useState<{ ok: boolean; text: string } | null>(null);

  const resetUsage = async () => {
    if (resetting) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return setUsageNote({ ok: true, text: 'Tap again to reset this month’s data usage.' });
    }
    setConfirmReset(false);
    setResetting(true);
    setUsageNote(null);
    try {
      await usage.reset('month');
      setUsageNote({ ok: true, text: 'Data usage reset for this month' });
    } catch (e: unknown) {
      setUsageNote({ ok: false, text: e instanceof Error ? e.message : 'Could not reset data usage' });
    } finally {
      setResetting(false);
    }
  };

  const clearCache = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const before = downloads.cacheBytes();
      const [disk, memory] = await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]);
      const after = downloads.cacheBytes();
      measure();
      setNote(
        disk || memory
          ? { ok: true, text: before > after ? `Cache cleared · freed ${formatBytes(before - after)}` : 'Artwork cache cleared' }
          : { ok: true, text: 'Cache was already empty' },
      );
    } catch (e: unknown) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not clear the cache' });
    } finally {
      setBusy(false);
    }
  };

  const clearDownloads = () => {
    if (!dl.list.length) return setNote({ ok: true, text: 'No downloads on this device.' });
    if (!confirmClear) {
      setConfirmClear(true);
      return setNote({ ok: true, text: `Tap again to delete ${dl.list.length} downloaded ${dl.list.length === 1 ? 'song' : 'songs'}.` });
    }
    setConfirmClear(false);
    const freed = sizes?.downloads ?? dl.totalBytes;
    try {
      downloads.removeAll();
      measure();
      setNote({ ok: true, text: `Downloads cleared · freed ${formatBytes(freed)}` });
    } catch (e: unknown) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not clear downloads' });
    }
  };

  const total = (sizes?.downloads ?? 0) + (sizes?.cache ?? 0);
  const pct = (n: number) => (total > 0 ? `${(n / total) * 100}%` : '0%') as `${number}%`;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'gold' }}>
      <ScreenHeader title="Data and storage" />

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <Row align="baseline" style={{ justifyContent: 'space-between' }}>
            <T variant="title" tracking={0}>
              {sizes ? formatBytes(total) : '…'}
            </T>
            <T mono size={12} color={colors.textSecondary}>
              Downloads {sizes ? formatBytes(sizes.downloads) : '…'} · Cache {sizes ? formatBytes(sizes.cache) : '…'}
            </T>
          </Row>
          <View
            accessibilityLabel={sizes ? `Downloads ${formatBytes(sizes.downloads)}, cache ${formatBytes(sizes.cache)}` : 'Measuring storage'}
            style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.track }}
          >
            <View style={{ width: pct(sizes?.downloads ?? 0), backgroundColor: colors.accent }} />
            <View style={{ width: pct(sizes?.cache ?? 0), backgroundColor: colors.amber }} />
          </View>
          <Row gap={12}>
            <Button label={busy ? 'Clearing…' : 'Clear cache'} variant="glass" style={{ flex: 1 }} onPress={() => void clearCache()} />
            <Button label={confirmClear ? 'Tap to confirm' : 'Clear downloads'} variant="destructive" style={{ flex: 1 }} onPress={clearDownloads} />
          </Row>
          {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}
        </View>
      </Glass>


      <Glass padding={4}>
        <ListRow title="Wi-Fi only streaming" subtitle="On mobile data, only downloads play" minHeight={64} right={<Toggle value={wifiStreaming} onChange={setWifiStreaming} label="Wi-Fi only" />} />
        <ListRow title="Wi-Fi only downloads" minHeight={56} divider right={<Toggle value={dl.wifiOnly} onChange={downloads.setWifiOnly} label="Wi-Fi only downloads" />} />
      </Glass>

      <Glass padding={4}>
        <ListRow title="Data usage" subtitle="Weekly and monthly breakdown" icon="bolt" href="/data-usage" minHeight={64} />
        <ListRow title="Cache" subtitle="Artwork and temporary files" icon="download" href="/cache" minHeight={64} divider />
      </Glass>

      <Glass padding={16}>
        <View style={{ gap: 12 }}>
          <Row align="baseline" style={{ justifyContent: 'space-between' }}>
            <T size={14} weight={600}>
              Data used this month
            </T>
            <T mono size={14} color={colors.textSecondary}>
              {usageSnap.ready ? `≈ ${formatBytes(Math.round(streamed))}` : '…'}
            </T>
          </Row>
          <Row gap={8} align="flex-end" style={{ height: 80 }}>
            {WEEKS.map((w, i) => {
              const v = month?.weeks[i] ?? 0;
              return (
                <View key={w} accessibilityLabel={`Week ${i + 1}: about ${formatBytes(Math.round(v))}`} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                  <View style={{ width: '100%', height: Math.max(4, Math.round((v / weekMax) * 56)), borderRadius: 2, backgroundColor: v > 0 ? colors.accent : colors.track }} />
                  <T mono size={10} color={colors.textSecondary}>
                    {w}
                  </T>
                </View>
              );
            })}
          </Row>
          <T mono size={12} color={colors.textSecondary}>
            Wi-Fi {formatBytes(Math.round(month?.wifi ?? 0))} · Cellular {formatBytes(Math.round(month?.cellular ?? 0))}
            {month?.other ? ` · Other ${formatBytes(Math.round(month.other))}` : ''}
          </T>
          <T mono size={12} color={colors.textSecondary}>
            Played from downloads {formatBytes(Math.round(month?.offline ?? 0))} · no data used
          </T>
          <T size={12} color={colors.textSecondary}>
            {`Estimate from listening time × the ${STREAM_KBPS} kbps stream bitrate. Downloads and device files use no data. Measured on this device only.`}
          </T>
          <Button label={resetting ? 'Resetting…' : confirmReset ? 'Tap to confirm' : 'Reset data usage'} variant={resetting ? 'disabled' : 'glass'} onPress={() => void resetUsage()} />
          {usageNote ? <Toast icon={usageNote.ok ? 'check' : 'info'} iconColor={usageNote.ok ? colors.success : colors.error} message={usageNote.text} /> : null}
        </View>
      </Glass>
    </Screen>
  );
}
