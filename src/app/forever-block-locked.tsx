import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { go, Glass, Icon, ListRow, Sheet, T, type IconName } from '../components';
import { GoldButton, goldTint } from '../components/forever';
import { showDialog } from '../lib/dialog';
import { restrictUser, setChatArchived } from '../lib/dm';
import { flash } from '../lib/flash';
import { daysUntil, firstName, foreverErrorMessage, GOLD, requestForeverRemoval, setForeverHush, useForeverFriend, useForeverPerson } from '../lib/forever';
import { colors } from '../theme/tokens';

type Action = 'mute' | 'restrict' | 'archive' | 'pause';

/**
 * Block attempt on a Forever friend (MsgBlockLocked), `/forever-block-locked?uid=&cid=`. Forever friends can't be
 * blocked, so this offers Mute notifications (mutes the chat and keeps "Always gets through" from overriding it),
 * Restrict, Archive chat and Pause Forever (starts the 30 day removal). "Got it" closes.
 */
export default function ForeverBlockLocked() {
  const params = useLocalSearchParams<{ uid?: string; cid?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const person = useForeverPerson(uid);
  const friend = useForeverFriend(uid);
  const cid = (typeof params.cid === 'string' && params.cid) || friend?.conversation_id || null;
  const [busy, setBusy] = useState<Action | null>(null);
  const [done, setDone] = useState<Set<Action>>(() => new Set());

  const name = person?.display_name?.trim() || 'This person';
  const first = firstName(name, 'them');
  const removing = !!friend?.removal_at;

  const run = async (a: Action) => {
    if (!person || busy || done.has(a)) return;
    if (a === 'pause') {
      const ok = await showDialog({
        title: `Pause Forever with ${first}?`,
        message: `This starts a 30 day removal. ${first} is told and either of you can cancel it. Blocking stays off until it ends.`,
        tone: 'danger',
        actions: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Start removal', style: 'destructive' },
        ],
      });
      if (ok !== 'Start removal') return;
    }
    setBusy(a);
    try {
      if (a === 'mute') await setForeverHush(person.id, true);
      else if (a === 'restrict') await restrictUser(person.id);
      else if (a === 'archive') {
        if (!cid) throw new Error('There is no chat with this person yet.');
        await setChatArchived(cid, true);
      } else await requestForeverRemoval(person.id);
      setDone((s) => new Set(s).add(a));
      flash(
        a === 'mute' ? `${first} is muted` : a === 'restrict' ? `${first} is restricted` : a === 'archive' ? 'Chat archived' : 'Removal started. Forever ends in 30 days.',
      );
    } catch (e) {
      flash(foreverErrorMessage(e, 'Could not do that. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const rows: { key: Action; icon: IconName; title: string; sub: string; hidden?: boolean }[] = [
    { key: 'mute', icon: 'bellOff', title: 'Mute notifications', sub: 'Silence chat, keep the friendship' },
    { key: 'restrict', icon: 'eye', title: 'Restrict', sub: `Limit what ${first} sees` },
    { key: 'archive', icon: 'storage', title: 'Archive chat', sub: 'Hide it from your list', hidden: !cid },
    removing
      ? { key: 'pause', icon: 'timer', title: 'Removal in progress', sub: `Forever ends in ${daysUntil(friend?.removal_at)} days` }
      : { key: 'pause', icon: 'timer', title: 'Pause Forever', sub: 'Start 30 day removal request' },
  ];

  return (
    <Sheet>
      <View style={{ alignItems: 'center', gap: 10 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: goldTint(0.14), borderWidth: 1, borderColor: goldTint(0.5), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="lock" size={28} color={GOLD.mid} />
        </View>
        <T size={21} weight={600} align="center" accessibilityRole="header">
          {person === undefined ? 'Forever friend' : `${name} is your Forever`}
        </T>
        <T size={13} color={colors.peach} align="center" lineHeight={19} style={{ maxWidth: 300 }}>
          Forever friends cannot be blocked. If you need space, you can use these instead.
        </T>
      </View>
      <Glass padding={4}>
        {rows
          .filter((r) => !r.hidden)
          .map((r, i) => {
            const isDone = done.has(r.key) || (r.key === 'pause' && removing);
            return (
              <ListRow
                key={r.key}
                divider={i > 0}
                icon={r.icon}
                title={r.title}
                subtitle={r.sub}
                onPress={isDone ? undefined : () => void run(r.key)}
                right={busy === r.key ? <ActivityIndicator color={colors.textSecondary} /> : isDone ? <Icon name="check" size={18} color={colors.success} /> : undefined}
              />
            );
          })}
      </Glass>
      <GoldButton label="Got it" height={50} onPress={() => go('back')} />
    </Sheet>
  );
}
