import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, ErrorState, go, Loading, Row, Sheet, T, Tap } from '../components';
import { RoundFace } from '../lib/inbox-ui';
import { noteAge, noteAudience, type NoteAudienceRow } from '../lib/notes';
import { colors, glow, withAlpha } from '../theme/tokens';

/**
 * "Seen by N" (`/note-viewers`, MsgNoteViewers), opened from my note's sheet in Messages. Everyone who
 * opened, reacted to or replied to my active note (note_audience(), owner only), with tabs Viewers / Likes /
 * Replies. Each row: "Replied · now" / "Liked · 12m" / "Seen · 2h" and their reaction emoji.
 * Presented as a bottom sheet (add 'note-viewers' to the overlay routes in src/app/_layout.tsx so the
 * inbox stays visible behind it; it also works as a plain stack screen).
 */

type Tab = 'viewers' | 'likes' | 'replies';

const ago = (iso: string | null) => (iso ? noteAge(iso) : '');

function status(r: NoteAudienceRow, tab: Tab): string {
  if (tab === 'likes' && r.reacted_at) return `Liked · ${ago(r.reacted_at)}`;
  if (tab === 'replies' && r.replied_at) return `${r.replies > 1 ? `Replied ${r.replies}×` : 'Replied'} · ${ago(r.replied_at)}`;
  if (r.replied_at) return `Replied · ${ago(r.replied_at)}`;
  if (r.reacted_at) return `Liked · ${ago(r.reacted_at)}`;
  return `Seen · ${ago(r.seen_at)}`;
}

export default function NoteViewers() {
  const [rows, setRows] = useState<NoteAudienceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('viewers');

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await noteAudience());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load who saw your note');
    }
  }, []);

  useEffect(() => {
    let alive = true;
    noteAudience()
      .then((r) => alive && setRows(r))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load who saw your note'));
    return () => {
      alive = false;
    };
  }, []);

  const all = rows ?? [];
  const likes = all.filter((r) => r.emoji);
  const replies = all.filter((r) => r.replies > 0);
  const shown = tab === 'likes' ? likes : tab === 'replies' ? replies : all;
  const tabs: { key: Tab; label: string; n: number }[] = [
    { key: 'viewers', label: 'Viewers', n: all.length },
    { key: 'likes', label: 'Likes', n: likes.length },
    { key: 'replies', label: 'Replies', n: replies.length },
  ];

  return (
    <Sheet>
      <T size={18} weight={600} accessibilityRole="header">
        {rows ? `Seen by ${all.length}` : 'Seen by'}
      </T>
      <Row gap={8} accessibilityRole="tablist">
        {tabs.map((t) => {
          const on = t.key === tab;
          return (
            <Tap key={t.key} onPress={() => setTab(t.key)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={`${t.label}, ${t.n}`} style={{ minHeight: 44, justifyContent: 'center' }}>
              <View
                style={[
                  { height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center' },
                  on ? [{ backgroundColor: colors.accent }, glow(colors.accent, 10, 0.45)] : { backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: colors.glassBorder },
                ]}
              >
                <T size={13} weight={600} color={on ? colors.onAccent : colors.text}>
                  {t.label} {rows ? t.n : ''}
                </T>
              </View>
            </Tap>
          );
        })}
      </Row>

      {error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !rows ? (
        <Loading label="Loading viewers" />
      ) : shown.length === 0 ? (
        <T size={14} color={colors.textSecondary} align="center" style={{ paddingVertical: 24 }}>
          {tab === 'likes' ? 'No reactions yet.' : tab === 'replies' ? 'No replies yet. Replies arrive in your chats.' : 'Nobody has opened your note yet.'}
        </T>
      ) : (
        <View>
          {shown.map((r) => (
            <Row
              key={r.user_id}
              gap={12}
              accessible
              accessibilityLabel={`${r.display_name}, ${status(r, tab)}${r.emoji ? `, reacted ${r.emoji}` : ''}`}
              style={{ paddingVertical: 10, paddingHorizontal: 4, borderTopWidth: 1, borderTopColor: withAlpha(colors.white, 0.07) }}
            >
              <RoundFace id={r.user_id} name={r.display_name} uri={r.avatar_url} size={44} radius={15} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={15} weight={600} numberOfLines={1}>
                  {r.display_name}
                </T>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {status(r, tab)}
                </T>
              </View>
              <T size={20} maxFontSizeMultiplier={1.2}>
                {r.emoji ?? ''}
              </T>
            </Row>
          ))}
        </View>
      )}

      <Button label="Done" variant="secondary" onPress={() => go('back')} />
    </Sheet>
  );
}
