import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button, Icon, Sheet, T, Tap, useAsync } from '../components';
import { loadMessage, messagePreview } from '../lib/chat';
import { cancelMessageReminder, clockLabel, getMessageReminder, reminderPresets, scheduleMessageReminder } from '../lib/reminders';
import { colors, fonts, withAlpha } from '../theme/tokens';

/**
 * Remind me (`/remind-me?id=<conversation>&msg=<message>[&group=1][&name=]`), sheet opened from Message options.
 * Schedules a local notification on this device that reopens the chat; the message text never leaves it.
 */
export default function RemindMe() {
  const params = useLocalSearchParams<{ id?: string; msg?: string; group?: string; name?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const mid = typeof params.msg === 'string' ? params.msg : '';
  const name = typeof params.name === 'string' ? params.name : undefined;
  const presets = reminderPresets();
  const [sel, setSel] = useState(1);
  const [customMin, setCustomMin] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const msg = useAsync(() => (mid ? loadMessage(mid) : Promise.resolve(null)), [mid], 'app/remind-me:25');
  const existing = useAsync(() => (mid ? getMessageReminder(mid) : Promise.resolve(null)), [mid], 'app/remind-me:26');
  const preview = msg.data ? messagePreview(msg.data) : '';

  const custom = sel === presets.length;
  const customValue = Math.round(Number(customMin));
  const customOk = Number.isFinite(customValue) && customValue >= 1 && customValue <= 60 * 24 * 30;
  const at = custom ? new Date(presets[0].at.getTime() - 3600_000 + customValue * 60_000) : presets[sel].at;

  const save = async () => {
    if (busy || !cid || !mid || (custom && !customOk)) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await scheduleMessageReminder({ mid, cid, preview: preview || 'Open the chat', name, at, group: params.group === '1' });
      if (!ok) throw new Error('Allow notifications in Settings to get reminders');
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not set the reminder');
      setBusy(false);
    }
  };

  const labels = [...presets.map((p) => ({ label: p.label, time: clockLabel(p.at) })), { label: 'Pick date and time', time: custom && customOk ? clockLabel(at) : '' }];

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        Remind me
      </T>
      {preview ? (
        <View style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 18, backgroundColor: withAlpha(colors.white, 0.06), borderLeftWidth: 3, borderLeftColor: colors.accent }}>
          <T size={13} numberOfLines={3}>
            {preview}
          </T>
        </View>
      ) : null}
      {existing.data ? (
        <T size={13} color={colors.accentLight}>
          {`Already set for ${clockLabel(existing.data)}. Saving replaces it.`}
        </T>
      ) : null}

      <View style={{ borderRadius: 32, overflow: 'hidden', backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        {labels.map((o, i) => (
          <Tap
            key={o.label}
            onPress={() => setSel(i)}
            accessibilityRole="radio"
            accessibilityState={{ selected: i === sel }}
            accessibilityLabel={`${o.label}${o.time ? `, ${o.time}` : ''}`}
            style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 52 }, i ? { borderTopWidth: 1, borderTopColor: colors.divider } : null]}
          >
            <T size={15} weight={600} style={{ flex: 1 }}>
              {o.label}
            </T>
            <T size={13} color={colors.textSecondary}>
              {o.time}
            </T>
            {i === sel ? <Icon name="check" size={18} color={colors.accentLight} /> : null}
          </Tap>
        ))}
      </View>

      {custom ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}>
          <T size={16} weight={500} style={{ flex: 1 }}>
            Minutes from now
          </T>
          <TextInput
            value={customMin}
            onChangeText={(v) => setCustomMin(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={5}
            accessibilityLabel="Custom minutes"
            style={{ width: 96, height: 44, borderRadius: 22, backgroundColor: colors.bgTertiary, color: colors.text, fontFamily: fonts.regular, fontSize: 16, textAlign: 'center' }}
          />
        </View>
      ) : null}

      {error ? (
        <T size={13} color={colors.error} accessibilityRole="alert">
          {error}
        </T>
      ) : null}
      <Button label={busy ? 'Setting…' : 'Set reminder'} variant={busy || (custom && !customOk) ? 'disabled' : 'primary'} onPress={() => void save()} />
      {existing.data ? (
        <Button
          label="Remove reminder"
          variant="secondary"
          onPress={() => {
            void cancelMessageReminder(mid).then(() => router.back());
          }}
        />
      ) : null}
    </Sheet>
  );
}
