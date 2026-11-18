import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, View } from 'react-native';

import { Icon, Row, T, Tap } from '../components';
import { colors, withAlpha } from '../theme/tokens';
import { decryptErrorText } from './chat-e2ee';
import { showDialog } from './dialog';
import { getIdentityChanges, subscribeIdentityChanges, type DecryptError, type IdentityChange } from './e2ee';

/** Bubble for a message this phone can't decrypt. Tap explains why; long press keeps message options. */
export function UnavailableBubble({ code, mine, onLongPress }: { code: DecryptError['error'] | null; mine: boolean; onLongPress?: () => void }) {
  const explain = () =>
    void showDialog({
      title: 'Message unavailable on this device',
      message: decryptErrorText(code),
      icon: 'lock',
      actions: [{ label: 'OK', style: 'primary' }],
    });
  return (
    <Tap
      onPress={explain}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel="Message unavailable on this device"
      accessibilityHint="Shows why it can't be read"
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        minHeight: 44,
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 20,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: withAlpha(colors.white, 0.25),
        backgroundColor: withAlpha(colors.white, 0.04),
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Icon name="lock" size={14} color={colors.textSecondary} />
      <T size={13} color={colors.textSecondary} style={{ fontStyle: 'italic', flexShrink: 1 }}>
        Message unavailable on this device
      </T>
      <Icon name="info" size={14} color={colors.textTertiary} />
    </Tap>
  );
}

/** Small caption under a message that went out in plaintext (a member had no encryption keys yet). */
export function NotEncryptedNote({ mine, indent = 0 }: { mine: boolean; indent?: number }) {
  return (
    <Tap
      onPress={() =>
        void showDialog({
          title: 'Not end-to-end encrypted',
          message: 'Someone in this chat is on a version of Zoyra without end-to-end encryption, so this message was sent without it. New messages are encrypted automatically once everyone has set it up.',
          icon: 'shield',
          actions: [{ label: 'OK', style: 'primary' }],
        })
      }
      accessibilityRole="button"
      accessibilityLabel="Not end-to-end encrypted. Tap for details"
      hitSlop={8}
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', marginLeft: mine ? 0 : indent, flexDirection: 'row', alignItems: 'center', gap: 4 }}
    >
      <Icon name="shield" size={11} color={colors.textTertiary} />
      <T size={10} color={colors.textTertiary}>
        Not end-to-end encrypted
      </T>
    </Tap>
  );
}

/** "Security code changed" system row; opens /e2ee-verify for that contact. */
export function SecurityCodeRow({ uid, name, at }: { uid: string; name: string; at: string }) {
  const first = name.split(' ')[0] || 'This contact';
  return (
    <Tap
      onPress={() => router.push({ pathname: '/e2ee-verify', params: { uid, name } })}
      accessibilityRole="button"
      accessibilityLabel={`${first}'s security code changed. Tap to verify`}
      style={{ alignSelf: 'center', minHeight: 32, maxWidth: '92%', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: withAlpha(colors.amber, 0.12), flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <Icon name="shield" size={13} color={colors.amber} />
      <T size={11} color={colors.amber} style={{ flexShrink: 1 }}>
        {first}’s security code changed · {new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short' })} · Verify
      </T>
    </Tap>
  );
}

/**
 * WhatsApp-style system row at the top of every chat: "Messages are end-to-end encrypted…". Tap → /e2ee-verify
 * for the other person of a 1:1 chat (`uid`, `name`); in groups it explains in a dialog.
 */
export function E2EEChatNotice({ uid, name }: { uid?: string | null; name?: string | null }) {
  const open = () => {
    if (uid) router.push({ pathname: '/e2ee-verify', params: name ? { uid, name } : { uid } });
    else
      void showDialog({
        title: 'End-to-end encrypted',
        message: 'Messages, voice notes and photos in this group are locked on your phone before they leave it. Only the members can read them, not even Zoyra. To verify someone, open your 1:1 chat with them and tap this notice.',
        icon: 'lock',
        actions: [{ label: 'OK', style: 'primary' }],
      });
  };
  return (
    <Tap
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel="Messages are end-to-end encrypted. No one outside of this chat, not even Zoyra, can read them. Tap to learn more."
      style={{ alignSelf: 'center', minHeight: 32, maxWidth: '92%', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, backgroundColor: withAlpha(colors.amber, 0.12), flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <Icon name="lock" size={13} color={colors.amber} />
      <T size={11} lineHeight={15} color={colors.amber} align="center" style={{ flexShrink: 1 }}>
        Messages are end-to-end encrypted. No one outside of this chat, not even Zoyra, can read them.
      </T>
    </Tap>
  );
}

/** Unacknowledged "security code changed" notices for these users (live). */
export function useIdentityChanges(userIds: string[]): IdentityChange[] {
  const key = [...userIds].sort().join(',');
  const [changes, setChanges] = useState<IdentityChange[]>([]);
  useEffect(() => {
    let alive = true;
    const ids = new Set(key.split(',').filter(Boolean));
    const apply = (all: IdentityChange[]) => alive && setChanges(all.filter((c) => ids.has(c.userId)));
    void getIdentityChanges().then(apply);
    const off = subscribeIdentityChanges(apply);
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return changes;
}

/**
 * Pinned message bar for the top of a chat (directly under the header, full width): pin icon, the pinned
 * text, "1 of N" dots. Tap = jump to it and cycle to the next pin; long press = pinned list. Fades in / out.
 */
export function PinnedBar({ text, index, count, onPress, onLongPress }: { text: string | null; index: number; count: number; onPress: () => void; onLongPress: () => void }) {
  const show = !!text;
  const [fade] = useState(() => new Animated.Value(show ? 1 : 0));
  const [mounted, setMounted] = useState(show);
  const [last, setLast] = useState(text);
  if (text && text !== last) setLast(text);
  if (show && !mounted) setMounted(true);
  useEffect(() => {
    Animated.timing(fade, { toValue: show ? 1 : 0, duration: 160, useNativeDriver: true }).start(({ finished }) => {
      if (finished && !show) setMounted(false);
    });
  }, [show, fade]);
  if (!mounted) return null;
  const shown = text ?? last ?? '';
  return (
    <Animated.View style={{ opacity: fade }}>
      <Tap
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={`Pinned message ${index + 1} of ${count}: ${shown}`}
        accessibilityHint={count > 1 ? 'Shows it in the chat, then moves to the next pin. Long press to manage pins' : 'Shows it in the chat. Long press to manage pins'}
        pressScale={0.99}
        style={{ minHeight: 44, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8, borderBottomWidth: 1, borderBottomColor: withAlpha(colors.white, 0.08), backgroundColor: withAlpha(colors.white, 0.04) }}
      >
        <Icon name="pushPin" size={16} color={colors.peach} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <T size={11} weight={700} color={colors.accentLight}>
            {count > 1 ? `Pinned · ${index + 1} of ${count}` : 'Pinned'}
          </T>
          <T size={13} color={colors.peach} numberOfLines={1}>
            {shown}
          </T>
        </View>
        {count > 1 ? (
          <Row gap={3} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {Array.from({ length: Math.min(count, 5) }, (_, i) => (
              <View key={i} style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: i === Math.min(index, 4) ? colors.accentLight : withAlpha(colors.white, 0.3) }} />
            ))}
          </Row>
        ) : null}
      </Tap>
    </Animated.View>
  );
}
