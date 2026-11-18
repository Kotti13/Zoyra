import { useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { IconButton, ListGroup, ListRow, Screen, T } from '../components';
import { ForeverAvatar, GoldCard, ShineText } from '../components/forever';
import { decryptChatRows, messagePreview, MSG_SELECT, type ChatMessage } from '../lib/chat';
import { firstName, foreverErrorMessage, foreverSinceLabel, foreverVault, GOLD, useForeverFriend, useForeverPerson, type ForeverVault } from '../lib/forever';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Starred = { message: ChatMessage; starredBy: string[]; at: string };

/** Starred messages (loaded + decrypted on this phone; the vault RPC only returns ids). */
async function loadStarred(v: ForeverVault): Promise<Starred[]> {
  if (!v.starred.length) return [];
  const ids = v.starred.map((s) => s.message_id);
  const { data, error } = await supabase.from('messages').select(MSG_SELECT).in('id', ids);
  if (error) throw error;
  const rows = await decryptChatRows((data ?? []) as ChatMessage[]);
  const byId = new Map(rows.map((m) => [m.id, m]));
  return v.starred.flatMap((s) => {
    const m = byId.get(s.message_id);
    return m ? [{ message: m, starredBy: s.starred_by, at: s.starred_at }] : [];
  });
}

const dateLabel = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

/**
 * Shared vault with a Forever friend, `/forever-vault?uid=`: both people's starred messages from your 1:1 chat
 * and your milestones (Became Forever, monthly / yearly anniversaries, message counts, streaks).
 */
export default function ForeverVaultScreen() {
  const params = useLocalSearchParams<{ uid?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const person = useForeverPerson(uid);
  const friend = useForeverFriend(uid);
  const { user } = useAuth();
  const [vault, setVault] = useState<ForeverVault | null>(null);
  const [starred, setStarred] = useState<Starred[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [tick, setTick] = useState(0);
  const resolveRefresh = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!uid) return;
    let alive = true;
    foreverVault(uid)
      .then(async (v) => {
        if (!alive) return;
        setVault(v);
        setError(null);
        const s = await loadStarred(v).catch(() => [] as Starred[]);
        if (alive) setStarred(s);
      })
      .catch((e) => alive && setError(foreverErrorMessage(e, 'Could not open the vault.')))
      .finally(() => {
        resolveRefresh.current?.();
        resolveRefresh.current = null;
      });
    return () => {
      alive = false;
    };
  }, [uid, tick]);

  const load = useCallback(
    () =>
      new Promise<void>((resolve) => {
        resolveRefresh.current?.();
        resolveRefresh.current = resolve;
        setTick((t) => t + 1);
      }),
    [],
  );

  const first = firstName(person?.display_name, 'them');
  const chatHref = vault?.conversation_id ? (`/chat-pro?id=${encodeURIComponent(vault.conversation_id)}` as Href) : undefined;

  return (
    <Screen gap={16} onRefresh={load}>
      <View style={{ flexDirection: 'row' }}>
        <IconButton icon="back" label="Back" href="back" bg={colors.glass} />
      </View>
      <GoldCard strong radius={32} style={{ padding: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <ForeverAvatar person={person ?? null} size={54} radius={18} forever />
          <View style={{ flex: 1, gap: 3 }}>
            <ShineText size={22} weight={800}>
              Shared vault
            </ShineText>
            <T size={13} color={GOLD.text}>
              {friend ? `You and ${first} · Forever since ${foreverSinceLabel(friend.since)} · Day ${friend.days}` : `You and ${first}`}
            </T>
          </View>
        </View>
      </GoldCard>

      {error ? (
        <T size={14} color={colors.error}>
          {error}
        </T>
      ) : null}

      <ListGroup title="MEMORIES">
        {vault === null && !error ? <ListRow title="Loading…" right={false} /> : null}
        {(vault?.milestones ?? []).map((m, i) => (
          <ListRow
            key={m.key}
            divider={i > 0}
            icon={m.kind === 'messages' ? 'chat' : m.kind === 'streak' ? 'flame' : m.kind === 'anniversary' ? 'trophy' : 'star'}
            iconColor={GOLD.mid}
            iconBg={`rgba(255,176,32,0.14)`}
            title={m.title}
            subtitle={dateLabel(m.reached_at)}
            right={false}
          />
        ))}
      </ListGroup>

      <ListGroup title="STARRED MESSAGES">
        {starred === null && vault !== null ? <ListRow title="Loading…" right={false} /> : null}
        {starred?.length === 0 ? (
          <ListRow
            title={vault?.starred_ready === false ? 'Starred messages need the latest backend update' : 'Nothing starred yet'}
            subtitle={`Star a message in your chat with ${first} and it lands here for both of you.`}
            href={chatHref}
            right={chatHref ? undefined : false}
          />
        ) : null}
        {(starred ?? []).map((s, i) => {
          const mine = s.message.sender_id === user?.id;
          return (
            <ListRow
              key={s.message.id}
              divider={i > 0}
              icon="star"
              iconColor={GOLD.mid}
              iconBg="rgba(255,176,32,0.14)"
              title={messagePreview(s.message)}
              subtitle={`${mine ? 'You' : first} · ${dateLabel(s.message.created_at)}${s.starredBy.length > 1 ? ' · starred by both' : ''}`}
              href={chatHref}
              right={false}
            />
          );
        })}
      </ListGroup>
    </Screen>
  );
}
