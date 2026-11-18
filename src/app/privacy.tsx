import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Share } from 'react-native';

import { Glass, Icon, ListRow, Row, Screen, ScreenHeader, T, Toggle } from '../components';
import type { IconName } from '../components';
import { confirmDialog, showDialog } from '../lib/dialog';
import { verifiedTotpFactor } from '../lib/mfa';
import { countBlocked } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type ToggleKey = 'private_session' | 'public_profile' | 'listening_activity';

const toggles: { key: ToggleKey; title: string; subtitle: string; icon: IconName }[] = [
  { key: 'private_session', title: 'Private session', subtitle: 'Do not save listening history', icon: 'lock' },
  { key: 'public_profile', title: 'Public profile', subtitle: 'Anyone can find you', icon: 'user' },
  { key: 'listening_activity', title: 'Share activity', subtitle: 'Friends see what you play', icon: 'users' },
];

/** Everything we store about the signed-in user, as JSON (RLS limits each query to their own rows). */
async function exportMyData(uid: string) {
  const [profile, settings, liked, playlists, follows, artists, history] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', uid).single(),
    supabase.from('user_settings').select('*').eq('user_id', uid).single(),
    supabase.from('liked_tracks').select('track_id, created_at').eq('user_id', uid),
    supabase.from('playlists').select('id, title, description, visibility, created_at, playlist_tracks(track_id, added_at)').eq('owner_id', uid),
    supabase.from('follows').select('following_id, created_at').eq('follower_id', uid),
    supabase.from('followed_artists').select('artist_id, created_at').eq('user_id', uid),
    supabase.from('play_history').select('track_id, played_at, seconds_listened').eq('user_id', uid).order('played_at', { ascending: false }).limit(500),
  ]);
  const err = profile.error ?? settings.error ?? liked.error ?? playlists.error ?? follows.error ?? artists.error ?? history.error;
  if (err) throw new Error(err.message);
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      profile: profile.data,
      settings: settings.data,
      liked_tracks: liked.data,
      playlists: playlists.data,
      following_users: follows.data,
      followed_artists: artists.data,
      recent_play_history: history.data,
    },
    null,
    2,
  );
}

export default function Privacy() {
  const { user, profile, settings, updateProfile, updateSettings, refresh } = useAuth();
  const [note, setNote] = useState<{ text: string; error?: boolean }>();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [signingOutOthers, setSigningOutOthers] = useState(false);
  /** undefined while loading, null when it couldn't be read. */
  const [twoFactorOn, setTwoFactorOn] = useState<boolean | null | undefined>(undefined);
  const [blockedCount, setBlockedCount] = useState<number | null | undefined>(undefined);
  const uid = user?.id;

  // Re-read 2FA status and the block count whenever the screen comes back into focus.
  useFocusEffect(
    useCallback(() => {
      if (!uid) return;
      let alive = true;
      verifiedTotpFactor()
        .then((f) => alive && setTwoFactorOn(!!f))
        .catch(() => alive && setTwoFactorOn(null));
      countBlocked(uid)
        .then((n) => alive && setBlockedCount(n))
        .catch(() => alive && setBlockedCount(null));
      return () => {
        alive = false;
      };
    }, [uid]),
  );

  // Pull to refresh: profile + settings (privacy toggles saved from another device), 2FA status, block count.
  const pullRefresh = () =>
    Promise.all([
      refresh().catch(() => undefined),
      verifiedTotpFactor()
        .then((f) => setTwoFactorOn(!!f))
        .catch(() => setTwoFactorOn(null)),
      uid
        ? countBlocked(uid)
            .then((n) => setBlockedCount(n))
            .catch(() => setBlockedCount(null))
        : undefined,
    ]);

  const signOutOthers = async () => {
    if (signingOutOthers) return;
    setSigningOutOthers(true);
    setNote(undefined);
    try {
      const { error } = await supabase.auth.signOut({ scope: 'others' });
      if (error) throw new Error(error.message);
      setNote({ text: 'Logged out of every other device. This one stays signed in.' });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not log out other devices', error: true });
    } finally {
      setSigningOutOthers(false);
    }
  };

  const confirmSignOutOthers = () => {
    if (signingOutOthers) return;
    const title = 'Log out other devices?';
    const message = 'Every other phone, tablet or browser signed in to your account will be logged out. This device stays signed in.';
    void confirmDialog(title, message, 'Log out others').then((ok) => {
      if (ok) void signOutOthers();
    });
  };

  const deleteAccount = async () => {
    if (deleting) return;
    setDeleting(true);
    setNote(undefined);
    try {
      const { error } = await supabase.functions.invoke('delete-account', { body: {} });
      if (error) {
        const ctx: unknown = (error as { context?: unknown }).context;
        const status = typeof Response !== 'undefined' && ctx instanceof Response ? ctx.status : null;
        const body = status != null && ctx instanceof Response ? ((await ctx.clone().json().catch(() => null)) as { error?: string; message?: string } | null) : null;
        if (status === 503 || body?.error === 'not_configured') throw new Error('Account deletion needs server setup. Nothing has been removed. Contact support to delete your account.');
        if (status === 404) throw new Error('Account deletion is not deployed yet. Nothing has been removed.');
        throw new Error(body?.message ?? body?.error ?? error.message ?? 'Could not delete your account');
      }
      // The user no longer exists server-side, so only clear the local session.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      // The auth gate sends us to Welcome once the session is gone.
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not delete your account. Nothing has been removed.', error: true });
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    if (deleting) return;
    void (async () => {
      const first = await showDialog({
        title: 'Delete your account?',
        message: 'Your profile, playlists, likes, follows and listening history will be permanently deleted.',
        icon: 'trash',
        tone: 'danger',
        actions: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Continue', style: 'destructive' },
        ],
      });
      if (first !== 'Continue') return;
      const second = await showDialog({
        title: 'This cannot be undone',
        message: 'Delete your Zoyra account forever? Cancel any app store subscription separately.',
        icon: 'trash',
        tone: 'danger',
        actions: [
          { label: 'Keep my account', style: 'cancel' },
          { label: 'Delete forever', style: 'destructive' },
        ],
      });
      if (second === 'Delete forever') void deleteAccount();
    })();
  };

  const privacy = settings?.privacy ?? {};
  const values: Record<ToggleKey, boolean> = {
    private_session: privacy.private_session ?? false,
    public_profile: !(profile?.is_private ?? false),
    listening_activity: privacy.listening_activity ?? true,
  };

  const setToggle = async (key: ToggleKey, v: boolean) => {
    setNote(undefined);
    try {
      if (key === 'public_profile') await updateProfile({ is_private: !v });
      else await updateSettings({ privacy: { ...privacy, [key]: v } });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not save that change', error: true });
    }
  };

  const download = async () => {
    if (!user || exporting) return;
    setExporting(true);
    setNote(undefined);
    try {
      const json = await exportMyData(user.id);
      await Share.share({ title: 'My Zoyra data', message: json });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not export your data', error: true });
    } finally {
      setExporting(false);
    }
  };

  const links: { title: string; subtitle: string; icon: IconName; value?: string; busy?: boolean; onPress: () => void }[] = [
    {
      title: 'Two-factor authentication',
      subtitle: 'Authenticator app',
      icon: 'shield',
      value: twoFactorOn === undefined ? '…' : twoFactorOn === null ? '' : twoFactorOn ? 'On' : 'Off',
      onPress: () => router.push('/two-factor'),
    },
    { title: 'Message privacy', subtitle: 'Who can message you, read receipts', icon: 'mail', onPress: () => router.push('/dm-privacy') },
    { title: 'Forever friends', subtitle: 'Up to 3 people for life · can never be blocked', icon: 'heart', onPress: () => router.push('/forever') },
    { title: 'Chat backup', subtitle: 'Encrypted backup of your chat keys with a PIN', icon: 'lock', onPress: () => router.push('/e2ee-setup') },
    { title: 'Permissions', subtitle: 'Notifications, microphone, camera and more', icon: 'eye', onPress: () => router.push('/permissions?mode=manage') },
    {
      title: 'Blocked users',
      subtitle: 'Manage who you blocked',
      icon: 'close',
      value: blockedCount === undefined ? '…' : blockedCount === null ? '' : String(blockedCount),
      onPress: () => router.push('/blocked'),
    },
    { title: 'Devices and sessions', subtitle: 'See where you are signed in', icon: 'phone', onPress: () => router.push('/sessions') },
    {
      title: 'Log out other devices',
      subtitle: signingOutOthers
        ? 'Logging out…'
        : user?.last_sign_in_at
          ? `Last sign-in here ${new Date(user.last_sign_in_at).toLocaleString()}`
          : 'Keep only this device signed in',
      icon: 'clock',
      busy: signingOutOthers,
      onPress: confirmSignOutOthers,
    },
    { title: 'Download my data', subtitle: 'Export everything as JSON', icon: 'download', busy: exporting, onPress: () => void download() },
  ];

  return (
    <Screen onRefresh={uid ? pullRefresh : undefined}
      top={4}
      gap={16}
      backdrop={{
        pattern: 'lines',
        mesh: 'none',
        glows: [
          { x: 0, y: 0, color: colors.sky, opacity: 0.32 },
          { x: 1, y: 0.5, color: colors.accent, opacity: 0.25 },
        ],
      }}
    >
      <ScreenHeader title="Privacy and security" />

      <Glass padding={4}>
        {toggles.map((t, i) => (
          <ListRow
            key={t.key}
            title={t.title}
            subtitle={t.subtitle}
            icon={t.icon}
            divider={i > 0}
            right={<Toggle value={values[t.key]} label={t.title} onChange={(v) => void setToggle(t.key, v)} />}
          />
        ))}
      </Glass>

      <Glass padding={4}>
        {links.map((l, i) => (
          <ListRow
            key={l.title}
            title={l.title}
            subtitle={l.subtitle}
            icon={l.icon}
            divider={i > 0}
            onPress={l.onPress}
            right={
              <Row gap={12}>
                {l.value ? (
                  <T mono size={13} color={colors.textSecondary}>
                    {l.value}
                  </T>
                ) : null}
                {l.busy ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Icon name="chevronRight" size={18} color={colors.textSecondary} />
                )}
              </Row>
            }
          />
        ))}
      </Glass>

      <Glass padding={4}>
        <ListRow
          title="Delete account"
          subtitle={deleting ? 'Deleting…' : 'Permanently remove your data'}
          icon="trash"
          iconColor={colors.error}
          iconBg={withAlpha(colors.error, 0.16)}
          titleColor={colors.error}
          onPress={confirmDelete}
          right={deleting ? <ActivityIndicator color={colors.error} /> : undefined}
        />
      </Glass>

      {note ? (
        <T size={13} lineHeight={18} color={note.error ? colors.error : colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
    </Screen>
  );
}
