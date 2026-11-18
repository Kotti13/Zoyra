import { ActivityIndicator, View } from 'react-native';

import type { CatalogTrack } from '../lib/catalog';
import { downloads } from '../lib/downloads';
import { useDownloads } from '../state/downloads';
import { colors } from '../theme/tokens';
import { IconButton } from './controls';
import { T, useStatusColor } from './primitives';

/**
 * Download toggle for one podcast episode (episodes are catalogue tracks, so they share the regular
 * offline downloads store): idle → download, downloading → cancel (shows %), downloaded → remove.
 */
export function EpisodeDownload({ episode, onResult }: { episode: CatalogTrack; onResult: (r: { ok: boolean; text: string }) => void }) {
  const dl = useDownloads();
  const downloaded = !!dl.entries[episode.id];
  const active = dl.active[episode.id];
  const queued = dl.queued.includes(episode.id);

  const onPress = () => {
    if (active || queued) {
      downloads.cancel(episode.id);
      return onResult({ ok: true, text: 'Download cancelled' });
    }
    if (downloaded) {
      downloads.remove(episode.id);
      return onResult({ ok: true, text: `Removed “${episode.title}” from downloads` });
    }
    onResult({ ok: true, text: `Downloading “${episode.title}”…` });
    downloads
      .downloadTrack(episode)
      .then(() => onResult({ ok: true, text: `“${episode.title}” downloaded — plays offline` }))
      .catch((e: unknown) => {
        const text = e instanceof Error ? e.message : 'Download failed';
        if (text !== 'Download cancelled') onResult({ ok: false, text });
      });
  };

  if (active) {
    const pct = active.totalBytes > 0 ? Math.round(active.progress * 100) : null;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {pct === null ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <T mono size={11} color={colors.accentLight}>
            {`${pct}%`}
          </T>
        )}
        <IconButton icon="close" label={`Cancel download${pct === null ? '' : `, ${pct} percent`}`} color={colors.accentLight} onPress={onPress} />
      </View>
    );
  }
  return <DoneButton downloaded={downloaded} queued={queued} onPress={onPress} />;
}

function DoneButton({ downloaded, queued, onPress }: { downloaded: boolean; queued: boolean; onPress: () => void }) {
  const done = useStatusColor(colors.success);
  return (
    <IconButton
      icon={downloaded ? 'check' : 'download'}
      label={downloaded ? 'Downloaded. Remove download' : queued ? 'Queued. Cancel download' : 'Download episode'}
      color={downloaded ? done : colors.textSecondary}
      onPress={onPress}
    />
  );
}
