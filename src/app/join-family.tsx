import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, ErrorState, Glass, Loading, Row, Screen, ScreenHeader, T, TextField } from '../components';
import { cleanInviteCode, familyInviteInfo, joinFamily, type FamilyInvite } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Lookup = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'missing' } | { state: 'found'; invite: FamilyInvite };

/** Opened by zoyra://join-family?code=… (or typed code). Shows whose family it is, then joins. */
export default function JoinFamily() {
  const { code: rawCode } = useLocalSearchParams<{ code?: string }>();
  const { user, refresh } = useAuth();
  const [code, setCode] = useState(() => cleanInviteCode(typeof rawCode === 'string' ? rawCode : ''));
  const [result, setResult] = useState<{ key: string; lookup: Lookup } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string>();

  // A new deep link while this screen is open replaces the typed code.
  const [seenRaw, setSeenRaw] = useState(rawCode);
  if (rawCode !== seenRaw) {
    setSeenRaw(rawCode);
    if (typeof rawCode === 'string' && rawCode) setCode(cleanInviteCode(rawCode));
  }

  // Look the code up once it's long enough (codes are 8 characters).
  useEffect(() => {
    if (code.length < 8) return;
    let alive = true;
    const key = `${code}#${attempt}`;
    familyInviteInfo(code)
      .then((invite) => alive && setResult({ key, lookup: invite ? { state: 'found', invite } : { state: 'missing' } }))
      .catch((e: unknown) => alive && setResult({ key, lookup: { state: 'error', message: e instanceof Error ? e.message : 'Could not check that code' } }));
    return () => {
      alive = false;
    };
  }, [code, attempt]);
  // Derived: idle for short codes, loading until the result for this exact code + attempt arrives.
  const lookup: Lookup = code.length < 8 ? { state: 'idle' } : result?.key === `${code}#${attempt}` ? result.lookup : { state: 'loading' };

  const join = async () => {
    if (joining || lookup.state !== 'found') return;
    setJoining(true);
    setError(undefined);
    try {
      await joinFamily(code);
      await refresh();
      router.replace('/family');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join this family');
    } finally {
      setJoining(false);
    }
  };

  const invite = lookup.state === 'found' ? lookup.invite : null;
  const isOwn = !!invite && invite.owner_id === user?.id;
  const full = !!invite && invite.seats_used >= invite.seats_total && !invite.is_member;
  const blocker = !invite
    ? null
    : isOwn
      ? 'This is your own family invite. Share it with the people you want to add.'
      : invite.is_member
        ? 'You are already in this family.'
        : !invite.active
          ? "This family's plan isn't active right now."
          : full
            ? 'This family is full (6 of 6 seats).'
            : null;

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'gold' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Join a family" />

      <T size={15} lineHeight={21} color={colors.textSecondary}>
        Enter the invite code from your plan manager, or open their invite link. You get Premium for as long as their Family plan is active.
      </T>

      <TextField
        label="Invite code"
        icon="users"
        value={code}
        onChangeText={(v) => {
          setCode(cleanInviteCode(v));
          setError(undefined);
        }}
        placeholder="AB12CD34"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={16}
      />

      {lookup.state === 'loading' ? (
        <Loading label="Checking code" height={80} />
      ) : lookup.state === 'error' ? (
        <ErrorState message={lookup.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : lookup.state === 'missing' ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          That invite code isn&apos;t valid. Check it with your plan manager.
        </T>
      ) : invite ? (
        <Glass padding={14}>
          <Row gap={12}>
            <Cover uri={invite.owner_avatar} id={invite.owner_id} size={48} radius={24} style={{ alignItems: 'center', justifyContent: 'center' }}>
              {invite.owner_avatar ? null : (
                <T size={16} weight={600} color={colors.white}>
                  {(invite.owner_name || '?').charAt(0).toUpperCase()}
                </T>
              )}
            </Cover>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={16} weight={600} numberOfLines={1}>
                {invite.owner_name}&apos;s family
              </T>
              <T mono size={12} color={colors.textSecondary}>
                {invite.seats_used} of {invite.seats_total} seats used
              </T>
            </View>
          </Row>
        </Glass>
      ) : null}

      {blocker ? (
        <T size={13} lineHeight={18} color={colors.textSecondary} accessibilityLiveRegion="polite">
          {blocker}
        </T>
      ) : null}
      {error ? (
        <T size={13} lineHeight={18} color={colors.error} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      <View style={{ flex: 1 }} />

      {invite?.is_member || isOwn ? (
        <Button label="Go to Family plan" variant="secondary" onPress={() => router.replace('/family')} />
      ) : (
        <Button label={joining ? 'Joining…' : 'Join family'} variant={joining || !invite || !!blocker ? 'disabled' : 'primary'} onPress={() => void join()} />
      )}
    </Screen>
  );
}
