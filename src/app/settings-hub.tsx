import { View } from 'react-native';

import { Avatar, Cover, Glass, Icon, IconButton, ListGroup, ListRow, Row, Screen, T, Tap, artFor, type IconName, type NavTarget } from '../components';
import { useScreenReaderHints } from '../lib/a11y';
import { useAuth, type Profile } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const PLAN_LABEL: Record<Profile['plan'], string> = { free: 'Zoyra Free', premium: 'Zoyra Premium', family: 'Zoyra Family', student: 'Zoyra Student' };

type Item = { title: string; subtitle: string; icon: IconName; href: NavTarget };

/** Tile grid (pairs), from the SettingsHub design. */
const TILES: Item[] = [
  { title: 'Playback', subtitle: 'Crossfade, autoplay, resume', icon: 'play', href: '/playback-settings' },
  { title: 'Audio quality', subtitle: 'Streaming and downloads', icon: 'speaker', href: '/audio-quality' },
  { title: 'Video', subtitle: 'Autoplay and data', icon: 'camera', href: '/video-settings' },
  { title: 'Lyrics', subtitle: 'Size, highlight and translate', icon: 'mic', href: '/lyrics-settings' },
  { title: 'Devices', subtitle: 'Bluetooth, car and network', icon: 'cast', href: '/devices-connect' },
  { title: 'Widgets', subtitle: 'Lock screen controls', icon: 'lock', href: '/widgets-lock' },
  { title: 'Accessibility', subtitle: 'Motion, text, contrast', icon: 'eye', href: '/accessibility' },
  { title: 'Content', subtitle: 'Explicit and hidden artists', icon: 'filter', href: '/content-controls' },
];

const GROUPS: { title: string; rows: Item[] }[] = [
  {
    title: 'GENERAL',
    rows: [
      { title: 'Notifications', subtitle: 'Alerts and quiet hours', icon: 'bell', href: '/notif-settings' },
      { title: 'Display and theme', subtitle: 'Cinematic red, dark', icon: 'moon', href: '/theme' },
      { title: 'Languages', subtitle: 'Music in your languages', icon: 'globe', href: '/languages' },
      { title: 'Sleep timer', subtitle: 'Stop playing after a while', icon: 'clock', href: '/sleep' },
    ],
  },
  {
    title: 'SOUND',
    rows: [
      { title: 'Audio', subtitle: 'Smooth transitions, gapless, normalize', icon: 'speaker', href: '/audio-settings' },
      { title: 'Equalizer', subtitle: 'Presets and bands', icon: 'sliders', href: '/equalizer' },
    ],
  },
  {
    title: 'DATA AND STORAGE',
    rows: [
      { title: 'Storage and data', subtitle: 'Downloads and cache', icon: 'storage', href: '/storage' },
      { title: 'Data usage', subtitle: 'Mobile data this month', icon: 'chart', href: '/data-usage' },
      { title: 'Connection', subtitle: 'Offline mode, speed test', icon: 'wifi', href: '/net-status' },
      { title: 'Cache and prefetch', subtitle: 'Artwork and temporary files', icon: 'storage', href: '/cache' },
      { title: 'Downloads', subtitle: 'Songs saved on this phone', icon: 'download', href: '/downloads' },
      { title: 'Local files', subtitle: 'Music already on this phone', icon: 'file', href: '/local-music' },
    ],
  },
  {
    title: 'PRIVACY AND ACCOUNT',
    rows: [
      { title: 'Privacy and security', subtitle: 'Sessions and sharing', icon: 'shield', href: '/privacy' },
      { title: 'Permissions', subtitle: 'Notifications, mic, camera', icon: 'eye', href: '/permissions?mode=manage' },
      { title: 'Two-factor authentication', subtitle: 'Authenticator app', icon: 'lock', href: '/two-factor' },
      { title: 'Signed-in devices', subtitle: 'Where you’re signed in', icon: 'phone', href: '/sessions' },
      { title: 'Blocked users', subtitle: 'People you blocked', icon: 'user', href: '/blocked' },
      { title: 'Family plan', subtitle: 'Members and kid-safe mode', icon: 'users', href: '/family' },
      { title: 'Plans', subtitle: 'Premium, Family, Student', icon: 'star', href: '/plans' },
      { title: 'Billing', subtitle: 'Purchases and payment', icon: 'star', href: '/billing' },
    ],
  },
  {
    title: 'CONNECTED',
    rows: [
      { title: 'Connected services', subtitle: 'Spotify, Last.fm', icon: 'link', href: '/connected' },
      { title: 'Scrobbling', subtitle: 'Last.fm and ListenBrainz', icon: 'chart', href: '/scrobbling' },
      { title: 'Import playlists', subtitle: 'Bring your Spotify playlists', icon: 'download', href: '/import' },
    ],
  },
  {
    title: 'SUPPORT',
    rows: [
      { title: 'Help center', subtitle: 'Answers and contact', icon: 'info', href: '/help' },
      { title: 'About', subtitle: 'Version, terms, licenses', icon: 'info', href: '/about' },
    ],
  },
];

function TileCard({ item, hints }: { item: Item; hints: boolean }) {
  return (
    <Tap href={item.href} accessibilityRole="button" accessibilityLabel={`${item.title}. ${item.subtitle}`} accessibilityHint={hints ? `Opens ${item.title} settings` : undefined} style={{ flex: 1, minWidth: 0 }}>
      <Glass padding={16} radius={28} style={{ flex: 1 }}>
        <View style={{ gap: 12 }}>
          <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accentTint, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={item.icon} size={22} color={colors.accentLight} />
          </View>
          <View style={{ gap: 2 }}>
            <T size={15} weight={600} numberOfLines={1}>
              {item.title}
            </T>
            <T size={12} color={colors.textSecondary} numberOfLines={2}>
              {item.subtitle}
            </T>
          </View>
        </View>
      </Glass>
    </Tap>
  );
}

export default function SettingsHub() {
  const { profile, user } = useAuth();
  const [hints] = useScreenReaderHints();
  const name = profile?.display_name ?? 'Listener';
  const plan = PLAN_LABEL[profile?.plan ?? 'free'];
  const pairs: Item[][] = [];
  for (let i = 0; i < TILES.length; i += 2) pairs.push(TILES.slice(i, i + 2));

  return (
    <Screen top={4} gap={16} bottom={24} backdrop={{ pattern: 'none', mesh: 'coral', orbs: true }}>
      <Row style={{ justifyContent: 'space-between', minHeight: 44 }}>
        <T variant="display" size={36} accessibilityRole="header">
          Settings
        </T>
        <IconButton icon="close" label="Close" href="back" bg={colors.chipGhost} />
      </Row>

      <Tap href="/settings-search" accessibilityRole="search" accessibilityLabel="Search settings">
        <Glass radius={26} style={{ height: 52, justifyContent: 'center', paddingHorizontal: 18 }}>
          <Row gap={12}>
            <Icon name="search" size={20} color={colors.textSecondary} />
            <T size={15} color={colors.textSecondary}>
              Search settings
            </T>
          </Row>
        </Glass>
      </Tap>

      <Tap href="/profile" accessibilityLabel={`${name}, ${plan}. Open profile`}>
        <View style={{ borderRadius: 36, borderWidth: 1, borderColor: colors.glassBorder, backgroundColor: withAlpha(colors.red, 0.22), padding: 16 }}>
          <Row gap={14}>
            {profile?.avatar_url ? (
              <Cover uri={profile.avatar_url} id={user?.id} size={56} radius={19} />
            ) : (
              <Avatar initial={name.trim().charAt(0).toUpperCase() || 'Z'} art={artFor(user?.id)} size={56} />
            )}
            <View style={{ flex: 1, gap: 4 }}>
              <T size={17} weight={600} numberOfLines={1}>
                {name}
              </T>
              <Row gap={6}>
                <Icon name="star" size={14} color={colors.gold} filled />
                <T size={13} color={colors.peach} numberOfLines={1}>
                  {plan}
                  {profile?.username ? ` · @${profile.username}` : ''}
                </T>
              </Row>
            </View>
            <Icon name="chevronRight" size={18} color={colors.textSecondary} />
          </Row>
        </View>
      </Tap>

      {pairs.map((pair) => (
        <Row key={pair[0].title} gap={12} align="stretch">
          {pair.map((it) => (
            <TileCard key={it.title} item={it} hints={hints} />
          ))}
        </Row>
      ))}

      {GROUPS.map((g) => (
        <ListGroup key={g.title} title={g.title}>
          {g.rows.map((r, i) => (
            <ListRow key={r.title} title={r.title} subtitle={r.subtitle} icon={r.icon} href={r.href} divider={i > 0} />
          ))}
        </ListGroup>
      ))}
    </Screen>
  );
}
