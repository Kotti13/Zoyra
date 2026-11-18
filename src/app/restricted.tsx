import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Glass, Icon, Loading, Row, Screen, ScreenHeader, T, Toast, useAsync } from '../components';
import { listRestricted, unrestrictUser, type RestrictedUser } from '../lib/dm';
import { confirmDialog } from '../lib/dialog';
import { friendlySocialError } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

function confirmUnrestrict(name: string): Promise<boolean> {
  return confirmDialog(
    `Unrestrict ${name}?`,
    `${name}'s messages will go to your chats again, and they'll be able to see when you're online and have read their messages.`,
    'Unrestrict',
    false,
  );
}

/** Message privacy → Restricted accounts: everyone I restrict, with Unrestrict. */
export default function Restricted() {
  const { user } = useAuth();
  const me = user?.id;
  const res = useAsync<RestrictedUser[]>(() => (me ? listRestricted() : Promise.resolve([])), [me]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = (res.data ?? []).filter((r) => !removed.has(r.id));

  const unrestrict = async (r: RestrictedUser) => {
    if (busyId) return;
    if (!(await confirmUnrestrict(r.display_name))) return;
    setBusyId(r.id);
    setToast(null);
    try {
      await unrestrictUser(r.id);
      setRemoved((s) => new Set(s).add(r.id));
      setToast({ ok: true, text: `Unrestricted ${r.display_name}` });
    } catch (e) {
      setToast({ ok: false, text: friendlySocialError(e, 'Could not unrestrict') });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen onRefresh={me ? res.refresh : undefined}
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
      <ScreenHeader title="Restricted accounts" />

      <Row
        gap={10}
        align="flex-start"
        style={{ paddingVertical: 12, paddingHorizontal: 14, borderRadius: 20, backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) }}
      >
        <Icon name="info" size={18} color={colors.textSecondary} />
        <T size={12} lineHeight={18} color={colors.textSecondary} style={{ flex: 1 }}>
          New messages from people you restrict go to Message requests without notifications. They can&apos;t see when you&apos;re online or when you&apos;ve read their
          messages, and they aren&apos;t told.
        </T>
      </Row>

      {!me ? (
        <EmptyState icon="users" title="Sign in to manage restricted accounts" action="Sign in" href="/login" />
      ) : res.loading && !res.data ? (
        <Loading label="Loading restricted accounts" />
      ) : res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : rows.length === 0 ? (
        <EmptyState icon="users" title="No restricted accounts" body="Long-press a chat in Messages to restrict someone." />
      ) : (
        <Glass padding={4}>
          {rows.map((r, i) => (
            <Row key={r.id} gap={12} style={[{ minHeight: 68, paddingHorizontal: 12 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
              <Cover uri={r.avatar_url} id={r.id} size={44} radius={22} style={{ alignItems: 'center', justifyContent: 'center' }}>
                {r.avatar_url ? null : (
                  <T size={15} weight={600} color={colors.white}>
                    {(r.display_name || '?').charAt(0).toUpperCase()}
                  </T>
                )}
              </Cover>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T size={16} weight={500} numberOfLines={1}>
                  {r.display_name}
                </T>
                <T size={13} color={colors.textSecondary} numberOfLines={1}>
                  {r.username ? `@${r.username} · ` : ''}Restricted {new Date(r.restricted_at).toLocaleDateString()}
                </T>
              </View>
              {busyId === r.id ? (
                <ActivityIndicator color={colors.accent} accessibilityLabel={`Unrestricting ${r.display_name}`} />
              ) : (
                <Button label="Unrestrict" variant="secondary" height={44} onPress={() => void unrestrict(r)} />
              )}
            </Row>
          ))}
        </Glass>
      )}

      {toast ? <Toast icon="info" iconColor={toast.ok ? colors.accentLight : colors.error} message={toast.text} /> : null}
    </Screen>
  );
}
