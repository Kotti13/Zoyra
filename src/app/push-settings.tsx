import { useEffect, useState } from 'react';
import { Linking, Platform, View } from 'react-native';

import { artFor, Avatar, Icon, IconButton, ListGroup, ListRow, Row, Screen, T, Tap, Toggle } from '../components';
import type { IconName } from '../components';
import { showDialog } from '../lib/dialog';
import {
  alertChoice,
  alertPref,
  MESSAGE_ALERT_CHOICES,
  MESSAGE_ALERT_PREFS,
  pushPermissionStatus,
  QUICK_REPLIES,
  saveNotificationTimeZone,
  setAlertPrefsCache,
  type MessageAlertChoice,
  type MessageAlertPref,
} from '../lib/push';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Latest = { name: string; senderId: string | null; text: string; count: number } | null;

/** Preview card (Push settings design): rgba(32,32,32,.62) card, 26 radius, 1px glass edge. */
const CARD_BG = 'rgba(32,32,32,0.62)';
const CARD_TEXT = '#E5E5E5';

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Same defaults as notif-settings.tsx and the push function. */
const QUIET_FROM = '23:00';
const QUIET_UNTIL = '07:00';

function hourLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h)) return hhmm;
  const hour = (h ?? 0) % 12 || 12;
  const mins = m ? `:${String(m).padStart(2, '0')}` : '';
  return `${hour}${mins} ${(h ?? 0) < 12 ? 'am' : 'pm'}`;
}

/** The newest real message alert in the user's inbox, used to preview how alerts will look. */
function useLatestMessageAlert(userId: string | undefined) {
  const [latest, setLatest] = useState<Latest>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void supabase
      .from('notifications')
      .select('payload')
      .eq('user_id', userId)
      .eq('kind', 'message')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!live || !data) return;
        const p = (data.payload ?? {}) as Record<string, unknown>;
        const text = str(p.preview) ?? str(p.body);
        const name = str(p.actor_name) ?? str(p.title);
        if (!text || !name) return;
        setLatest({ name, senderId: str(p.sender_id) ?? null, text, count: typeof p.count === 'number' ? p.count : 1 });
      });
    return () => {
      live = false;
    };
  }, [userId]);
  return latest;
}

export default function PushSettings() {
  const { user, settings, updateSettings } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<'granted' | 'denied' | 'undetermined' | 'unsupported' | null>(null);
  const latest = useLatestMessageAlert(user?.id);
  const n = settings?.notifications ?? {};

  useEffect(() => {
    let live = true;
    void pushPermissionStatus().then((s) => {
      if (live) setPermission(s);
    });
    return () => {
      live = false;
    };
  }, []);

  // Keep the foreground handler's copy current (banner / sound for alerts while the app is open).
  useEffect(() => setAlertPrefsCache(settings?.notifications), [settings?.notifications]);

  const pref = (p: MessageAlertPref) => alertPref(n, p);
  const save = (patch: Record<string, string | boolean>) => {
    if (!user) return setError('Sign in to save message alert settings.');
    setError(null);
    updateSettings({ notifications: { ...n, ...patch } }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not save'));
  };
  const setPref = (p: MessageAlertPref, v: boolean) => save({ [MESSAGE_ALERT_PREFS[p].key]: v });

  const sound = alertChoice(n, 'sound');
  const vibration = alertChoice(n, 'vibration');
  const option = <C extends MessageAlertChoice>(c: C, value: string) => MESSAGE_ALERT_CHOICES[c].options.find((o) => o.value === value) ?? MESSAGE_ALERT_CHOICES[c].options[0];

  const pick = async (c: MessageAlertChoice, title: string) => {
    const current = c === 'sound' ? sound : vibration;
    const opts = MESSAGE_ALERT_CHOICES[c].options;
    const chosen = await showDialog({
      title,
      icon: c === 'sound' ? 'bell' : 'phone',
      actions: [...opts.map((o) => ({ label: o.value === current ? `${o.subtitle} ✓` : o.subtitle, style: 'default' as const })), { label: 'Cancel', style: 'cancel' }],
    });
    const hit = opts.find((o) => chosen === o.subtitle || chosen === `${o.subtitle} ✓`);
    if (hit && hit.value !== current) {
      save({ [MESSAGE_ALERT_CHOICES[c].key]: hit.value });
      // Quiet hours run on the server in local time: make sure it knows this phone's time zone.
      void saveNotificationTimeZone();
    }
  };

  const quietOn = typeof n.quiet_hours === 'boolean' ? n.quiet_hours : true;
  const quietFrom = typeof n.quiet_from === 'string' ? n.quiet_from : QUIET_FROM;
  const quietUntil = typeof n.quiet_until === 'string' ? n.quiet_until : QUIET_UNTIL;
  const pushOn = n.push === true;
  const messagesOn = typeof n.messages === 'boolean' ? n.messages : true;

  // Preview banner, built from the newest real message alert and the toggles below.
  const senderName = latest?.name ?? 'Priya Nair';
  const grouped = pref('group') && (latest?.count ?? 1) > 1;
  const previewTitle = pref('sender') ? senderName : 'Zoyra';
  const previewText = latest?.text ?? 'Yes! The drop at 0:42 is unreal';
  const previewBody = pref('preview') ? (grouped ? `${latest?.count ?? 1} new messages · ${previewText}` : previewText) : grouped ? `${latest?.count ?? 1} new messages` : 'New message';

  const display: { pref: MessageAlertPref; title: string; subtitle: string; icon: IconName; a11y: string }[] = [
    { pref: 'sender', title: 'Show sender name', subtitle: `${senderName} above the message`, icon: 'user', a11y: 'Sender' },
    { pref: 'preview', title: 'Show message preview', subtitle: 'Hide text on lock screen', icon: 'eye', a11y: 'Preview' },
    { pref: 'rich', title: 'Show song and image previews', subtitle: 'Rich cards in notifications', icon: 'music', a11y: 'Rich' },
    { pref: 'group', title: 'Group by chat', subtitle: 'Stack messages per person', icon: 'library', a11y: 'Group' },
  ];
  const actions: { pref: MessageAlertPref; title: string; subtitle: string; icon: IconName; a11y: string }[] = [
    { pref: 'reply', title: 'Reply from notification', subtitle: 'Type without opening the app', icon: 'chat', a11y: 'Inline reply' },
    { pref: 'quick', title: 'Quick reply chips', subtitle: 'Thumbs up, Love it, On my way', icon: 'star', a11y: 'Chips' },
    { pref: 'markRead', title: 'Mark as read button', subtitle: 'One tap from the banner', icon: 'check', a11y: 'Read button' },
  ];

  // Android shows only the first 3 buttons of a notification.
  const buttons = [
    ...(pref('reply') ? ['Reply'] : []),
    ...(pref('quick') ? QUICK_REPLIES.map((q) => q.title) : []),
    ...(pref('markRead') ? ['Mark read'] : []),
    'Mute 1h',
    'Like',
  ];

  const status = !user
    ? 'Sign in to save message alert settings.'
    : permission === 'unsupported'
      ? 'Push notifications are not available here. These settings apply on your phone.'
      : permission === 'denied'
        ? 'Notifications are blocked for Zoyra in system settings. Tap to open them.'
        : !pushOn
          ? 'Push is off for this account. Tap to turn it on in Notifications.'
          : !messagesOn
            ? 'Message alerts are off in Notifications. Tap to turn them on.'
            : null;

  return (
    <Screen
      top={4}
      gap={16}
      bottom={28}
      backdrop={{
        pattern: 'none',
        mesh: 'none',
        glows: [
          { x: 0.1, y: 0, color: colors.accent, opacity: 0.45 },
          { x: 1, y: 0.35, color: colors.orange, opacity: 0.18 },
        ],
      }}
    >
      <Row gap={8}>
        <IconButton icon="back" label="Back" bg={withAlpha(colors.white, 0.1)} href="back" />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} lineHeight={38} accessibilityRole="header">
          Message alerts
        </T>
        <T size={14} color={colors.textSecondary} lineHeight={20}>
          How chats appear in notifications
        </T>
      </View>

      <View
        accessible
        accessibilityLabel={`Preview. ${previewTitle}. ${previewBody}`}
        style={{ borderRadius: 26, paddingVertical: 12, paddingHorizontal: 14, backgroundColor: CARD_BG, borderWidth: 1, borderColor: colors.glassBorder, gap: 8 }}
      >
        <Row gap={6}>
          <View style={{ width: 16, height: 16, borderRadius: 5, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="music" size={10} color={colors.onAccent} />
          </View>
          <T size={11} tracking={0.6} color={CARD_TEXT} style={{ flex: 1 }}>
            ZOYRA · MESSAGES
          </T>
          <T size={11} color={CARD_TEXT}>
            now
          </T>
        </Row>
        <Row gap={12}>
          {pref('sender') ? (
            <Avatar initial={(senderName.charAt(0) || '?').toUpperCase()} art={artFor(latest?.senderId ?? senderName)} size={44} />
          ) : (
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface3, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="mail" size={20} color={colors.textSecondary} />
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <T size={15} weight={700} numberOfLines={1}>
              {previewTitle}
            </T>
            <T size={14} color={CARD_TEXT} lineHeight={18} numberOfLines={2}>
              {previewBody}
            </T>
          </View>
        </Row>
      </View>

      <ListGroup title="DISPLAY">
        {display.map((d, i) => (
          <ListRow key={d.pref} title={d.title} subtitle={d.subtitle} icon={d.icon} divider={i > 0} right={<Toggle value={pref(d.pref)} onChange={(v) => setPref(d.pref, v)} label={d.a11y} />} />
        ))}
      </ListGroup>

      <ListGroup title="ACTIONS">
        {actions.map((a, i) => (
          <ListRow key={a.pref} title={a.title} subtitle={a.subtitle} icon={a.icon} divider={i > 0} right={<Toggle value={pref(a.pref)} onChange={(v) => setPref(a.pref, v)} label={a.a11y} />} />
        ))}
      </ListGroup>

      <ListGroup title="ALERT">
        <ListRow
          title="Sound"
          subtitle={option('sound', sound).subtitle}
          icon="bell"
          onPress={() => void pick('sound', 'Message sound')}
          right={<Value text={option('sound', sound).label} />}
        />
        <ListRow
          title="Vibration"
          subtitle={option('vibration', vibration).subtitle}
          icon="phone"
          divider
          onPress={() => void pick('vibration', 'Vibration')}
          right={<Value text={option('vibration', vibration).label} />}
        />
        <ListRow title="Pop up banner" subtitle="Heads-up on top of apps" icon="play" divider right={<Toggle value={pref('banner')} onChange={(v) => setPref('banner', v)} label="Banner" />} />
        <ListRow
          title="Quiet hours"
          subtitle={quietOn ? `${hourLabel(quietFrom)} to ${hourLabel(quietUntil)}` : 'Alerts can sound any time'}
          icon="moon"
          divider
          href="/notif-settings"
          right={<Value text={quietOn ? 'On' : 'Off'} />}
        />
      </ListGroup>

      {status ? (
        <Tap
          onPress={permission === 'denied' ? () => void Linking.openSettings() : undefined}
          href={user && permission !== 'denied' && permission !== 'unsupported' ? '/notif-settings' : undefined}
          accessibilityLabel={status}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}
        >
          <Icon name="info" size={16} color={colors.textSecondary} />
          <T size={12} color={colors.textSecondary} lineHeight={17} style={{ flex: 1 }}>
            {status}
          </T>
        </Tap>
      ) : null}
      {error ? (
        <T size={13} color={colors.error} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}
      {Platform.OS === 'android' && buttons.length > 3 ? (
        <T size={12} color={colors.textSecondary} lineHeight={17} style={{ paddingHorizontal: 4 }}>
          Android shows up to 3 buttons on a notification: {buttons.slice(0, 3).join(', ')}.
        </T>
      ) : null}
      {Platform.OS === 'ios' ? (
        <T size={12} color={colors.textSecondary} lineHeight={17} style={{ paddingHorizontal: 4 }}>
          On iPhone, vibration follows your phone&apos;s haptics, and turning off pop-up banners also silences alerts.
        </T>
      ) : null}
    </Screen>
  );
}

/** Trailing "Chime ›" value used by the Sound / Vibration / Quiet hours rows. */
function Value({ text }: { text: string }) {
  return (
    <Row gap={4}>
      <T size={13} color={colors.textSecondary}>
        {text}
      </T>
      <Icon name="chevronRight" size={16} color={colors.textSecondary} />
    </Row>
  );
}
