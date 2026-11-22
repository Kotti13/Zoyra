import { router, useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Avatar, Button, Cover, EmptyState, ErrorState, Glass, Icon, LinkText, ListRow, Loading, Row, Screen, ScreenHeader, Spacer, T, Toast, go, useAsync } from '../components';
import type { CatalogTrack } from '../lib/catalog';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors, shadow } from '../theme/tokens';
import { inviteShareUrl, shareContent } from '../lib/share-links';

type Owner = { id: string; display_name: string; avatar_url: string | null };
type PlaylistInfo = {
  id: string;
  owner_id: string;
  title: string;
  cover_url: string | null;
  visibility: 'public' | 'private' | 'collaborative';
  owner: Owner | null;
  trackCount: number;
  collaborators: string[];
  firstTrack: CatalogTrack | null;
};

const firstName = (n: string) => n.split(' ')[0] ?? n;

export default function Invite() {
  const { playlist: rawId } = useLocalSearchParams<{ playlist?: string }>();
  const id = typeof rawId === 'string' && rawId ? rawId : undefined;
  const { user } = useAuth();
  const me = user?.id;
  const { playlists } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [showQr, setShowQr] = useState(false);

  const res = useAsync<PlaylistInfo | null>(async () => {
    if (!id) return null;
    const p = await supabase.from('playlists').select('id, owner_id, title, cover_url, visibility, owner:profiles!playlists_owner_id_fkey(id, display_name, avatar_url)').eq('id', id).maybeSingle();
    if (p.error) throw new Error(p.error.message);
    if (!p.data) return null;
    const [count, collabs, first] = await Promise.all([
      supabase.from('playlist_tracks').select('id', { count: 'exact', head: true }).eq('playlist_id', id),
      supabase.from('playlist_collaborators').select('user_id').eq('playlist_id', id),
      supabase.from('playlist_tracks').select('track').eq('playlist_id', id).order('position').limit(1),
    ]);
    const row = p.data as unknown as Omit<PlaylistInfo, 'trackCount' | 'collaborators' | 'firstTrack'>;
    return {
      ...row,
      trackCount: count.count ?? 0,
      collaborators: ((collabs.data ?? []) as { user_id: string }[]).map((c) => c.user_id),
      firstTrack: ((first.data ?? []) as { track: CatalogTrack }[])[0]?.track ?? null,
    };
  }, [id]);

  const pl = res.data;
  const isOwner = !!pl && pl.owner_id === me;
  const isCollaborator = !!pl && !!me && pl.collaborators.includes(me);
  const link = id ? `zoyra://invite?playlist=${id}` : '';

  /** Invitees can only open playlists that aren't private; inviting makes it collaborative. */
  const ensureCollaborative = async () => {
    if (!pl) return false;
    if (pl.visibility === 'collaborative') return true;
    setBusy(true);
    const { error } = await supabase.from('playlists').update({ visibility: 'collaborative' }).eq('id', pl.id);
    setBusy(false);
    if (error) {
      setToast({ ok: false, text: error.message });
      return false;
    }
    return true;
  };

  const toggleQr = async () => {
    if (showQr) {
      setShowQr(false);
      return;
    }
    if (!(await ensureCollaborative())) return;
    setShowQr(true);
    if (pl?.visibility !== 'collaborative') res.reload();
  };

  const shareInvite = async () => {
    if (!pl) return;
    if (!(await ensureCollaborative())) return;
    await shareContent({ url: inviteShareUrl(pl.id), title: pl.title }).catch(() => undefined);
    res.reload();
  };

  const copyCode = async () => {
    if (!pl) return;
    await Clipboard.setStringAsync(link);
    setToast({ ok: true, text: 'Invite link copied' });
  };

  const accept = async () => {
    if (!pl || !me) return;
    setBusy(true);
    const { error } = await supabase.from('playlist_collaborators').insert({ playlist_id: pl.id, user_id: me });
    setBusy(false);
    if (error && error.code !== '23505') {
      setToast({ ok: false, text: error.message });
      return;
    }
    router.replace({ pathname: '/playlist', params: { id: pl.id } });
  };

  const backdrop = {
    pattern: 'lines' as const,
    mesh: 'none' as const,
    glows: [
      { x: 1, y: 0, color: colors.amber, opacity: 0.28 },
      { x: 0, y: 0.3, color: colors.violet, opacity: 0.2 },
    ],
  };

  if (!id) {
    const mine = playlists.filter((p) => p.owner_id === me);
    return (
      <Screen top={4} gap={20} backdrop={backdrop}>
        <ScreenHeader title="Invite to a playlist" />
        {mine.length === 0 ? (
          <EmptyState icon="music" title="No playlists yet" body="Create a playlist, then invite friends to build it with you." action="Create playlist" href="/create-playlist" />
        ) : (
          <Glass padding={4}>
            {mine.map((p, i) => (
              <ListRow key={p.id} divider={i > 0} icon="users" title={p.title} subtitle={p.visibility === 'collaborative' ? 'Collaborative' : 'Make collaborative'} onPress={() => router.setParams({ playlist: p.id })} />
            ))}
          </Glass>
        )}
      </Screen>
    );
  }

  if (res.loading || res.error || !pl) {
    return (
      <Screen top={4} gap={20} backdrop={backdrop}>
        <ScreenHeader />
        {res.loading ? (
          <Loading />
        ) : res.error ? (
          <ErrorState message={res.error} onRetry={res.reload} />
        ) : (
          <EmptyState icon="music" title="Invite unavailable" body="This playlist doesn't exist or is private." action="Go home" onAction={() => router.replace('/')} />
        )}
      </Screen>
    );
  }

  const ownerName = pl.owner?.display_name ?? 'Someone';
  const collabCount = pl.collaborators.length;

  return (
    <Screen top={4} gap={20} contentStyle={{ flexGrow: 1 }} backdrop={backdrop}>
      <ScreenHeader />

      <View style={{ alignItems: 'center', gap: 12 }}>
        {pl.owner?.avatar_url ? (
          <Cover uri={pl.owner.avatar_url} id={pl.owner.id} size={56} radius={19} />
        ) : (
          <Avatar initial={(ownerName[0] ?? '?').toUpperCase()} art="rose" size={56} radius={19} />
        )}
        <T size={16} color={colors.peach} align="center">
          {isOwner ? 'Invite friends to build this playlist' : `${firstName(ownerName)} invited you to a playlist`}
        </T>
      </View>

      <View style={{ alignItems: 'center' }}>
        <View style={[{ borderRadius: 26 }, shadow.artGlow, { shadowColor: colors.accent, shadowOpacity: 0.3, shadowRadius: 40, shadowOffset: { width: 0, height: 8 } }]}>
          <Cover uri={pl.cover_url} artwork={pl.firstTrack?.artwork} id={pl.id} size={220} radius={26} />
        </View>
      </View>

      <View style={{ alignItems: 'center', gap: 6 }}>
        <T variant="display" align="center" accessibilityRole="header">
          {pl.title}
        </T>
        <T mono size={12} color={colors.textSecondary}>
          {pl.trackCount} {pl.trackCount === 1 ? 'song' : 'songs'} · {collabCount} {collabCount === 1 ? 'collaborator' : 'collaborators'}
        </T>
      </View>

      <Glass padding={16}>
        <Row gap={12} align="flex-start">
          <Icon name="users" size={22} color={colors.accentLight} />
          <T size={14} lineHeight={20} color={colors.textSecondary} style={{ flex: 1 }}>
            Collaborators can add, remove and reorder songs. You can leave any time.
          </T>
        </Row>
      </Glass>

      <Spacer />

      {isOwner && showQr ? (
        <View style={{ alignItems: 'center', gap: 6 }}>
          <View style={{ width: 168, height: 168, padding: 12, borderRadius: 26, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="QR code of the invite link">
            <QRCode value={link} size={144} color={colors.bg} backgroundColor={colors.white} ecl="M" />
          </View>
          <T size={12} tracking={0.2} color={colors.textSecondary}>
            Friends scan this with their camera to join
          </T>
        </View>
      ) : null}

      {toast ? <Toast icon={toast.ok ? 'check' : 'info'} iconColor={toast.ok ? colors.success : colors.error} message={toast.text} /> : null}

      {isOwner ? (
        <>
          <Button label={busy ? 'Preparing…' : 'Share invite link'} icon="share" onPress={() => void shareInvite()} />
          <View style={{ alignItems: 'center', marginTop: -12 }}>
            <LinkText label="Copy invite link" icon="link" onPress={() => void copyCode()} />
            <LinkText label={showQr ? 'Hide QR code' : 'Show QR code'} icon="qr" onPress={() => void toggleQr()} />
          </View>
        </>
      ) : isCollaborator ? (
        <Button label="Open playlist" onPress={() => router.replace({ pathname: '/playlist', params: { id: pl.id } })} />
      ) : (
        <>
          <Button label={busy ? 'Joining…' : 'Accept and join'} onPress={() => void accept()} />
          <View style={{ alignItems: 'center', marginTop: -12 }}>
            <LinkText label="Decline" onPress={() => go('back')} />
          </View>
        </>
      )}
    </Screen>
  );
}
