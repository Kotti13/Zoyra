import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, Button, Chip, Cover, Glass, Icon, IconButton, Row, Sheet, T, TextField, Toggle } from '../components';
import type { IconName } from '../components';
import { createSession } from '../lib/live';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { colors } from '../theme/tokens';

const STEP_MIN = 15;

/** Next quarter hour at least 30 minutes from now. */
function defaultStart(): Date {
  const d = new Date(Date.now() + 30 * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / STEP_MIN) * STEP_MIN);
  return d;
}

const dayLabel = (d: Date, i: number) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }));

function OptionRow({ icon, title, subtitle, value, onChange, divider }: { icon: IconName; title: string; subtitle: string; value: boolean; onChange: (v: boolean) => void; divider?: boolean }) {
  return (
    <Row style={[{ minHeight: 64, paddingHorizontal: 8 }, divider && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={colors.accentLight} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={16} weight={500}>
          {title}
        </T>
        <T size={14} color={colors.textSecondary}>
          {subtitle}
        </T>
      </View>
      <Toggle value={value} onChange={onChange} label={title} />
    </Row>
  );
}

export default function GoLive() {
  const { user, profile } = useAuth();
  const me = user?.id;
  const { track } = usePlayerPick('track');
  const [title, setTitle] = useState('');
  const [chat, setChat] = useState(true);
  const [requests, setRequests] = useState(true);
  const [replay, setReplay] = useState(false);
  const [notify, setNotify] = useState(true);
  const [schedule, setSchedule] = useState(false);
  const [start, setStart] = useState(defaultStart);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const days = useMemo(() => {
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + i));
  }, []);
  const dayIndex = days.findIndex((d) => d.toDateString() === start.toDateString());

  const pickDay = (d: Date) => {
    const next = new Date(d);
    next.setHours(start.getHours(), start.getMinutes(), 0, 0);
    setStart(next);
  };
  const shift = (min: number) => setStart((s) => new Date(s.getTime() + min * 60_000));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!schedule) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [schedule]);
  const tooSoon = schedule && start.getTime() < now + 5 * 60_000;

  const placeholder = `${profile?.display_name ?? 'My'} live`;

  const submit = async () => {
    if (!me || busy || tooSoon) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createSession(me, {
        title: title.trim() || placeholder,
        chat,
        requests,
        replay,
        notifyFollowers: notify,
        scheduledAt: schedule ? start : undefined,
      });
      if (schedule) router.replace('/live-hub');
      else router.replace({ pathname: '/live-room', params: { id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the session');
      setBusy(false);
    }
  };

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Go live
      </T>
      <Row gap={14}>
        {track ? <Cover artwork={track.artwork} id={track.id} size={88} radius={32} /> : <Art art="coral" size={88} radius={32} />}
        <TextField label="Session title" value={title} onChangeText={setTitle} placeholder={placeholder} maxLength={80} returnKeyType="done" style={{ flex: 1 }} />
      </Row>

      <Glass padding={4}>
        <OptionRow icon="mail" title="Live chat" subtitle={chat ? 'Listeners can comment' : 'Only you can post'} value={chat} onChange={setChat} />
        <OptionRow icon="queue" title="Song requests" subtitle={requests ? 'Listeners request tracks' : 'Requests are off'} value={requests} onChange={setRequests} divider />
        <OptionRow icon="repeat" title="Save replay" subtitle={replay ? 'Tracklist available for 7 days' : 'Nothing is kept after you end'} value={replay} onChange={setReplay} divider />
        <OptionRow icon="bell" title="Notify followers" subtitle="Tell followers when you go live" value={notify} onChange={setNotify} divider />
      </Glass>

      {schedule ? (
        <View style={{ gap: 8 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
            {days.map((d, i) => (
              <Chip key={d.toISOString()} label={dayLabel(d, i)} active={i === dayIndex} onPress={() => pickDay(d)} />
            ))}
          </ScrollView>
          <Row style={{ justifyContent: 'center' }}>
            <IconButton icon="back" label={`${STEP_MIN} minutes earlier`} onPress={() => shift(-STEP_MIN)} glass />
            <T size={22} weight={600} align="center" style={{ minWidth: 140 }} accessibilityLiveRegion="polite">
              {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
            </T>
            <IconButton icon="chevronRight" label={`${STEP_MIN} minutes later`} onPress={() => shift(STEP_MIN)} glass />
          </Row>
          <T size={13} color={tooSoon ? colors.error : colors.textSecondary} align="center">
            {tooSoon ? 'Pick a time at least 5 minutes from now.' : 'People can tap “Notify me” in Live. They get a notification when you start.'}
          </T>
        </View>
      ) : null}

      {error ? (
        <T size={14} color={colors.error} accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      <Row gap={10}>
        <Button label={schedule ? 'Start now' : 'Schedule'} icon={schedule ? 'cast' : 'clock'} variant="glass" height={48} style={{ flex: 1 }} onPress={() => setSchedule((x) => !x)} />
        <Button
          label={busy ? (schedule ? 'Scheduling…' : 'Starting…') : schedule ? 'Schedule' : 'Start live'}
          icon={schedule ? 'clock' : 'cast'}
          variant={busy || tooSoon || !me ? 'disabled' : 'primary'}
          style={{ flex: 1.5 }}
          onPress={() => void submit()}
        />
      </Row>
    </Sheet>
  );
}
