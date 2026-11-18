import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, T, Tap, useAsync } from '../components';
import { PhotoViewer, type ViewerPhoto } from '../components/PhotoViewer';
import { dayLabel, peerFromParams, photoMeta, trackArtist, useChatMediaUrl, voiceMeta, type PhotoMeta } from '../lib/chat';
import { loadSharedMedia, monthLabel, type MediaTab, type SharedEntry } from '../lib/chat-extras';
import { VoiceNote } from '../lib/chat-ui';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const TABS: { key: MediaTab; label: string }[] = [
  { key: 'media', label: 'Media' },
  { key: 'songs', label: 'Songs' },
  { key: 'links', label: 'Links' },
  { key: 'docs', label: 'Docs' },
  { key: 'voice', label: 'Voice' },
];

/** Entries grouped by "This month" / "Last month" / "Month YYYY" (input newest first). */
function byMonth(list: SharedEntry[]): { label: string; items: SharedEntry[] }[] {
  const out: { label: string; items: SharedEntry[] }[] = [];
  for (const e of list) {
    const label = monthLabel(e.message.created_at);
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(e);
    else out.push({ label, items: [e] });
  }
  return out;
}

/**
 * Shared media (`/chat-media?id=<conversation>[&name=]`, MsgMedia design): tabs Media / Songs / Links / Docs /
 * Voice with counts, grouped by month. Encrypted photos and voice notes are decrypted on this phone
 * (useChatMediaUrl → decryptedMediaUri). View-once photos are never listed.
 */
export default function ChatMedia() {
  const params = useLocalSearchParams<{ id?: string; uid?: string; name?: string; avatar?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const peer = peerFromParams(params.uid, params.name, params.avatar);
  const { user } = useAuth();
  const me = user?.id;
  const { playTracks } = usePlayerPick();
  const [tab, setTab] = useState<MediaTab>('media');
  const [viewing, setViewing] = useState<number | null>(null);
  const data = useAsync(() => (cid && me ? loadSharedMedia(cid) : Promise.resolve(null)), [cid, me]);
  const first = peer?.display_name?.split(' ')[0];

  const photos = useMemo<ViewerPhoto[]>(
    () =>
      (data.data?.media ?? []).flatMap((e) => {
        const ph = photoMeta(e.message);
        return ph ? [{ id: e.message.id, path: ph.path, key: ph.key, mime: ph.mime, width: ph.width, height: ph.height, senderName: e.message.sender_id === me ? 'You' : (first ?? 'Photo'), at: e.message.created_at }] : [];
      }),
    [data.data, me, first],
  );
  const list = data.data?.[tab] ?? [];
  const groups = byMonth(list);
  const songs = (data.data?.songs ?? []).flatMap((e) => (e.track ? [e.track] : []));

  const section = (label: string, children: ReactNode) => (
    <View key={label} style={{ gap: 10 }}>
      <T size={12} weight={600} tracking={1.2} color={colors.textSecondary} accessibilityRole="header" style={{ paddingHorizontal: 4 }}>
        {label.toUpperCase()}
      </T>
      {children}
    </View>
  );

  return (
    <Screen top={4} gap={14} onRefresh={data.refresh} backdrop={{ pattern: 'none', mesh: 'rose', orbs: false }}>
      <Row style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat-info', params: { id: cid } }))} />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={32} weight={300} tracking={-1} accessibilityRole="header">
          Media, links and songs
        </T>
        <T size={14} color={colors.textSecondary}>
          Everything you{first ? ` and ${first}` : ''} shared.
        </T>
      </View>
      <Row gap={8} style={{ flexWrap: 'wrap' }} accessibilityRole="tablist">
        {TABS.map((t) => {
          const on = tab === t.key;
          const n = data.data?.[t.key].length;
          return (
            <Tap
              key={t.key}
              onPress={() => setTab(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${t.label}${n !== undefined ? `, ${n}` : ''}`}
              style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, justifyContent: 'center', backgroundColor: on ? colors.text : withAlpha(colors.white, 0.06), borderWidth: on ? 0 : 1, borderColor: withAlpha(colors.white, 0.12) }}
            >
              <T size={13} weight={600} color={on ? colors.onLight : colors.text}>
                {t.label}
                {n !== undefined ? ` ${n}` : ''}
              </T>
            </Tap>
          );
        })}
      </Row>

      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : !list.length ? (
        <EmptyState
          icon={tab === 'songs' ? 'music' : tab === 'links' ? 'search' : tab === 'docs' ? 'download' : tab === 'voice' ? 'music' : 'heart'}
          title={tab === 'docs' ? 'No documents' : `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} yet`}
          body={tab === 'docs' ? 'Documents you share in this chat show up here.' : 'Things you share in this chat show up here.'}
        />
      ) : tab === 'media' ? (
        groups.map((g) => {
          const rows: SharedEntry[][] = [];
          for (let i = 0; i < g.items.length; i += 3) rows.push(g.items.slice(i, i + 3));
          return section(
            g.label,
            <View style={{ gap: 6 }}>
              {rows.map((r, ri) => (
                <Row key={ri} gap={6}>
                  {r.map((e) => {
                    const ph = photoMeta(e.message);
                    const at = photos.findIndex((p) => p.id === e.message.id);
                    return ph ? <Tile key={e.message.id} meta={ph} onOpen={() => setViewing(at >= 0 ? at : null)} /> : null;
                  })}
                  {Array.from({ length: 3 - r.length }, (_, i) => (
                    <View key={`pad${i}`} style={{ flex: 1 }} />
                  ))}
                </Row>
              ))}
            </View>,
          );
        })
      ) : tab === 'songs' ? (
        groups.map((g) =>
          section(
            g.label,
            g.items.map((e) => {
              const t = e.track;
              if (!t) return null;
              const i = songs.findIndex((s) => s.id === t.id);
              return (
                <Tap
                  key={`${e.message.id}-${t.id}`}
                  onPress={() => {
                    playTracks(songs, Math.max(0, i), 'Shared in chat');
                    router.push('/player');
                  }}
                  accessibilityLabel={`Play ${t.title}${trackArtist(t) ? ` by ${trackArtist(t)}` : ''}`}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}
                >
                  <Cover artwork={t.artwork} id={t.id} size={48} radius={14} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={15} weight={500} numberOfLines={1}>
                      {t.title}
                    </T>
                    <T size={12} color={colors.textSecondary} numberOfLines={1}>
                      {trackArtist(t)} · {e.message.sender_id === me ? 'You' : (first ?? 'Them')} · {dayLabel(e.message.created_at)}
                    </T>
                  </View>
                  <Icon name="play" size={16} color={colors.text} filled />
                </Tap>
              );
            }),
          ),
        )
      ) : tab === 'links' ? (
        groups.map((g) =>
          section(
            g.label,
            g.items.map((e, i) => (
              <Tap
                key={`${e.message.id}-${i}`}
                onPress={() => e.link && void Linking.openURL(e.link).catch(() => undefined)}
                accessibilityRole="link"
                accessibilityLabel={`Open ${e.link}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, padding: 10, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06) }}
              >
                <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="link" size={18} color={colors.accentLight} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={14} weight={500} numberOfLines={1}>
                    {(e.link ?? '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}
                  </T>
                  <T size={12} color={colors.textSecondary} numberOfLines={1}>
                    {e.link}
                  </T>
                </View>
              </Tap>
            )),
          ),
        )
      ) : tab === 'voice' ? (
        groups.map((g) =>
          section(
            g.label,
            g.items.map((e) => {
              const v = voiceMeta(e.message);
              const mine = e.message.sender_id === me;
              return v ? (
                <View key={e.message.id} style={{ gap: 4, padding: 12, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.06) }}>
                  <T size={12} color={colors.textSecondary}>
                    {mine ? 'You' : (first ?? 'Them')} · {dayLabel(e.message.created_at)}
                  </T>
                  <VoiceNote meta={v} mine={false} />
                </View>
              ) : null;
            }),
          ),
        )
      ) : null}
      <PhotoViewer photos={photos} index={viewing} onClose={() => setViewing(null)} onIndexChange={setViewing} />
    </Screen>
  );
}

function Tile({ meta, onOpen }: { meta: PhotoMeta; onOpen: () => void }) {
  const media = useChatMediaUrl(meta.path, meta.key, meta.mime);
  return (
    <Tap onPress={onOpen} pressScale={0.97} accessibilityLabel="Photo. Open full screen" style={{ flex: 1, aspectRatio: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }}>
      {media.url ? (
        <Image source={{ uri: media.url }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" transition={150} accessibilityIgnoresInvertColors />
      ) : media.error ? (
        <Icon name="camera" size={18} color={colors.textSecondary} />
      ) : (
        <ActivityIndicator color={colors.textSecondary} />
      )}
    </Tap>
  );
}
