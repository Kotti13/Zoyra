import { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Avatar, Cover, Glass, Icon, IconButton, LinkText, ListGroup, ListRow, Row, Screen, ScreenHeader, T, Tap, artFor } from '../components';
import type { IconName, NavTarget } from '../components';
import { useAuth, type Profile } from '../state/auth';
import { colors } from '../theme/tokens';

const PLAN_LABEL: Record<Profile['plan'], string> = { free: 'Free plan', premium: 'Premium', family: 'Family plan', student: 'Student plan' };

const rows: { title: string; subtitle: string; icon: IconName; href?: NavTarget; filled?: boolean }[] = [
  { title: 'Audio', subtitle: 'Quality, equalizer, crossfade', icon: 'speaker', href: '/audio-settings' },
  { title: 'Playback', subtitle: 'Autoplay, crossfade, resume', icon: 'play', filled: false, href: '/playback-settings' },
  { title: 'Lyrics', subtitle: 'Text size, highlight, translation', icon: 'mic', href: '/lyrics-settings' },
  { title: 'Video', subtitle: 'Autoplay, shorts, captions', icon: 'camera', href: '/video-settings' },
  { title: 'Content', subtitle: 'Explicit filter, hidden artists', icon: 'filter', href: '/content-controls' },
  { title: 'Connection and data', subtitle: 'Wi-Fi, speed test, offline mode', icon: 'globe', href: '/net-status' },
  { title: 'Data and storage', subtitle: 'Downloads, cache, data saver', icon: 'storage', href: '/storage' },
  { title: 'Display and theme', subtitle: 'Dark, accent, font size', icon: 'moon', href: '/theme' },
  { title: 'Notifications', subtitle: 'Releases, friends, reports', icon: 'bell', href: '/notif-settings' },
  { title: 'Privacy and security', subtitle: 'Sessions, 2FA, your data', icon: 'shield', href: '/privacy' },
  { title: 'Devices and sessions', subtitle: 'Where you’re signed in', icon: 'phone', href: '/sessions' },
  { title: 'Connected services', subtitle: 'Spotify, Apple Music, Last.fm', icon: 'link', href: '/connected' },
  { title: 'About', subtitle: 'Version, terms, licenses', icon: 'info', href: '/about' },
];

export default function Settings() {
  const { profile, user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = profile?.display_name ?? 'Listener';
  const plan = PLAN_LABEL[profile?.plan ?? 'free'];
  const sub = [plan, profile?.username ? `@${profile.username}` : user?.email].filter(Boolean).join(' · ');

  const logOut = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await signOut(); // the root auth gate sends signed-out users to Welcome
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not log out');
      setBusy(false);
    }
  };

  return (
    <Screen top={4} gap={16} bottom={16} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <ScreenHeader title="Settings" right={<IconButton icon="search" label="Search settings" href="/settings-search" />} />

      <Tap href="/settings-hub" accessibilityLabel="All settings. Playback, quality, video, lyrics and more">
        <Glass padding={12}>
          <Row gap={12}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="sliders" size={22} color={colors.accentLight} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <T size={16} weight={600}>
                All settings
              </T>
              <T size={13} color={colors.textSecondary}>
                Playback, quality, video, lyrics and more
              </T>
            </View>
            <Icon name="chevronRight" size={18} color={colors.textSecondary} />
          </Row>
        </Glass>
      </Tap>

      <Tap href="/profile" accessibilityLabel={`${name}, ${plan}. Open profile`}>
        <Glass padding={12}>
          <Row gap={12}>
            {profile?.avatar_url ? (
              <Cover uri={profile.avatar_url} id={user?.id} size={56} radius={28} />
            ) : (
              <Avatar initial={name.trim().charAt(0).toUpperCase() || 'Z'} art={artFor(user?.id)} size={56} />
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <T size={16} weight={600} numberOfLines={1}>
                {name}
              </T>
              <T size={14} color={colors.textSecondary} numberOfLines={1}>
                {sub}
              </T>
            </View>
            <Icon name="chevronRight" size={18} color={colors.textSecondary} />
          </Row>
        </Glass>
      </Tap>

      <ListGroup>
        {rows.map((r, i) => (
          <ListRow
            key={r.title}
            title={r.title}
            subtitle={r.subtitle}
            divider={i > 0}
            href={r.href}
            leading={
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={r.icon} size={20} color={colors.accentLight} filled={r.filled} />
              </View>
            }
          />
        ))}
      </ListGroup>

      <View style={{ alignItems: 'center', gap: 4 }}>
        {busy ? <ActivityIndicator color={colors.error} style={{ minHeight: 44 }} /> : <LinkText label="Log out" onPress={() => void logOut()} color={colors.error} />}
        {error ? (
          <T size={13} color={colors.error} align="center">
            {error}
          </T>
        ) : null}
      </View>
    </Screen>
  );
}
