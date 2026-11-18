import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Glass, Icon, ListRow, Overline, Row, Screen, ScreenHeader, T, Tap, Toggle } from '../components';
import { DM_WHO_LABEL, dmSettings, restrictedCount, type DmSettings, type DmWho, type GroupInvites } from '../lib/dm';
import { showDialog } from '../lib/dialog';
import { LAST_SEEN_WHO, lastSeenPrefs } from '../lib/last-seen';
import { countBlocked } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors, radius, withAlpha } from '../theme/tokens';

const WHO_ORDER: DmWho[] = ['everyone', 'mutuals', 'followers', 'none'];

type SwitchKey = 'read_receipts' | 'online_status' | 'typing' | 'now_playing' | 'filter_spam' | 'song_shares_anyone';

const SWITCHES: { key: SwitchKey; title: string; subtitle: string }[] = [
  { key: 'read_receipts', title: 'Read receipts', subtitle: "Turn off and you won't see theirs either" },
  { key: 'online_status', title: 'Online status', subtitle: 'Show a green dot and "Active now" to friends' },
  { key: 'typing', title: 'Typing indicator', subtitle: 'Let friends see when you are typing' },
  { key: 'now_playing', title: 'Show now playing', subtitle: 'Friends see your current song in chat' },
  { key: 'filter_spam', title: 'Filter spam requests', subtitle: 'Move suspicious requests to Filtered' },
  { key: 'song_shares_anyone', title: 'Song shares from anyone', subtitle: 'Allow song shares from people you have not chatted with' },
];

const GROUP_LABEL: Record<GroupInvites, string> = { everyone: 'Everyone', mutuals: 'Mutual friends', none: 'No one' };
const GROUP_ORDER: GroupInvites[] = ['everyone', 'mutuals', 'none'];

function Radio({ on }: { on: boolean }) {
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? colors.accent : withAlpha(colors.white, 0.35), alignItems: 'center', justifyContent: 'center' }}>
      {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent }} /> : null}
    </View>
  );
}

function RadioRow({ title, hint, on, divider, onPress, minHeight = 60 }: { title: string; hint?: string; on: boolean; divider?: boolean; onPress: () => void; minHeight?: number }) {
  return (
    <Tap
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={hint ? `${title}. ${hint}` : title}
      onPress={onPress}
      pressScale={0.98}
      style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight, paddingHorizontal: 14 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}
    >
      <Radio on={on} />
      <View style={{ flex: 1, gap: 2 }}>
        <T size={15} weight={500}>
          {title}
        </T>
        {hint ? (
          <T size={12} color={colors.textSecondary}>
            {hint}
          </T>
        ) : null}
      </View>
    </Tap>
  );
}

/** Access card row: title, trailing value and a chevron (56 px). */
function AccessRow({ title, value, onPress, divider, hint }: { title: string; value?: string; onPress: () => void; divider?: boolean; hint?: string }) {
  return (
    <Tap accessibilityRole="button" accessibilityLabel={value ? `${title}, ${value}` : title} accessibilityHint={hint} onPress={onPress} pressScale={0.98}>
      <Row gap={12} style={[{ minHeight: 56, paddingHorizontal: 14 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
        <T size={15} weight={500} style={{ flex: 1 }}>
          {title}
        </T>
        {value ? (
          <T size={14} color={colors.textSecondary}>
            {value}
          </T>
        ) : null}
        <Icon name="chevronRight" size={18} color={colors.textSecondary} />
      </Row>
    </Tap>
  );
}

export default function DmPrivacy() {
  const { user, settings, updateSettings, refresh } = useAuth();
  const uid = user?.id;
  const dm = dmSettings(settings?.dm);
  const [note, setNote] = useState<string>();
  const [blockedCount, setBlockedCount] = useState<number | null | undefined>(undefined);
  const [restrictCount, setRestrictCount] = useState<number | null | undefined>(undefined);

  useFocusEffect(
    useCallback(() => {
      if (!uid) return;
      let alive = true;
      countBlocked(uid)
        .then((n) => alive && setBlockedCount(n))
        .catch(() => alive && setBlockedCount(null));
      restrictedCount()
        .then((n) => alive && setRestrictCount(n))
        .catch(() => alive && setRestrictCount(null));
      return () => {
        alive = false;
      };
    }, [uid]),
  );

  // Pull to refresh: stored message settings (another device may have changed them) and the counts.
  const pullRefresh = () =>
    Promise.all([
      refresh().catch(() => undefined),
      uid
        ? countBlocked(uid)
            .then((n) => setBlockedCount(n))
            .catch(() => setBlockedCount(null))
        : undefined,
      uid
        ? restrictedCount()
            .then((n) => setRestrictCount(n))
            .catch(() => setRestrictCount(null))
        : undefined,
    ]);

  /** Saves at once (the auth context updates optimistically); on failure reload the stored settings. */
  const save = async <K extends keyof DmSettings>(key: K, value: DmSettings[K]) => {
    setNote(undefined);
    try {
      await updateSettings({ dm: { ...dm, [key]: value } });
    } catch (e) {
      setNote(e instanceof Error && e.message ? e.message : 'Could not save that change');
      await refresh().catch(() => undefined);
    }
  };

  /** Group invites picker (who can add me to group chats). */
  const pickGroupInvites = async () => {
    const picked = await showDialog({
      title: 'Group invites',
      message: 'Who can add you to group chats',
      icon: 'users',
      actions: [
        ...GROUP_ORDER.map((g) => ({ label: g === dm.group_invites ? `${GROUP_LABEL[g]} ✓` : GROUP_LABEL[g], style: 'default' as const })),
        { label: 'Cancel', style: 'cancel' as const },
      ],
    });
    const g = GROUP_ORDER.find((x) => picked === GROUP_LABEL[x] || picked === `${GROUP_LABEL[x]} ✓`);
    if (g && g !== dm.group_invites) void save('group_invites', g);
  };

  return (
    <Screen onRefresh={uid ? pullRefresh : undefined}
      top={4}
      gap={16}
      backdrop={{
        pattern: 'dots',
        mesh: 'none',
        glows: [
          { x: 0.9, y: 0, color: colors.orange, opacity: 0.38 },
          { x: 0, y: 0.4, color: colors.accent, opacity: 0.2 },
        ],
      }}
    >
      <ScreenHeader title="Message privacy" />

      <View style={{ gap: 10 }}>
        <View style={{ marginHorizontal: 4 }}>
          <Overline color={colors.textSecondary}>Who can message you</Overline>
        </View>
        <Glass radius={radius.card} style={{ paddingVertical: 4 }}>
          <View accessibilityRole="radiogroup" accessibilityLabel="Who can message you">
            {WHO_ORDER.map((w, i) => (
              <RadioRow key={w} title={DM_WHO_LABEL[w].title} hint={DM_WHO_LABEL[w].hint} on={dm.who === w} divider={i > 0} onPress={() => dm.who !== w && void save('who', w)} />
            ))}
          </View>
        </Glass>
      </View>

      <View style={{ gap: 10 }}>
        <View style={{ marginHorizontal: 4 }}>
          <Overline color={colors.textSecondary}>Chat activity</Overline>
        </View>
        <Glass radius={radius.card} style={{ paddingVertical: 4 }}>
          {SWITCHES.map((s, i) => (
            <ListRow
              key={s.key}
              title={s.title}
              subtitle={s.subtitle}
              divider={i > 0}
              minHeight={60}
              right={<Toggle value={dm[s.key]} label={s.title} onChange={(v) => void save(s.key, v)} />}
            />
          ))}
        </Glass>
      </View>

      <View style={{ gap: 10 }}>
        <View style={{ marginHorizontal: 4 }}>
          <Overline color={colors.textSecondary}>Access</Overline>
        </View>
        <Glass radius={radius.card} style={{ paddingVertical: 4 }}>
          <AccessRow
            title="Last seen and online"
            value={LAST_SEEN_WHO.find((w) => w.key === lastSeenPrefs(settings?.dm).last_seen_who)?.title}
            onPress={() => router.push('/last-seen')}
            hint="Choose who can see when you were last active"
          />
          <AccessRow divider title="Group invites" value={GROUP_LABEL[dm.group_invites]} onPress={() => void pickGroupInvites()} hint="Choose who can add you to group chats" />
          <AccessRow title="Blocked accounts" value={blockedCount === undefined ? '…' : blockedCount === null ? undefined : String(blockedCount)} onPress={() => router.push('/blocked')} divider />
          <AccessRow
            title="Restricted accounts"
            value={restrictCount === undefined ? '…' : restrictCount === null ? undefined : String(restrictCount)}
            onPress={() => router.push('/restricted')}
            hint="Their messages go to Requests and they can't see when you're online or have read their messages"
            divider
          />
        </Glass>
      </View>

      {note ? (
        <T size={13} lineHeight={18} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}
    </Screen>
  );
}
