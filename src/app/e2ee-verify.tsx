import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, ErrorState, Glass, ListRow, Loading, Row, Screen, ScreenHeader, Sticker, T } from '../components';
import { getSafetyNumber, markVerified, type SafetyNumber } from '../lib/e2ee';
import { useE2EEBoot } from '../lib/e2ee/ui';
import { colors } from '../theme/tokens';

/**
 * Verify security code (`/e2ee-verify?uid=<other user>&name=`). Shows the 60-digit safety number
 * computed from both account keys (identical on both phones) as 12 groups and a QR code. If they match
 * in person, mark the contact as verified; a later key change shows "security code changed".
 */
export default function E2EEVerify() {
  const params = useLocalSearchParams<{ uid?: string; name?: string }>();
  const uid = typeof params.uid === 'string' ? params.uid : '';
  const name = typeof params.name === 'string' && params.name.trim() ? params.name.trim() : 'this person';
  const boot = useE2EEBoot();
  const [sn, setSn] = useState<SafetyNumber | null | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);
  const ready = boot.status === 'ready';

  useEffect(() => {
    if (!uid || !ready) return;
    let alive = true;
    getSafetyNumber(uid)
      .then((v) => alive && setSn(v))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load the security code'));
    return () => {
      alive = false;
    };
  }, [uid, ready, attempt]);

  const load = () => {
    setError(undefined);
    setAttempt((n) => n + 1);
  };

  const toggle = async () => {
    if (!sn || busy) return;
    setBusy(true);
    try {
      await markVerified(uid, !sn.verified);
      setSn({ ...sn, verified: !sn.verified, changed: false });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const groups = sn ? sn.formatted.split(' ') : [];

  return (
    <Screen top={4} gap={18} backdrop={{ pattern: 'lines', mesh: 'none', glows: [{ x: 0, y: 0, color: colors.sky, opacity: 0.3 }] }}>
      <ScreenHeader title="Verify security code" />
      {!uid ? (
        <T color={colors.textSecondary}>No contact selected.</T>
      ) : boot.status === 'needs_restore' || boot.status === 'needs_reauth' ? (
        <>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            Finish turning on encrypted chats on this phone first.
          </T>
          {boot.status === 'needs_restore' && boot.restoreReason === 'backup' ? <Button label="Restore with PIN" icon="lock" onPress={() => router.push('/e2ee-restore')} /> : null}
          <Button label="Use new keys on this phone" variant="secondary" onPress={() => router.push({ pathname: '/e2ee-setup', params: { mode: 'reauth' } })} />
        </>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : sn === undefined || boot.status !== 'ready' ? (
        <Loading label="Computing security code" />
      ) : sn === null ? (
        <T size={14} lineHeight={20} color={colors.textSecondary}>
          {name} hasn’t turned on end-to-end encryption yet.
        </T>
      ) : (
        <>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            Compare this code with the one on {name}’s phone, or let them scan the QR. If they match, your chat is end-to-end encrypted with no one in between.
          </T>
          {sn.changed ? (
            <Glass padding={4}>
              <ListRow title="Security code changed" subtitle={`${name} reset their keys or uses a new phone. Verify again.`} icon="info" />
            </Glass>
          ) : null}
          <View style={{ alignItems: 'center' }}>
            <View style={{ width: 208, height: 208, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Security code QR">
              <QRCode value={sn.qr} size={184} color={colors.bg} backgroundColor={colors.white} ecl="M" />
            </View>
          </View>
          <Glass padding={16}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }} accessibilityLabel={`Security code ${sn.number.split('').join(' ')}`}>
              {groups.map((g, i) => (
                <T key={i} mono size={18} weight={600} style={{ width: '25%', textAlign: 'center' }} selectable>
                  {g}
                </T>
              ))}
            </View>
          </Glass>
          <Row gap={10} style={{ justifyContent: 'center' }}>
            <Sticker label={sn.verified ? 'VERIFIED' : 'NOT VERIFIED'} bg={sn.verified ? colors.success : colors.handle} rotate={-2} />
          </Row>
          <Button label={busy ? 'Saving…' : sn.verified ? 'Clear verification' : 'Mark as verified'} icon={sn.verified ? undefined : 'checkBold'} variant={busy ? 'disabled' : sn.verified ? 'glass' : 'primary'} onPress={() => void toggle()} />
        </>
      )}
    </Screen>
  );
}
