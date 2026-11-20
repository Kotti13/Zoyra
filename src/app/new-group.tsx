import { router } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { EmptyState, ErrorState, Glass, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, useAsync, useDebounced } from '../components';
import { ChatAvatar } from '../lib/chat-ui';
import { searchContacts, type DmContact } from '../lib/dm';
import { PickRow, PickSearch } from '../lib/group-ui';
import { checkInvites, createGroup, GROUP_MAX_MEMBERS, GROUP_TITLE_MAX, groupError, type InviteCheck } from '../lib/groups';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

/** Contacts plus whether I may add each to a group (group_invite_check). */
async function loadPickable(q: string): Promise<{ contacts: DmContact[]; checks: Map<string, InviteCheck> }> {
  const contacts = (await searchContacts(q)).filter((c) => c.access !== 'blocked');
  const checks = await checkInvites(contacts.map((c) => c.id)).catch(() => new Map<string, InviteCheck>());
  return { contacts, checks };
}

/**
 * New group (`/new-group`): name the group, pick members from my contacts (people whose group-invite
 * privacy doesn't allow me are shown greyed out with the reason), Create → /group-chat.
 */
export default function NewGroup() {
  const { user } = useAuth();
  const me = user?.id;
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 300);
  const [picked, setPicked] = useState<Map<string, DmContact>>(new Map());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const list = useAsync(() => (me ? loadPickable(q) : Promise.resolve({ contacts: [] as DmContact[], checks: new Map<string, InviteCheck>() })), [q, me], 'app/new-group:33');

  const toggle = (c: DmContact) => {
    setNote(null);
    setPicked((cur) => {
      const next = new Map(cur);
      if (next.has(c.id)) next.delete(c.id);
      else if (next.size + 1 >= GROUP_MAX_MEMBERS) setNote(`Groups can have up to ${GROUP_MAX_MEMBERS} people.`);
      else next.set(c.id, c);
      return next;
    });
  };

  const create = async () => {
    if (!picked.size || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const id = await createGroup(name, [...picked.keys()]);
      router.replace({ pathname: '/group-chat', params: { id } });
    } catch (e) {
      setNote(groupError(e, 'Could not create the group'));
    } finally {
      setBusy(false);
    }
  };

  const can = picked.size > 0 && !busy;
  const createButton = (
    <Tap onPress={() => void create()} disabled={!can} accessibilityLabel={can ? `Create group with ${picked.size} people` : 'Create. Pick people first'} accessibilityState={{ disabled: !can, busy }} style={{ minHeight: 44, justifyContent: 'center' }}>
      <View style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', backgroundColor: can ? colors.accent : withAlpha(colors.white, 0.08) }}>
        <T size={14} weight={600} color={can ? colors.onAccent : colors.textTertiary}>
          {busy ? 'Creating…' : 'Create'}
        </T>
      </View>
    </Tap>
  );

  const contacts = (list.data?.contacts ?? []).filter((c) => c.id !== me);
  const checks = list.data?.checks ?? new Map<string, InviteCheck>();
  const sorted = [...contacts].sort((a, b) => Number(checks.get(b.id)?.ok !== false) - Number(checks.get(a.id)?.ok !== false));

  return (
    <Screen top={4} gap={16} bottom={16} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
      <ScreenHeader title="New group" backIcon="close" right={createButton} />

      <Glass padding={0} style={{ paddingVertical: 12, paddingHorizontal: 14 }}>
        <View style={{ gap: 8 }}>
          <T size={12} weight={600} color={colors.textSecondary}>
            Group name
          </T>
          <TextInput
            value={name}
            onChangeText={(t) => setName(t.slice(0, GROUP_TITLE_MAX))}
            placeholder="Friday jam crew"
            placeholderTextColor={colors.textTertiary}
            accessibilityLabel="Group name (optional)"
            maxLength={GROUP_TITLE_MAX}
            returnKeyType="done"
            style={{ height: 44, color: colors.text, fontFamily: fonts.medium, fontSize: 17 }}
          />
          <T size={12} color={colors.textSecondary}>
            Optional. Without a name the group is called after its members.
          </T>
        </View>
      </Glass>

      {picked.size ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }} accessibilityLabel={`${picked.size} selected`}>
          {[...picked.values()].map((c) => (
            <Row key={c.id} gap={6} style={{ height: 32, paddingLeft: 4, paddingRight: 2, borderRadius: 16, backgroundColor: withAlpha(colors.accent, 0.22), borderWidth: 1, borderColor: withAlpha(colors.accent, 0.5) }}>
              <ChatAvatar person={c} size={24} radius={12} />
              <T size={13} weight={600} numberOfLines={1} style={{ maxWidth: 140 }}>
                {c.display_name}
              </T>
              <IconButton icon="close" label={`Remove ${c.display_name}`} size={28} iconSize={14} onPress={() => toggle(c)} />
            </Row>
          ))}
        </View>
      ) : null}

      <PickSearch value={query} onChange={setQuery} />

      {note ? (
        <Tap onPress={() => setNote(null)} accessibilityLabel={`${note}. Dismiss`}>
          <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
            {note}
          </T>
        </Tap>
      ) : null}

      {!me ? (
        <EmptyState icon="users" title="Sign in to make a group" action="Sign in" href="/login" />
      ) : list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <ErrorState message={groupError({ message: list.error }, 'Could not load people')} onRetry={list.reload} />
      ) : !sorted.length ? (
        q.trim() ? <EmptyState icon="search" title={`No one matches “${q.trim()}”`} /> : <EmptyState icon="users" title="No one to add yet" body="Follow people to start a group." action="Find people" href="/followers" />
      ) : (
        <Glass padding={0} style={{ paddingVertical: 4 }}>
          {sorted.map((c, i) => (
            <PickRow key={c.id} c={c} first={i === 0} selected={picked.has(c.id)} check={checks.get(c.id)} onPress={() => toggle(c)} />
          ))}
        </Glass>
      )}

      <T size={12} lineHeight={18} color={colors.textSecondary}>
        People choose who can add them to groups in Message privacy. Up to {GROUP_MAX_MEMBERS} people per group.
      </T>
    </Screen>
  );
}
