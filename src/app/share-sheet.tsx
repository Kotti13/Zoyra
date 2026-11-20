import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { LinearGradient } from 'expo-linear-gradient';
import { Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Avatar, Cover, EmptyState, ErrorState, Icon, Loading, Sheet, T, Tap, Toast, artFor, useAsync, type IconName } from '../components';
import { catalog } from '../lib/catalog';
import { shareContent, trackShareUrl } from '../lib/share-links';
import { sendMessage } from '../lib/chat';
import { isSetupRequired, routeIfSetupRequired } from '../lib/chat-e2ee';
import { startChat } from '../lib/dm';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { usePlayerPick } from '../state/player';
import { useSheetTrack } from '../state/selection';
import { colors, withAlpha } from '../theme/tokens';

type Friend = { id: string; display_name: string; username: string | null; avatar_url: string | null };
type Note = { message: string; error?: boolean };

/** Song-share errors in plain words (server hints: locked / song_shares_off / blocked). */
function shareError(e: unknown, name: string, fallback: string): string {
  const hint = (e as { hint?: unknown } | null)?.hint;
  if (hint === 'locked') return `${name} isn't accepting messages from you right now.`;
  if (hint === 'song_shares_off') return `${name} only gets songs from people they chat with. Send them a message first.`;
  if (hint === 'blocked') return `You can't send songs to ${name}.`;
  return friendlySocialError(e, fallback);
}

export default function ShareSheet() {
  const player = usePlayerPick('track');
  const track = useSheetTrack(player.track);
  const { user } = useAuth();
  const [note, setNote] = useState<Note | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 2600);
    return () => clearTimeout(id);
  }, [note]);

  const friends = useAsync(async (): Promise<Friend[]> => {
    if (!user) return [];
    const f = await supabase.from('follows').select('following_id').eq('follower_id', user.id).order('created_at', { ascending: false });
    if (f.error) throw new Error(f.error.message);
    const ids = (f.data ?? []).map((r) => r.following_id as string);
    if (!ids.length) return [];
    const p = await supabase.from('profiles').select('id, display_name, username, avatar_url').in('id', ids);
    if (p.error) throw new Error(p.error.message);
    const byId = new Map((p.data as Friend[]).map((x) => [x.id, x]));
    return ids.map((id) => byId.get(id)).filter((x): x is Friend => !!x);
  }, [user?.id], 'app/share-sheet:48');
  // People you blocked aren't offered as recipients.
  const { blocked } = useBlocks(user?.id);
  const recipients = friends.data?.filter((f) => !blocked.has(f.id));

  if (!track) {
    return (
      <Sheet>
        <EmptyState title="Nothing to share" body="Play or pick a song to share it." />
      </Sheet>
    );
  }

  // Rich https share link (preview card + opens the app); device-only songs fall back to the source page.
  const url = trackShareUrl(track) ?? catalog.shareUrl(track);
  const text = `${track.title} by ${track.artist.name} — listen on Zoyra`;

  const systemShare = async () => {
    try {
      await shareContent({ url, title: track.title, message: text });
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not open sharing', error: true });
    }
  };

  const openOr = async (link: string) => {
    try {
      await Linking.openURL(link);
    } catch {
      await systemShare();
    }
  };

  const targets: { label: string; icon: IconName; bg: string | readonly [string, string]; onPress: () => void }[] = [
    { label: 'Lyrics card', icon: 'image', bg: ['#FF8A3D', '#E50914'], onPress: () => router.push('/lyrics-share') },
    { label: 'WhatsApp', icon: 'chat', bg: '#1FBF8F', onPress: () => void openOr(`whatsapp://send?text=${encodeURIComponent(`${text}\n${url}`)}`) },
    { label: 'X', icon: 'share', bg: ['#8A4BFF', '#E50914'], onPress: () => void openOr(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`) },
    { label: 'Messages', icon: 'mail', bg: '#2B6BFF', onPress: () => void openOr(`sms:${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(`${text} ${url}`)}`) },
    {
      label: 'Copy link',
      icon: 'link',
      bg: 'rgba(255,255,255,0.14)',
      onPress: () => {
        Clipboard.setStringAsync(url)
          .then(() => setNote({ message: 'Link copied' }))
          .catch(() => setNote({ message: 'Could not copy the link', error: true }));
      },
    },
    { label: 'QR code', icon: 'qr', bg: 'rgba(255,255,255,0.14)', onPress: () => setShowQr((v) => !v) },
    { label: 'Nearby', icon: 'broadcast', bg: 'rgba(255,255,255,0.14)', onPress: () => router.push('/nearby-share') },
    { label: 'More', icon: 'more', bg: 'rgba(255,255,255,0.14)', onPress: () => void systemShare() },
  ];

  const sendTo = async (f: Friend) => {
    if (!user || sending) return;
    setSending(f.id);
    try {
      let chat: { id: string; request: boolean };
      try {
        chat = await startChat(f.id);
      } catch (e) {
        throw new Error(shareError(e, f.display_name, 'Could not start a conversation'));
      }
      // End-to-end encrypted when both of you have keys (plaintext only for contacts without E2EE yet).
      try {
        await sendMessage(chat.id, user.id, { body: '', track, kind: 'track' });
      } catch (e) {
        if (isSetupRequired(e)) {
          routeIfSetupRequired(e); // "Restore" picked on the one-time prompt (or cancelled)
          throw new Error(e.route ? 'Restore your chats, then share again.' : 'Not sent');
        }
        throw new Error(shareError(e, f.display_name, 'Could not send the song'));
      }
      setSent((s) => new Set(s).add(f.id));
      setNote({ message: chat.request ? `Sent as a request to ${f.display_name}` : `Sent to ${f.display_name}` });
    } catch (e) {
      setNote({ message: e instanceof Error ? e.message : 'Could not send the song', error: true });
    } finally {
      setSending(null);
    }
  };

  return (
    <Sheet>
      <T size={18} weight={600} accessibilityRole="header">
        Share
      </T>

      <View style={{ borderRadius: 26, borderWidth: 1, borderColor: withAlpha(colors.white, 0.14), overflow: 'hidden' }}>
        <LinearGradient colors={[withAlpha(colors.accent, 0.3), 'rgba(20,20,20,0.6)']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12 }}>
          <Cover artwork={track.artwork} id={track.id} size={64} radius={20} />
          <View style={{ gap: 3, flex: 1, minWidth: 0 }}>
            <T size={16} weight={700} numberOfLines={1}>
              {track.title}
            </T>
            <T size={13} color={colors.accentLight} numberOfLines={1}>
              {track.artist.name}
            </T>
          </View>
        </View>
      </View>

      {/* Send to a friend */}
      <T size={11} weight={700} tracking={1.4} color={colors.textSecondary} style={{ marginTop: 2, marginLeft: 4 }}>
        SEND TO FRIENDS
      </T>
      {!user ? (
        <T size={14} color={colors.textSecondary}>
          Sign in to send songs to friends.
        </T>
      ) : friends.loading ? (
        <Loading height={88} />
      ) : friends.error ? (
        <ErrorState message={friends.error} onRetry={friends.reload} />
      ) : !recipients?.length ? (
        <T size={14} color={colors.textSecondary}>
          Follow people to send them songs directly.
        </T>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
          {recipients.map((f) => {
            const done = sent.has(f.id);
            return (
              <Tap
                key={f.id}
                onPress={done ? undefined : () => void sendTo(f)}
                accessibilityLabel={done ? `Sent to ${f.display_name}` : `Send to ${f.display_name}`}
                style={{ width: 62, alignItems: 'center', gap: 6, opacity: sending && sending !== f.id ? 0.5 : 1 }}
              >
                <View>
                  {f.avatar_url ? (
                    <Cover uri={f.avatar_url} id={f.id} size={52} radius={17} />
                  ) : (
                    <Avatar initial={f.display_name.slice(0, 1).toUpperCase()} art={artFor(f.id)} size={52} radius={17} />
                  )}
                  {done || sending === f.id ? (
                    <View style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: done ? colors.success : colors.accent, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name={done ? 'check' : 'share'} size={12} color={colors.onAccent} />
                    </View>
                  ) : null}
                </View>
                <T size={11} align="center" numberOfLines={1}>
                  {f.display_name}
                </T>
              </Tap>
            );
          })}
        </ScrollView>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 14 }}>
        {targets.map((t) => (
          <Tap key={t.label} onPress={t.onPress} accessibilityLabel={t.label === 'More' ? 'Share with another app' : `Share to ${t.label}`} style={{ width: '25%', alignItems: 'center', gap: 6, paddingHorizontal: 2 }}>
            <View style={{ width: 54, height: 54, borderRadius: 19, overflow: 'hidden', backgroundColor: typeof t.bg === 'string' ? t.bg : undefined, alignItems: 'center', justifyContent: 'center' }}>
              {typeof t.bg === 'string' ? null : <LinearGradient colors={t.bg} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />}
              <Icon name={t.icon} size={24} color={colors.white} />
            </View>
            <T size={11} align="center" numberOfLines={1}>
              {t.label}
            </T>
          </Tap>
        ))}
      </View>

      {showQr ? (
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ width: 168, height: 168, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`QR code linking to ${track.title}`}>
            <QRCode value={url} size={144} color={colors.bg} backgroundColor={colors.white} ecl="M" />
          </View>
          <T size={12} color={colors.textSecondary}>
            Scan to open this song
          </T>
        </View>
      ) : null}

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}
    </Sheet>
  );
}
