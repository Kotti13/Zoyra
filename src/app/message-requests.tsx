import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, Toast } from '../components';
import { chatPeerParams } from '../lib/chat';
import { acceptRequest, declineAllRequests, declineRequest, listRequests, type MessageRequest, type RequestFolder } from '../lib/dm';
import { confirmAction, friendlySocialError, useBlocks } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors, radius, withAlpha } from '../theme/tokens';

const FOLDERS: { key: RequestFolder; label: string }[] = [
  { key: 'requests', label: 'Requests' },
  { key: 'filtered', label: 'Filtered' },
];

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

function subtitle(r: MessageRequest): string {
  const parts: string[] = [];
  if (r.username) parts.push(`@${r.username}`);
  if (r.restricted) parts.push('Restricted');
  if (r.new_account) parts.push('New account');
  if (r.follows_me) parts.push('Follows you');
  if (r.mutual_count > 0) parts.push(`${r.mutual_count} mutual friend${r.mutual_count === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

export default function MessageRequests() {
  const { user } = useAuth();
  const me = user?.id;
  const { block } = useBlocks(me);

  const [items, setItems] = useState<MessageRequest[] | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState<RequestFolder>('requests');
  /** Optimistically removed conversation ids (restored on failure). */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const rows = await listRequests();
      if (!alive.current) return;
      setItems(rows);
      setHidden(new Set());
    } catch (e) {
      if (alive.current) setError(errText(e, 'Could not load message requests'));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      alive.current = true;
      void load();
      return () => {
        alive.current = false;
      };
    }, [load]),
  );

  const hide = (ids: string[]) => setHidden((s) => new Set([...s, ...ids]));
  const unhide = (ids: string[]) =>
    setHidden((s) => {
      const n = new Set(s);
      ids.forEach((id) => n.delete(id));
      return n;
    });

  const visible = (items ?? []).filter((r) => !hidden.has(r.conversation_id));
  const counts: Record<RequestFolder, number> = {
    requests: visible.filter((r) => r.folder === 'requests').length,
    filtered: visible.filter((r) => r.folder === 'filtered').length,
  };
  const rows = visible.filter((r) => r.folder === folder);

  const accept = async (r: MessageRequest) => {
    if (busy) return;
    setBusy(r.conversation_id);
    setToast(null);
    hide([r.conversation_id]);
    try {
      await acceptRequest(r.conversation_id);
      router.replace({ pathname: '/chat-pro', params: { id: r.conversation_id, ...chatPeerParams({ id: r.other_id, display_name: r.display_name, avatar_url: r.avatar_url }) } });
    } catch (e) {
      unhide([r.conversation_id]);
      setToast({ ok: false, text: errText(e, 'Could not accept the request') });
    } finally {
      setBusy(null);
    }
  };

  const decline = async (r: MessageRequest) => {
    if (busy) return;
    setBusy(r.conversation_id);
    setToast(null);
    hide([r.conversation_id]);
    try {
      await declineRequest(r.conversation_id);
      // A restricted chat is only cleared for me; it comes back here if they write again.
      setToast({ ok: true, text: r.restricted ? `Cleared ${r.display_name}'s messages` : `Declined ${r.display_name}'s request` });
    } catch (e) {
      unhide([r.conversation_id]);
      setToast({ ok: false, text: errText(e, 'Could not decline the request') });
    } finally {
      setBusy(null);
    }
  };

  const blockSender = async (r: MessageRequest) => {
    if (busy) return;
    setToast(null);
    try {
      if (!(await block(r.other_id, r.display_name))) return;
    } catch (e) {
      setToast({ ok: false, text: friendlySocialError(e, 'Could not block') });
      return;
    }
    // Every request from this person goes with the block.
    const ids = (items ?? []).filter((x) => x.other_id === r.other_id).map((x) => x.conversation_id);
    hide(ids);
    setToast({ ok: true, text: `Blocked ${r.display_name}. Unblock them in Privacy → Blocked users.` });
    await Promise.all(ids.map((id) => declineRequest(id).catch(() => undefined)));
  };

  const declineAll = async () => {
    if (busy || rows.length === 0) return;
    const name = folder === 'requests' ? 'requests' : 'filtered requests';
    const ok = await confirmAction(`Decline all ${name}?`, `${rows.length} ${rows.length === 1 ? 'request' : 'requests'} will be deleted. Senders aren't told.`, 'Decline all');
    if (!ok) return;
    const ids = rows.map((r) => r.conversation_id);
    setBusy('all');
    setToast(null);
    hide(ids);
    try {
      await declineAllRequests(folder);
      setToast({ ok: true, text: `Declined ${ids.length} ${ids.length === 1 ? 'request' : 'requests'}` });
    } catch (e) {
      unhide(ids);
      setToast({ ok: false, text: errText(e, 'Could not decline all requests') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen onRefresh={() => load(true)}
      top={4}
      gap={16}
      backdrop={{
        pattern: 'dots',
        mesh: 'none',
        glows: [
          { x: 0.9, y: 0, color: colors.orange, opacity: 0.38 },
          { x: 0, y: 0.4, color: colors.accent, opacity: 0.2 },
        ],
      }}
    >
      <ScreenHeader title="Message requests" right={<IconButton icon="sliders" label="Message privacy settings" href="/dm-privacy" />} />

      <View accessibilityRole="tablist" accessibilityLabel="Request folders" style={{ flexDirection: 'row', gap: 6, padding: 4, borderRadius: radius.pill, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        {FOLDERS.map((f) => {
          const on = f.key === folder;
          return (
            <Tap
              key={f.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${f.label}, ${counts[f.key]}`}
              onPress={() => setFolder(f.key)}
              style={{ flex: 1, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.accent : undefined }}
            >
              <T size={14} weight={600} color={on ? colors.onAccent : colors.textSecondary}>
                {f.label} · {items ? counts[f.key] : '…'}
              </T>
            </Tap>
          );
        })}
      </View>

      <Row gap={10} align="flex-start" style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}>
        <Icon name="info" size={18} color={colors.textSecondary} />
        <T size={12} lineHeight={18} color={colors.textSecondary} style={{ flex: 1 }}>
          {folder === 'filtered'
            ? 'Requests that look like spam end up here. You can still accept them.'
            : "People won't see that you've read their request until you accept. Accepting lets them message you, see when you're active and share music."}
        </T>
      </Row>

      {loading && !items ? (
        <Loading label="Loading message requests" />
      ) : error && !items ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="mail"
          title={folder === 'requests' ? 'No message requests' : 'Nothing filtered'}
          body={folder === 'requests' ? "When someone you don't chat with messages you, it shows up here." : 'Suspicious requests are moved here so they stay out of your way.'}
        />
      ) : (
        <>
          {rows.map((r) => (
            <RequestCard key={r.conversation_id} r={r} disabled={!!busy} onAccept={() => void accept(r)} onDecline={() => void decline(r)} onBlock={() => void blockSender(r)} />
          ))}
          <Tap
            accessibilityRole="button"
            accessibilityLabel={`Decline all ${folder === 'requests' ? 'requests' : 'filtered requests'}`}
            onPress={() => void declineAll()}
            style={{ alignSelf: 'center', height: 44, paddingHorizontal: 20, justifyContent: 'center' }}
          >
            <T size={14} weight={600} color={colors.error}>
              Decline all
            </T>
          </Tap>
        </>
      )}

      {error && items ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      {toast ? <Toast icon="info" iconColor={toast.ok ? colors.accentLight : colors.error} message={toast.text} /> : null}
    </Screen>
  );
}

function RequestCard({ r, disabled, onAccept, onDecline, onBlock }: { r: MessageRequest; disabled: boolean; onAccept: () => void; onDecline: () => void; onBlock: () => void }) {
  const sub = subtitle(r);
  return (
    <Glass radius={radius.card} padding={14} style={{ gap: 12 }}>
      <Row gap={12}>
        <Cover uri={r.avatar_url} id={r.other_id} size={48} radius={16} style={{ alignItems: 'center', justifyContent: 'center' }}>
          {r.avatar_url ? null : (
            <T size={16} weight={600} color={colors.white}>
              {(r.display_name || '?').charAt(0).toUpperCase()}
            </T>
          )}
        </Cover>
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
          <T size={15} weight={600} numberOfLines={1}>
            {r.display_name}
          </T>
          {sub ? (
            <T size={12} color={colors.textSecondary} numberOfLines={2}>
              {sub}
            </T>
          ) : null}
        </View>
        {r.taste_match != null ? (
          <View
            accessibilityLabel={`${Math.round(r.taste_match)} percent music taste match`}
            style={{ height: 24, paddingHorizontal: 10, borderRadius: 12, justifyContent: 'center', backgroundColor: withAlpha(colors.success, 0.14), borderWidth: 1, borderColor: withAlpha(colors.success, 0.35) }}
          >
            <T size={11} weight={600} color={colors.mint}>
              {Math.round(r.taste_match)}% match
            </T>
          </View>
        ) : null}
      </Row>

      {r.preview ? (
        <View
          style={{
            paddingVertical: 10,
            paddingHorizontal: 14,
            borderTopLeftRadius: 18,
            borderTopRightRadius: 18,
            borderBottomRightRadius: 18,
            borderBottomLeftRadius: 6,
            backgroundColor: withAlpha(colors.white, 0.06),
            borderWidth: 1,
            borderColor: withAlpha(colors.white, 0.12),
          }}
        >
          <T size={14} lineHeight={20} color={colors.peach} numberOfLines={4}>
            {r.preview}
          </T>
        </View>
      ) : null}

      {r.mass_sent ? (
        <Row gap={6}>
          <Icon name="info" size={16} color={colors.warning} />
          <T size={12} color={colors.warning}>
            Sent to many people at once
          </T>
        </Row>
      ) : null}

      <Row gap={8} style={disabled ? { opacity: 0.6 } : undefined}>
        <Button
          label="Accept"
          icon="check"
          height={44}
          style={{ flex: 1 }}
          onPress={disabled ? undefined : onAccept}
        />
        <Button label="Decline" variant="glass" height={44} style={{ flex: 1 }} onPress={disabled ? undefined : onDecline} />
        <IconButton icon="close" label={`Block ${r.display_name}`} iconSize={20} color={colors.error} bg={withAlpha(colors.white, 0.1)} onPress={disabled ? undefined : onBlock} />
      </Row>
    </Glass>
  );
}
