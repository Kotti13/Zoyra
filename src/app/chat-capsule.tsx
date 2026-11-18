import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';

import { Cover, Gradient, Icon, IconButton, Row, Screen, T, Tap, Toggle, useAsync } from '../components';
import { SongPicker } from '../components/SongPicker';
import type { IconName } from '../components/icons';
import type { CatalogTrack } from '../lib/catalog';
import { chatError, trackArtist, type ChatPerson } from '../lib/chat';
import { routeIfSetupRequired } from '../lib/chat-e2ee';
import { capsuleDateLabel, sendCapsule } from '../lib/chat-extras';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, fonts, withAlpha } from '../theme/tokens';

const PURPLE = '#8A4BFF';
const PURPLE_LIGHT = '#C9A7FF';

/** 9:00 AM local, `days` from today (months when `months`). */
function at9(days: number, months = 0): Date {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d;
}
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * Time capsule (`/chat-capsule?id=<conversation>`, MsgCapsule design). Write a message (+ optional song), pick the
 * open date (Tomorrow / 1 week / 1 month / Pick a date) and the switches: reminder for both, hide text until then
 * (they see a locked card; their key is withheld by the server until the date), reveal with a countdown.
 * Sent end-to-end encrypted (kind 'capsule'); see src/lib/chat-extras.ts sendCapsule.
 */
export default function ChatCapsule() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const [body, setBody] = useState('');
  const [track, setTrack] = useState<CatalogTrack | null>(null);
  const [picking, setPicking] = useState(false);
  const [preset, setPreset] = useState<'tomorrow' | 'week' | 'month' | 'pick'>('week');
  const [picked, setPicked] = useState<Date | null>(null);
  const [calendar, setCalendar] = useState(false);
  const [reminder, setReminder] = useState(true);
  const [hide, setHide] = useState(true);
  const [countdown, setCountdown] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const other = useAsync(async () => {
    if (!cid || !me) return null;
    const { data } = await supabase.from('conversation_members').select('profiles(id, display_name, avatar_url, username)').eq('conversation_id', cid).neq('user_id', me).limit(1).maybeSingle();
    return ((data as { profiles: ChatPerson | null } | null)?.profiles ?? null) as ChatPerson | null;
  }, [cid, me]);
  const first = (other.data?.display_name || 'They').split(' ')[0];

  const opensAt = useMemo(() => (preset === 'tomorrow' ? at9(1) : preset === 'week' ? at9(7) : preset === 'month' ? at9(0, 1) : (picked ?? at9(7))), [preset, picked]);
  const ready = (body.trim().length > 0 || !!track) && !busy;

  const seal = async () => {
    if (!ready || !cid || !me) return;
    setBusy(true);
    setNote(null);
    try {
      await sendCapsule(cid, me, { body, track, opensAt, hide, reminder, countdown });
      if (router.canGoBack()) router.back();
      else router.replace({ pathname: '/chat-pro', params: { id: cid } });
    } catch (e) {
      if (routeIfSetupRequired(e)) return;
      setNote(chatError(e, 'Could not seal the capsule'));
    } finally {
      setBusy(false);
    }
  };

  const chip = (key: typeof preset, label: string) => {
    const on = preset === key;
    return (
      <Tap
        key={key}
        onPress={() => {
          setPreset(key);
          setCalendar(key === 'pick');
        }}
        accessibilityRole="radio"
        accessibilityState={{ checked: on }}
        accessibilityLabel={label}
        style={{ height: 38, paddingHorizontal: 16, borderRadius: 19, justifyContent: 'center', backgroundColor: on ? PURPLE : withAlpha(colors.white, 0.06), borderWidth: on ? 0 : 1, borderColor: withAlpha(colors.white, 0.12) }}
      >
        <T size={13} weight={600}>
          {label}
        </T>
      </Tap>
    );
  };

  const toggles: { key: string; title: string; sub: string; icon: IconName; value: boolean; set: (v: boolean) => void }[] = [
    { key: 'reminder', title: 'Reminder for both', sub: 'Both of you get a nudge that day', icon: 'bell', value: reminder, set: setReminder },
    { key: 'hide', title: 'Hide text until then', sub: `${first} sees only a locked card`, icon: 'lock', value: hide, set: setHide },
    { key: 'countdown', title: 'Reveal with a countdown', sub: 'Animated unlock in the chat', icon: 'timer', value: countdown, set: setCountdown },
  ];

  return (
    <Screen top={4} gap={14} backdrop={{ pattern: 'none', mesh: 'rose', orbs: false }}>
      <Row style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat-pro', params: { id: cid } }))} />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} accessibilityRole="header">
          Time capsule
        </T>
        <T size={14} color={colors.textSecondary} lineHeight={20}>
          Write now. {first} can open it on the day you choose.
        </T>
      </View>

      <View style={{ padding: 18, gap: 12, borderRadius: 36, overflow: 'hidden', borderWidth: 1, borderColor: withAlpha(PURPLE, 0.5) }}>
        <Gradient colors={[withAlpha(PURPLE, 0.3), 'rgba(20,20,20,0.7)']} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
        <Row gap={8}>
          <Icon name="lock" size={14} color={PURPLE_LIGHT} />
          <T size={12} weight={700} tracking={0.8} color={PURPLE_LIGHT}>
            OPENS {capsuleDateLabel(opensAt.toISOString()).toUpperCase()}
          </T>
        </Row>
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder={`Write something for ${first} to open later…`}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Capsule message"
          multiline
          maxLength={2000}
          style={{ minHeight: 72, color: colors.text, fontFamily: fonts.regular, fontSize: 17, lineHeight: 24, textAlignVertical: 'top', padding: 0 }}
        />
        <Tap
          onPress={() => (track ? setTrack(null) : setPicking((v) => !v))}
          accessibilityLabel={track ? `Song ${track.title}. Tap to remove` : 'Add a song'}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, minHeight: 56, borderRadius: 26, backgroundColor: withAlpha(colors.white, 0.08) }}
        >
          {track ? <Cover artwork={track.artwork} id={track.id} size={40} radius={20} /> : <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}><Icon name="music" size={18} color={colors.text} /></View>}
          <T size={13} weight={600} numberOfLines={1} style={{ flex: 1 }}>
            {track ? `${track.title}${trackArtist(track) ? ` · ${trackArtist(track)}` : ''}` : 'Add a song (optional)'}
          </T>
          <Icon name={track ? 'close' : picking ? 'chevronUp' : 'plus'} size={16} color={colors.textSecondary} />
        </Tap>
      </View>
      {picking && !track ? (
        <SongPicker
          busyLabel="Adding…"
          maxHeight={300}
          onPick={(t) => {
            setTrack(t);
            setPicking(false);
          }}
        />
      ) : null}

      <T size={12} weight={600} tracking={1.2} color={colors.textSecondary} style={{ paddingHorizontal: 4 }}>
        OPEN ON
      </T>
      <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {chip('tomorrow', 'Tomorrow')}
        {chip('week', '1 week')}
        {chip('month', '1 month')}
        {chip('pick', picked ? capsuleDateLabel(picked.toISOString()) : 'Pick a date')}
      </View>
      {calendar ? (
        <MiniCalendar
          value={picked}
          onPick={(d) => {
            setPicked(d);
            setPreset('pick');
            setCalendar(false);
          }}
        />
      ) : null}

      <View style={{ borderRadius: 36, paddingVertical: 4, paddingHorizontal: 16, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        {toggles.map((t, i) => (
          <Row key={t.key} gap={12} style={{ minHeight: 68, borderTopWidth: i ? 1 : 0, borderTopColor: withAlpha(colors.white, 0.06) }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: withAlpha(colors.accent, 0.18), alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={t.icon} size={18} color={colors.accentLight} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <T size={16} weight={500}>
                {t.title}
              </T>
              <T size={14} color={colors.textSecondary}>
                {t.sub}
              </T>
            </View>
            <Toggle label={t.title} value={t.value} onChange={t.set} />
          </Row>
        ))}
      </View>

      {note ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {note}
        </T>
      ) : null}
      <Tap
        onPress={() => void seal()}
        disabled={!ready}
        accessibilityRole="button"
        accessibilityLabel="Seal capsule"
        accessibilityState={{ disabled: !ready, busy }}
        style={{ height: 52, borderRadius: 26, backgroundColor: PURPLE, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: ready ? 1 : 0.5 }}
      >
        <Icon name="lock" size={18} color={colors.white} />
        <T size={15} weight={800}>
          {busy ? 'Sealing…' : 'Seal capsule'}
        </T>
      </Tap>
      <T size={12} color={colors.textTertiary} align="center" lineHeight={17}>
        End-to-end encrypted. Zoyra only knows the open date; {first}’s key is released on the day.
      </T>
    </Screen>
  );
}

/** Month grid date picker (tomorrow … 5 years). */
function MiniCalendar({ value, onPick }: { value: Date | null; onPick: (d: Date) => void }) {
  const today = new Date();
  const min = at9(1);
  const max = at9(-1, 60);
  const [month, setMonth] = useState(() => {
    const d = value ?? min;
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const startPad = month.getDay();
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [...Array.from({ length: startPad }, () => null), ...Array.from({ length: days }, (_, i) => new Date(month.getFullYear(), month.getMonth(), i + 1, 9))];
  while (cells.length % 7) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  const canPrev = month > new Date(today.getFullYear(), today.getMonth(), 1);
  const canNext = month < new Date(max.getFullYear(), max.getMonth(), 1);
  return (
    <View style={{ padding: 12, gap: 6, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="back" label="Previous month" size={40} iconSize={18} color={canPrev ? colors.text : colors.textTertiary} onPress={() => canPrev && setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} />
        <T size={15} weight={600}>
          {month.toLocaleDateString([], { month: 'long', year: 'numeric' })}
        </T>
        <IconButton icon="chevronRight" label="Next month" size={40} iconSize={18} color={canNext ? colors.text : colors.textTertiary} onPress={() => canNext && setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} />
      </Row>
      {weeks.map((w, i) => (
        <Row key={i} gap={0}>
          {w.map((d, j) => {
            if (!d) return <View key={j} style={{ flex: 1, height: 40 }} />;
            const ok = d >= new Date(min.getFullYear(), min.getMonth(), min.getDate()) && d <= max;
            const on = !!value && sameDay(value, d);
            return (
              <Tap
                key={j}
                onPress={ok ? () => onPick(d) : undefined}
                disabled={!ok}
                accessibilityLabel={d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                accessibilityState={{ selected: on, disabled: !ok }}
                style={{ flex: 1, height: 40, alignItems: 'center', justifyContent: 'center' }}
              >
                <View style={{ width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? PURPLE : 'transparent' }}>
                  <T size={14} weight={on ? 700 : 400} color={ok ? colors.text : colors.textTertiary}>
                    {d.getDate()}
                  </T>
                </View>
              </Tap>
            );
          })}
        </Row>
      ))}
    </View>
  );
}
