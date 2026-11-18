import { useState } from 'react';
import { View } from 'react-native';

import { firstName, foreverAskHref, foreverHubHref, foreverPromptHref, foreverSentHref, foreverSinceLabel, GOLD, useForeverEligibility, useForeverFriend } from '../../lib/forever';
import { usePref } from '../../lib/prefs';
import { colors } from '../../theme/tokens';
import { IconButton, Tap } from '../controls';
import { Icon, T } from '../primitives';
import { GoldCard, GoldInfinity } from './gold';

/** How long "×" hides the in-chat prompt for one person. */
const DISMISS_MS = 30 * 86_400_000;
const dismissKey = (uid: string) => `forever.promptDismissed.${uid}`;

/**
 * In-chat prompt card (MsgChat): "∞ Make Priya your Forever? You follow each other and chat daily. [Set]".
 * Shows only when I can ask `uid` right now (eligible, no open request). When they already asked me it becomes
 * "Priya wants you as her Forever [View]". "×" hides it for 30 days on this device.
 */
export function ForeverPromptCard({ uid, name }: { uid: string | null | undefined; name?: string | null }) {
  const { data } = useForeverEligibility(uid);
  const [dismissedAt, setDismissedAt] = usePref<number>(dismissKey(uid ?? '-'), 0);
  const [mountedAt] = useState(() => Date.now());
  if (!uid || !data) return null;
  const who = firstName(name, 'them');
  const incoming = data.state === 'pending_in' && !!data.request_id;
  const waiting = data.state === 'pending_out' && !!data.request_id;
  if (!incoming && !waiting && (!data.eligible || (mountedAt - dismissedAt < DISMISS_MS && dismissedAt > 0))) return null;
  const title = incoming ? `${who} wants you as their Forever` : waiting ? `Waiting for ${who}` : `Make ${who} your Forever?`;
  const sub = incoming
    ? 'Forever friends can never be blocked and always get through.'
    : waiting
      ? 'Your Forever request is sent. You both see a celebration when they accept.'
      : 'You follow each other and chat daily.';
  const href = incoming ? foreverAskHref(data.request_id as string) : waiting ? foreverSentHref(uid, data.request_id as string) : foreverPromptHref(uid);
  const action = incoming ? 'Approve' : waiting ? 'View' : 'Set';
  return (
    <GoldCard strong radius={32} style={{ padding: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <GoldInfinity size={44} />
        <View style={{ flex: 1, gap: 2 }}>
          <T size={14} weight={700}>
            {title}
          </T>
          <T size={12} color={GOLD.text} lineHeight={16}>
            {sub}
          </T>
        </View>
        <Tap href={href} accessibilityRole="button" accessibilityLabel={incoming ? `Approve ${who}'s Forever request` : waiting ? 'View your Forever request' : `Set ${who} as your Forever`} hitSlop={4}>
          <View style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: GOLD.light, alignItems: 'center', justifyContent: 'center' }}>
            <T size={13} weight={800} color={GOLD.ink}>
              {action}
            </T>
          </View>
        </Tap>
        {incoming || waiting ? null : <IconButton icon="close" label="Hide this suggestion" size={28} iconSize={16} color={colors.textSecondary} onPress={() => setDismissedAt(Date.now())} />}
      </View>
    </GoldCard>
  );
}

/**
 * Chat info card (MsgChatInfo). Forever: "Priya is your Forever · Forever since 12 Nov · Day 34" → Forever hub.
 * Eligible: "Make Priya your Forever · Mutual follow, 1,204 messages" → prompt sheet. Request sent: "Waiting for
 * Priya" → Sent screen. They asked: → Ask screen. Otherwise renders nothing.
 */
export function ForeverInfoCard({ uid, name }: { uid: string | null | undefined; name?: string | null }) {
  const friend = useForeverFriend(uid);
  const { data } = useForeverEligibility(friend ? null : uid);
  if (!uid) return null;
  const who = firstName(name ?? friend?.display_name, 'them');
  let title: string;
  let sub: string;
  let href;
  if (friend) {
    title = `${who} is your Forever`;
    sub = `Forever since ${foreverSinceLabel(friend.since)} · Day ${friend.days}`;
    href = foreverHubHref;
  } else if (!data) {
    return null;
  } else if (data.state === 'pending_out' && data.request_id) {
    title = 'Forever request sent';
    sub = `Waiting for ${who}`;
    href = foreverSentHref(uid, data.request_id);
  } else if (data.state === 'pending_in' && data.request_id) {
    title = `${who} wants you as their Forever`;
    sub = 'Tap to answer';
    href = foreverAskHref(data.request_id);
  } else if (data.eligible) {
    title = `Make ${who} your Forever`;
    sub = `Mutual follow, ${data.messages.toLocaleString('en-US')} messages`;
    href = foreverPromptHref(uid);
  } else {
    return null;
  }
  return (
    <Tap href={href} accessibilityRole="button" accessibilityLabel={`${title}. ${sub}`} pressScale={0.98}>
      <GoldCard radius={26} style={{ paddingVertical: 14, paddingHorizontal: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <GoldInfinity size={40} />
          <View style={{ flex: 1, gap: 2 }}>
            <T size={14} weight={700}>
              {title}
            </T>
            <T size={12} color={GOLD.text}>
              {sub}
            </T>
          </View>
          <Icon name="chevronRight" size={18} color={colors.textSecondary} />
        </View>
      </GoldCard>
    </Tap>
  );
}
