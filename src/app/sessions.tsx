import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, ErrorState, Glass, Icon, ListGroup, ListRow, Loading, OutlineTag, Row, Screen, ScreenHeader, T, Tap, Toast, useAsync } from '../components';
import type { IconName } from '../components';
import { verifiedTotpFactor } from '../lib/mfa';
import { formatAgo } from '../lib/network';
import { heartbeat, listSessions, revokeSession, signOutOthers, type DeviceSession } from '../lib/sessions';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const ICON: Record<NonNullable<DeviceSession['platform']>, IconName> = { ios: 'phone', android: 'phone', web: 'globe', other: 'cast' };

const when = (iso: string | null) => (iso ? formatAgo(iso) : 'unknown');

export default function Sessions() {
  const { session } = useAuth();
  const list = useAsync(async () => {
    await heartbeat(session, true).catch(() => undefined);
    return listSessions(session);
  }, [session?.access_token]);
  const mfa = useAsync(() => verifiedTotpFactor(), []);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();

  const others = list.data?.sessions.filter((s) => !s.current) ?? [];

  const revoke = async (s: DeviceSession) => {
    if (busyId) return;
    if (confirmId !== s.id) {
      setConfirmId(s.id);
      return setNote({ ok: true, text: `Tap again to sign out ${s.name}.` });
    }
    setConfirmId(null);
    setBusyId(s.id);
    setNote(undefined);
    try {
      await revokeSession(s.id);
      setNote({ ok: true, text: `${s.name} is signed out. It may stay open for up to an hour until its access expires.` });
      list.reload();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not sign out that device' });
    } finally {
      setBusyId(null);
    }
  };

  const revokeAll = async () => {
    if (busyId) return;
    if (confirmId !== 'all') {
      setConfirmId('all');
      return setNote({ ok: true, text: 'Tap again to sign out every other device. This one stays signed in.' });
    }
    setConfirmId(null);
    setBusyId('all');
    setNote(undefined);
    try {
      await signOutOthers();
      setNote({ ok: true, text: 'Signed out of every other device.' });
      list.reload();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not sign out other devices' });
    } finally {
      setBusyId(null);
    }
  };

  const twoStepOn = !!mfa.data;
  const secure = twoStepOn;

  return (
    <Screen onRefresh={() => Promise.all([list.refresh(), mfa.refresh()])} top={4} gap={16} backdrop={{ pattern: 'grid', mesh: 'coral' }}>
      <ScreenHeader title="Devices" />

      <Glass padding={16}>
        <Row gap={14}>
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: withAlpha(secure ? colors.success : colors.warning, 0.18),
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="shield" size={24} color={secure ? colors.success : colors.warning} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={16} weight={600}>
              {mfa.loading ? 'Checking your account…' : secure ? 'Your account looks secure' : 'Add a second step'}
            </T>
            <T size={13} color={colors.textSecondary}>
              {mfa.error ? 'Could not check two-step verification.' : secure ? 'Two-step verification is on.' : 'Two-step verification is off. Turn it on to protect your account.'}
            </T>
          </View>
        </Row>
      </Glass>

      <View style={{ gap: 8 }}>
        <T variant="section" accessibilityRole="header">
          Signed in
        </T>
        {list.loading && !list.data ? (
          <Loading label="Loading devices" />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : (
          <Glass padding={4}>
            {list.data?.sessions.map((s, i) => (
              <Row key={s.id} gap={12} style={[{ minHeight: 72, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={s.platform ? ICON[s.platform] : 'lock'} size={20} color={colors.accentLight} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <T size={16} weight={500} numberOfLines={1}>
                    {s.name}
                  </T>
                  <T size={13} color={colors.textSecondary} numberOfLines={2}>
                    {[s.detail, s.current ? 'Active now' : `Active ${when(s.lastActiveAt)}`, s.createdAt ? `signed in ${when(s.createdAt)}` : null].filter(Boolean).join(' · ')}
                  </T>
                </View>
                {s.current ? (
                  <OutlineTag label="THIS DEVICE" color={colors.accentLight} />
                ) : busyId === s.id ? (
                  <ActivityIndicator color={colors.error} style={{ width: 72 }} />
                ) : (
                  <Tap onPress={() => void revoke(s)} accessibilityLabel={`Sign out ${s.name}`} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 }}>
                    <T size={14} weight={600} color={colors.error}>
                      {confirmId === s.id ? 'Confirm' : 'Sign out'}
                    </T>
                  </Tap>
                )}
              </Row>
            ))}
          </Glass>
        )}
        {list.data && !list.data.supported ? (
          <T size={12} color={colors.textSecondary} lineHeight={18}>
            Only this device can be shown right now. You can still sign out every other device below.
          </T>
        ) : list.data && !others.length ? (
          <T size={12} color={colors.textSecondary}>
            No other devices are signed in.
          </T>
        ) : null}
      </View>

      <ListGroup>
        <ListRow title="Two-step verification" subtitle={twoStepOn ? `Authenticator app${mfa.data?.friendly_name ? ` · ${mfa.data.friendly_name}` : ''}` : 'Off'} icon="lock" href="/two-factor" />
        <ListRow title="Privacy and security" subtitle="Your data, private session" icon="shield" href="/privacy" divider />
      </ListGroup>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} /> : null}

      <Button
        label={busyId === 'all' ? 'Signing out…' : confirmId === 'all' ? 'Tap to confirm' : 'Sign out of all other devices'}
        variant={busyId === 'all' ? 'disabled' : 'destructive'}
        onPress={() => void revokeAll()}
      />
    </Screen>
  );
}
