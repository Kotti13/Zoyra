import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { Button, Glass, ListRow, Screen, ScreenHeader, SectionHeader, T, TextField, Toast, Toggle } from '../components';
import { SERVICE_NAMES, scrobbler, useScrobbleState, type ActionResult, type ScrobbleService, type ScrobbleStatus } from '../lib/scrobble';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

const ago = (at: number) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

function StatusLine({ status }: { status: ScrobbleStatus | null }) {
  if (!status) return null;
  return (
    <T size={12} color={status.ok ? colors.textSecondary : colors.error} lineHeight={17} style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
      {status.message} · {ago(status.at)}
    </T>
  );
}

export default function Scrobbling() {
  const s = useScrobbleState();
  const { settings } = useAuth();
  const params = useLocalSearchParams<{ token?: string }>();
  const [busy, setBusy] = useState<ScrobbleService | null>(null);
  const [lbToken, setLbToken] = useState('');
  const [lbError, setLbError] = useState<string | undefined>();
  const [note, setNote] = useState<ActionResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((r: ActionResult) => {
    setNote(r);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 4000);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const run = useCallback(
    async (service: ScrobbleService, fn: () => Promise<ActionResult>) => {
      setBusy(service);
      try {
        show(await fn());
      } finally {
        setBusy(null);
      }
    },
    [show],
  );

  // Deep link fallback: Last.fm redirected to zoyra://scrobbling?token=… outside the auth session.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const token = typeof params.token === 'string' ? params.token : null;
    if (!token || handled.current === token || !s.loaded) return;
    handled.current = token;
    void run('lastfm', () => scrobbler.completeLastfm(token));
  }, [params.token, s.loaded, run]);

  const connectLb = async () => {
    setLbError(undefined);
    setBusy('listenbrainz');
    try {
      const r = await scrobbler.connectListenBrainz(lbToken);
      if (r.ok) {
        setLbToken('');
        show(r);
      } else setLbError(r.message);
    } finally {
      setBusy(null);
    }
  };

  const privateSession = Boolean(settings?.privacy?.private_session);
  const anyConnected = !!(s.accounts.lastfm || s.accounts.listenbrainz);

  const lastfmSubtitle = s.accounts.lastfm
    ? `Connected as ${s.accounts.lastfm.username}`
    : s.lastfmNeedsSetup
      ? 'Needs Last.fm setup'
      : 'Not connected · sign in on last.fm';

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'lines', mesh: 'amber' }}>
      <ScreenHeader title="Scrobbling" />

      {note ? <Toast icon={note.ok ? 'check' : 'info'} iconColor={note.ok ? colors.success : colors.accentLight} message={note.message} /> : null}

      <Glass padding={4}>
        <ListRow
          title="Scrobble what I play"
          subtitle={
            privateSession
              ? 'Paused while Private session is on'
              : s.queued
                ? `${s.queued} ${s.queued === 1 ? 'listen' : 'listens'} waiting to send`
                : anyConnected
                  ? 'After half a song or 4 minutes'
                  : 'Connect a service below'
          }
          icon="clock"
          right={<Toggle value={s.enabled} label="Scrobbling" onChange={(v) => void scrobbler.setEnabled(v)} />}
        />
      </Glass>

      <SectionHeader title={SERVICE_NAMES.lastfm} />
      <Glass padding={4}>
        <ListRow
          title={SERVICE_NAMES.lastfm}
          subtitle={!s.loaded ? 'Checking…' : lastfmSubtitle}
          icon="music"
          right={
            busy === 'lastfm' || !s.loaded ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Toggle
                value={!!s.accounts.lastfm}
                label="Last.fm"
                onChange={(v) => void run('lastfm', v ? scrobbler.connectLastfm : scrobbler.disconnectLastfm)}
              />
            )
          }
        />
        <StatusLine status={s.status.lastfm} />
      </Glass>

      <SectionHeader title={SERVICE_NAMES.listenbrainz} />
      <Glass padding={4}>
        <ListRow
          title={SERVICE_NAMES.listenbrainz}
          subtitle={!s.loaded ? 'Checking…' : s.accounts.listenbrainz ? `Connected as ${s.accounts.listenbrainz.username}` : 'Not connected · paste your user token'}
          icon="music"
          right={
            busy === 'listenbrainz' || !s.loaded ? (
              <ActivityIndicator color={colors.accent} />
            ) : s.accounts.listenbrainz ? (
              <Toggle value label="ListenBrainz" onChange={() => void run('listenbrainz', scrobbler.disconnectListenBrainz)} />
            ) : (
              false
            )
          }
        />
        <StatusLine status={s.status.listenbrainz} />
        {s.loaded && !s.accounts.listenbrainz ? (
          <View style={{ padding: 12, gap: 12 }}>
            <TextField
              label="User token"
              placeholder="From listenbrainz.org/settings"
              value={lbToken}
              onChangeText={setLbToken}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              error={lbError}
              icon="lock"
            />
            <Button
              label={busy === 'listenbrainz' ? 'Checking token…' : 'Connect ListenBrainz'}
              variant={lbToken.trim() && !busy ? 'primary' : 'disabled'}
              onPress={lbToken.trim() && !busy ? () => void connectLb() : undefined}
            />
          </View>
        ) : null}
      </Glass>

      <View>
        <T size={12} color={colors.textSecondary} lineHeight={17} align="center">
          Zoyra sends the song title, artist and time you listened. Songs under 30 seconds and private sessions are never scrobbled.
          Your tokens are stored privately on our server and never shown on your profile.
        </T>
      </View>
    </Screen>
  );
}
