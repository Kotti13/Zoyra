import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Share, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Cover, ErrorState, Glass, IconButton, LinkText, Loading, Row, Screen, ScreenHeader, SectionHeader, Spacer, Sticker, T, Toast, Toggle, useAsync, IconBadge } from '../components';
import { confirmDialog } from '../lib/dialog';
import { manageSubscription } from '../lib/payments';
import { FAMILY_SEATS, createFamilyInvite, familyInviteLink, leaveFamily, loadFamily, removeFamilyMember, type FamilyMember } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

function confirmAsync(title: string, message: string, action: string): Promise<boolean> {
  return confirmDialog(title, message, action, true);
}

function MemberRow({ m, me, divider, canRemove, busy, onRemove }: { m: FamilyMember; me?: string; divider: boolean; canRemove: boolean; busy: boolean; onRemove: () => void }) {
  const isMe = m.id === me;
  return (
    <Row gap={12} style={[{ minHeight: 68, paddingLeft: 8, paddingRight: 4 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      <Cover uri={m.avatar_url} id={m.id} size={48} radius={32} style={{ alignItems: 'center', justifyContent: 'center' }}>
        {m.avatar_url ? null : (
          <T size={16} weight={600} color={colors.white}>
            {(m.display_name || '?').charAt(0).toUpperCase()}
          </T>
        )}
      </Cover>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500} numberOfLines={1}>
          {m.display_name}
        </T>
        <T size={14} color={colors.textSecondary}>
          {m.isOwner ? 'Plan manager' : `Joined ${new Date(m.joined_at).toLocaleDateString()}`}
        </T>
      </View>
      {isMe ? <Sticker label="YOU" rotate={3} style={{ alignSelf: 'center', marginRight: 8 }} /> : null}
      {canRemove && !isMe ? (
        busy ? (
          <ActivityIndicator color={colors.accent} style={{ marginRight: 12 }} />
        ) : (
          <IconButton icon="close" label={`Remove ${m.display_name}`} iconSize={20} color={colors.textSecondary} onPress={onRemove} />
        )
      ) : null}
    </Row>
  );
}

export default function Family() {
  const { user, profile, settings, updateSettings, refresh } = useAuth();
  const me = user?.id;
  const { code: deepCode } = useLocalSearchParams<{ code?: string }>();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState<'get' | 'rotate' | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [managing, setManaging] = useState(false);

  // zoyra://family?code=… → the join screen.
  useEffect(() => {
    if (typeof deepCode === 'string' && deepCode) router.replace({ pathname: '/join-family', params: { code: deepCode } });
  }, [deepCode]);

  const fam = useAsync(() => (me ? loadFamily(me) : Promise.resolve(null)), [me], 'app/family:66');
  const { reload } = fam;
  // Coming back to the screen: re-read seats and the plan (the owner's plan drives members' plans).
  const firstFocus = useRef(true);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      reload();
      void refreshRef.current().catch(() => {});
    }, [reload]),
  );

  const family = fam.data ?? null;
  const onFamily = profile?.plan === 'family';
  const isOwner = !!family && family.owner_id === me;
  const isMember = !!family && !isOwner;
  const canInvite = onFamily && !isMember;
  const owner = family?.members.find((m) => m.isOwner);
  const selfRow: FamilyMember = { id: me ?? 'me', display_name: profile?.display_name || 'You', avatar_url: profile?.avatar_url ?? null, joined_at: new Date().toISOString(), isOwner: onFamily };
  const members = family?.members.length ? family.members : [selfRow];
  const used = members.length;
  const inviteCode = code ?? family?.invite_code ?? null;
  const kidSafe = settings?.privacy?.hide_explicit ?? false;

  const setKidSafe = (v: boolean) => {
    if (!settings) return;
    setNote(null);
    updateSettings({ privacy: { ...settings.privacy, hide_explicit: v } }).catch((e: unknown) => setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save' }));
  };

  /** Returns the current invite code, creating the family on first use. */
  const ensureCode = async (rotate = false): Promise<string | null> => {
    if (!rotate && inviteCode) return inviteCode;
    if (codeBusy) return null;
    setCodeBusy(rotate ? 'rotate' : 'get');
    setNote(null);
    try {
      const c = await createFamilyInvite(rotate);
      setCode(c);
      if (!family) reload();
      return c;
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not create an invite' });
      return null;
    } finally {
      setCodeBusy(null);
    }
  };

  const copyLink = async () => {
    const c = await ensureCode();
    if (!c) return;
    try {
      await Clipboard.setStringAsync(familyInviteLink(c));
      setNote({ ok: true, text: 'Invite link copied' });
    } catch {
      setNote({ ok: false, text: `Could not copy. Share the code ${c} instead.` });
    }
  };

  const shareInvite = async () => {
    const c = await ensureCode();
    if (!c) return;
    try {
      await Share.share({ title: 'Join my Zoyra Family plan', message: `Join my Zoyra Family plan: ${familyInviteLink(c)}\nOr enter code ${c} in Zoyra → Family plan.` });
    } catch {
      setNote({ ok: false, text: 'Could not open the share sheet' });
    }
  };

  const toggleQr = async () => {
    if (showQr) return setShowQr(false);
    if (await ensureCode()) setShowQr(true);
  };

  const rotate = async () => {
    if (!(await confirmAsync('Make a new invite code?', 'The old link and code stop working. People already in your family stay.', 'New code'))) return;
    if (await ensureCode(true)) setNote({ ok: true, text: 'New invite code ready. The old one no longer works.' });
  };

  const remove = async (m: FamilyMember) => {
    if (removing) return;
    if (!(await confirmAsync(`Remove ${m.display_name}?`, 'They go back to the Free plan right away. You can invite them again later.', 'Remove'))) return;
    setRemoving(m.id);
    setNote(null);
    try {
      await removeFamilyMember(m.id);
      setNote({ ok: true, text: `${m.display_name} was removed` });
      reload();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not remove that member' });
    } finally {
      setRemoving(null);
    }
  };

  const leave = async () => {
    if (leaving) return;
    if (!(await confirmAsync('Leave this family?', 'You go back to the Free plan right away.', 'Leave'))) return;
    setLeaving(true);
    setNote(null);
    try {
      await leaveFamily();
      await refresh();
      setNote({ ok: true, text: 'You left the family. You are on the Free plan now.' });
      reload();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not leave the family' });
    } finally {
      setLeaving(false);
    }
  };

  const manage = async () => {
    if (managing) return;
    setManaging(true);
    try {
      await manageSubscription(me ?? null);
    } catch {
      setNote({ ok: false, text: 'Could not open subscription settings. Manage it from your app store account.' });
    } finally {
      setManaging(false);
    }
  };

  const footnote = isMember
    ? onFamily
      ? `${owner?.display_name ?? 'Your plan manager'} shares Premium with you. Leaving puts you back on Free.`
      : `${owner?.display_name ?? 'Your plan manager'}'s Family plan isn't active right now, so you're on Free. You'll get Premium back if they renew.`
    : isOwner && !onFamily
      ? "Your Family plan isn't active. Members are on Free until you renew."
      : onFamily
        ? 'Share the invite link or QR code. Up to 5 people can join you.'
        : 'Get the Family plan to share Premium with up to 6 people.';

  return (
    <Screen onRefresh={me ? fam.refresh : undefined} top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'gold' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Family plan" />

      {fam.loading && fam.data === undefined ? (
        <Loading label="Loading your family" />
      ) : fam.error && fam.data === undefined ? (
        <ErrorState message={fam.error} onRetry={reload} />
      ) : (
        <>
          {/* Seats */}
          <Glass padding={16}>
            <View style={{ gap: 12 }}>
              <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <T size={22} weight={700}>
                  {used} of {FAMILY_SEATS} seats
                </T>
                <T mono size={12} color={colors.textSecondary}>
                  {Math.max(0, FAMILY_SEATS - used)} open
                </T>
              </Row>
              <View accessible accessibilityLabel={`${used} of ${FAMILY_SEATS} seats used`} style={{ flexDirection: 'row', gap: 8 }}>
                {Array.from({ length: FAMILY_SEATS }, (_, i) => (
                  <View key={i} style={{ flex: 1, height: 8, borderRadius: 4, backgroundColor: i < used ? colors.accent : colors.track }} />
                ))}
              </View>
            </View>
          </Glass>

          <SectionHeader title="Members" />
          <Glass padding={4}>
            {members.map((m, i) => (
              <MemberRow key={m.id} m={m} me={me} divider={i > 0} canRemove={isOwner} busy={removing === m.id} onRemove={() => void remove(m)} />
            ))}
          </Glass>
          <T size={12} color={colors.textSecondary} lineHeight={17}>
            {footnote}
          </T>

          {/* Invite link (plan manager only) */}
          {canInvite ? (
            <Glass padding={14}>
              <View style={{ gap: 12 }}>
                <Row gap={12}>
                  <IconBadge icon="link" size={40} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T size={15} weight={600}>
                      Invite link
                    </T>
                    <T mono size={12} color={colors.textSecondary} selectable>
                      {codeBusy ? 'Creating…' : inviteCode ? `Code ${inviteCode}` : 'Tap Copy to create one'}
                    </T>
                  </View>
                  {codeBusy ? <ActivityIndicator color={colors.accent} /> : <LinkText label="Copy" onPress={() => void copyLink()} />}
                  <IconButton icon="qr" label={showQr ? 'Hide QR code' : 'Show QR code'} iconSize={20} color={colors.accentLight} onPress={() => void toggleQr()} />
                </Row>
                {showQr && inviteCode ? (
                  <View style={{ alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 168, height: 168, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="QR code of the family invite link">
                      <QRCode value={familyInviteLink(inviteCode)} size={144} color={colors.bg} backgroundColor={colors.white} ecl="M" />
                    </View>
                    <T size={12} tracking={0.2} color={colors.textSecondary}>
                      Family scan this with their camera to join
                    </T>
                  </View>
                ) : null}
                {inviteCode ? (
                  <View style={{ alignItems: 'flex-start' }}>
                    <LinkText label={codeBusy === 'rotate' ? 'Making a new code…' : 'Make a new code'} size={13} onPress={() => void rotate()} />
                  </View>
                ) : null}
              </View>
            </Glass>
          ) : null}

          {/* Kid-safe */}
          <Glass padding={4}>
            <Row gap={12} style={{ minHeight: 64, paddingHorizontal: 8 }}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={16} weight={500}>
                  Kid-safe mode
                </T>
                <T size={14} color={colors.textSecondary}>
                  Hide explicit songs on this account
                </T>
              </View>
              <Toggle value={kidSafe} onChange={setKidSafe} label="Kid-safe mode" />
            </Row>
          </Glass>
        </>
      )}

      {note ? <Toast icon="info" iconColor={note.ok ? colors.accentLight : colors.error} message={note.text} /> : null}

      <Spacer />

      {isMember ? (
        <Button label={leaving ? 'Leaving…' : 'Leave family'} variant={leaving ? 'disabled' : 'destructive'} onPress={() => void leave()} />
      ) : onFamily ? (
        <View style={{ gap: 12 }}>
          <Button label={codeBusy === 'get' ? 'Creating invite…' : 'Invite someone'} variant={codeBusy ? 'disabled' : 'secondary'} onPress={() => void shareInvite()} />
          <View style={{ alignItems: 'center' }}>
            <LinkText label={managing ? 'Opening…' : 'Manage subscription'} onPress={() => void manage()} />
          </View>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          <Button label="Get the Family plan" href={{ pathname: '/plans', params: { plan: 'family' } }} />
          {!family ? (
            <View style={{ alignItems: 'center' }}>
              <LinkText label="Have an invite code? Join a family" href="/join-family" />
            </View>
          ) : null}
        </View>
      )}
    </Screen>
  );
}
