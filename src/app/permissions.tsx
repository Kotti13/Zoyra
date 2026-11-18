import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';

import { Button, Glass, Icon, IconTile, LinkText, Row, Screen, ScreenHeader, T, Tap, useReduceMotion } from '../components';
import {
  getPermissionStatus,
  markPermissionsSeen,
  openPermissionSettings,
  PERMISSIONS,
  permissionApplies,
  requestPermission,
  type PermDef,
  type PermKey,
  type PermStatus,
} from '../lib/permissions';
import { registerForPush } from '../lib/push';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Statuses = Partial<Record<PermKey, PermStatus>>;

/**
 * "Get the most out of Zoyra": asks for the permissions the app uses, once per device after onboarding / sign-in
 * (the AuthGate in _layout.tsx sends signed-in users here until `zoyra.permissions.seen.v1` is set).
 * `?mode=manage` (Settings → Privacy → Permissions) shows the same rows with their current status.
 */
export default function Permissions() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const manage = mode === 'manage';
  const { user, settings, updateSettings } = useAuth();
  const reduceMotion = useReduceMotion();

  const [statuses, setStatuses] = useState<Statuses>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<PermKey | 'all' | null>(null);
  /** First run only lists full-screen alerts when they were off on arrival (it's an Android 14+ special access). */
  const [showFullscreen, setShowFullscreen] = useState(manage);
  const firstLoad = useRef(false);

  // Opening the screen counts as "seen" on disk (never shown twice); the gate is released on Continue.
  useEffect(() => {
    if (!manage) markPermissionsSeen(false);
  }, [manage]);

  const refresh = useCallback(
    () =>
      Promise.all(PERMISSIONS.map(async (p) => [p.key, await getPermissionStatus(p.key)] as const)).then((entries) => {
        const next = Object.fromEntries(entries) as Statuses;
        setStatuses(next);
        if (!firstLoad.current) {
          firstLoad.current = true;
          if (!manage && next.fullscreen && next.fullscreen !== 'granted' && next.fullscreen !== 'unavailable') setShowFullscreen(true);
        }
        setLoaded(true);
      })
      // A status read failing must never leave the step on a spinner: show what we have (rows hide).
      .catch(() => setLoaded(true)),
    [manage],
  );

  useEffect(() => {
    void refresh();
    // Coming back from the Settings app: re-read everything.
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /** Notifications granted while signed in: register this phone's push token and turn push on. */
  const afterGrant = useCallback(
    async (key: PermKey) => {
      if (key !== 'notifications' || !user) return;
      const r = await registerForPush(user.id, { prompt: false });
      const n = settingsRef.current?.notifications ?? {};
      if (r.ok && n.push !== true) await updateSettings({ notifications: { ...n, push: true } }).catch(() => undefined);
    },
    [user, updateSettings],
  );

  const ask = useCallback(
    async (key: PermKey): Promise<PermStatus> => {
      const s = await requestPermission(key);
      setStatuses((prev) => ({ ...prev, [key]: s }));
      if (s === 'granted') await afterGrant(key);
      return s;
    },
    [afterGrant],
  );

  const visible = PERMISSIONS.filter((p) => {
    const s = statuses[p.key];
    if (!permissionApplies(p.key) || !s || s === 'unavailable') return false;
    return p.key !== 'fullscreen' || showFullscreen;
  });
  const actionable = visible.filter((p) => statuses[p.key] !== 'granted' && (statuses[p.key] !== 'blocked' || p.settingsOnly));

  const onRow = async (p: PermDef) => {
    if (busy) return;
    const s = statuses[p.key];
    if (s === 'granted') return;
    if (s === 'blocked') {
      openPermissionSettings(p.key);
      return;
    }
    setBusy(p.key);
    try {
      await ask(p.key);
    } finally {
      setBusy(null);
    }
  };

  const allowAll = async () => {
    if (busy) return;
    setBusy('all');
    try {
      // OS dialogs one after another; the full-screen settings page (leaves the app) goes last.
      for (const p of actionable.filter((x) => !x.settingsOnly)) await ask(p.key);
      const fs = actionable.find((x) => x.settingsOnly);
      if (fs) openPermissionSettings(fs.key);
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    if (manage) {
      if (router.canGoBack()) router.back();
      else router.replace('/');
      return;
    }
    markPermissionsSeen(true);
    router.replace('/');
  };

  const done = loaded && actionable.length === 0;

  // First run with nothing to ask on this device (Expo Go, web, emulators): continue straight to the next step
  // instead of showing an empty "Get the most out of Zoyra" page.
  const nothingToShow = !manage && loaded && visible.length === 0;
  useEffect(() => {
    if (nothingToShow) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nothingToShow]);

  const footer = manage ? null : (
    <View style={{ gap: 6, paddingHorizontal: 20, paddingTop: 12 }}>
      <Button
        label={busy === 'all' ? 'Asking…' : done ? 'Continue' : 'Allow all'}
        variant={busy === 'all' || !loaded ? 'disabled' : 'primary'}
        onPress={() => void (done ? finish() : allowAll())}
      />
      {!done ? (
        <View style={{ alignItems: 'center', minHeight: 44, justifyContent: 'center' }}>
          <LinkText label="Not now" color={colors.textSecondary} onPress={finish} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen
      top={manage ? 4 : 24}
      gap={20}
      bottom={24}
      stagger={!reduceMotion}
      footer={footer}
      backdrop={{ pattern: 'dots', mesh: 'none', glows: [{ x: 0.85, y: 0, color: colors.accent, opacity: 0.24, stop: 0.32 }] }}
    >
      {manage ? <ScreenHeader title="Permissions" /> : null}

      <View style={{ gap: 8 }}>
        {manage ? null : <IconTile icon="shield" size={56} color={colors.accentLight} />}
        <T variant={manage ? 'body' : 'hero'} size={manage ? 22 : undefined} weight={manage ? 700 : undefined} lineHeight={manage ? 28 : 37} accessibilityRole="header">
          Get the most out of Zoyra
        </T>
        <T size={15} lineHeight={21} color={colors.textSecondary}>
          You can change these anytime in Settings.
        </T>
      </View>

      {!loaded ? (
        <ActivityIndicator color={colors.accent} accessibilityLabel="Checking permissions" />
      ) : visible.length === 0 ? (
        <Glass padding={16}>
          <T size={14} lineHeight={20} color={colors.textSecondary}>
            Nothing to set up on this device. Zoyra asks for anything it needs when you use that feature.
          </T>
        </Glass>
      ) : (
        <Glass padding={4}>
          {visible.map((p, i) => (
            <PermissionRow key={p.key} def={p} status={statuses[p.key] ?? 'undetermined'} busy={busy === p.key || busy === 'all'} divider={i > 0} onPress={() => void onRow(p)} />
          ))}
        </Glass>
      )}

      <Row gap={10} align="flex-start" style={{ paddingHorizontal: 4 }}>
        <Icon name="infoDot" size={16} color={colors.textTertiary} />
        <T size={12} lineHeight={17} color={colors.textTertiary} style={{ flex: 1 }}>
          Asked only when you need them: Location, when you start Run mode. Photos, when you save to your gallery (picking a photo uses the system
          picker and needs no permission).
        </T>
      </Row>
    </Screen>
  );
}

function PermissionRow({ def, status, busy, divider, onPress }: { def: PermDef; status: PermStatus; busy: boolean; divider: boolean; onPress: () => void }) {
  const granted = status === 'granted';
  const blocked = status === 'blocked';
  const note = status === 'denied' ? 'Not allowed yet' : blocked && !def.settingsOnly ? 'Turned off in Settings' : null;

  return (
    <Row
      gap={12}
      style={[{ minHeight: 72, paddingHorizontal: 12, paddingVertical: 10 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}
    >
      <View
        style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: granted ? withAlpha(colors.success, 0.16) : colors.accentTint, alignItems: 'center', justifyContent: 'center' }}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Icon name={def.icon} size={20} color={granted ? colors.success : colors.accentLight} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500}>
          {def.title}
        </T>
        <T variant="small" color={colors.textSecondary}>
          {def.why}
        </T>
        {note ? (
          <T size={12} color={colors.warning}>
            {note}
          </T>
        ) : null}
      </View>
      {granted ? (
        <View
          accessible
          accessibilityLabel={`${def.title}: allowed`}
          style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6 }}
        >
          <Icon name="checkBold" size={16} color={colors.success} strokeWidth={2.4} />
          <T size={14} weight={600} color={colors.success}>
            Allowed
          </T>
        </View>
      ) : (
        <Tap
          onPress={onPress}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={blocked ? `Open Settings to allow ${def.title}` : `Allow ${def.title}`}
          accessibilityHint={def.why}
          accessibilityState={{ busy, disabled: busy }}
          hitSlop={4}
          style={{
            minHeight: 44,
            minWidth: 84,
            paddingHorizontal: 16,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: blocked ? 'transparent' : colors.accent,
            borderWidth: blocked ? 1 : 0,
            borderColor: colors.accent,
          }}
        >
          {busy ? (
            <ActivityIndicator color={blocked ? colors.accentLight : colors.onAccent} />
          ) : (
            <T size={14} weight={600} color={blocked ? colors.accentLight : colors.onAccent}>
              {blocked ? 'Open Settings' : 'Allow'}
            </T>
          )}
        </Tap>
      )}
    </Row>
  );
}
