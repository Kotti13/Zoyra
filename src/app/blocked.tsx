import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Glass, Loading, Row, Screen, ScreenHeader, T, Toast, useAsync } from '../components';
import { confirmDialog } from '../lib/dialog';
import { listBlocked, unblockUser, type BlockedUser } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

function confirmUnblock(name: string): Promise<boolean> {
  return confirmDialog(`Unblock ${name}?`, `${name} will be able to follow you, message you and send you dedications again.`, 'Unblock', false);
}

export default function Blocked() {
  const { user } = useAuth();
  const me = user?.id;
  const res = useAsync<BlockedUser[]>(() => (me ? listBlocked(me) : Promise.resolve([])), [me]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = (res.data ?? []).filter((b) => !removed.has(b.id));

  const unblock = async (b: BlockedUser) => {
    if (busyId) return;
    if (!(await confirmUnblock(b.display_name))) return;
    setBusyId(b.id);
    setToast(null);
    try {
      await unblockUser(b.id);
      setRemoved((s) => new Set(s).add(b.id));
      setToast({ ok: true, text: `Unblocked ${b.display_name}` });
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : 'Could not unblock' });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen onRefresh={me ? res.refresh : undefined} top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'none', glows: [{ x: 0, y: 0, color: colors.sky, opacity: 0.32 }] }}>
      <ScreenHeader title="Blocked users" />

      {res.loading && !res.data ? (
        <Loading label="Loading blocked users" />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : rows.length === 0 ? (
        <EmptyState icon="users" title="No one blocked" body="Block someone from their profile, a chat or a dedication. They won't be told." />
      ) : (
        <Glass padding={4}>
          {rows.map((b, i) => (
            <Row key={b.id} gap={12} style={[{ minHeight: 68, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <Cover uri={b.avatar_url} id={b.id} size={44} radius={22} style={{ alignItems: 'center', justifyContent: 'center' }}>
                {b.avatar_url ? null : (
                  <T size={15} weight={600} color={colors.white}>
                    {(b.display_name || '?').charAt(0).toUpperCase()}
                  </T>
                )}
              </Cover>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={16} weight={500} numberOfLines={1}>
                  {b.display_name}
                </T>
                <T size={13} color={colors.textSecondary} numberOfLines={1}>
                  {b.username ? `@${b.username} · ` : ''}Blocked {new Date(b.blocked_at).toLocaleDateString()}
                </T>
              </View>
              {busyId === b.id ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Button label="Unblock" variant="secondary" height={36} onPress={() => void unblock(b)} />
              )}
            </Row>
          ))}
        </Glass>
      )}

      <T size={12} lineHeight={17} color={colors.textSecondary}>
        Blocked people can&apos;t follow you, message you or send you dedications, and you can&apos;t do those things with them.
      </T>

      {toast ? <Toast icon="info" iconColor={toast.ok ? colors.accentLight : colors.error} message={toast.text} /> : null}
    </Screen>
  );
}
