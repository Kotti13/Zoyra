import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Glass, Icon, Loading, Sheet, T, Tap } from '../components';
import { beginAddAccount, forgetAccount, rememberSession, switchToAccount, useAccountSync, useSavedAccounts, type SavedAccount } from '../lib/accounts';
import { FRAMES, FramedAvatar, parseCustom, type FrameKey } from '../lib/profile-custom';
import { confirmAction } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const PLAN_LABEL: Record<string, string> = { free: 'Free', premium: 'Premium', family: 'Family', student: 'Student' };

const subtitle = (a: { username: string | null; plan: string | null; email?: string | null }) =>
  [a.username ? `@${a.username}` : a.email ?? null, a.plan ? PLAN_LABEL[a.plan] ?? a.plan : null].filter(Boolean).join(' · ');

const frameOf = (f: string | null): FrameKey => ((FRAMES as readonly string[]).includes(f ?? '') ? (f as FrameKey) : 'glow');

/** Leave every sheet and land on Home as the new account. */
function goHome() {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

export default function AccountSwitcher() {
  const { session, profile, signOut } = useAuth();
  const { accounts } = useSavedAccounts();
  // Keeps saved tokens fresh from now on (the root layout should also mount this; see accounts.ts).
  useAccountSync();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Make sure the account in use is saved (and its tokens are current) whenever the sheet opens.
  useEffect(() => {
    if (session) void rememberSession(session, profile as unknown as Record<string, unknown>).catch(() => {});
  }, [session, profile]);

  if (!session) {
    return (
      <Sheet>
        <T variant="section">Sign in to switch accounts</T>
        <Button label="Sign in" href="/login" />
      </Sheet>
    );
  }

  const me = session.user.id;
  const custom = parseCustom(profile);
  const others = (accounts ?? []).filter((a) => a.id !== me);
  const myName = profile?.display_name || session.user.email || 'this account';

  const switchTo = async (a: SavedAccount) => {
    if (busy) return;
    setBusy(a.id);
    setError(null);
    try {
      await switchToAccount(a.id);
      goHome();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not switch accounts');
    } finally {
      setBusy(null);
    }
  };

  const addAccount = async () => {
    if (busy) return;
    setBusy('add');
    setError(null);
    try {
      await beginAddAccount();
      router.push('/login');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start adding an account');
    } finally {
      setBusy(null);
    }
  };

  const logOut = async () => {
    if (busy) return;
    const ok = await confirmAction(`Log out of ${myName}?`, others.length ? `You'll switch to ${others[0].display_name}.` : 'You can sign back in any time.', 'Log out');
    if (!ok) return;
    setBusy('logout');
    setError(null);
    try {
      await forgetAccount(me);
      await signOut();
      // Carry on as the next saved account, if there is one that's still signed in.
      for (const next of others) {
        try {
          await switchToAccount(next.id);
          goHome();
          return;
        } catch {
          /* that one expired too; try the next */
        }
      }
      // No other account: the AuthGate resets the stack to Welcome after the sign-out.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log out');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (a: SavedAccount) => {
    const ok = await confirmAction(`Remove ${a.display_name}?`, 'It will be forgotten on this device. You can add it again later.', 'Remove');
    if (ok) await forgetAccount(a.id).catch(() => setError('Could not remove that account'));
  };

  return (
    <Sheet gap={12}>
      <T variant="section" accessibilityRole="header">
        Switch account
      </T>

      <Glass padding={8}>
        <View accessible accessibilityLabel={`${myName}, current account`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}>
          <FramedAvatar uri={profile?.avatar_url} id={me} name={myName} preset={custom.avatar_art} frame={custom.avatar_frame} size={48} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T size={16} weight={600} numberOfLines={1}>
              {myName}
            </T>
            <T size={13} color={colors.textSecondary} numberOfLines={1}>
              {subtitle({ username: profile?.username ?? null, plan: profile?.plan ?? null, email: session.user.email })}
            </T>
          </View>
          <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={16} color={colors.onAccent} />
          </View>
        </View>

        {accounts === null ? <Loading height={64} /> : null}

        {others.map((a) => (
          <View key={a.id} style={{ borderTopWidth: 1, borderTopColor: colors.divider }}>
            <Tap
              accessibilityLabel={`Switch to ${a.display_name}`}
              accessibilityHint="Long press to remove from this device"
              onPress={() => void switchTo(a)}
              onLongPress={() => void remove(a)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 }}
            >
              <FramedAvatar uri={a.avatar_url} id={a.id} name={a.display_name} preset={a.avatar_art} frame={frameOf(a.avatar_frame)} size={48} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={16} weight={600} numberOfLines={1}>
                  {a.display_name}
                </T>
                <T size={13} color={colors.textSecondary} numberOfLines={1}>
                  {subtitle(a)}
                </T>
              </View>
              {busy === a.id ? <ActivityIndicator color={colors.accent} /> : <Icon name="chevronRight" size={18} color={colors.textSecondary} />}
            </Tap>
          </View>
        ))}
      </Glass>

      {error ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      <Button label={busy === 'add' ? 'Opening sign in…' : 'Add another account'} icon="plus" variant="glass" onPress={() => void addAccount()} />
      <Button label="Manage family profiles" icon="users" variant="glass" href="/family" />

      <Tap accessibilityLabel={`Log out of ${myName}`} onPress={() => void logOut()} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
        {busy === 'logout' ? <ActivityIndicator color={colors.like} /> : <Icon name="close" size={18} color={colors.like} />}
        <T size={14} weight={600} color={colors.like}>
          Log out of {myName}
        </T>
      </Tap>
    </Sheet>
  );
}
