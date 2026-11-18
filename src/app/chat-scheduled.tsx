import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, EmptyState, ErrorState, Icon, IconButton, Loading, Row, Screen, T, Tap, TextField, useAsync } from '../components';
import { cancelScheduled, chatError, decryptChatRows, editScheduled, listScheduled, MSG_SELECT, scheduleMessage, type ChatMessage, type Scheduled } from '../lib/chat';
import { cancelCapsule, capsuleDateLabel, myPendingCapsules } from '../lib/chat-extras';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const whenLabel = (iso: string) => {
  const d = new Date(iso);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow · ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} · ${time}`;
};

function presets(now = new Date()): { label: string; at: Date }[] {
  const inHour = new Date(now.getTime() + 2 * 3_600_000);
  inHour.setMinutes(0, 0, 0);
  const tonight = new Date(now);
  tonight.setHours(21, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const weekend = new Date(now);
  weekend.setDate(weekend.getDate() + ((6 - weekend.getDay() + 7) % 7 || 7));
  weekend.setHours(10, 0, 0, 0);
  const out = [{ label: `In ~2 hours`, at: inHour }];
  if (tonight.getTime() - now.getTime() > 15 * 60_000) out.push({ label: 'Tonight 9 PM', at: tonight });
  out.push({ label: 'Midnight', at: midnight }, { label: 'Tomorrow 9 AM', at: tomorrow }, { label: 'Saturday 10 AM', at: weekend });
  return out;
}

type CapsuleItem = { id: string; opens_at: string; preview: string };

/**
 * Scheduled (`/chat-scheduled?id=<conversation>`, MsgScheduled design): my messages waiting to be sent in this
 * chat ("send later", edit or cancel) and my time capsules waiting to open (cancel = unsend). "Schedule a
 * message" opens the composer. Send-later messages are delivered by the server, so (as before) they are not
 * end-to-end encrypted; capsules are.
 */
export default function ChatScheduled() {
  const params = useLocalSearchParams<{ id?: string }>();
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const [composer, setComposer] = useState<{ edit: Scheduled | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const data = useAsync(async () => {
    if (!cid || !me) return { scheduled: [] as Scheduled[], capsules: [] as CapsuleItem[], name: '' };
    const [scheduled, caps, other] = await Promise.all([
      listScheduled(cid),
      myPendingCapsules(cid, me),
      supabase.from('conversation_members').select('profiles(display_name)').eq('conversation_id', cid).neq('user_id', me).limit(1).maybeSingle(),
    ]);
    let capsules: CapsuleItem[] = [];
    if (caps.length) {
      const msgs = await supabase.from('messages').select(MSG_SELECT).in('id', caps.map((c) => c.message_id));
      const dec = await decryptChatRows(((msgs.data ?? []) as ChatMessage[]));
      const byId = new Map(dec.map((m) => [m.id, m]));
      capsules = caps.map((c) => {
        const m = byId.get(c.message_id);
        return { id: c.message_id, opens_at: c.opens_at, preview: m?.track ? m.track.title : m?.body ? m.body : 'Sealed message' };
      });
    }
    const name = ((other.data as { profiles: { display_name: string } | null } | null)?.profiles?.display_name ?? '').split(' ')[0];
    return { scheduled: scheduled.filter((s) => !s.sent_at), capsules, name };
  }, [cid, me]);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    if (busy) return;
    setBusy(key);
    setNote(null);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
      data.reload();
    } catch (e) {
      setNote({ ok: false, text: chatError(e, 'That didn’t work. Try again.') });
    } finally {
      setBusy(null);
    }
  };

  const name = data.data?.name || 'them';
  const empty = !data.data?.scheduled.length && !data.data?.capsules.length;

  return (
    <Screen top={4} gap={14} onRefresh={data.refresh} backdrop={{ pattern: 'none', mesh: 'rose', orbs: false }}>
      <Row style={{ minHeight: 44 }}>
        <IconButton icon="back" label="Back" size={44} bg={colors.chipGhost} onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat-pro', params: { id: cid } }))} />
      </Row>
      <View style={{ gap: 6 }}>
        <T size={36} weight={300} tracking={-1} accessibilityRole="header">
          Scheduled
        </T>
        <T size={14} color={colors.textSecondary}>
          Messages waiting to be sent to {name}.
        </T>
      </View>
      {note ? (
        <T size={13} color={note.ok ? colors.success : colors.error} accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
      {data.loading ? (
        <Loading />
      ) : data.error ? (
        <ErrorState message={data.error} onRetry={data.reload} />
      ) : empty && !composer ? (
        <EmptyState icon="clock" title="Nothing scheduled" body="Schedule a message or seal a time capsule from Chat extras." />
      ) : (
        <>
          {(data.data?.scheduled ?? []).map((s) => (
            <ItemRow
              key={s.id}
              icon="clock"
              color="#1FBF8F"
              title={s.body}
              sub={s.failed ? `Not sent (${s.failed === 'blocked' ? 'blocked' : 'no longer in this chat'})` : whenLabel(s.send_at)}
              busy={busy === s.id}
              onEdit={s.failed ? undefined : () => setComposer({ edit: s })}
              onCancel={() => void run(s.id, () => cancelScheduled(s.id), 'Cancelled')}
            />
          ))}
          {(data.data?.capsules ?? []).map((c) => (
            <ItemRow
              key={c.id}
              icon="lock"
              color="#8A4BFF"
              title={`Time capsule · ${c.preview}`}
              sub={`Opens ${capsuleDateLabel(c.opens_at)}`}
              busy={busy === c.id}
              onCancel={() => void run(c.id, () => cancelCapsule(c.id), 'Capsule cancelled')}
            />
          ))}
        </>
      )}
      {composer && me ? (
        <Composer
          key={composer.edit?.id ?? 'new'}
          edit={composer.edit}
          onDone={(text) => {
            setComposer(null);
            setNote({ ok: true, text });
            data.reload();
          }}
          onCancel={() => setComposer(null)}
          send={(body, at) => (composer.edit ? editScheduled(composer.edit.id, body, at) : scheduleMessage(cid, me, body, at))}
        />
      ) : (
        <Tap
          onPress={() => setComposer({ edit: null })}
          accessibilityRole="button"
          accessibilityLabel="Schedule a message"
          style={{ height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
        >
          <Icon name="plus" size={18} color={colors.text} />
          <T size={15} weight={600}>
            Schedule a message
          </T>
        </Tap>
      )}
      <T size={12} color={colors.textTertiary} lineHeight={17}>
        Zoyra’s server sends scheduled messages at the chosen time, even if your phone is off, so they are not end-to-end encrypted. Time capsules are.
      </T>
    </Screen>
  );
}

function ItemRow({ icon, color, title, sub, busy, onEdit, onCancel }: { icon: 'clock' | 'lock'; color: string; title: string; sub: string; busy: boolean; onEdit?: () => void; onCancel: () => void }) {
  return (
    <Row gap={12} style={{ padding: 12, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: color, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={18} color={colors.white} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T size={15} weight={500} numberOfLines={2}>
          {title}
        </T>
        <T size={13} color={colors.textSecondary}>
          {sub}
        </T>
      </View>
      {onEdit ? <IconButton icon="edit" label={`Edit: ${title}`} size={40} iconSize={18} onPress={onEdit} /> : null}
      <IconButton icon={busy ? 'clock' : 'trash'} label={`Cancel: ${title}`} size={40} iconSize={18} color={colors.accentLight} onPress={onCancel} />
    </Row>
  );
}

function Composer({ edit, send, onDone, onCancel }: { edit: Scheduled | null; send: (body: string, at: Date) => Promise<void>; onDone: (text: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(edit?.body ?? '');
  const [choices] = useState(() => {
    const p = presets();
    return edit ? [{ label: `Keep · ${whenLabel(edit.send_at)}`, at: new Date(edit.send_at) }, ...p] : p;
  });
  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    const text = body.trim();
    const at = choices[pick]?.at;
    if (!text || !at || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await send(text, at);
      onDone(edit ? 'Saved' : `Scheduled for ${whenLabel(at.toISOString())}`);
    } catch (e) {
      setErr(chatError(e, 'Could not schedule'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 10, padding: 14, borderRadius: 28, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
      <T size={15} weight={600}>
        {edit ? 'Edit scheduled message' : 'Schedule a message'}
      </T>
      <TextField label="Message" hideLabel placeholder="Message to send later" value={body} onChangeText={setBody} maxLength={2000} multiline />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 8 }}>
        {choices.map((c, i) => (
          <Chip key={c.label} label={c.label} active={pick === i} onPress={() => setPick(i)} />
        ))}
      </View>
      {err ? (
        <T size={13} color={colors.error}>
          {err}
        </T>
      ) : null}
      <Row gap={8}>
        <Button label="Cancel" variant="glass" height={44} style={{ flex: 1 }} onPress={onCancel} />
        <Button label={busy ? 'Saving…' : edit ? 'Save' : 'Schedule'} icon="clock" height={44} style={{ flex: 1 }} variant={body.trim() && !busy ? 'primary' : 'disabled'} onPress={() => void save()} />
      </Row>
    </View>
  );
}
