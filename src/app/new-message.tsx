import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, Icon, IconButton, LinkText, Loading, Row, Screen, ScreenHeader, T, Tap, flash, useAsync, useDebounced, useStatusColors } from '../components';
import { chatPeerParams } from '../lib/chat';
import { type DmContact, searchContacts, startChat, useRequestCount } from '../lib/dm';
import { useOnlineUsers } from '../lib/presence';
import { friendlySocialError } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

const AMBER = colors.gold;
const AMBER_TEXT = '#FFD27A';

function ContactAvatar({ c, size, r, online }: { c: DmContact; size: number; r: number; online?: boolean }) {
  const status = useStatusColors();
  return (
    <View style={{ width: size, height: size }}>
      <Cover uri={c.avatar_url} id={c.id} size={size} radius={r} style={{ alignItems: 'center', justifyContent: 'center' }}>
        {c.avatar_url ? null : (
          <T size={Math.max(8, Math.round(size / 3))} weight={600} color={colors.white}>
            {(c.display_name[0] ?? '?').toUpperCase()}
          </T>
        )}
      </Cover>
      {online ? (
        <View style={{ position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, borderRadius: 6, backgroundColor: status.success, borderWidth: 2, borderColor: colors.playerBg }} />
      ) : null}
    </View>
  );
}

/** Row subtitle (New message design): Active now / taste match / follows + mutuals / why it's locked. */
function subtitle(c: DmContact, online: boolean) {
  // Their exact privacy setting stays private: the design's wording, without revealing which rule applies.
  if (c.access === 'locked') return c.i_follow ? 'Isn’t accepting new chats right now' : 'Only accepts people they follow';
  if (online) return 'Active now';
  const mutual = c.mutual_count > 0 ? `${c.mutual_count} mutual ${c.mutual_count === 1 ? 'friend' : 'friends'}` : '';
  if (c.access === 'direct' && typeof c.taste_match === 'number' && c.taste_match >= 50) return `${Math.round(c.taste_match)}% taste match`;
  if (c.follows_me && mutual) return `Follows you · ${mutual}`;
  if (c.follows_me) return 'Follows you';
  if (mutual) return mutual;
  if (c.i_follow) return 'You follow them';
  return c.access === 'request' ? 'Your message goes to their requests' : '';
}

function AccessPill({ access }: { access: DmContact['access'] }) {
  if (access === 'request')
    return (
      <View style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, justifyContent: 'center', backgroundColor: withAlpha(AMBER, 0.14), borderWidth: 1, borderColor: withAlpha(AMBER, 0.35) }}>
        <T size={11} weight={600} color={AMBER_TEXT}>
          Request
        </T>
      </View>
    );
  if (access === 'locked')
    return (
      <Row gap={4} style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: withAlpha(colors.white, 0.18) }}>
        <Icon name="lock" size={12} color={colors.peach} />
        <T size={11} weight={600} color={colors.peach}>
          Locked
        </T>
      </Row>
    );
  return null;
}

function ContactRow({ c, first, selected, online, onPress }: { c: DmContact; first: boolean; selected: boolean; online: boolean; onPress: () => void }) {
  const locked = c.access === 'locked';
  const sub = subtitle(c, online);
  return (
    <Tap
      onPress={onPress}
      disabled={locked}
      pressScale={0.98}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: locked }}
      accessibilityLabel={`${c.display_name}${c.username ? `, @${c.username}` : ''}${sub ? `, ${sub}` : ''}${c.access === 'request' ? ', will be sent as a request' : ''}${locked ? ', locked' : ''}`}
      style={[{ minHeight: 72, paddingHorizontal: 12, justifyContent: 'center' }, !first && { borderTopWidth: 1, borderTopColor: colors.divider }, locked && { opacity: 0.6 }]}
    >
      <Row gap={12}>
        <ContactAvatar c={c} size={46} r={15} online={online} />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T size={15} weight={600} numberOfLines={1}>
            {c.display_name}
            {c.username ? (
              <T size={13} weight={400} color={colors.textSecondary}>
                {`  @${c.username}`}
              </T>
            ) : null}
          </T>
          {sub ? (
            <T size={12} color={colors.textSecondary} numberOfLines={2}>
              {sub}
            </T>
          ) : null}
        </View>
        <AccessPill access={c.access} />
        <View
          style={
            selected
              ? { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }
              : { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: withAlpha(colors.white, 0.3) }
          }
        >
          {selected ? <Icon name="checkBold" size={14} color={colors.onAccent} /> : null}
        </View>
      </Row>
    </Tap>
  );
}

function Tile({ icon, label, href, badge }: { icon: 'users' | 'mail' | 'qr'; label: string; href: '/new-group' | '/message-requests' | '/profile-qr'; badge?: number }) {
  return (
    <Tap
      href={href}
      accessibilityLabel={badge ? `${label}, ${badge} pending` : label}
      style={{ flex: 1, minHeight: 84, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12), alignItems: 'center', justifyContent: 'center', gap: 6 }}
    >
      <Icon name={icon} size={22} color={colors.text} />
      <T size={12} weight={600} align="center">
        {label}
      </T>
      {badge ? (
        <View style={{ position: 'absolute', top: 8, right: 10, minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
          <T size={11} weight={700} color={colors.onAccent}>
            {badge > 99 ? '99+' : badge}
          </T>
        </View>
      ) : null}
    </Tap>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <T size={13} weight={600} tracking={0.6} color={colors.textSecondary} accessibilityRole="header" style={{ marginHorizontal: 4, marginTop: 4 }}>
      {children.toUpperCase()}
    </T>
  );
}

export default function NewMessage() {
  const { user } = useAuth();
  const me = user?.id;
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 300);
  const [selected, setSelected] = useState<DmContact | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { count: requestCount } = useRequestCount(me);
  const onlineIds = useOnlineUsers();
  const contacts = useAsync(() => (me ? searchContacts(q) : Promise.resolve([] as DmContact[])), [q, me], 'app/new-message:154');

  const list = (contacts.data ?? []).filter((c) => c.access !== 'blocked' && c.id !== me);
  const direct = list.filter((c) => c.access === 'direct');
  const others = list.filter((c) => c.access !== 'direct');

  const toggle = (c: DmContact) => {
    setNote(null);
    setSelected((s) => (s?.id === c.id ? null : c));
  };

  const chat = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const { id, request } = await startChat(selected.id);
      if (request) flash('Sent as a request');
      router.replace({ pathname: '/chat-pro', params: { id, ...chatPeerParams(selected) } });
    } catch (e) {
      setNote(friendlySocialError(e, 'Could not start a conversation'));
    } finally {
      setBusy(false);
    }
  };

  const canChat = !!selected && !busy;
  const chatButton = (
    <Tap
      onPress={() => void chat()}
      disabled={!canChat}
      accessibilityLabel={selected ? `Chat with ${selected.display_name}` : 'Chat. Pick someone first'}
      accessibilityState={{ disabled: !canChat, busy }}
      style={{ minHeight: 44, justifyContent: 'center' }}
    >
      <View style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: canChat ? colors.accent : withAlpha(colors.white, 0.08) }}>
        <T size={14} weight={600} color={canChat ? colors.onAccent : colors.textTertiary}>
          {busy ? 'Opening…' : 'Chat'}
        </T>
      </View>
    </Tap>
  );

  const renderSection = (title: string, rows: DmContact[]) =>
    rows.length ? (
      <View style={{ gap: 10 }}>
        <SectionLabel>{title}</SectionLabel>
        <Glass padding={0} style={{ paddingVertical: 4 }}>
          <View accessibilityRole="radiogroup">
            {rows.map((c, i) => (
              <ContactRow key={c.id} c={c} first={i === 0} selected={selected?.id === c.id} online={onlineIds.has(c.id)} onPress={() => toggle(c)} />
            ))}
          </View>
        </Glass>
      </View>
    ) : null;

  return (
    <Screen top={4} gap={16} bottom={16} backdrop={{ pattern: 'dots', mesh: 'amber' }}>
      <ScreenHeader title="New message" backIcon="close" right={chatButton} />

      <Glass padding={0} style={{ paddingVertical: 12, paddingHorizontal: 14 }}>
        <View style={{ gap: 10 }}>
          <T size={12} weight={600} color={colors.textSecondary} nativeID="nm-to-label">
            To
          </T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            {selected ? (
              <Row
                gap={6}
                style={{ height: 32, paddingLeft: 4, paddingRight: 2, borderRadius: 16, backgroundColor: withAlpha(colors.accent, 0.22), borderWidth: 1, borderColor: withAlpha(colors.accent, 0.5) }}
              >
                <ContactAvatar c={selected} size={24} r={12} />
                <T size={13} weight={600} numberOfLines={1} style={{ maxWidth: 160 }}>
                  {selected.display_name}
                </T>
                <IconButton icon="close" label={`Remove ${selected.display_name}`} size={28} iconSize={14} onPress={() => setSelected(null)} />
              </Row>
            ) : null}
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search name or @username"
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel="To: search name or username"
              accessibilityLabelledBy="nm-to-label"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{ flex: 1, minWidth: 150, height: 44, color: colors.text, fontFamily: fonts.regular, fontSize: 15 }}
            />
          </View>
        </View>
      </Glass>

      <Row gap={10}>
        <Tile icon="users" label="New group" href="/new-group" />
        <Tile icon="mail" label="Requests" href="/message-requests" badge={requestCount} />
        <Tile icon="qr" label="Scan QR" href="/profile-qr" />
      </Row>

      {note ? (
        <Tap onPress={() => setNote(null)} accessibilityLabel={`${note}. Dismiss`}>
          <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
            {note}
          </T>
        </Tap>
      ) : null}

      {!me ? (
        <EmptyState icon="mail" title="Sign in to message" body="Chat and share songs with friends." action="Sign in" href="/login" />
      ) : contacts.loading && !contacts.data ? (
        <Loading />
      ) : contacts.error ? (
        <ErrorState message={friendlySocialError({ message: contacts.error }, 'Could not load people')} onRetry={contacts.reload} />
      ) : list.length === 0 ? (
        q.trim() ? (
          <EmptyState icon="search" title={`No one matches “${q.trim()}”`} body="Try a different name or @username." />
        ) : (
          <EmptyState icon="users" title="No one to message yet" body="Follow people to start a conversation." action="Find people" href="/followers" />
        )
      ) : (
        <>
          {renderSection('Mutual friends · can message', direct)}
          {renderSection('Others · access depends on their settings', others)}
        </>
      )}

      <Row gap={10} align="flex-start" style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <View style={{ marginTop: 2 }}>
          <Icon name="info" size={18} color={AMBER_TEXT} />
        </View>
        <View style={{ flex: 1 }}>
          <T size={12} lineHeight={18} color={colors.peach}>
            Mutual friends get your message straight away. Anyone else gets it as a request they can accept or decline.
          </T>
          <LinkText label="Message privacy" href="/dm-privacy" size={12} />
        </View>
      </Row>
    </Screen>
  );
}
