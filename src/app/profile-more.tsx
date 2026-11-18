import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Linking, View } from 'react-native';

import { Glass, ListRow, Loading, Sheet, T, Toggle, useAsync, type IconName } from '../components';
import { emitProfileChange } from '../lib/profile';
import { profileShareUrl, shareContent } from '../lib/share-links';
import { friendlySocialError, useBlocks } from '../lib/social';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const SUPPORT_EMAIL = 'support@zoyra.app';

type Item = { title: string; icon: IconName; onPress?: () => void; danger?: boolean; right?: ReactNode; busy?: boolean };

/** Profile options sheet. Without `id` (or with your own) it shows your options; with someone else's `id`, share / block / report. */
export default function ProfileMore() {
  const { id: rawId } = useLocalSearchParams<{ id?: string }>();
  const { user, profile, updateProfile } = useAuth();
  const me = user?.id;
  const otherId = typeof rawId === 'string' && rawId && rawId !== me ? rawId : null;
  const targetId = otherId ?? me;
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { blocked, block, unblock, ready } = useBlocks(me);

  const other = useAsync(async () => {
    if (!otherId) return null;
    const { data, error } = await supabase.from('profiles').select('display_name, username').eq('id', otherId).maybeSingle();
    if (error) throw new Error(error.message);
    return (data as { display_name: string; username: string | null } | null) ?? null;
  }, [otherId]);

  const name = otherId ? other.data?.display_name ?? 'this person' : profile?.display_name ?? 'me';
  const targetUsername = otherId ? other.data?.username : profile?.username;
  const link = targetId ? profileShareUrl({ id: targetId, username: targetUsername }) : '';

  const copy = async () => {
    if (!link) return setNote({ text: 'Sign in to get your profile link.', error: true });
    try {
      await Clipboard.setStringAsync(link);
      setNote({ text: 'Profile link copied.' });
    } catch {
      setNote({ text: 'Could not copy the link.', error: true });
    }
  };

  const share = () => {
    if (!link) return setNote({ text: 'Sign in to share your profile.', error: true });
    const msg = otherId ? `Check out ${name} on Zoyra` : `Listen along with ${name} on Zoyra`;
    shareContent({ url: link, title: `${name} on Zoyra`, message: msg }).catch(() => setNote({ text: 'Could not open the share menu.', error: true }));
  };

  // Optimistic value so the switch slides immediately; cleared once the saved profile catches up.
  const [privDraft, setPrivDraft] = useState<boolean | null>(null);
  const isPrivate = privDraft ?? profile?.is_private ?? false;
  if (privDraft !== null && busy !== 'private' && profile?.is_private === privDraft) setPrivDraft(null);

  const setPrivate = async (v: boolean) => {
    if (!me) return setNote({ text: 'Sign in to change your privacy.', error: true });
    if (busy) return;
    setBusy('private');
    setPrivDraft(v);
    setNote(null);
    try {
      await updateProfile({ is_private: v });
      setNote({ text: v ? 'Your profile is private. Only followers see your playlists and listening.' : 'Your profile is public.' });
    } catch (e) {
      setPrivDraft(null);
      setNote({ text: e instanceof Error ? e.message : 'Could not save that change', error: true });
    } finally {
      setBusy(null);
    }
  };

  const toggleBlock = async () => {
    if (!otherId || busy) return;
    setBusy('block');
    setNote(null);
    try {
      if (blocked.has(otherId)) {
        if (await unblock(otherId, name)) {
          emitProfileChange({ id: otherId, blocked: false });
          setNote({ text: `${name} is unblocked.` });
        }
      } else if (await block(otherId, name)) {
        emitProfileChange({ id: otherId, blocked: true });
        router.back();
        return;
      }
    } catch (e) {
      setNote({ text: friendlySocialError(e, 'Could not update block'), error: true });
    } finally {
      setBusy(null);
    }
  };

  const report = () => {
    if (!otherId) return;
    const subject = encodeURIComponent(`Report profile: ${name}`);
    const body = encodeURIComponent(`Profile id: ${otherId}\nWhat happened:\n`);
    Linking.openURL(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`).catch(() => setNote({ text: `No mail app found. Email ${SUPPORT_EMAIL} with profile id ${otherId}.`, error: true }));
  };

  const groups: Item[][] = otherId
    ? [
        [
          { title: 'Copy profile link', icon: 'link', onPress: () => void copy() },
          { title: 'Share profile', icon: 'share', onPress: share },
          { title: 'Compare taste', icon: 'users', onPress: () => router.replace({ pathname: '/taste-compare', params: { user: otherId } }) },
        ],
        [
          { title: blocked.has(otherId) ? 'Unblock user' : 'Block user', icon: 'close', danger: !blocked.has(otherId), onPress: ready ? () => void toggleBlock() : undefined, busy: busy === 'block' },
          { title: 'Report profile', icon: 'shield', danger: true, onPress: report },
        ],
      ]
    : [
        [
          { title: 'Copy profile link', icon: 'link', onPress: () => void copy() },
          { title: 'Show QR code', icon: 'qr', onPress: () => router.replace('/profile-qr') },
          { title: 'Share profile', icon: 'share', onPress: share },
          {
            title: 'Private profile',
            icon: 'lock',
            right: <Toggle value={isPrivate} label="Private profile" onChange={(v) => void setPrivate(v)} />,
            busy: busy === 'private',
          },
          { title: 'Privacy settings', icon: 'shield', onPress: () => router.replace('/privacy') },
          { title: 'Devices and sessions', icon: 'phone', onPress: () => router.replace('/sessions') },
        ],
      ];

  return (
    <Sheet>
      <T variant="section" accessibilityRole="header">
        {otherId && other.data ? name : 'Profile options'}
      </T>
      {otherId && other.loading ? <Loading height={48} /> : null}
      {groups.map((g, gi) => (
        <Glass key={gi} padding={4}>
          {g.map((it, i) => (
            <ListRow
              key={it.title}
              divider={i > 0}
              minHeight={56}
              title={it.busy ? `${it.title}…` : it.title}
              titleColor={it.danger ? colors.like : colors.text}
              icon={it.icon}
              iconBg={colors.iconGhost}
              iconColor={it.danger ? colors.like : colors.text}
              onPress={it.right ? undefined : it.onPress}
              right={it.right ?? false}
            />
          ))}
        </Glass>
      ))}
      {!otherId ? (
        <T size={12} color={colors.textSecondary} lineHeight={17}>
          A private profile hides your playlists, listening and taste from people who don’t follow you. Your name and photo stay visible so friends can find you.
        </T>
      ) : null}
      {note ? (
        <View accessibilityLiveRegion="polite">
          <T size={13} color={note.error ? colors.error : colors.textSecondary} align="center">
            {note.text}
          </T>
        </View>
      ) : null}
    </Sheet>
  );
}
