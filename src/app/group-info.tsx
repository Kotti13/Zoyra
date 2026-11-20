import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { EmptyState, ErrorState, Glass, Icon, IconButton, ListRow, Loading, Row, Screen, T, Tap, Toggle, useAsync, useDebounced } from '../components';
import { chatError, loadMySettings, updateMySettings } from '../lib/chat';
import { ChatAvatar, GroupAvatar } from '../lib/chat-ui';
import { confirmClearHref } from '../lib/confirm-routes';
import { confirmDialog, showDialog } from '../lib/dialog';
import { searchContacts, type DmContact } from '../lib/dm';
import { PickRow, PickSearch } from '../lib/group-ui';
import {
  addGroupMembers,
  checkInvites,
  clearGroupPhoto,
  firstName,
  GROUP_MAX_MEMBERS,
  GROUP_TITLE_MAX,
  groupError,
  isAdmin,
  leaveGroup,
  loadGroupInfo,
  loadGroupMembers,
  removeGroupMember,
  renameGroup,
  roleLabel,
  setGroupPhoto,
  setGroupRole,
  startGroupJam,
  type GroupMember,
  type InviteCheck,
} from '../lib/groups';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

const PILL_BG = withAlpha(colors.white, 0.06);
const PILL_BORDER = withAlpha(colors.white, 0.12);

function SectionLabel({ children }: { children: string }) {
  return (
    <T size={12} weight={600} tracking={1.2} color={colors.textSecondary} accessibilityRole="header" style={{ paddingHorizontal: 4 }}>
      {children}
    </T>
  );
}

async function loadAll(cid: string, me: string) {
  const [group, members, mine] = await Promise.all([loadGroupInfo(cid), loadGroupMembers(cid), loadMySettings(cid, me)]);
  return { group, members, mine };
}

/**
 * Group info (`/group-info?id=<conversation>`), ChatInfo layout for groups: photo + name (admins can rename
 * and change the photo), Add / Jam / Mute actions, members with roles (tap a member for Make admin,
 * Remove, Make owner, View profile), add members (contact picker honouring group-invite privacy), mute and
 * read receipts, Clear chat and Leave group.
 */
export default function GroupInfo() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const data = useAsync(() => (cid && me ? loadAll(cid, me) : Promise.resolve(null)), [cid, me], 'app/group-info:64');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 300);
  const [picked, setPicked] = useState<Map<string, DmContact>>(new Map());
  const [mineEdit, setMine] = useState<{ muted: boolean; read_receipts: boolean } | null>(null);

  const group = data.data?.group ?? null;
  const members = data.data?.members ?? [];
  const memberIds = new Set(members.map((m) => m.user_id));
  const myRole = members.find((m) => m.user_id === me)?.role ?? null;
  const admin = isAdmin(myRole);
  const loaded = data.data?.mine;
  const mine = mineEdit ?? (loaded ? { muted: loaded.muted, read_receipts: loaded.read_receipts } : null);
  const title = group?.title || 'Group';

  const candidates = useAsync(async () => {
    if (!adding || !me) return { contacts: [] as DmContact[], checks: new Map<string, InviteCheck>() };
    const contacts = (await searchContacts(q)).filter((c) => c.access !== 'blocked' && c.id !== me);
    const checks = await checkInvites(contacts.filter((c) => !memberIds.has(c.id)).map((c) => c.id)).catch(() => new Map<string, InviteCheck>());
    return { contacts, checks };
    // memberIds is derived from data; reloading on q/adding is enough.
  }, [adding, q, me], 'app/group-info:83');

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : groupError(e) });
    } finally {
      setBusy(null);
    }
  };

  const saveName = () => {
    const t = (editingName ?? '').trim();
    if (!t || t === group?.title) return setEditingName(null);
    void run('name', async () => {
      await renameGroup(cid, t);
      setEditingName(null);
      data.reload();
    }, 'Group renamed');
  };

  const changePhoto = async () => {
    if (!admin || !me) return;
    const choice = group?.avatar_url
      ? await showDialog({ title: 'Group photo', actions: [{ label: 'Cancel', style: 'cancel' }, { label: 'Remove photo', style: 'destructive' }, { label: 'Choose photo', style: 'primary' }] })
      : 'Choose photo';
    if (choice === 'Remove photo') {
      void run('photo', async () => {
        await clearGroupPhoto(cid);
        data.reload();
      }, 'Photo removed');
      return;
    }
    if (choice !== 'Choose photo') return;
    void run('photo', async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('Photo library access is needed to pick a group photo.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      await setGroupPhoto(cid, me, res.assets[0].uri, res.assets[0].mimeType);
      data.reload();
    });
  };

  const jam = () =>
    run('jam', async () => {
      const rid = await startGroupJam(cid);
      router.push({ pathname: '/group-listening', params: { id: rid } });
    });

  const setSetting = (patch: { muted?: boolean; read_receipts?: boolean }) => {
    if (!me || !mine) return;
    const prev = mine;
    setMine({ ...mine, ...patch });
    void updateMySettings(cid, me, patch).catch((e: unknown) => {
      setMine(prev);
      setNote({ ok: false, text: chatError(e, 'Setting not saved') });
    });
  };

  const memberOptions = async (m: GroupMember) => {
    if (m.user_id === me) return;
    const name = firstName(m.display_name);
    const acts: { label: string; style?: 'destructive' | 'primary' | 'cancel' | 'default' }[] = [{ label: 'View profile' }, { label: 'Verify security code' }];
    if (myRole === 'owner' || (myRole === 'admin' && m.role === 'member')) {
      if (m.role === 'member') acts.push({ label: 'Make admin' });
      if (m.role === 'admin' && myRole === 'owner') acts.push({ label: 'Remove as admin' });
    }
    if (myRole === 'owner' && m.role !== 'owner') acts.push({ label: 'Make group owner' });
    if (m.role !== 'owner' && (myRole === 'owner' || (myRole === 'admin' && m.role === 'member'))) acts.push({ label: `Remove ${name}`, style: 'destructive' });
    acts.push({ label: 'Cancel', style: 'cancel' });
    const pick = await showDialog({ title: m.display_name, message: roleLabel(m.role) || undefined, actions: acts });
    if (!pick || pick === 'Cancel') return;
    if (pick === 'View profile') return router.push({ pathname: '/public-profile', params: { id: m.user_id } });
    if (pick === 'Verify security code') return router.push({ pathname: '/e2ee-verify', params: { uid: m.user_id, name: m.display_name } });
    if (pick === 'Make admin') return run(`role${m.user_id}`, async () => (await setGroupRole(cid, m.user_id, 'admin'), data.reload()), `${name} is now an admin`);
    if (pick === 'Remove as admin') return run(`role${m.user_id}`, async () => (await setGroupRole(cid, m.user_id, 'member'), data.reload()), `${name} is no longer an admin`);
    if (pick === 'Make group owner') {
      if (!(await confirmDialog(`Make ${name} the owner?`, 'You’ll stay in the group as an admin.', 'Make owner', false))) return;
      return run(`role${m.user_id}`, async () => (await setGroupRole(cid, m.user_id, 'owner'), data.reload()), `${name} now owns the group`);
    }
    if (!(await confirmDialog(`Remove ${name}?`, `${name} will leave ${title} and stop getting its messages.`, 'Remove'))) return;
    void run(`rm${m.user_id}`, async () => (await removeGroupMember(cid, m.user_id), data.reload()), `${name} was removed`);
  };

  const addPicked = () =>
    run('add', async () => {
      const n = await addGroupMembers(cid, [...picked.keys()]);
      setPicked(new Map());
      setAdding(false);
      setQuery('');
      data.reload();
      setNote({ ok: true, text: n === 1 ? 'Added 1 person' : `Added ${n} people` });
    });

  const leave = async () => {
    const owner = myRole === 'owner' && members.length > 1;
    const ok = await confirmDialog(
      `Leave ${title}?`,
      members.length <= 1 ? 'You’re the last member, so the group will be deleted.' : owner ? 'You own this group. An admin (or the longest-standing member) becomes the owner.' : 'You’ll stop getting messages from this group.',
      'Leave group',
    );
    if (!ok) return;
    void run('leave', async () => {
      await leaveGroup(cid);
      router.replace('/messages');
    });
  };

  const goBack = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/group-chat', params: { id: cid } }));

  if (!cid || !me) {
    return (
      <Screen top={4}>
        <EmptyState icon="users" title={me ? 'No group selected' : 'Sign in to see this group'} action="Back" onAction={goBack} />
      </Screen>
    );
  }

  const actions = [
    ...(admin ? [{ key: 'add', label: 'Add', icon: 'plus' as const, on: adding, onPress: () => setAdding((v) => !v) }] : []),
    { key: 'jam', label: busy === 'jam' ? 'Starting…' : 'Jam', icon: 'headphones' as const, on: false, onPress: () => void jam() },
    { key: 'mute', label: mine?.muted ? 'Muted' : 'Mute', icon: (mine?.muted ? 'bellOff' : 'bell') as 'bellOff' | 'bell', on: !!mine?.muted, onPress: () => setSetting({ muted: !mine?.muted }) },
  ];

  const cand = candidates.data?.contacts ?? [];
  const checks = candidates.data?.checks ?? new Map<string, InviteCheck>();

  return (
    <Screen onRefresh={() => Promise.all([data.refresh(), candidates.refresh()])} top={4} gap={16} backdrop={{ pattern: 'none', mesh: 'rose', orbs: true }}>
      <Row gap={8}>
        <IconButton icon="back" label="Back" size={44} iconSize={22} onPress={goBack} />
        <T size={18} weight={600} style={{ flex: 1 }} accessibilityRole="header">
          Group info
        </T>
      </Row>

      {data.loading && !data.data ? (
        <Loading />
      ) : data.error ? (
        <ErrorState message={groupError({ message: data.error }, 'Could not load this group')} onRetry={data.reload} />
      ) : !group || group.kind !== 'group' || !myRole ? (
        <EmptyState icon="users" title="This group is no longer available" action="Back to messages" onAction={() => router.replace('/messages')} />
      ) : (
        <>
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Tap onPress={admin ? () => void changePhoto() : undefined} disabled={!admin} accessibilityLabel={admin ? 'Change group photo' : `${title} photo`} style={{ alignItems: 'center' }}>
              <GroupAvatar avatarUrl={group.avatar_url} title={title} size={88} members={members.filter((m) => m.user_id !== me).map((m) => ({ id: m.user_id, display_name: m.display_name, avatar_url: m.avatar_url, username: m.username }))} />
              {admin ? (
                <View style={{ position: 'absolute', right: -6, bottom: -6, width: 30, height: 30, borderRadius: 15, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.bg }}>
                  <Icon name={busy === 'photo' ? 'clockSmall' : 'camera'} size={15} color={colors.onAccent} />
                </View>
              ) : null}
            </Tap>
            {editingName !== null ? (
              <Row gap={8} style={{ alignSelf: 'stretch', height: 48, borderRadius: 24, paddingLeft: 16, paddingRight: 4, backgroundColor: PILL_BG, borderWidth: 1, borderColor: colors.accent }}>
                <TextInput
                  value={editingName}
                  onChangeText={(t) => setEditingName(t.slice(0, GROUP_TITLE_MAX))}
                  autoFocus
                  maxLength={GROUP_TITLE_MAX}
                  onSubmitEditing={saveName}
                  returnKeyType="done"
                  accessibilityLabel="Group name"
                  style={{ flex: 1, height: 44, color: colors.text, fontFamily: fonts.medium, fontSize: 17 }}
                />
                <IconButton icon="check" label="Save name" size={40} iconSize={18} bg={colors.accent} color={colors.onAccent} onPress={saveName} />
              </Row>
            ) : (
              <Tap onPress={admin ? () => setEditingName(group.title ?? '') : undefined} disabled={!admin} accessibilityLabel={admin ? `${title}. Rename group` : title} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 }}>
                <T size={22} weight={700} align="center" numberOfLines={2}>
                  {title}
                </T>
                {admin ? <Icon name="edit" size={16} color={colors.textSecondary} /> : null}
              </Tap>
            )}
            <T size={13} color={colors.textSecondary}>
              Group · {members.length === 1 ? '1 member' : `${members.length} members`}
            </T>
          </View>

          <Row gap={10}>
            {actions.map((a) => (
              <Tap
                key={a.key}
                onPress={a.onPress}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                accessibilityState={{ selected: a.on }}
                style={{ flex: 1, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: a.on ? colors.accentTint : PILL_BG, borderWidth: 1, borderColor: a.on ? colors.accent : PILL_BORDER }}
              >
                <Icon name={a.icon} size={20} color={a.on ? colors.accentLight : colors.text} />
                <T size={12} weight={600}>
                  {a.label}
                </T>
              </Tap>
            ))}
          </Row>

          {note ? (
            <T size={13} color={note.ok ? colors.success : colors.error} align="center" accessibilityLiveRegion="polite">
              {note.text}
            </T>
          ) : null}

          {adding ? (
            <View style={{ gap: 10 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <SectionLabel>ADD PEOPLE</SectionLabel>
                <Tap
                  onPress={() => void addPicked()}
                  disabled={!picked.size || !!busy}
                  accessibilityLabel={picked.size ? `Add ${picked.size}` : 'Add. Pick people first'}
                  style={{ minHeight: 44, justifyContent: 'center' }}
                >
                  <View style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center', backgroundColor: picked.size ? colors.accent : withAlpha(colors.white, 0.08) }}>
                    <T size={13} weight={600} color={picked.size ? colors.onAccent : colors.textTertiary}>
                      {busy === 'add' ? 'Adding…' : picked.size ? `Add ${picked.size}` : 'Add'}
                    </T>
                  </View>
                </Tap>
              </Row>
              <PickSearch value={query} onChange={setQuery} />
              {candidates.loading && !candidates.data ? (
                <Loading height={80} />
              ) : !cand.length ? (
                <T size={14} color={colors.textSecondary}>
                  {q.trim() ? `No one matches “${q.trim()}”.` : 'No contacts to add yet.'}
                </T>
              ) : (
                <Glass padding={0} style={{ paddingVertical: 4 }}>
                  {cand.map((c, i) => (
                    <PickRow
                      key={c.id}
                      c={c}
                      first={i === 0}
                      already={memberIds.has(c.id)}
                      selected={picked.has(c.id)}
                      check={checks.get(c.id)}
                      onPress={() =>
                        setPicked((cur) => {
                          const next = new Map(cur);
                          if (next.has(c.id)) next.delete(c.id);
                          else if (members.length + next.size < GROUP_MAX_MEMBERS) next.set(c.id, c);
                          else setNote({ ok: false, text: `Groups can have up to ${GROUP_MAX_MEMBERS} people.` });
                          return next;
                        })
                      }
                    />
                  ))}
                </Glass>
              )}
            </View>
          ) : null}

          <View style={{ gap: 10 }}>
            <SectionLabel>{`MEMBERS · ${members.length}`}</SectionLabel>
            <Glass padding={4} radius={36}>
              {members.map((m, i) => {
                const you = m.user_id === me;
                const role = roleLabel(m.role);
                return (
                  <Tap
                    key={m.user_id}
                    onPress={you ? undefined : () => void memberOptions(m)}
                    disabled={you}
                    accessibilityLabel={`${you ? 'You' : m.display_name}${role ? `, ${role}` : ''}${you ? '' : '. Member options'}`}
                    style={[{ minHeight: 60, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}
                  >
                    <ChatAvatar person={{ id: m.user_id, display_name: m.display_name, avatar_url: m.avatar_url, username: m.username }} size={40} radius={13} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T size={15} weight={500} numberOfLines={1}>
                        {you ? 'You' : m.display_name}
                      </T>
                      {m.username ? (
                        <T size={12} color={colors.textSecondary} numberOfLines={1}>
                          @{m.username}
                        </T>
                      ) : null}
                    </View>
                    {role ? (
                      <View style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, justifyContent: 'center', backgroundColor: m.role === 'owner' ? colors.accentTint : PILL_BG, borderWidth: 1, borderColor: m.role === 'owner' ? colors.accent : PILL_BORDER }}>
                        <T size={11} weight={600} color={m.role === 'owner' ? colors.accentLight : colors.text}>
                          {busy === `role${m.user_id}` || busy === `rm${m.user_id}` ? '…' : role}
                        </T>
                      </View>
                    ) : busy === `rm${m.user_id}` || busy === `role${m.user_id}` ? (
                      <T size={12} color={colors.textSecondary}>
                        …
                      </T>
                    ) : null}
                  </Tap>
                );
              })}
            </Glass>
          </View>

          <View style={{ gap: 10 }}>
            <SectionLabel>CHAT SETTINGS</SectionLabel>
            <Glass padding={4} radius={36}>
              <ListRow title="Mute notifications" subtitle="Silence this group" icon="bell" right={<Toggle label="Mute notifications" value={!!mine?.muted} onChange={(v) => setSetting({ muted: v })} />} />
              <ListRow divider title="Read receipts" subtitle="Show when I have seen" icon="eye" right={<Toggle label="Read receipts" value={!!mine?.read_receipts} onChange={(v) => setSetting({ read_receipts: v })} />} />
              <ListRow
                divider
                title="Encryption"
                subtitle="Messages are end-to-end encrypted · Tap a member to verify their security code"
                icon="lock"
                right={false}
                onPress={() =>
                  void showDialog({
                    title: 'End-to-end encrypted',
                    message: 'Messages, photos and voice notes in this group are encrypted on each member’s phone. Only current members can read new messages; people who join later can’t read older ones. To check you’re talking to the right person, tap them in Members and choose Verify security code.',
                    actions: [{ label: 'OK', style: 'cancel' }],
                  })
                }
              />
            </Glass>
          </View>

          <Tap
            onPress={() => router.push(confirmClearHref(cid, title, { group: true }))}
            accessibilityRole="button"
            accessibilityLabel="Clear chat"
            style={{ height: 50, borderRadius: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PILL_BG, borderWidth: 1, borderColor: PILL_BORDER }}
          >
            <Icon name="trash" size={18} color={colors.text} />
            <T size={15} weight={600}>
              Clear chat
            </T>
          </Tap>
          <Tap
            onPress={() => void leave()}
            accessibilityRole="button"
            accessibilityLabel="Leave group"
            style={{ height: 50, borderRadius: 25, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: PILL_BG, borderWidth: 1, borderColor: PILL_BORDER }}
          >
            <Icon name="arrowRight" size={18} color={colors.accentLight} />
            <T size={15} weight={600} color={colors.accentLight}>
              {busy === 'leave' ? 'Leaving…' : 'Leave group'}
            </T>
          </Tap>
        </>
      )}
    </Screen>
  );
}
