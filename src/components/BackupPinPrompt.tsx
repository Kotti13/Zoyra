import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { hasBackup, useE2EE } from '../lib/e2ee';
import { useKids } from '../lib/kids';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';
import { Button } from './controls';
import { Icon, T } from './primitives';

/** Wait between reminders, by how many times the person has already said "Later" (then it stays at the last value). */
const SNOOZE_DAYS = [1, 3, 7, 14];
const DAY_MS = 24 * 60 * 60_000;
/** Only over these screens: never on top of a call, the player, sign-in or the backup screens themselves. */
const SHOW_ON = new Set(['/', '/library', '/search', '/profile', '/messages']);

const keyFor = (uid: string) => `zoyra.backupPrompt.${uid}`;
type Saved = { until: number; count: number };

async function readSaved(uid: string): Promise<Saved> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(uid));
    const v = raw ? (JSON.parse(raw) as Partial<Saved>) : {};
    return { until: typeof v.until === 'number' ? v.until : 0, count: typeof v.count === 'number' ? v.count : 0 };
  } catch {
    return { until: 0, count: 0 };
  }
}

/**
 * "Back up your chats" reminder. Chats are end-to-end encrypted with keys that live on the phone, so on a new
 * phone older messages are unreadable unless a backup PIN was set. This asks, once the person has actually sent a
 * message and has no backup yet, and keeps asking gently (1 day, 3, 7, then every 14) until they set it.
 * Set backup PIN → /e2ee-setup. Later → snoozed. Nothing is shown when a backup already exists.
 */
export function BackupPinPrompt() {
  const pathname = usePathname();
  const { user } = useAuth();
  const me = user?.id;
  const e2ee = useE2EE();
  const kids = useKids();
  const [show, setShow] = useState(false);
  const ready = !!me && e2ee.status === 'ready' && e2ee.userId === me && !kids.on;

  // Decide once the keys are ready (and again when the account changes).
  useEffect(() => {
    if (!ready || !me) return;
    let alive = true;
    void (async () => {
      const saved = await readSaved(me);
      if (Date.now() < saved.until) return;
      // Needs an actual conversation behind it: a brand-new account has nothing worth backing up yet.
      const sent = await supabase.from('messages').select('id', { count: 'exact', head: true }).eq('sender_id', me);
      if (sent.error || !sent.count) return;
      if (await hasBackup().catch(() => true)) return;
      if (alive) setShow(true);
    })();
    return () => {
      alive = false;
    };
  }, [ready, me]);

  const snooze = useCallback(async () => {
    setShow(false);
    if (!me) return;
    const saved = await readSaved(me);
    const days = SNOOZE_DAYS[Math.min(saved.count, SNOOZE_DAYS.length - 1)];
    try {
      await AsyncStorage.setItem(keyFor(me), JSON.stringify({ until: Date.now() + days * DAY_MS, count: saved.count + 1 }));
    } catch {
      /* the prompt may come back sooner; harmless */
    }
  }, [me]);

  if (!show || !SHOW_ON.has(pathname)) return null;

  // A centered dialog over a dimmed screen. Tapping outside is the same as "Later".
  return (
    <View accessibilityViewIsModal style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 }}>
      <Pressable accessibilityLabel="Remind me later" onPress={() => void snooze()} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay }} />
      <View
        accessibilityRole="alert"
        style={{
          width: '100%',
          maxWidth: 380,
          borderRadius: 28,
          paddingHorizontal: 22,
          paddingTop: 26,
          paddingBottom: 20,
          gap: 18,
          alignItems: 'center',
          backgroundColor: colors.glassStrong,
          borderWidth: 1,
          borderColor: colors.glassBorder,
        }}
      >
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.gold, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="lock" size={28} color={colors.onLight} strokeWidth={2} />
        </View>
        <View style={{ gap: 8, alignItems: 'center' }}>
          <T size={20} weight={700} align="center" accessibilityRole="header">
            Back up your chats
          </T>
          <T size={14} color={colors.textSecondary} lineHeight={20} align="center">
            Set a 6-digit PIN so you can read your messages again if you switch phones. Without it, older messages can’t be read on a new phone.
          </T>
        </View>
        <View style={{ alignSelf: 'stretch', gap: 10 }}>
          <Button
            label="Set backup PIN"
            variant="primary"
            height={48}
            onPress={() => {
              void snooze();
              router.push('/e2ee-setup');
            }}
          />
          <Button label="Remind me later" variant="glass" height={48} onPress={() => void snooze()} />
        </View>
      </View>
    </View>
  );
}
