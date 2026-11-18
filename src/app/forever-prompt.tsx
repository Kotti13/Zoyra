import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { go, Icon, IconButton, Screen, T, type IconName } from '../components';
import { ForeverAvatar, GoldBackdrop, GoldButton, GoldInfinity, goldTint, SoftButton } from '../components/forever';
import {
  firstName,
  foreverAskHref,
  foreverDoneHref,
  foreverErrorMessage,
  foreverReasonText,
  foreverSentHref,
  GOLD,
  requestForever,
  useForeverEligibility,
  useForeverPerson,
} from '../lib/forever';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const PERKS: { icon: IconName; title: string; sub: string }[] = [
  { icon: 'shield', title: 'Can never be blocked', sub: 'Neither of you can block the other' },
  { icon: 'bell', title: 'Always gets through', sub: 'Rings and alerts even in quiet hours' },
  { icon: 'pushPin', title: 'Pinned at the top', sub: 'With a gold ring and ∞ badge' },
  { icon: 'star', title: 'Shared vault', sub: 'Starred messages and memories together' },
];

/**
 * "Make Priya your Forever?" full screen (MsgForeverPrompt), `/forever-prompt?uid=`. Both avatars with the ∞ between them,
 * the four perks, a note that they must accept, "∞ Send Forever request" → Sent (or Done when they had already
 * asked me), "Not now". Ineligible: the reason replaces the button.
 */
export default function ForeverPrompt() {
  const params = useLocalSearchParams<{ uid?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const person = useForeverPerson(uid);
  const { profile } = useAuth();
  const { data: elig } = useForeverEligibility(person ? uid : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = person?.display_name?.trim() || 'them';
  const first = firstName(name, 'them');

  const send = async () => {
    if (!person || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await requestForever(person.id);
      router.replace(res.status === 'accepted' ? foreverDoneHref(person.id) : foreverSentHref(person.id, res.id));
    } catch (e) {
      setError(foreverErrorMessage(e, 'Could not send the request. Try again.'));
      setBusy(false);
    }
  };

  const blocked = elig && !elig.eligible ? elig : null;
  const reason = blocked ? foreverReasonText(blocked.reason, first) : '';

  return (
    <Screen
      backdrop={false}
      underlay={<GoldBackdrop />}
      gap={16}
      top={8}
      bottom={24}
      footer={
      <View style={{ gap: 10, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12 }}>
        {error || reason ? (
          <T size={13} color={error ? colors.error : GOLD.text} align="center" accessibilityLiveRegion="polite">
            {error ?? reason}
          </T>
        ) : null}

        {blocked?.state === 'pending_in' && blocked.request_id ? (
          <GoldButton label="∞ See their request" onPress={() => router.replace(foreverAskHref(blocked.request_id as string))} />
        ) : blocked?.state === 'pending_out' && blocked.request_id ? (
          <GoldButton label="See your request" onPress={() => router.replace(foreverSentHref(uid, blocked.request_id as string))} />
        ) : (
          <GoldButton label="∞ Send Forever request" busy={busy} disabled={!person || !elig || !!blocked} onPress={() => void send()} />
        )}
        <SoftButton label="Not now" onPress={() => go('back')} height={44} />
      </View>
      }
    >
      <View style={{ flexDirection: 'row', minHeight: 44 }}>
        <IconButton icon="close" label="Close" size={44} onPress={() => go('back')} />
      </View>
      <View style={{ alignItems: 'center', gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 6 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ForeverAvatar person={profile ? { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, username: profile.username } : null} size={64} radius={21} forever />
          <GoldInfinity size={34} style={{ marginHorizontal: -6, zIndex: 2 }} />
          <ForeverAvatar person={person ?? null} size={64} radius={21} forever />
        </View>
        <T size={22} weight={300} tracking={-0.4} align="center" accessibilityRole="header">
          {`Make ${first} your `}
          <T size={22} weight={800}>
            Forever
          </T>
          ?
        </T>
        <T size={13} color={colors.peach} align="center" lineHeight={19} style={{ maxWidth: 300 }}>
          {person === null
            ? 'This person is no longer available.'
            : 'You follow each other and chat every day. Forever is a promise: this person stays in your life.'}
        </T>
      </View>

      {PERKS.map((p) => (
        <View key={p.title} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: goldTint(0.14), alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={p.icon} size={20} color={GOLD.mid} />
          </View>
          <View style={{ flex: 1 }}>
            <T size={14} weight={600}>
              {p.title}
            </T>
            <T size={12} color={colors.textSecondary}>
              {p.sub}
            </T>
          </View>
        </View>
      ))}

      <View style={{ paddingVertical: 10, paddingHorizontal: 12, borderRadius: 26, backgroundColor: goldTint(0.1), borderWidth: 1, borderColor: goldTint(0.35) }}>
        <T size={12} color={GOLD.textBright} lineHeight={17}>
          {`${first} has to accept too. Once both of you agree, Forever cannot be removed for 30 days.`}
        </T>
      </View>
    </Screen>
  );
}
