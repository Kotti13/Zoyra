import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { go, Screen, T } from '../components';
import { ForeverPair, ForeverSteps, GoldBackdrop, GoldButton, SoftButton } from '../components/forever';
import { flash } from '../lib/flash';
import { firstName, foreverDoneHref, foreverErrorMessage, foreverRequestInfo, GOLD, isUuid, respondForever, type ForeverRequestInfo } from '../lib/forever';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/**
 * Incoming Forever request (MsgForeverAsk), `/forever-ask?id=<request id>` (the 'forever_request' notification).
 * "∞ Accept Forever" → celebration; "Not now" declines (they can ask again after a few days).
 */
export default function ForeverAsk() {
  const params = useLocalSearchParams<{ id?: string }>();
  const requestId = typeof params.id === 'string' ? params.id : '';
  const { profile } = useAuth();
  const [info, setInfo] = useState<ForeverRequestInfo | null | undefined>(isUuid(requestId) ? undefined : null);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isUuid(requestId)) return;
    let alive = true;
    foreverRequestInfo(requestId)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, [requestId]);

  const open = !!info && info.incoming && info.status === 'pending';
  const name = info?.other_name?.trim() || 'Someone';
  const first = firstName(name, 'Someone');
  const them = info ? { id: info.other_id, display_name: info.other_name, avatar_url: info.other_avatar, username: info.other_username } : null;

  const answer = async (accept: boolean) => {
    if (!info || busy) return;
    setBusy(accept ? 'accept' : 'decline');
    setError(null);
    try {
      const status = await respondForever(info.id, accept);
      if (status === 'accepted') router.replace(foreverDoneHref(info.other_id));
      else {
        flash('Request declined');
        go('back');
      }
    } catch (e) {
      setError(foreverErrorMessage(e, 'Could not answer. Try again.'));
      setBusy(null);
    }
  };

  return (
    <Screen backdrop={false} underlay={<GoldBackdrop />} scroll={false} gap={10} top={48} bottom={40} contentStyle={{ flex: 1, alignItems: 'center', paddingHorizontal: 24 }}>
      <ForeverSteps step={2} name={null} />
      <View style={{ marginTop: 30 }}>
        <ForeverPair me={profile ? { id: profile.id, display_name: profile.display_name, avatar_url: profile.avatar_url, username: profile.username } : null} them={them} themAccepted />
      </View>
      {info === undefined ? (
        <T size={14} color={GOLD.text} style={{ marginTop: 22 }}>
          Loading…
        </T>
      ) : open ? (
        <>
          <T size={30} weight={300} tracking={-0.6} align="center" lineHeight={35} style={{ marginTop: 22 }} accessibilityRole="header">
            {`${first} wants you as their `}
            <T size={30} weight={800}>
              Forever
            </T>
          </T>
          <T size={14} color={GOLD.text} align="center" lineHeight={21} style={{ maxWidth: 300 }}>
            Forever friends can never be blocked and always get through. It cannot be removed for 30 days.
          </T>
        </>
      ) : (
        <>
          <T size={26} weight={300} align="center" style={{ marginTop: 22 }} accessibilityRole="header">
            {info?.status === 'accepted' ? 'You are already Forever' : 'This request is no longer open'}
          </T>
          <T size={14} color={GOLD.text} align="center" lineHeight={21} style={{ maxWidth: 300 }}>
            {info?.status === 'accepted' ? `You and ${first} are Forever.` : info ? `${first} may have cancelled it.` : 'It may have been cancelled or already answered.'}
          </T>
        </>
      )}
      {error ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}
      <View style={{ flex: 1 }} />
      <View style={{ width: '100%', gap: 10 }}>
        {open ? (
          <>
            <GoldButton label="∞ Accept Forever" busy={busy === 'accept'} disabled={!!busy} onPress={() => void answer(true)} />
            <SoftButton label="Not now" busy={busy === 'decline'} onPress={() => void answer(false)} />
          </>
        ) : info?.status === 'accepted' ? (
          <GoldButton label="Open Forever" onPress={() => router.replace('/forever')} />
        ) : (
          <SoftButton label="Close" onPress={() => go('back')} />
        )}
      </View>
    </Screen>
  );
}
