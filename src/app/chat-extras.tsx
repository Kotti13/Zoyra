import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, go, Icon, ListRow, Row, Sheet, T, Tap, useAsync, IconBadge } from '../components';
import type { IconName } from '../components/icons';
import { chatError, DISAPPEAR_OPTIONS, disappearLabel, setDisappearing } from '../lib/chat';
import { routeIfSetupRequired } from '../lib/chat-e2ee';
import { sendWhisper, starCount } from '../lib/chat-extras';
import { useChatMood } from '../lib/chat-mood';
import { createBlend, requestState } from '../lib/dm';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Tile = { key: string; title: string; body: string; icon: IconName; color: string; disabled?: boolean; onPress: () => void };

/**
 * Chat extras sheet (`/chat-extras?id=<conversation>`, MsgExtras design): the composer "+" target in Chat Pro.
 * Time capsule, Whisper (view once photo, sent right from here), Song swap, Blend, Mood theme (Auto / Off for this
 * chat), Schedule, Disappearing messages and Starred messages. "More chat tools" keeps the older tools sheet
 * (Listen together, shared queue, poll, lyric reply, dedication, taste match) one tap away.
 */
export default function ChatExtras() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [showTimer, setShowTimer] = useState(false);
  const [timerEdit, setTimerEdit] = useState<number | null | undefined>(undefined);
  const [mood, setMood] = useChatMood(cid);

  const ctx = useAsync(async () => {
    if (!cid || !me) return null;
    const [conv, req, stars] = await Promise.all([
      supabase.from('conversations').select('disappear_seconds, kind').eq('id', cid).maybeSingle(),
      requestState(cid).catch(() => 'none' as const),
      starCount(cid),
    ]);
    const c = conv.data as { disappear_seconds: number | null; kind: string | null } | null;
    return { disappear: c?.disappear_seconds ?? null, group: c?.kind === 'group', pending: req !== 'none', stars };
  }, [cid, me], 'app/chat-extras:36');
  const timer = timerEdit !== undefined ? timerEdit : (ctx.data?.disappear ?? null);
  const pending = !!ctx.data?.pending;

  const run = async (key: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      if (routeIfSetupRequired(e)) return;
      setNote({ ok: false, text: chatError(e, 'That didn’t work. Try again.') });
    } finally {
      setBusy(null);
    }
  };

  if (!cid || !me) {
    return (
      <Sheet>
        <T variant="section">Chat extras</T>
        <T size={14} color={colors.textSecondary}>
          {me ? 'Open a chat first.' : 'Sign in to use chat extras.'}
        </T>
        <Button label="Close" height={44} onPress={() => go('back')} />
      </Sheet>
    );
  }

  const whisper = () =>
    void run('whisper', async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('Photo library access is needed to send a photo.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      const a = res.assets[0];
      const mime = a.mimeType && a.mimeType.startsWith('image/') ? a.mimeType : 'image/jpeg';
      await sendWhisper(cid, me, { uri: a.uri, mime, width: a.width, height: a.height });
      go('back');
    });

  const changeTimer = (seconds: number | null) => {
    if (busy || seconds === timer || pending) return;
    const before = timer;
    setTimerEdit(seconds);
    void run('timer', async () => {
      try {
        await setDisappearing(cid, seconds);
      } catch (e) {
        setTimerEdit(before);
        throw e;
      }
    });
  };

  const addRows: { key: string; title: string; body: string; icon: IconName; onPress: () => void }[] = [
    { key: 'song', title: 'Song', body: 'Share now playing or search', icon: 'music', onPress: () => router.replace({ pathname: '/chat-attach', params: { id: cid, mode: 'song' } }) },
    { key: 'photo', title: 'Photo or video', body: 'Camera roll', icon: 'image', onPress: () => router.replace({ pathname: '/chat-attach', params: { id: cid } }) },
    { key: 'voice', title: 'Voice note', body: 'Hold to record', icon: 'mic', onPress: () => router.replace({ pathname: '/chat-voice', params: { id: cid } }) },
    { key: 'schedule', title: 'Schedule', body: 'Send later or lock in a time capsule', icon: 'clock', onPress: () => router.replace({ pathname: '/chat-scheduled', params: { id: cid } }) },
    { key: 'poll', title: 'Poll', body: 'Let the chat vote', icon: 'chart', onPress: () => router.replace({ pathname: '/chat-attach', params: { id: cid, mode: 'poll' } }) },
  ];
  const tiles: Tile[] = [
    { key: 'capsule', title: 'Time capsule', body: 'Locked until a date you pick', icon: 'lock', color: '#8A4BFF', onPress: () => router.replace({ pathname: '/chat-capsule', params: { id: cid } }) },
    { key: 'whisper', title: busy === 'whisper' ? 'Sending…' : 'Whisper', body: 'View once, then gone', icon: 'eye', color: '#2B6BFF', onPress: whisper },
    { key: 'swap', title: 'Song swap', body: 'Trade a song each day', icon: 'repeat', color: colors.accent, disabled: ctx.data?.group, onPress: () => router.replace({ pathname: '/chat-tools', params: { id: cid, mode: 'swap' } }) },
    {
      key: 'blend',
      title: busy === 'blend' ? 'Mixing…' : 'Blend',
      body: 'Mix your tastes into one list',
      icon: 'library',
      color: '#FF6F91',
      disabled: ctx.data?.group,
      onPress: () =>
        void run('blend', async () => {
          const pid = await createBlend(cid);
          router.replace({ pathname: '/playlist', params: { id: pid } });
        }),
    },
    {
      key: 'mood',
      title: 'Mood theme',
      body: mood === 'auto' ? 'On · follows the song playing' : 'Off · tap to colour the chat',
      icon: 'music',
      color: '#FF7A8C',
      onPress: () => {
        const next = mood === 'auto' ? 'off' : 'auto';
        setMood(next);
        setNote({ ok: true, text: next === 'auto' ? 'Chat mood follows the song playing' : 'Chat mood off' });
      },
    },
  ];

  return (
    <Sheet gap={12}>
      <T size={18} weight={600} accessibilityRole="header">
        Add to chat
      </T>
      <View>
        {addRows.map((r, i) => (
          <Tap
            key={r.key}
            onPress={r.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${r.title}. ${r.body}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 64, paddingVertical: 12, paddingHorizontal: 4, borderTopWidth: i ? 1 : 0, borderTopColor: withAlpha(colors.white, 0.07) }}
          >
            <IconBadge icon={r.icon} size={40} />
            <View style={{ flex: 1 }}>
              <T size={15} weight={600}>
                {r.title}
              </T>
              <T size={12} color={colors.textSecondary}>
                {r.body}
              </T>
            </View>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </Tap>
        ))}
      </View>
      <T size={12} weight={600} color={colors.textSecondary} style={{ letterSpacing: 1.2, paddingHorizontal: 4 }}>
        MORE
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 10 }}>
        {tiles.map((t) => (
          <Tap
            key={t.key}
            onPress={t.disabled ? undefined : t.onPress}
            disabled={t.disabled}
            accessibilityRole="button"
            accessibilityLabel={`${t.title}. ${t.body}`}
            accessibilityState={{ disabled: !!t.disabled, busy: busy === t.key }}
            pressScale={0.97}
            style={{ width: '48.5%', minHeight: 112, padding: 14, gap: 10, borderRadius: 32, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: busy === t.key ? colors.accent : withAlpha(colors.white, 0.12), opacity: t.disabled ? 0.45 : 1 }}
          >
            <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: t.color, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={t.icon} size={20} color={colors.white} />
            </View>
            <View>
              <T size={14} weight={700}>
                {t.title}
              </T>
              <T size={11} lineHeight={14} color={colors.textSecondary}>
                {t.body}
              </T>
            </View>
          </Tap>
        ))}
      </View>

      {note ? (
        <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}

      <View style={{ borderRadius: 36, paddingVertical: 4, paddingHorizontal: 4, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <ListRow
          title="Disappearing messages"
          subtitle={pending ? 'Available after they accept' : busy === 'timer' ? 'Saving…' : disappearLabel(timer)}
          icon="timer"
          onPress={pending ? undefined : () => setShowTimer((v) => !v)}
          right={pending ? false : <Icon name={showTimer ? 'chevronDown' : 'chevronRight'} size={16} color={colors.textSecondary} />}
        />
        {showTimer && !pending ? (
          <Row gap={8} style={{ flexWrap: 'wrap', paddingHorizontal: 12, paddingBottom: 8 }}>
            {DISAPPEAR_OPTIONS.map((o) => (
              <Chip key={o.label} label={o.label} active={(timer ?? null) === o.seconds} onPress={() => changeTimer(o.seconds)} />
            ))}
          </Row>
        ) : null}
        <ListRow
          divider
          title="Starred messages"
          subtitle={ctx.data ? `${ctx.data.stars} saved` : '…'}
          icon="star"
          onPress={() => router.replace({ pathname: '/starred', params: { cid } })}
        />
        <ListRow divider title="More chat tools" subtitle="Listen together, polls, lyric reply, dedications" icon="grid" onPress={() => router.replace({ pathname: '/chat-tools', params: { id: cid } })} />
      </View>

      <Tap
        onPress={() => go('back')}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={{ height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
      >
        <T size={15} weight={600}>
          Close
        </T>
      </Tap>
    </Sheet>
  );
}
