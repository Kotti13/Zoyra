import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, ScrollView, View } from 'react-native';
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
import { colors } from '../theme/tokens';

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
  }, [user?.id]);
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

  const targets: { label: string; icon: IconName; onPress: () => void }[] = [
    { label: 'Share via…', icon: 'share', onPress: () => void systemShare() },
    {
      label: 'Copy link',
      icon: 'link',
      onPress: () => {
        Clipboard.setStringAsync(url)
          .then(() => setNote({ message: 'Link copied' }))
          .catch(() => setNote({ message: 'Could not copy the link', error: true }));
      },
    },
    { label: 'QR code', icon: 'qr', onPress: () => setShowQr((v) => !v) },
    { label: 'Nearby', icon: 'broadcast', onPress: () => router.push('/nearby-share') },
    { label: 'WhatsApp', icon: 'phone', onPress: () => void openOr(`whatsapp://send?text=${encodeURIComponent(`${text}\n${url}`)}`) },
    { label: 'X', icon: 'share', onPress: () => void openOr(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`) },
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
      <T variant="section" accessibilityRole="header">
        Share
      </T>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 26, backgroundColor: colors.divider }}>
        <Cover artwork={track.artwork} id={track.id} size={56} radius={28} />
        <View style={{ gap: 2, flex: 1, minWidth: 0 }}>
          <T size={16} weight={600} numberOfLines={1}>
            {track.title}
          </T>
          <T size={14} color={colors.textSecondary} numberOfLines={1}>
            {track.artist.name}
          </T>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16 }}>
        {targets.map((t) => (
          <Tap key={t.label} onPress={t.onPress} accessibilityLabel={t.label === 'Share via…' ? 'Share with another app' : `Share to ${t.label}`} style={{ width: '25%', alignItems: 'center', gap: 6, paddingHorizontal: 4 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.iconGhost, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={t.icon} size={24} color={colors.accentLight} />
            </View>
            <T size={12} align="center">
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

      {/* Send to a friend */}
      <T size={12} weight={600} tracking={0.5} color={colors.textSecondary} style={{ marginTop: 4 }}>
        SEND TO A FRIEND
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
                style={{ width: 72, alignItems: 'center', gap: 6, opacity: sending && sending !== f.id ? 0.5 : 1 }}
              >
                <View>
                  {f.avatar_url ? (
                    <Cover uri={f.avatar_url} id={f.id} size={56} radius={28} />
                  ) : (
                    <Avatar initial={f.display_name.slice(0, 1).toUpperCase()} art={artFor(f.id)} size={56} />
                  )}
                  {done || sending === f.id ? (
                    <View style={{ position: 'absolute', right: -2, bottom: -2, width: 22, height: 22, borderRadius: 11, backgroundColor: done ? colors.success : colors.accent, alignItems: 'center', justifyContent: 'center' }}>
                      <Icon name={done ? 'check' : 'share'} size={12} color={colors.onAccent} />
                    </View>
                  ) : null}
                </View>
                <T size={12} align="center" numberOfLines={1}>
                  {f.display_name}
                </T>
              </Tap>
            );
          })}
        </ScrollView>
      )}

      {note ? <Toast icon={note.error ? 'info' : 'check'} iconColor={note.error ? colors.accentLight : colors.success} message={note.message} /> : null}
    </Sheet>
  );
}
