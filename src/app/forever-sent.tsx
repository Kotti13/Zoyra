import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { go, Screen, T } from '../components';
import { ForeverPair, ForeverSteps, GoldBackdrop, SoftButton } from '../components/forever';
import { flash } from '../lib/flash';
import {
  cancelForeverRequest,
  firstName,
  foreverDoneHref,
  foreverErrorMessage,
  foreverRequestInfo,
  GOLD,
  useForeverFriend,
  useForeverPending,
  useForeverPerson,
  type ForeverRequestInfo,
} from '../lib/forever';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/**
 * Waiting for them (MsgForeverSent), `/forever-sent?uid=&id=<request id>`. Live: when they accept, it moves on to
 * the celebration; declined / cancelled show a short note. "Back to chat", "Cancel request".
 */
export default function ForeverSent() {
  const params = useLocalSearchParams<{ uid?: string; id?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const requestId = typeof params.id === 'string' ? params.id : '';
  const person = useForeverPerson(uid);
  const { profile } = useAuth();
  const friend = useForeverFriend(uid);
  const { pending } = useForeverPending();
  const [info, setInfo] = useState<ForeverRequestInfo | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // Re-read the request whenever my open requests change (Realtime on forever_requests).
  useEffect(() => {
    if (!requestId) return;
    let alive = true;
    foreverRequestInfo(requestId)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [requestId, pending]);

  const accepted = !!friend || info?.status === 'accepted';
  useEffect(() => {
    if (accepted && uid) router.replace(foreverDoneHref(uid));
  }, [accepted, uid]);

  const name = person?.display_name?.trim() || 'them';
  const first = firstName(name, 'them');
  const closed = info?.status === 'declined' || info?.status === 'cancelled' || info === null;

  const cancel = async () => {
    if (!requestId || busy) return;
    setBusy(true);
    try {
      await cancelForeverRequest(requestId);
      flash('Forever request cancelled');
      go('back');
    } catch (e) {
      flash(foreverErrorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Screen backdrop={false} underlay={<GoldBackdrop />} scroll={false} gap={10} top={48} bottom={40} contentStyle={{ flex: 1, alignItems: 'center', paddingHorizontal: 24 }}>
      <ForeverSteps step={1} name={first} />
      <View style={{ marginTop: 30 }}>
        <ForeverPair me={profile ? { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, username: profile.username } : null} them={person ?? null} themAccepted={false} />
      </View>
      <T size={30} weight={300} tracking={-0.6} align="center" lineHeight={35} style={{ marginTop: 22 }} accessibilityRole="header">
        {closed ? 'Not this time' : 'Waiting for '}
        {closed ? null : (
          <T size={30} weight={800}>
            {first}
          </T>
        )}
      </T>
      <T size={14} color={GOLD.text} align="center" lineHeight={21} style={{ maxWidth: 300 }} accessibilityLiveRegion="polite">
        {closed
          ? info?.status === 'declined'
            ? `${first} said not now. You can ask again in a few days.`
            : 'This request is no longer open.'
          : `${first} just got your request. When they accept, you both see a celebration and the ∞ badge appears.`}
      </T>
      <View style={{ flex: 1 }} />
      <View style={{ width: '100%', gap: 10 }}>
        <SoftButton label="Back to chat" onPress={() => go('back')} />
        {closed ? null : <SoftButton label="Cancel request" busy={busy} color={colors.error} onPress={() => void cancel()} />}
      </View>
    </Screen>
  );
}
