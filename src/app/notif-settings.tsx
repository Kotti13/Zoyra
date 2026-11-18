import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking } from 'react-native';

import { Glass, Icon, ListRow, Screen, ScreenHeader, T, Toggle } from '../components';
import type { IconName } from '../components';
import { showDialog } from '../lib/dialog';
import { describePushResult, pushPermissionStatus, registerForPush, saveNotificationTimeZone, setAlertPrefsCache, type PushResult } from '../lib/push';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/** `key` is the field stored in user_settings.notifications; `on` is the default when unset. */
const prefs: { key: string; title: string; subtitle: string; icon: IconName; on: boolean }[] = [
  { key: 'new_releases', title: 'New releases', subtitle: 'New songs from artists you follow (checked hourly)', icon: 'music', on: true },
  { key: 'live_reminders', title: 'Live sessions', subtitle: 'When a session you asked to be reminded of starts', icon: 'bolt', on: true },
  { key: 'friend_activity', title: 'Friend activity', subtitle: 'Friends going live and joining your jams', icon: 'users', on: false },
  { key: 'downloads', title: 'Downloads', subtitle: 'When songs finish downloading on this device', icon: 'download', on: true },
  { key: 'playlist_updates', title: 'Playlist updates', subtitle: 'Collaborators add songs', icon: 'queue', on: true },
  { key: 'weekly_report', title: 'Weekly report', subtitle: 'Your listening recap', icon: 'clock', on: true },
  { key: 'concerts', title: 'Concerts near you', subtitle: 'For followed artists', icon: 'pin', on: true },
  { key: 'recommendations', title: 'Recommendations', subtitle: 'You might like', icon: 'star', on: false },
];

export default function NotifSettings() {
  const { user, settings, updateSettings } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<PushResult | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const n = settings?.notifications ?? {};
  const bool = (key: string, fallback: boolean) => (typeof n[key] === 'boolean' ? (n[key] as boolean) : fallback);
  const str = (key: string, fallback: string) => (typeof n[key] === 'string' ? (n[key] as string) : fallback);
  const quiet = bool('quiet_hours', true);
  // Defaults match push-settings.tsx and the push function (11 pm to 7 am).
  const from = str('quiet_from', '23:00');
  const until = str('quiet_until', '07:00');

  const pushOn = bool('push', false);

  // Refresh the token silently if push was enabled before (no OS prompt).
  useEffect(() => {
    if (!user || !pushOn) return;
    let live = true;
    void pushPermissionStatus().then(async (status) => {
      if (!live) return;
      if (status === 'granted') {
        const r = await registerForPush(user.id, { prompt: false });
        if (live) setPush(r);
      } else if (status === 'denied') setPush({ ok: false, reason: 'permission_denied' });
    });
    return () => {
      live = false;
    };
  }, [user, pushOn]);

  const togglePush = async (value: boolean) => {
    if (!user || pushBusy) return;
    setError(null);
    if (!value) {
      setPush(null);
      set('push', false);
      return;
    }
    setPushBusy(true);
    const r = await registerForPush(user.id);
    setPushBusy(false);
    setPush(r);
    set('push', r.ok);
  };

  const pushSubtitle = pushBusy ? 'Setting up…' : push ? describePushResult(push) : pushOn ? 'Enabled' : 'Messages, dedications, follows and invites';

  const set = (key: string, value: boolean | string) => {
    setError(null);
    updateSettings({ notifications: { ...n, [key]: value } }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save'));
  };

  // Keep the foreground notification handler's copy of these settings current.
  useEffect(() => setAlertPrefsCache(settings?.notifications), [settings?.notifications]);

  /** Quiet hours start / end picker. Quiet hours run on the server in this phone's time zone. */
  const pickTime = async (key: 'quiet_from' | 'quiet_until') => {
    const choices = key === 'quiet_from' ? ['21:00', '22:00', '23:00', '00:00'] : ['06:00', '07:00', '08:00', '09:00'];
    const current = key === 'quiet_from' ? from : until;
    const picked = await showDialog({
      title: key === 'quiet_from' ? 'Quiet from' : 'Quiet until',
      icon: 'moon',
      actions: [...choices.map((c) => ({ label: c === current ? `${c} ✓` : c, style: 'default' as const })), { label: 'Cancel', style: 'cancel' }],
    });
    const value = picked?.replace(' ✓', '');
    if (value && choices.includes(value) && value !== current) {
      set(key, value);
      void saveNotificationTimeZone();
    }
  };

  return (
    <Screen
      top={4}
      gap={16}
      backdrop={{
        pattern: 'dots',
        mesh: 'none',
        glows: [
          { x: 1, y: 0, color: colors.amber, opacity: 0.28 },
          { x: 0, y: 0.3, color: colors.violet, opacity: 0.2 },
        ],
      }}
    >
      <ScreenHeader title="Notifications" />

      <Glass padding={4}>
        <ListRow
          title="Push notifications"
          subtitle={pushSubtitle}
          icon="bell"
          iconColor={push && !push.ok ? colors.error : colors.accentLight}
          onPress={push && !push.ok && push.reason === 'permission_denied' ? () => void Linking.openSettings() : undefined}
          right={pushBusy ? <ActivityIndicator color={colors.accentLight} /> : <Toggle value={pushOn && (push?.ok ?? true)} onChange={(v) => void togglePush(v)} label="Push notifications" />}
        />
      </Glass>

      <Glass padding={4}>
        <ListRow
          title="Message alerts"
          subtitle="Reply from notification, previews"
          icon="mail"
          href="/push-settings"
          right={<Icon name="chevronRight" size={18} color={colors.textSecondary} />}
        />
      </Glass>

      <Glass padding={4}>
        {prefs.map((p, i) => (
          <ListRow key={p.key} title={p.title} subtitle={p.subtitle} icon={p.icon} divider={i > 0} right={<Toggle value={bool(p.key, p.on)} onChange={(v) => set(p.key, v)} label={p.title} />} />
        ))}
      </Glass>

      <Glass padding={4}>
        <ListRow
          title="Quiet hours"
          subtitle="Alerts arrive silently, without pop-ups"
          icon="moon"
          right={
            <Toggle
              value={quiet}
              onChange={(v) => {
                set('quiet_hours', v);
                if (v) void saveNotificationTimeZone();
              }}
              label="Quiet hours"
            />
          }
        />
        {quiet ? (
          <>
            <ListRow
              title="From"
              minHeight={52}
              divider
              onPress={() => void pickTime('quiet_from')}
              right={
                <T mono size={16} accessibilityLabel={`From ${from}. Change`}>
                  {from}
                </T>
              }
            />
            <ListRow
              title="Until"
              minHeight={52}
              divider
              onPress={() => void pickTime('quiet_until')}
              right={
                <T mono size={16} color={colors.text} accessibilityLabel={`Until ${until}. Change`}>
                  {until}
                </T>
              }
            />
          </>
        ) : null}
      </Glass>

      {error ? (
        <T size={13} color={colors.error}>
          {error}
        </T>
      ) : null}
      <T size={12} color={colors.textSecondary} align="center" lineHeight={17}>
        Your choices are saved to your account. Push alerts go to every device where you turn them on.
      </T>
    </Screen>
  );
}
