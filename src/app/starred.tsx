import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Cover, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, T, Tap, useAsync } from '../components';
import { chatError, dayLabel, messagePreview, photoMeta, trackArtist, useChatMediaUrl, type PhotoMeta } from '../lib/chat';
import { linksIn, loadStarred, setStarred, starKind, type StarFilter, type StarredItem } from '../lib/chat-extras';
import { ChatAvatar } from '../lib/chat-ui';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const FILTERS: { key: StarFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'text', label: 'Text' },
  { key: 'songs', label: 'Songs' },
  { key: 'photos', label: 'Photos' },
  { key: 'links', label: 'Links' },
];

/**
 * Starred messages (`/starred[?cid=<conversation>]`, MsgStarred design): every message I starred (long-press ›
 * Star), across all chats or one chat, decrypted on this phone. Filters All / Text / Songs / Photos / Links.
 * Tap → opens the chat and jumps to the message; the star unstars it.
 */
export default function Starred() {
  const params = useLocalSearchParams<{ cid?: string }>();
  const cid = typeof params.cid === 'string' && params.cid ? params.cid : undefined;
  const { user } = useAuth();
  const me = user?.id;
  const [filter, setFilter] = useState<StarFilter>('all');
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const list = useAsync(() => (me ? loadStarred(cid) : Promise.resolve([])), [me, cid]);
  const items = (list.data ?? []).filter((it) => !removed.has(it.message.id));
  const shown = filter === 'all' ? items : items.filter((it) => starKind(it.message) === filter);

  const unstar = async (it: StarredItem) => {
    if (!me) return;
    setRemoved((s) => new Set(s).add(it.message.id));
    try {
      await setStarred(it.message.id, me, false);
    } catch (e) {
      setRemoved((s) => {
        const n = new Set(s);
        n.delete(it.message.id);
        return n;
      });
      setNote(chatError(e, 'Could not unstar'));
    }
  };

  const open = (it: StarredItem) => router.push({ pathname: it.chat.group ? '/group-chat' : '/chat-pro', params: { id: it.chat.id, jump: it.message.id } });

  return (
    <Screen top={4} gap={14} onRefresh={list.refresh} backdrop={{ pattern: 'none', mesh: 'rose', orbs: false }}>
      <Row style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={() => (router.canGoBack() ? router.back() : router.replace('/messages'))} />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} accessibilityRole="header">
          Starred
        </T>
        <T size={14} color={colors.textSecondary}>
          {list.loading ? 'Loading…' : `${items.length === 1 ? '1 message' : `${items.length} messages`} you saved ${cid ? 'from this chat' : 'from every chat'}.`}
        </T>
      </View>
      <Row gap={8} style={{ flexWrap: 'wrap' }} accessibilityRole="tablist">
        {FILTERS.map((f) => {
          const on = filter === f.key;
          return (
            <Tap
              key={f.key}
              onPress={() => setFilter(f.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: on ? colors.text : withAlpha(colors.white, 0.06), borderWidth: on ? 0 : 1, borderColor: withAlpha(colors.white, 0.12) }}
            >
              <T size={13} weight={600} color={on ? colors.onLight : colors.text}>
                {f.label}
              </T>
            </Tap>
          );
        })}
      </Row>
      {note ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}
      {list.loading ? (
        <Loading />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !shown.length ? (
        <EmptyState icon="heart" title={items.length ? 'Nothing in this filter' : 'No starred messages'} body="Long-press a message and tap Star to keep it here." />
      ) : (
        shown.map((it) => <StarCard key={it.message.id} it={it} me={me} onOpen={() => open(it)} onUnstar={() => void unstar(it)} />)
      )}
    </Screen>
  );
}

function StarCard({ it, me, onOpen, onUnstar }: { it: StarredItem; me: string | undefined; onOpen: () => void; onUnstar: () => void }) {
  const m = it.message;
  const mine = m.sender_id === me;
  const ph = photoMeta(m);
  const link = m.body ? linksIn(m.body)[0] : undefined;
  const who = mine ? 'You' : it.chat.group ? it.chat.title : it.chat.person?.display_name || it.chat.title;
  return (
    <Tap
      onPress={onOpen}
      accessibilityLabel={`${who}, ${dayLabel(m.created_at)}: ${messagePreview(m)}. Open in chat`}
      pressScale={0.98}
      style={{ padding: 14, gap: 10, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
    >
      <Row gap={10}>
        <ChatAvatar person={it.chat.person} size={28} radius={10} />
        <T size={13} weight={600} numberOfLines={1} style={{ flex: 1 }}>
          {who}
        </T>
        <T size={12} color={colors.textSecondary}>
          {dayLabel(m.created_at)}
        </T>
        <Tap onPress={onUnstar} accessibilityLabel="Unstar" hitSlop={8} style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="star" size={18} color={colors.gold} filled />
        </Tap>
      </Row>
      {m.track ? (
        <>
          {m.body ? <T size={15}>{m.body}</T> : <T size={15} weight={600}>{m.track.title}</T>}
          <Row gap={10} style={{ padding: 8, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.06) }}>
            <Cover artwork={m.track.artwork} id={m.track.id} size={36} radius={18} />
            <T size={13} color={colors.textSecondary} numberOfLines={1} style={{ flex: 1 }}>
              {trackArtist(m.track)}
              {m.track.duration ? ` · ${Math.floor(m.track.duration / 60)}:${String(Math.floor(m.track.duration % 60)).padStart(2, '0')}` : ''}
            </T>
          </Row>
        </>
      ) : ph ? (
        <StarPhoto meta={ph} />
      ) : link ? (
        <View style={{ gap: 4 }}>
          <T size={15} numberOfLines={3}>
            {m.body}
          </T>
          <Row gap={6}>
            <Icon name="link" size={14} color={colors.accentLight} />
            <T size={12} color={colors.accentLight} numberOfLines={1} style={{ flex: 1 }}>
              {link}
            </T>
          </Row>
        </View>
      ) : (
        <T size={15} numberOfLines={4}>
          {messagePreview(m)}
        </T>
      )}
    </Tap>
  );
}

function StarPhoto({ meta }: { meta: PhotoMeta }) {
  const media = useChatMediaUrl(meta.path, meta.key, meta.mime);
  return (
    <View style={{ height: 160, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.surface2 }}>
      {media.url ? <Image source={{ uri: media.url }} style={{ position: 'absolute', inset: 0 }} contentFit="cover" accessibilityLabel="Starred photo" accessibilityIgnoresInvertColors /> : null}
    </View>
  );
}
