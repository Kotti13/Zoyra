import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Glass, Icon, ListRow, Screen, ScreenHeader, SectionHeader, T, Toast, Toggle } from '../components';
import type { IconName } from '../components';
import { useSpotifyLink } from '../lib/spotify';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Service = { name: string; icon: IconName; why: string };

/**
 * Spotify links for real (PKCE, client id only). None of these can be wired with just a public
 * client id, so they show an honest one-line note instead of a switch.
 */
const unavailable: Service[] = [
  { name: 'Apple Music', icon: 'music', why: 'Needs a signed MusicKit developer token from a server key.' },
  { name: 'Alexa', icon: 'speaker', why: 'Needs a published Alexa skill.' },
  { name: 'Google Home', icon: 'speaker', why: 'Needs Google Cast registration and a native build.' },
  { name: 'AirPlay and Chromecast', icon: 'cast', why: 'Needs the native Cast SDK in a development build.' },
  { name: 'CarPlay and Android Auto', icon: 'car', why: 'Needs Apple and Google car entitlements.' },
];

export default function Connected() {
  const { user, profile } = useAuth();
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, ok = true) => {
    setNote({ text, ok });
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => setNote(null), 3500);
  }, []);
  useEffect(() => () => void (t.current && clearTimeout(t.current)), []);

  const account = user?.email ?? user?.phone ?? null;
  const spotify = useSpotifyLink();

  const toggleSpotify = async (on: boolean) => {
    if (spotify.busy) return;
    if (!on) {
      await spotify.disconnect();
      return show('Spotify disconnected. Your imported playlists stay in your library.');
    }
    const r = await spotify.connect();
    if (r) show(r.message, r.ok);
  };

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'amber' }}>
      <ScreenHeader title="Connected services" />

      <Glass padding={4}>
        <ListRow
          title="Zoyra account"
          subtitle={account ? `Signed in as ${account}${profile?.display_name ? ` · ${profile.display_name}` : ''}` : 'Not signed in'}
          icon="user"
          href={account ? undefined : '/login'}
          right={account ? <Icon name="check" size={20} color={colors.success} /> : undefined}
        />
      </Glass>

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.accentLight} message={note.text} /> : null}

      <Glass padding={4}>
        <ListRow
          title="Spotify"
          subtitle={
            spotify.account === undefined
              ? 'Checking…'
              : spotify.account
                ? `Connected as ${spotify.account} · import playlists`
                : spotify.configured
                  ? 'Not connected · import your playlists'
                  : 'Needs Spotify app setup'
          }
          icon="music"
          href={spotify.account ? '/import' : undefined}
          right={
            spotify.busy || spotify.account === undefined ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Toggle value={!!spotify.account} label="Spotify" onChange={(v) => void toggleSpotify(v)} />
            )
          }
        />
        <ListRow title="Scrobbling" subtitle="Last.fm and ListenBrainz" icon="clock" href="/scrobbling" divider />
      </Glass>

      <SectionHeader title="Not available in this version" />
      <Glass padding={4}>
        {unavailable.map((s, i) => (
          <ListRow key={s.name} title={s.name} subtitle={s.why} icon={s.icon} iconColor={colors.textSecondary} divider={i > 0} right={false} />
        ))}
      </Glass>

      <View>
        <T size={12} color={colors.textSecondary} lineHeight={17} align="center">
          You can disconnect a service at any time. Zoyra only reads what each service allows.
        </T>
      </View>
    </Screen>
  );
}
