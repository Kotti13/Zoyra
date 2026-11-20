import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { go, Icon, Loading, Sheet, T, Tap, useAsync, type IconName } from '../components';
import { canEdit, chatBus, chatError, deliveryOf, DELIVERY_LABEL, hideForMe, loadMessage, loadReceipts, messagePreview, timeOf, type ChatMessage, type Receipt } from '../lib/chat';
import { unsendMessage } from '../lib/chat-delete';
import { decryptErrorOf } from '../lib/chat-e2ee';
import { DialogBody, DialogButton, DialogNote, DialogTitle, dialogColors } from '../lib/confirm-ui';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

type Ctx = { message: ChatMessage | null; otherName: string; receipt: Receipt | null; group: boolean };

async function loadCtx(mid: string, cid: string, me: string, groupHint: boolean): Promise<Ctx> {
  const [message, members, receipts, conv] = await Promise.all([
    loadMessage(mid),
    supabase.from('conversation_members').select('user_id, profiles(display_name)').eq('conversation_id', cid).neq('user_id', me).limit(1),
    loadReceipts(cid).catch(() => [] as Receipt[]),
    groupHint ? Promise.resolve({ data: { kind: 'group' } }) : supabase.from('conversations').select('kind').eq('id', cid).maybeSingle(),
  ]);
  const group = groupHint || (conv.data as { kind?: string } | null)?.kind === 'group';
  type Row = { user_id: string; profiles: { display_name: string | null } | { display_name: string | null }[] | null };
  const row = ((members.data ?? []) as unknown as Row[])[0];
  const prof = Array.isArray(row?.profiles) ? row?.profiles[0] : row?.profiles;
  if (group) return { message, otherName: '', receipt: null, group };
  return { message, otherName: prof?.display_name?.trim() ?? '', receipt: receipts.find((r) => r.user_id === row?.user_id) ?? null, group };
}

/**
 * Confirm unsend (`/confirm-unsend?mid=&cid=[&group=1]`), bottom sheet over the chat with the message lifted
 * above it. Delete for everyone (`unsend_message` rpc, your own messages only) or Delete for me.
 */
export default function ConfirmUnsend() {
  const params = useLocalSearchParams<{ mid?: string; cid?: string; group?: string }>();
  const groupHint = params.group === '1';
  const mid = typeof params.mid === 'string' ? params.mid : '';
  const cid = typeof params.cid === 'string' ? params.cid : '';
  const { user } = useAuth();
  const me = user?.id;
  const [busy, setBusy] = useState<'all' | 'me' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ctx = useAsync(() => (mid && cid && me ? loadCtx(mid, cid, me, groupHint) : Promise.resolve(null)), [mid, cid, me, groupHint], 'app/confirm-unsend:45');
  const m = ctx.data?.message ?? null;

  const run = async (key: 'all' | 'me', fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await fn();
      if (chatBus.get().replyTo[cid]?.id === mid) chatBus.setReply(cid, undefined);
      go('back');
    } catch (e) {
      setError(chatError(e, key === 'all' ? 'Could not delete this message' : 'Could not delete'));
      setBusy(null);
    }
  };

  const dismiss = busy ? () => undefined : undefined;

  if (!mid || !cid || !me || ctx.loading || !m) {
    return (
      <Sheet onDismiss={dismiss}>
        {ctx.loading && me ? (
          <Loading height={160} />
        ) : (
          <DialogBody label="Delete message" gap={12}>
            <DialogTitle size={20} align="left">
              Delete message
            </DialogTitle>
            <T size={14} color={colors.textSecondary}>
              {!me ? 'Sign in to manage messages.' : (ctx.error ?? 'This message is no longer available.')}
            </T>
            <DialogButton label="Close" onPress={() => go('back')} />
          </DialogBody>
        )}
      </Sheet>
    );
  }

  const mine = m.sender_id === me;
  // Call log rows (kind 'call', added by the calls migration) can't be unsent.
  const canUnsend = mine && (m.kind as string) !== 'call';
  const first = ctx.data?.otherName.split(/\s+/)[0] || '';
  const who = first || 'They';
  const group = !!ctx.data?.group;
  const state = mine && !group ? deliveryOf(m, ctx.data?.receipt, true) : null;
  const copy = !canUnsend
    ? 'This removes it from your view of the chat only.'
    : group
      ? 'Members may have already seen this. Deleting for everyone removes it for every member of this group.'
      : state === 'read'
      ? `${who} may have already seen this. Deleting for everyone removes it from ${first ? 'their' : 'the'} chat too.`
      : `${first ? `${first} hasn't` : "They haven't"} read this yet. Deleting for everyone removes it from ${first ? 'their' : 'the'} chat too.`;

  // "Edit instead" (edit_message, 20261115190000_advanced_chat.sql): my text messages within 15 minutes.
  // Hands the message to the chat composer's edit mode (chatBus.editing) and returns to the chat.
  const unavailable = !!decryptErrorOf(m);
  const editable = !unavailable && canEdit(m, me);
  const editInstead = () => {
    if (busy) return;
    chatBus.setReply(cid, undefined);
    chatBus.setEditing(cid, m);
    go('back');
  };

  const rows: { key: 'all' | 'me' | 'edit'; label: string; icon: IconName; danger?: boolean; trailing?: string; onPress: () => void }[] = [
    ...(canUnsend ? [{ key: 'all' as const, label: 'Delete for everyone', icon: 'trash' as const, danger: true, onPress: () => void run('all', () => unsendMessage(mid)) }] : []),
    { key: 'me', label: 'Delete for me', icon: 'trash', onPress: () => void run('me', () => hideForMe(mid, me)) },
    ...(editable ? [{ key: 'edit' as const, label: 'Edit instead', icon: 'edit' as const, trailing: 'Within 15 min', onPress: editInstead }] : []),
  ];

  return (
    <View style={{ flex: 1 }}>
      <Sheet onDismiss={dismiss}>
        <DialogBody label="Delete message?" gap={12}>
          <View style={{ gap: 4, paddingHorizontal: 4, paddingTop: 4 }}>
            <DialogTitle size={20} align="left">
              Delete message?
            </DialogTitle>
            <T size={13} color={colors.textSecondary} lineHeight={19}>
              {copy}
            </T>
          </View>
          <View style={{ borderRadius: 24, backgroundColor: dialogColors.field, borderWidth: 1, borderColor: dialogColors.fieldBorder, overflow: 'hidden' }}>
            {rows.map((r, i) => (
              <Tap
                key={r.key}
                onPress={busy ? undefined : r.onPress}
                disabled={!!busy}
                pressScale={0.98}
                accessibilityLabel={r.trailing ? `${r.label}, ${r.trailing.toLowerCase()}` : r.label}
                accessibilityState={{ disabled: !!busy, busy: busy === r.key }}
                style={[{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 16 }, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth * 2, borderTopColor: withAlpha(colors.white, 0.08) } : null]}
              >
                {busy === r.key ? <ActivityIndicator size="small" color={r.danger ? dialogColors.dangerText : colors.text} /> : <Icon name={r.icon} size={20} color={r.danger ? dialogColors.dangerText : colors.text} />}
                <T size={16} weight={r.danger ? 600 : 500} color={r.danger ? dialogColors.dangerText : colors.text} style={{ flex: 1 }}>
                  {r.label}
                </T>
                {r.trailing ? (
                  <T size={12} color={colors.textSecondary}>
                    {r.trailing}
                  </T>
                ) : null}
              </Tap>
            ))}
          </View>
          <DialogNote text={error} />
          <DialogButton label="Cancel" disabled={!!busy} onPress={() => go('back')} />
        </DialogBody>
      </Sheet>

      {/* The message, lifted above the scrim (decorative: the sheet describes it). */}
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants" style={{ position: 'absolute', left: 16, right: 16, top: '34%', alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
        <View
          style={{
            maxWidth: '86%',
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderRadius: 20,
            ...(mine ? { borderBottomRightRadius: 6, backgroundColor: colors.accent } : { borderBottomLeftRadius: 6, backgroundColor: colors.surface }),
          }}
        >
          <T size={15} numberOfLines={3} color={mine ? colors.onAccent : colors.text}>
            {messagePreview(m)}
          </T>
        </View>
        <T size={11} color={dialogColors.body}>
          {`${timeOf(m.created_at)}${state ? ` · ${DELIVERY_LABEL[state].text}` : ''}`}
        </T>
      </View>
    </View>
  );
}
