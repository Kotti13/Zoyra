import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Icon, IconButton, ListGroup, ListRow, Screen, T, Tap, Toggle } from '../components';
import { ForeverAvatar, ForeverBadge, GoldCard, goldTint } from '../components/forever';
import { flash } from '../lib/flash';
import { showDialog } from '../lib/dialog';
import {
  cancelForeverRemoval,
  daysUntil,
  firstName,
  FOREVER_MAX,
  foreverAskHref,
  foreverErrorMessage,
  foreverPromptHref,
  foreverReasonText,
  foreverSinceLabel,
  foreverVaultHref,
  GOLD,
  listForeverCandidates,
  requestForeverRemoval,
  setForeverSettings,
  useForeverList,
  useForeverPending,
  type ForeverCandidate,
  type ForeverFriend,
} from '../lib/forever';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const chatHref = (cid: string) => `/chat-pro?id=${encodeURIComponent(cid)}` as Href;
const profileHref = (uid: string) => `/public-profile?id=${encodeURIComponent(uid)}` as Href;

/**
 * Forever hub (MsgForever): my Forever friends (gold ring + ∞, "Forever since · N messages", streak), open
 * requests, "Add a Forever (N slots left)" with a picker of mutual follows, perks (Always gets through,
 * Special ringtone, Shared vault, Milestones) and the rules. Tap a friend for Open chat / Shared vault /
 * Pause Forever (30 day removal) or Keep Forever (cancel a pending removal).
 */
export default function ForeverHub() {
  const { user } = useAuth();
  const me = user?.id ?? null;
  const { list, settings, reload, error } = useForeverList();
  const { pending, reload: reloadPending } = useForeverPending();
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<ForeverCandidate[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const used = list?.length ?? 0;
  const outgoing = (pending ?? []).filter((p) => !p.incoming);
  const incoming = (pending ?? []).filter((p) => p.incoming);
  const slots = Math.max(0, FOREVER_MAX - used - outgoing.length);

  useEffect(() => {
    if (!picking) return;
    let alive = true;
    listForeverCandidates()
      .then((c) => alive && setCandidates(c))
      .catch((e) => {
        if (!alive) return;
        setCandidates([]);
        flash(foreverErrorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [picking]);

  const toggle = useCallback(
    async (key: 'breakthrough' | 'milestones' | 'ringtone', value: boolean | 'gold' | 'default') => {
      setSaving(key);
      try {
        await setForeverSettings({ [key]: value });
      } catch (e) {
        flash(foreverErrorMessage(e, 'Could not save. Try again.'));
      } finally {
        setSaving(null);
      }
    },
    [],
  );

  const manage = useCallback(async (f: ForeverFriend) => {
    const name = firstName(f.display_name, 'them');
    const removing = !!f.removal_at;
    const actions = [
      { label: 'Open chat', style: 'primary' as const },
      { label: 'Shared vault', style: 'default' as const },
      removing ? { label: 'Keep Forever', style: 'primary' as const } : { label: 'Pause Forever', style: 'destructive' as const },
      { label: 'Cancel', style: 'cancel' as const },
    ];
    const pick = await showDialog({
      title: f.display_name,
      message: removing
        ? `Forever ends in ${daysUntil(f.removal_at)} days${f.removal_requested_by === me ? ' (you started it)' : ''}. Either of you can keep it.`
        : `Forever since ${foreverSinceLabel(f.since)} · Day ${f.days}`,
      actions,
    });
    if (pick === 'Open chat') router.push(f.conversation_id ? chatHref(f.conversation_id) : profileHref(f.user_id));
    else if (pick === 'Shared vault') router.push(foreverVaultHref(f.user_id));
    else if (pick === 'Keep Forever') {
      try {
        await cancelForeverRemoval(f.user_id);
        flash(`You and ${name} are still Forever`);
      } catch (e) {
        flash(foreverErrorMessage(e));
      }
    } else if (pick === 'Pause Forever') {
      const ok = await showDialog({
        title: `Pause Forever with ${name}?`,
        message: `This starts a 30 day removal. ${name} is told and either of you can cancel it. Until then you stay Forever.`,
        tone: 'danger',
        actions: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Start removal', style: 'destructive' },
        ],
      });
      if (ok !== 'Start removal') return;
      try {
        await requestForeverRemoval(f.user_id);
        flash('Removal started. Forever ends in 30 days.');
      } catch (e) {
        flash(foreverErrorMessage(e));
      }
    }
  }, [me]);

  const openVault = useCallback(async () => {
    if (!list?.length) return;
    if (list.length === 1) {
      router.push(foreverVaultHref(list[0].user_id));
      return;
    }
    const pick = await showDialog({
      title: 'Shared vault',
      message: 'Whose vault?',
      actions: [...list.map((f) => ({ label: f.display_name, style: 'default' as const })), { label: 'Cancel', style: 'cancel' as const }],
    });
    const f = list.find((x) => x.display_name === pick);
    if (f) router.push(foreverVaultHref(f.user_id));
  }, [list]);

  const vaultTotal = (list ?? []).reduce((n, f) => n + f.vault_count, 0);

  return (
    <Screen gap={14} onRefresh={() => Promise.all([reload(), Promise.resolve(reloadPending())])}>
      <View style={{ flexDirection: 'row' }}>
        <IconButton icon="back" label="Back" href="back" bg={colors.glass} />
      </View>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={38} accessibilityRole="header">
          Forever
        </T>
        <T size={14} color={colors.textSecondary} lineHeight={20}>
          The people you chose for life. They can never be blocked.
        </T>
      </View>

      {incoming.map((p) => (
        <Tap key={p.id} href={foreverAskHref(p.id)} accessibilityRole="button" accessibilityLabel={`${p.other_name} wants you as their Forever`} pressScale={0.98}>
          <GoldCard strong style={{ padding: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <ForeverAvatar person={{ id: p.other_id, display_name: p.other_name, avatar_url: p.other_avatar, username: p.other_username }} size={44} forever={false} />
              <View style={{ flex: 1, gap: 2 }}>
                <T size={15} weight={700}>{`${firstName(p.other_name)} wants you as their Forever`}</T>
                <T size={12} color={GOLD.text}>
                  Tap to answer
                </T>
              </View>
              <ForeverBadge />
            </View>
          </GoldCard>
        </Tap>
      ))}

      {list === null ? (
        <T size={14} color={colors.textSecondary}>
          Loading…
        </T>
      ) : null}
      {error && !list?.length ? (
        <T size={14} color={colors.error}>
          {error}
        </T>
      ) : null}

      {(list ?? []).map((f) => (
        <Tap key={f.user_id} onPress={() => void manage(f)} accessibilityRole="button" accessibilityLabel={`${f.display_name}, Forever since ${foreverSinceLabel(f.since)}, ${f.messages} messages, ${f.streak} day streak`} accessibilityHint="Chat, vault or pause Forever" pressScale={0.98}>
          <GoldCard style={{ padding: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <ForeverAvatar person={{ id: f.user_id, display_name: f.display_name, avatar_url: f.avatar_url, username: f.username }} size={54} radius={18} forever />
              <View style={{ flex: 1, gap: 3 }}>
                <T size={16} weight={700} numberOfLines={1}>
                  {f.display_name}
                </T>
                <T size={12} color={f.removal_at ? colors.warning : GOLD.text} numberOfLines={1}>
                  {f.removal_at
                    ? `Forever ends in ${daysUntil(f.removal_at)} days · tap to keep`
                    : `Forever since ${foreverSinceLabel(f.since)} · ${f.messages.toLocaleString('en-US')} messages`}
                </T>
              </View>
              {f.streak > 0 ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                  <Icon name="flame" size={16} color={GOLD.mid} filled />
                  <T size={13} weight={700} color={GOLD.mid}>
                    {String(f.streak)}
                  </T>
                </View>
              ) : null}
            </View>
          </GoldCard>
        </Tap>
      ))}

      {outgoing.map((p) => (
        <GoldCard key={p.id} style={{ padding: 12, opacity: 0.85 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <ForeverAvatar person={{ id: p.other_id, display_name: p.other_name, avatar_url: p.other_avatar, username: p.other_username }} size={44} forever={false} />
            <View style={{ flex: 1, gap: 2 }}>
              <T size={15} weight={600}>
                {p.other_name}
              </T>
              <T size={12} color={GOLD.text}>
                Request sent · waiting
              </T>
            </View>
          </View>
        </GoldCard>
      ))}

      {list !== null && slots > 0 ? (
        <Tap
          onPress={() => setPicking((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: picking }}
          accessibilityLabel={`Add a Forever, ${slots} ${slots === 1 ? 'slot' : 'slots'} left`}
          style={{ height: 52, borderRadius: 26, borderWidth: 1.5, borderStyle: 'dashed', borderColor: goldTint(0.6), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <T size={18} weight={700} color={GOLD.mid}>
            +
          </T>
          <T size={15} weight={700} color={GOLD.mid}>
            {`Add a Forever (${slots} ${slots === 1 ? 'slot' : 'slots'} left)`}
          </T>
        </Tap>
      ) : list !== null ? (
        <T size={13} color={colors.textSecondary} align="center">
          {`All ${FOREVER_MAX} Forever slots are used.`}
        </T>
      ) : null}

      {picking ? (
        <ListGroup title="CHOOSE SOMEONE YOU FOLLOW BACK">
          {candidates === null ? <ListRow title="Loading…" right={false} /> : null}
          {candidates?.length === 0 ? <ListRow title="No mutual follows yet" subtitle="Forever is for people you follow each other with and chat with." right={false} /> : null}
          {(candidates ?? []).map((c, i) => {
            const name = firstName(c.display_name);
            const href = c.state === 'pending_in' && c.request_id ? foreverAskHref(c.request_id) : c.eligible ? foreverPromptHref(c.user_id) : undefined;
            return (
              <ListRow
                key={c.user_id}
                divider={i > 0}
                title={c.display_name}
                subtitle={c.eligible ? `${c.messages.toLocaleString('en-US')} messages` : foreverReasonText(c.reason, name) || `${c.messages} messages`}
                titleColor={href ? colors.text : colors.textSecondary}
                leading={<ForeverAvatar person={{ id: c.user_id, display_name: c.display_name, avatar_url: c.avatar_url, username: c.username }} size={40} radius={14} forever={false} />}
                href={href}
                right={href ? undefined : false}
              />
            );
          })}
        </ListGroup>
      ) : null}

      <ListGroup title="FOREVER PERKS">
        <ListRow
          icon="bell"
          title="Always gets through"
          subtitle="Alerts and calls in quiet hours"
          right={<Toggle label="Breakthrough" value={settings.breakthrough} onChange={(v) => saving ? undefined : void toggle('breakthrough', v)} />}
        />
        <ListRow
          divider
          icon="phone"
          title="Special ringtone"
          subtitle={settings.ringtone === 'gold' ? 'Gold chime for their calls' : 'Your normal ringtone'}
          onPress={() => void toggle('ringtone', settings.ringtone === 'gold' ? 'default' : 'gold')}
          right={
            <T size={13} color={colors.textSecondary}>
              {settings.ringtone === 'gold' ? 'Gold ›' : 'Default ›'}
            </T>
          }
        />
        <ListRow
          divider
          icon="star"
          title="Shared vault"
          subtitle="Starred messages and memories"
          onPress={list?.length ? () => void openVault() : undefined}
          right={
            <T size={13} color={colors.textSecondary}>
              {list?.length ? `${vaultTotal} ›` : '–'}
            </T>
          }
        />
        <ListRow
          divider
          icon="trophy"
          title="Milestones"
          subtitle="Anniversary and streak reminders"
          right={<Toggle label="Milestones" value={settings.milestones} onChange={(v) => saving ? undefined : void toggle('milestones', v)} />}
        />
      </ListGroup>

      <View style={{ gap: 8 }}>
        <T size={12} weight={600} tracking={1.2} color={colors.textSecondary} style={{ paddingHorizontal: 4 }}>
          RULES
        </T>
        <View style={{ padding: 16, borderRadius: 32, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.hairline, gap: 8 }}>
          {[
            '1. You must follow each other and have chatted.',
            '2. Both people accept, then it is locked.',
            '3. Blocking is switched off between Forever friends.',
            '4. Removing Forever takes a 30 day request.',
          ].map((r) => (
            <T key={r} size={13} color={colors.peach} lineHeight={19}>
              {r}
            </T>
          ))}
        </View>
      </View>
    </Screen>
  );
}
