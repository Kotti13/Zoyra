import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, EmptyState, ErrorState, Glass, Icon, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toast, ToggleBurst } from '../components';
import {
  endSession,
  formatCount,
  formatWhen,
  friendlyLiveError,
  isOnAir,
  loadHub,
  replayExpiresAt,
  setFollow,
  setReminder,
  sinceShort,
  startScheduled,
  type HubData,
  type LiveSession,
} from '../lib/live';
import { HostAvatar, LiveBadge } from '../lib/live-ui';
import { confirmAction } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const backdrop = {
  pattern: 'none' as const,
  mesh: 'none' as const,
  glows: [
    { x: 0.5, y: 0, color: colors.accent, opacity: 0.3 },
    { x: 0, y: 0.6, color: colors.accentDark, opacity: 0.2 },
  ],
};

export default function LiveHub() {
  const { user } = useAuth();
  const me = user?.id;
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (quiet = false) => {
      if (!me) return;
      if (!quiet) setLoading(true);
      setError(null);
      try {
        setData(await loadHub(me));
        setNow(Date.now());
      } catch (e) {
        if (!quiet) setError(friendlyLiveError(e, 'Could not load live sessions'));
      } finally {
        setLoading(false);
      }
    },
    [me],
  );

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // New sessions / status changes appear without a manual refresh (debounced).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!me) return;
    const ch = supabase
      .channel(`live-hub:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_sessions' }, () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void load(true), 1500);
      })
      .subscribe();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      clearInterval(tick);
      void supabase.removeChannel(ch);
    };
  }, [me, load]);

  const run = async (key: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) setNote({ ok: true, text: ok });
    } catch (e) {
      setNote({ ok: false, text: friendlyLiveError(e) });
    } finally {
      setBusy(null);
    }
  };

  const toggleFollow = (hostId: string, name: string) => {
    if (!me || !data) return;
    const on = !data.following.has(hostId);
    void run(`follow:${hostId}`, async () => {
      await setFollow(me, hostId, on);
      setData((d) => {
        if (!d) return d;
        const following = new Set(d.following);
        if (on) following.add(hostId);
        else following.delete(hostId);
        const followers = { ...d.followers, [hostId]: Math.max(0, (d.followers[hostId] ?? 0) + (on ? 1 : -1)) };
        return { ...d, following, followers };
      });
    }, on ? `Following ${name}` : undefined);
  };

  const toggleReminder = (s: LiveSession) => {
    if (!me || !data) return;
    const on = !data.reminders.has(s.id);
    void run(`remind:${s.id}`, async () => {
      await setReminder(me, s.id, on);
      setData((d) => {
        if (!d) return d;
        const reminders = new Set(d.reminders);
        if (on) reminders.add(s.id);
        else reminders.delete(s.id);
        return { ...d, reminders };
      });
    }, on ? 'We’ll notify you when it starts' : 'Reminder removed');
  };

  const startNow = (s: LiveSession) => {
    if (!me) return;
    void run(`start:${s.id}`, async () => {
      await startScheduled(me, s);
      router.push({ pathname: '/live-room', params: { id: s.id } });
    });
  };

  const cancel = async (s: LiveSession, live: boolean) => {
    const ok = await confirmAction(live ? 'End live session?' : 'Cancel scheduled session?', live ? 'Listeners will be disconnected.' : 'People who asked to be notified won’t be told.', live ? 'End' : 'Cancel session');
    if (!ok) return;
    void run(`end:${s.id}`, async () => {
      await endSession(s.id);
      await load(true);
    }, live ? 'Live session ended' : 'Session cancelled');
  };

  if (!me || loading || error || !data) {
    return (
      <Screen top={4} gap={16} backdrop={backdrop}>
        <ScreenHeader title="Live" />
        {loading || !me ? <Loading /> : <ErrorState message={error ?? 'Could not load live sessions'} onRetry={() => void load()} />}
      </Screen>
    );
  }

  const live = data.live.filter((s) => isOnAir(s, now));
  const hosts = [...live].sort((a, b) => Number(data.following.has(b.host_id)) - Number(data.following.has(a.host_id)));
  const followedLive = hosts.filter((s) => data.following.has(s.host_id));
  const mine = data.mine;
  const nothing = !live.length && !data.upcoming.length && !data.replays.length && !mine;

  return (
    <Screen onRefresh={() => load(true)} top={4} gap={20} backdrop={backdrop}>
      <ScreenHeader
        title="Live"
        right={<Button label="Go live" icon="cast" height={36} href="/go-live" style={{ minWidth: 104 }} />}
      />

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.error} message={note.text} action="OK" onAction={() => setNote(null)} /> : null}

      {mine ? (
        <Glass padding={16}>
          <View style={{ gap: 12 }}>
            <Row>
              <LiveBadge label={isOnAir(mine, now) ? 'YOU’RE LIVE' : 'PAUSED'} />
              <T size={13} color={colors.textSecondary}>
                {`Started ${sinceShort(mine.started_at, now)} ago`}
              </T>
            </Row>
            <T size={20} weight={600} numberOfLines={2}>
              {mine.title}
            </T>
            {!isOnAir(mine, now) ? (
              <T size={14} color={colors.textSecondary}>
                Your session isn’t sending music. Open it to keep playing for listeners, or end it.
              </T>
            ) : null}
            <Row gap={8}>
              <Button label="Open" icon="play" height={44} style={{ flex: 1 }} onPress={() => router.push({ pathname: '/live-room', params: { id: mine.id } })} />
              <Button label={busy === `end:${mine.id}` ? 'Ending…' : 'End'} variant={busy ? 'disabled' : 'destructive'} height={44} style={{ flex: 1 }} onPress={() => void cancel(mine, true)} />
            </Row>
          </View>
        </Glass>
      ) : null}

      {nothing ? (
        <EmptyState icon="users" title="No one is live right now" body="Start a live listening session and play songs for your followers in sync." action="Go live" href="/go-live" />
      ) : null}

      {hosts.length ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title={followedLive.length ? 'Live now · people you follow' : 'Live now'} />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 14, paddingHorizontal: 16 }}>
            {hosts.map((s) => (
              <Tap
                key={s.id}
                onPress={() => router.push({ pathname: '/live-room', params: { id: s.id } })}
                accessibilityLabel={`${s.host?.display_name ?? 'Someone'} is live: ${s.title}`}
                style={{ alignItems: 'center', gap: 6, width: 72 }}
              >
                <HostAvatar p={s.host} size={60} ring />
                <T size={12} weight={500} numberOfLines={1}>
                  {s.host_id === me ? 'You' : s.host?.display_name ?? 'Someone'}
                </T>
              </Tap>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {live.length ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title="Live sessions" />
          {live.map((s) => {
            const followers = data.followers[s.host_id];
            const isMe = s.host_id === me;
            const following = data.following.has(s.host_id);
            const name = s.host?.display_name ?? 'Someone';
            return (
              <Tap key={s.id} onPress={() => router.push({ pathname: '/live-room', params: { id: s.id } })} accessibilityLabel={`Join ${s.title} by ${name}, ${s.listeners} listening`}>
                <Glass padding={14}>
                  <View style={{ gap: 12 }}>
                    <Row>
                      <HostAvatar p={s.host} size={40} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T size={15} weight={600} numberOfLines={1}>
                          {isMe ? 'You' : name}
                        </T>
                        {followers ? (
                          <T size={12} color={colors.textSecondary}>
                            {`${formatCount(followers)} follower${followers === 1 ? '' : 's'}`}
                          </T>
                        ) : null}
                      </View>
                      {isMe ? null : (
                        <Tap
                          onPress={() => toggleFollow(s.host_id, name)}
                          accessibilityLabel={following ? `Unfollow ${name}` : `Follow ${name}`}
                          accessibilityState={{ selected: following, busy: busy === `follow:${s.host_id}` }}
                          style={{ height: 44, justifyContent: 'center' }}
                        >
                          <ToggleBurst active={following}>
                            <View style={{ height: 32, paddingHorizontal: 14, borderRadius: 16, justifyContent: 'center', backgroundColor: following ? colors.chipGhost : colors.accent }}>
                              <T size={12} weight={700} color={colors.white}>
                                {following ? 'Following' : 'Follow'}
                              </T>
                            </View>
                          </ToggleBurst>
                        </Tap>
                      )}
                    </Row>
                    <T size={22} weight={300} tracking={-0.4} numberOfLines={2}>
                      {s.title}
                    </T>
                    <Row gap={10}>
                      <LiveBadge />
                      <T size={13} color={colors.textSecondary}>
                        {sinceShort(s.started_at, now)}
                      </T>
                      <View style={{ flex: 1 }} />
                      <Icon name="users" size={16} color={colors.textSecondary} />
                      <T size={13} weight={600}>
                        {formatCount(s.listeners)}
                      </T>
                    </Row>
                  </View>
                </Glass>
              </Tap>
            );
          })}
        </View>
      ) : null}

      {data.upcoming.length ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title="Upcoming" />
          <Glass padding={4}>
            {data.upcoming.map((s, i) => {
              const isMe = s.host_id === me;
              const reminded = data.reminders.has(s.id);
              const late = !!s.scheduled_at && new Date(s.scheduled_at).getTime() < now;
              return (
                <Row key={s.id} style={[{ minHeight: 72, paddingHorizontal: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                  <HostAvatar p={s.host} size={44} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={16} weight={500} numberOfLines={1}>
                      {s.title}
                    </T>
                    <T size={13} color={colors.textSecondary} numberOfLines={1}>
                      {`${isMe ? 'You' : s.host?.display_name ?? 'Someone'} · ${s.scheduled_at ? (late ? 'Starting soon' : formatWhen(s.scheduled_at)) : ''}`}
                    </T>
                  </View>
                  {isMe ? (
                    <Row gap={4}>
                      <Button label={busy === `start:${s.id}` ? '…' : 'Start'} height={36} variant={busy ? 'disabled' : 'primary'} onPress={() => startNow(s)} />
                      <Tap onPress={() => void cancel(s, false)} accessibilityLabel={`Cancel ${s.title}`} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="close" size={20} color={colors.textSecondary} />
                      </Tap>
                    </Row>
                  ) : (
                    <Tap
                      onPress={() => toggleReminder(s)}
                      accessibilityLabel={reminded ? `Stop reminder for ${s.title}` : `Notify me when ${s.title} starts`}
                      accessibilityState={{ selected: reminded, busy: busy === `remind:${s.id}` }}
                      style={{ height: 44, justifyContent: 'center' }}
                    >
                      <Row gap={6} style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: reminded ? colors.accent : withAlpha(colors.white, 0.14), backgroundColor: reminded ? colors.accentTint : undefined }}>
                        <Icon name="bell" size={14} color={reminded ? colors.accentLight : colors.text} filled={reminded} />
                        <T size={12} weight={600}>
                          {reminded ? 'Notifying' : 'Notify me'}
                        </T>
                      </Row>
                    </Tap>
                  )}
                </Row>
              );
            })}
          </Glass>
        </View>
      ) : null}

      {data.replays.length ? (
        <View style={{ gap: 12 }}>
          <SectionHeader title="Replays" />
          <Glass padding={4}>
            {data.replays.map((s, i) => {
              const exp = replayExpiresAt(s);
              const daysLeft = exp ? Math.max(0, Math.ceil((exp.getTime() - now) / 86_400_000)) : 0;
              return (
                <Tap key={s.id} onPress={() => router.push({ pathname: '/live-room', params: { id: s.id } })} accessibilityLabel={`Replay ${s.title}`}>
                  <Row style={[{ minHeight: 72, paddingHorizontal: 10 }, i > 0 && { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                    <HostAvatar p={s.host} size={44} />
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <T size={16} weight={500} numberOfLines={1}>
                        {s.title}
                      </T>
                      <T size={13} color={colors.textSecondary} numberOfLines={1}>
                        {`${s.host_id === me ? 'You' : s.host?.display_name ?? 'Someone'} · ${s.trackCount} song${s.trackCount === 1 ? '' : 's'} · ${daysLeft}d left`}
                      </T>
                    </View>
                    <Icon name="chevronRight" size={18} color={colors.textSecondary} />
                  </Row>
                </Tap>
              );
            })}
          </Glass>
        </View>
      ) : null}
    </Screen>
  );
}
