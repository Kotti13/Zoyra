import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Cover, EmptyState, ErrorState, Glass, Gradient, Icon, IconButton, Loading, Row, Screen, ScreenHeader, T, Tap, Toast, ToggleBurst, Button } from '../components';
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
    { x: 0.5, y: 0, color: colors.indigo, opacity: 0.34, stop: 0.55 },
    { x: 0, y: 0.6, color: colors.accent, opacity: 0.22, stop: 0.55 },
  ],
};

function Heading({ children }: { children: string }) {
  return (
    <T size={19} weight={500} tracking={-0.2} accessibilityRole="header">
      {children}
    </T>
  );
}

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
      <Row style={{ justifyContent: 'space-between', minHeight: 44 }}>
        <IconButton icon="back" label="Back" href="back" />
        <Tap
          href="/go-live"
          accessibilityLabel="Go live"
          style={{ height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', gap: 8, shadowColor: colors.accent, shadowOpacity: 0.4, shadowRadius: 13, shadowOffset: { width: 0, height: 0 } }}
        >
          <Icon name="cast" size={18} color={colors.white} />
          <T size={14} weight={700} color={colors.white}>
            Go live
          </T>
        </Tap>
      </Row>
      <T size={36} weight={300} tracking={-1} accessibilityRole="header">
        Live <T size={36} weight={800} tracking={-1}>now</T>
      </T>

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
          <Heading>{followedLive.length ? 'Your artists' : 'Live now'}</Heading>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {hosts.map((s) => (
              <Tap
                key={s.id}
                onPress={() => router.push({ pathname: '/live-room', params: { id: s.id } })}
                accessibilityLabel={`${s.host?.display_name ?? 'Someone'} is live: ${s.title}`}
                style={{ alignItems: 'center', gap: 6, width: 62 }}
              >
                <View>
                  <HostAvatar p={s.host} size={58} />
                  <View style={{ position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, borderRadius: 7, backgroundColor: colors.success, borderWidth: 2.5, borderColor: colors.bg }} />
                </View>
                <T size={11} color={colors.peach} numberOfLines={1}>
                  {s.host_id === me ? 'You' : s.host?.display_name ?? 'Someone'}
                </T>
              </Tap>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {live.length ? (
        <View style={{ gap: 12 }}>
          <Heading>Live sessions</Heading>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
            {live.map((s) => {
              const followers = data.followers[s.host_id];
              const isMe = s.host_id === me;
              const following = data.following.has(s.host_id);
              const name = s.host?.display_name ?? 'Someone';
              return (
                <Tap key={s.id} onPress={() => router.push({ pathname: '/live-room', params: { id: s.id } })} accessibilityLabel={`Join ${s.title} by ${name}, ${s.listeners} listening`} style={{ width: 246 }}>
                  <View style={{ width: 246, height: 330, borderRadius: 30, overflow: 'hidden', backgroundColor: colors.bgTertiary }}>
                    <Cover uri={s.host?.avatar_url} id={s.host?.id ?? s.id} width={246} height={330} radius={0} />
                    <Gradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.9)]} angle={180} style={StyleSheet.absoluteFill} />
                    <Row gap={8} style={{ position: 'absolute', top: 12, left: 12, right: 12, height: 46, borderRadius: 23, paddingHorizontal: 6, backgroundColor: withAlpha(colors.white, 0.14), borderWidth: 1, borderColor: withAlpha(colors.white, 0.2) }}>
                      <HostAvatar p={s.host} size={34} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T size={12} weight={600} numberOfLines={1}>
                          {isMe ? 'You' : name}
                        </T>
                        {followers ? (
                          <T size={10} color={colors.peach} numberOfLines={1}>
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
                            <View style={{ height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: 'center', backgroundColor: withAlpha(colors.white, 0.2) }}>
                              <T size={12} weight={700}>
                                {following ? 'Following' : 'Follow'}
                              </T>
                            </View>
                          </ToggleBurst>
                        </Tap>
                      )}
                    </Row>
                    <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16, gap: 10 }}>
                      <T size={30} weight={800} tracking={-1} lineHeight={30} numberOfLines={3} style={{ textTransform: 'uppercase' }}>
                        {s.title}
                      </T>
                      <Row gap={8}>
                        <LiveBadge />
                        <T size={12}>{sinceShort(s.started_at, now)}</T>
                        <View style={{ flex: 1 }} />
                        <Icon name="users" size={14} color={colors.text} />
                        <T size={12} weight={700}>
                          {formatCount(s.listeners)}
                        </T>
                      </Row>
                    </View>
                  </View>
                </Tap>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {data.upcoming.length ? (
        <View style={{ gap: 12 }}>
          <Heading>Upcoming</Heading>
          <View style={{ gap: 10 }}>
            {data.upcoming.map((s) => {
              const isMe = s.host_id === me;
              const reminded = data.reminders.has(s.id);
              const late = !!s.scheduled_at && new Date(s.scheduled_at).getTime() < now;
              return (
                <Glass key={s.id} padding={12}>
                <Row gap={14}>
                  <HostAvatar p={s.host} size={52} />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <T size={15} weight={600} numberOfLines={1}>
                      {s.title}
                    </T>
                    <T size={12} color={colors.textSecondary} numberOfLines={1}>
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
                </Glass>
              );
            })}
          </View>
        </View>
      ) : null}

      {data.replays.length ? (
        <View style={{ gap: 12 }}>
          <Heading>Replays</Heading>
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
