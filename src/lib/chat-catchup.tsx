import { View } from 'react-native';

import { Icon, T, Tap } from '../components';
import { clockLabel } from './reminders';
import { messagePreview, type ChatMessage } from './chat';
import { colors, withAlpha } from '../theme/tokens';

/** Quick replies offered under the summary. Local and generic: message text is end-to-end encrypted and never leaves the device. */
const REPLIES = ['Sounds good', 'On my way', 'Thanks, catching up now'];

/** Local summary of what arrived while away: count and time, what kinds of things were sent, and the latest message. */
export function summarizeUnread(unread: ChatMessage[], name: string): string[] {
  const first = unread[0];
  const lines = [`${name} sent ${unread.length} messages since ${clockLabel(new Date(first.created_at))}.`];
  const count = (k: string) => unread.filter((m) => m.kind === k).length;
  const bits = [
    [count('photo') + count('whisper'), 'photo'],
    [count('voice'), 'voice note'],
    [count('swap') + (unread.filter((m) => m.track && m.kind !== 'swap').length), 'song'],
    [count('poll'), 'poll'],
    [count('location'), 'location'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`);
  if (bits.length) lines.push(`Includes ${bits.join(', ')}.`);
  const last = unread[unread.length - 1];
  const prev = messagePreview(last);
  if (prev) lines.push(`Latest: ${prev.length > 90 ? `${prev.slice(0, 90)}…` : prev}`);
  return lines;
}

export function CatchUpCard({ unread, name, onJump, onDismiss, onReply }: { unread: ChatMessage[]; name: string; onJump: () => void; onDismiss: () => void; onReply: (text: string) => void }) {
  if (unread.length === 0) return null;
  const lines = summarizeUnread(unread, name);
  return (
    <View style={{ gap: 12 }}>
      <View style={{ padding: 18, borderRadius: 36, gap: 12, backgroundColor: withAlpha(colors.white, 0.08), borderWidth: 1, borderColor: withAlpha(colors.white, 0.14) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="bolt" size={14} color={colors.accentLight} />
          <T size={12} weight={700} color={colors.accentLight} style={{ flex: 1, letterSpacing: 0.8 }}>
            CATCH UP
          </T>
          <Tap onPress={onDismiss} accessibilityLabel="Dismiss summary" style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -12, marginRight: -8 }}>
            <Icon name="close" size={16} color={colors.textSecondary} />
          </Tap>
        </View>
        {lines.map((l, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
            <T size={14} color={colors.accentLight}>
              •
            </T>
            <T size={14} lineHeight={20} style={{ flex: 1 }}>
              {l}
            </T>
          </View>
        ))}
      </View>
      <View style={{ gap: 8 }}>
        <T size={12} weight={600} color={colors.textSecondary} style={{ letterSpacing: 1.2, paddingHorizontal: 4 }}>
          SUGGESTED REPLIES
        </T>
        {REPLIES.map((r) => (
          <Tap
            key={r}
            onPress={() => onReply(r)}
            accessibilityLabel={`Use reply: ${r}`}
            style={{ minHeight: 44, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 28, justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
          >
            <T size={14}>{r}</T>
          </Tap>
        ))}
      </View>
      <Tap
        onPress={onJump}
        accessibilityLabel="Jump to first unread"
        style={{ height: 50, borderRadius: 25, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}
      >
        <T size={15} weight={700} color={colors.onAccent}>
          Jump to first unread
        </T>
        <Icon name="chevronRight" size={16} color={colors.onAccent} />
      </Tap>
    </View>
  );
}
