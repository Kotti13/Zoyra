import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, Loading, Row, Screen, ScreenHeader, T, Tap } from '../components';
import { PersonAvatar } from '../features/profile-ui';
import { acceptFollowRequest, declineFollowRequest, listFollowRequests, type FollowRequester } from '../lib/follow-requests';
import { flash } from '../lib/flash';
import { friendlySocialError } from '../lib/social';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

/**
 * Follow requests (Instagram-style): people who asked to follow a private profile.
 * Confirm makes them a follower; Delete removes the request without telling them.
 */
export default function FollowRequests() {
  const { user } = useAuth();
  const me = user?.id;
  const [items, setItems] = useState<FollowRequester[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!me) return;
    try {
      setItems(await listFollowRequests(me));
      setError(null);
    } catch (e) {
      setError(friendlySocialError(e, 'Could not load follow requests'));
    }
  }, [me]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const answer = async (p: FollowRequester, accept: boolean) => {
    if (busy) return;
    setBusy(p.id);
    try {
      if (accept) await acceptFollowRequest(p.id);
      else await declineFollowRequest(p.id);
      setItems((list) => list?.filter((x) => x.id !== p.id));
      flash(accept ? `${p.display_name} now follows you` : 'Request deleted');
    } catch (e) {
      setError(friendlySocialError(e, accept ? 'Could not accept the request' : 'Could not delete the request'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen backdrop={{ pattern: 'dots', mesh: 'rose' }} top={4} gap={16}>
      <ScreenHeader title="Follow requests" />
      {!me ? (
        <EmptyState icon="users" title="Sign in to see requests" body="Follow requests need an account." action="Sign in" href="/login" />
      ) : error && !items ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !items ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState icon="users" title="No follow requests" body="When someone asks to follow your private profile, they show up here for you to accept." />
      ) : (
        <Glass radius={24}>
          {items.map((p, i) => (
            <View key={p.id} style={{ paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderTopWidth: i ? 1 : 0, borderTopColor: 'rgba(255,255,255,0.08)' }}>
              <Tap accessibilityLabel={`Open ${p.display_name}'s profile`} onPress={() => router.push({ pathname: '/public-profile', params: { id: p.id } })}>
                <Row gap={12}>
                  <PersonAvatar id={p.id} name={p.display_name} uri={p.avatar_url} size={48} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T size={16} weight={600} numberOfLines={1}>
                      {p.display_name}
                    </T>
                    {p.username ? (
                      <T size={13} color={colors.textSecondary} numberOfLines={1}>
                        @{p.username}
                      </T>
                    ) : null}
                  </View>
                </Row>
              </Tap>
              <Row gap={10}>
                <Button label={busy === p.id ? '…' : 'Confirm'} variant="primary" height={40} onPress={() => void answer(p, true)} style={{ flex: 1 }} />
                <Button label="Delete" variant="glass" height={40} onPress={() => void answer(p, false)} style={{ flex: 1 }} />
              </Row>
            </View>
          ))}
        </Glass>
      )}
    </Screen>
  );
}
