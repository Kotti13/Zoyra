import { Directory, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Glass, Icon, ListGroup, ListRow, Loading, Row, Screen, ScreenHeader, T, Toast } from '../components';
import { downloads, formatBytes } from '../lib/downloads';
import { useDownloads } from '../state/downloads';
import { colors } from '../theme/tokens';

type Sizes = { artwork: number; other: number; downloads: number };

/** expo-image's disk cache folders: SDWebImage on iOS, Glide on Android. */
const IMAGE_CACHE = /SDImageCache|image_manager_disk_cache|expo-image/i;

function measure(): Sizes {
  let artwork = 0;
  let total = 0;
  try {
    total = Paths.cache.size ?? 0;
    const walk = (d: Directory, depth: number) => {
      for (const item of d.list()) {
        if (IMAGE_CACHE.test(item.name)) artwork += item.size ?? 0;
        else if (item instanceof Directory && depth < 2) walk(item, depth + 1);
      }
    };
    walk(new Directory(Paths.cache), 0);
  } catch {
    // Some platforms don't allow listing the cache folder; fall back to the total.
  }
  return { artwork, other: Math.max(0, total - artwork), downloads: downloads.diskBytes() };
}

export default function Cache() {
  const dl = useDownloads();
  const [sizes, setSizes] = useState<Sizes | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();

  const refresh = useCallback(() => {
    // Defer so the screen paints before walking the cache folder.
    setTimeout(() => setSizes(measure()), 0);
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh, dl.totalBytes]);

  const clear = async () => {
    if (busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      const before = measure();
      const [disk, memory] = await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]);
      const after = measure();
      setSizes(after);
      const freed = before.artwork + before.other - (after.artwork + after.other);
      setNote({ ok: true, text: disk || memory ? (freed > 0 ? `Artwork cache cleared · freed ${formatBytes(freed)}` : 'Artwork cache cleared') : 'Cache was already empty' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not clear the cache' });
    } finally {
      setBusy(false);
    }
  };

  const cacheTotal = sizes ? sizes.artwork + sizes.other : 0;
  const all = sizes ? cacheTotal + sizes.downloads : 0;
  const pct = (n: number) => (all > 0 ? `${Math.max(n > 0 ? 1 : 0, (n / all) * 100)}%` : '0%') as `${number}%`;
  const parts = sizes
    ? [
        { label: 'Downloads', value: sizes.downloads, color: colors.accent },
        { label: 'Artwork', value: sizes.artwork, color: colors.violet },
        { label: 'Other temp', value: sizes.other, color: colors.amber },
      ]
    : [];

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'coral' }}>
      <ScreenHeader title="Cache and prefetch" />

      <Glass padding={16}>
        {!sizes ? (
          <Loading label="Measuring storage" height={96} />
        ) : (
          <View style={{ gap: 12 }}>
            <Row align="baseline" style={{ justifyContent: 'space-between' }}>
              <T variant="display">{formatBytes(cacheTotal)}</T>
              <T size={13} color={colors.textSecondary}>
                cache · {formatBytes(sizes.downloads)} downloads
              </T>
            </Row>
            <View
              accessibilityLabel={parts.map((p) => `${p.label} ${formatBytes(p.value)}`).join(', ')}
              style={{ flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden', backgroundColor: colors.track }}
            >
              {parts.map((p) => (
                <View key={p.label} style={{ width: pct(p.value), backgroundColor: p.color }} />
              ))}
            </View>
            <Row gap={14} style={{ flexWrap: 'wrap' }}>
              {parts.map((p) => (
                <Row key={p.label} gap={6}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: p.color }} />
                  <T size={12} color={colors.textSecondary}>
                    {p.label} {formatBytes(p.value)}
                  </T>
                </Row>
              ))}
            </Row>
          </View>
        )}
      </Glass>

      <Glass padding={14}>
        <Row gap={12} align="flex-start">
          <Icon name="info" size={20} color={colors.accentLight} />
          <T size={13} color={colors.textSecondary} lineHeight={19} style={{ flex: 1 }}>
            Covers and photos are cached on this device so they load fast and use less data. The system may clear the cache when space runs low. Clearing it never removes your downloads.
          </T>
        </Row>
      </Glass>

      <ListGroup title="HOW DATA IS KEPT">
        <ListRow title="Album art and photos" subtitle="Kept until cleared or the system needs space" icon="camera" right={false} />
        <ListRow title="Downloaded songs" subtitle={`${dl.list.length} ${dl.list.length === 1 ? 'song' : 'songs'} · kept until you remove them`} icon="download" divider href="/downloads" />
      </ListGroup>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

      <Row gap={12}>
        <Button label="Refresh" variant="glass" style={{ flex: 1 }} onPress={refresh} />
        <Button label={busy ? 'Clearing…' : 'Clear cache'} icon="trash" variant={busy ? 'disabled' : 'primary'} style={{ flex: 1 }} onPress={() => void clear()} />
      </Row>
    </Screen>
  );
}
