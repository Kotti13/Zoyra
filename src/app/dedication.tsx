import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Cover, EmptyState, ErrorState, Glass, Gradient, Icon, Loading, Row, Screen, ScreenHeader, SongPicker, Spacer, Sticker, T, Tap, TextField, Toast, go, useAsync } from '../components';
import { catalog, type CatalogTrack } from '../lib/catalog';
import { friendlySocialError, useBlocks } from '../lib/social';
import { sendMessage } from '../lib/chat';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

type Person = { id: string; display_name: string; avatar_url: string | null };

const firstName = (n: string) => n.split(' ')[0] ?? n;

export default function Dedication() {
  const { user: userParam, track: trackParam } = useLocalSearchParams<{ user?: string; track?: string }>();
  const trackId = typeof trackParam === 'string' && trackParam ? trackParam : null;
  const { user } = useAuth();
  const me = user?.id;
  const player = usePlayerPick('track');
  // Default song: the sheet's track (song options → Dedicate), else what's playing. Frozen on open so a
  // track change in the player doesn't swap the song under you; the user can always change it below.
  const sheetOrPlaying = useSheetTrack(player.track);
  const [fallbackTrack] = useState<CatalogTrack | null>(sheetOrPlaying);
  // `?track=<id>` wins over the fallback.
  const paramTrack = useAsync<CatalogTrack | null>(() => (trackId ? catalog.track(trackId) : Promise.resolve(null)), [trackId]);
  const [picked, setPicked] = useState<CatalogTrack | null>(null);
  const track = picked ?? (trackId ? (paramTrack.data ?? null) : fallbackTrack);
  const trackLoading = !picked && !!trackId && paramTrack.loading;
  const [picking, setPicking] = useState(false);
  const showPicker = picking || (!track && !trackLoading);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [to, setTo] = useState<string | null>(typeof userParam === 'string' && userParam ? userParam : null);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const { blocked } = useBlocks(me);

  const people = useAsync<Person[]>(async () => {
    if (!me) return [];
    const { data, error } = await supabase.from('follows').select('following:profiles!follows_following_id_fkey(id, display_name, avatar_url)').eq('follower_id', me);
    if (error) throw new Error(error.message);
    const list = (data as unknown as { following: Person | null }[]).map((r) => r.following).filter((p): p is Person => !!p);
    // A recipient passed by param who isn't in the follow list (e.g. a follower) still gets shown.
    const pid = typeof userParam === 'string' ? userParam : undefined;
    if (pid && !list.some((p) => p.id === pid)) {
      const { data: extra } = await supabase.from('profiles').select('id, display_name, avatar_url').eq('id', pid).maybeSingle();
      if (extra) list.unshift(extra as Person);
    }
    return list;
  }, [me, userParam]);

  // People you blocked can't receive dedications, so they aren't offered.
  const choices = people.data?.filter((p) => !blocked.has(p.id));
  // No explicit pick yet: the first person (the `user` param is listed first) is preselected.
  const recipient = (to ? choices?.find((p) => p.id === to) : choices?.[0]) ?? null;

  const send = async () => {
    if (!me || !recipient || !track || sending || sent) return;
    setSending(true);
    setToast(null);
    try {
      const text = message.trim();
      const ded = await supabase.from('dedications').insert({ sender_id: me, recipient_id: recipient.id, track, message: text });
      if (ded.error) throw new Error(friendlySocialError(ded.error, 'Could not send dedication'));
      // The dedication itself is saved; the chat copy can still be refused (their message privacy, a block).
      setSent(true);
      const conv = await supabase.rpc('start_conversation', { other: recipient.id });
      // Chat copy goes through sendMessage: end-to-end encrypted when both of you have keys.
      let msgError: unknown = null;
      if (!conv.error && conv.data) {
        try {
          await sendMessage(String(conv.data), me, { body: text || 'Dedicated a song to you', track, kind: 'text' });
        } catch (e) {
          msgError = e;
        }
      }
      const chatError = conv.error || !conv.data ? conv.error : msgError;
      if (chatError || !conv.data) {
        setToast({ ok: false, text: `Dedication sent, but not added to your chat: ${friendlySocialError(chatError, 'could not reach the conversation')}` });
        setTimeout(() => go('back'), 3200);
        return;
      }
      setToast({ ok: true, text: `Dedicated to ${recipient.display_name}` });
      setTimeout(() => go('back'), 1200);
    } catch (e) {
      setToast({ ok: false, text: e instanceof Error ? e.message : 'Could not send dedication' });
      setSending(false);
    }
  };

  const toLabel = recipient ? firstName(recipient.display_name) : 'someone';

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'amberRose' }} contentStyle={{ flexGrow: 1 }}>
      <ScreenHeader title="Dedicate a song" />

      {/* Dedication card */}
      <View
        style={{
          transform: [{ rotate: '-2deg' }],
          borderRadius: 36,
          shadowColor: colors.shadow,
          shadowOpacity: 0.35,
          shadowRadius: 0,
          shadowOffset: { width: 0, height: 6 },
          elevation: 6,
          marginTop: 4,
        }}
      >
        <Gradient colors={[colors.accent, colors.like]} style={{ borderRadius: 36, padding: 20, gap: 14 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <Sticker label={`FOR ${toLabel.toUpperCase()}`} rotate={3} />
            <Icon name="heart" size={24} color={colors.onAccent} />
          </Row>
          <Tap
            onPress={() => setPicking((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={track ? `Song: ${track.title} by ${track.artist.name}. Change song` : 'Choose a song'}
            accessibilityState={{ expanded: showPicker }}
            style={{ minHeight: 72 }}
          >
            <Row gap={12}>
              <Cover
                artwork={track?.artwork}
                id={track?.id}
                size={72}
                radius={32}
                style={{ alignItems: 'center', justifyContent: 'center', shadowColor: colors.shadow, shadowOpacity: 0.3, shadowRadius: 0, shadowOffset: { width: 0, height: 4 }, elevation: 4 }}
              >
                {track ? null : <Icon name="music" size={28} color={colors.onAccent} />}
              </Cover>
              <View style={{ gap: 2, flex: 1 }}>
                <T size={20} weight={700} color={colors.onAccent} numberOfLines={1}>
                  {trackLoading ? 'Loading song…' : (track?.title ?? 'No song selected')}
                </T>
                <T size={14} color={colors.onAccent} numberOfLines={1}>
                  {track?.artist.name ?? (trackLoading ? ' ' : 'Tap to choose a song')}
                </T>
              </View>
              <View style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: withAlpha(colors.black, 0.28), flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Icon name={track ? 'edit' : 'search'} size={14} color={colors.onAccent} />
                <T size={12} weight={700} color={colors.onAccent}>
                  {track ? 'Change' : 'Choose'}
                </T>
              </View>
            </Row>
          </Tap>
          <T size={17} weight={500} lineHeight={24} color={colors.onAccent} style={message ? undefined : { opacity: 0.6 }}>
            {message || 'Add a few words…'}
          </T>
        </Gradient>
      </View>

      {showPicker ? (
        <Glass padding={12} style={{ gap: 10 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T size={12} weight={600} tracking={0.5} color={colors.textSecondary}>
              {track ? 'CHANGE SONG' : 'CHOOSE A SONG'}
            </T>
            {track ? (
              <Tap onPress={() => setPicking(false)} accessibilityRole="button" accessibilityLabel="Done choosing a song" style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' }}>
                <T size={14} weight={600} color={colors.accentLight}>
                  Done
                </T>
              </Tap>
            ) : null}
          </Row>
          {paramTrack.error && !picked ? (
            <T size={13} color={colors.error}>
              Could not load that song. Pick one below.
            </T>
          ) : null}
          <SongPicker
            selectedId={track?.id}
            maxHeight={320}
            onPick={(t) => {
              setPicked(t);
              setPicking(false);
            }}
          />
        </Glass>
      ) : null}

      <TextField label="Message" placeholder="Say something" value={message} onChangeText={setMessage} maxLength={280} style={{ marginTop: 8 }} />

      <T size={12} weight={600} tracking={0.5} color={colors.textSecondary}>
        SEND TO
      </T>
      {people.loading ? (
        <Loading height={84} />
      ) : people.error ? (
        <ErrorState message={people.error} onRetry={people.reload} />
      ) : !choices?.length ? (
        <EmptyState icon="users" title="No one to send to yet" body="Follow friends to dedicate songs to them." action="Find people" href="/followers" />
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
          {choices.map((p) => {
            const on = p.id === recipient?.id;
            return (
              <Tap
                key={p.id}
                onPress={() => setTo(p.id)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={p.display_name}
                style={{ width: 64, alignItems: 'center', gap: 6 }}
              >
                <View style={{ padding: 3, borderRadius: 30, backgroundColor: on ? colors.accent : 'transparent' }}>
                  <Cover uri={p.avatar_url} id={p.id} size={52} radius={26} style={{ alignItems: 'center', justifyContent: 'center' }}>
                    {p.avatar_url ? null : (
                      <T size={17} weight={600} color={colors.white}>
                        {(p.display_name[0] ?? '?').toUpperCase()}
                      </T>
                    )}
                  </Cover>
                </View>
                <T size={12} color={colors.textSecondary} numberOfLines={1}>
                  {firstName(p.display_name)}
                </T>
              </Tap>
            );
          })}
        </ScrollView>
      )}

      <Spacer />

      {toast ? <Toast icon={toast.ok ? 'check' : 'info'} iconColor={toast.ok ? colors.success : colors.error} message={toast.text} /> : null}

      <Button
        label={sent ? 'Sent' : sending ? 'Sending…' : !track ? 'Choose a song' : !recipient ? 'Choose who to send to' : 'Send dedication'}
        icon="heart"
        variant={track && recipient && !sending && !sent ? 'primary' : 'disabled'}
        onPress={() => void send()}
      />
    </Screen>
  );
}
