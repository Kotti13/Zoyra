import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Chip, Cover, EmptyState, ErrorState, Glass, Icon, ListRow, Loading, Row, Screen, ScreenHeader, SectionHeader, T, Tap, TextField, Toast, useAsync, useDebounced, type IconName } from '../components';
import { catalog } from '../lib/catalog';
import { historySeeds } from '../lib/radio';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors } from '../theme/tokens';

/** The artist's own links, straight from their Audius profile fields. */
type SupportLink = { key: string; label: string; detail: string; url: string; icon: IconName };
type ArtistLinks = { id: string; name: string; handle: string; image: string | null; links: SupportLink[] };

type RawProfile = {
  id: string;
  name: string;
  handle: string;
  website?: string | null;
  donation?: string | null;
  twitter_handle?: string | null;
  instagram_handle?: string | null;
  tiktok_handle?: string | null;
  profile_picture?: Partial<Record<'150x150' | '480x480', string>> | null;
};

/** Only http(s) links; bare domains ("PayPal.me/x") get https://. */
const webUrl = (raw: string | null | undefined): string | null => {
  const v = raw?.trim();
  if (!v || /\s/.test(v)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  return /^https?:\/\/[^/\s]+\.[^/\s]+/i.test(withScheme) ? withScheme : null;
};
const handleOf = (raw: string | null | undefined) => raw?.trim().replace(/^@/, '').replace(/[^A-Za-z0-9._]/g, '') || null;
const hostOf = (u: string) => u.replace(/^https?:\/\//i, '').replace(/\/$/, '');

async function artistLinks(id: string): Promise<ArtistLinks> {
  const res = await fetch(`https://api.audius.co/v1/users/${encodeURIComponent(id)}?app_name=zoyra`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Could not load this artist (${res.status})`);
  const u = ((await res.json()) as { data: RawProfile }).data;
  const links: SupportLink[] = [];
  const site = webUrl(u.website);
  if (site) links.push({ key: 'site', label: 'Website', detail: hostOf(site), url: site, icon: 'globe' });
  const tip = webUrl(u.donation);
  if (tip) links.push({ key: 'tip', label: 'Support directly', detail: hostOf(tip), url: tip, icon: 'heart' });
  const x = handleOf(u.twitter_handle);
  if (x) links.push({ key: 'x', label: 'X (Twitter)', detail: `@${x}`, url: `https://x.com/${x}`, icon: 'link' });
  const ig = handleOf(u.instagram_handle);
  if (ig) links.push({ key: 'ig', label: 'Instagram', detail: `@${ig}`, url: `https://instagram.com/${ig}`, icon: 'camera' });
  const tt = handleOf(u.tiktok_handle);
  if (tt) links.push({ key: 'tt', label: 'TikTok', detail: `@${tt}`, url: `https://www.tiktok.com/@${tt}`, icon: 'music' });
  links.push({ key: 'audius', label: 'Audius profile', detail: 'Follow, tip or buy their releases on Audius', url: `https://audius.co/${encodeURIComponent(u.handle)}`, icon: 'user' });
  return { id: u.id, name: u.name, handle: u.handle, image: u.profile_picture?.['480x480'] ?? u.profile_picture?.['150x150'] ?? null, links };
}

type ArtistPick = { id: string; name: string; image?: string };

export default function Merch() {
  const params = useLocalSearchParams<{ artistId?: string }>();
  const { user } = useAuth();
  const lib = useLibrary();
  const [chosen, setChosen] = useState<string | null>(params.artistId ?? null);
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 350);
  const [note, setNote] = useState<string | null>(null);

  const history = useAsync(async () => (user ? (await historySeeds(user.id)).artists.slice(0, 10) : []), [user?.id]);
  const found = useAsync(async () => (q.length >= 2 ? catalog.searchArtists(q, 8) : []), [q]);

  const picks: ArtistPick[] = [];
  const seen = new Set<string>();
  for (const a of [...lib.followedArtists.map((x) => ({ id: x.id, name: x.name, image: x.image.small })), ...(history.data ?? [])]) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    picks.push(a);
  }
  const active = chosen ?? picks[0]?.id ?? null;
  const detail = useAsync(async () => (active ? artistLinks(active) : null), [active]);

  const open = async (url: string) => {
    setNote(null);
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      setNote('Could not open that link.');
    }
  };

  return (
    <Screen onRefresh={() => Promise.all([history.refresh(), found.refresh(), detail.refresh()])} top={4} gap={18} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Support artists
        </T>
        <T size={15} color={colors.textSecondary}>
          Merch, tips and links, straight from the artist
        </T>
      </View>

      <Glass padding={14}>
        <Row gap={12} align="flex-start">
          <Icon name="info" size={18} color={colors.accentLight} />
          <T size={13} color={colors.textSecondary} style={{ flex: 1 }} lineHeight={19}>
            Zoyra doesn’t run a store or take a cut. These are the links each artist added to their Audius profile, so anything you buy or give goes to them.
          </T>
        </Row>
      </Glass>

      <TextField label="Find an artist" icon="search" value={query} onChangeText={setQuery} placeholder="Search artists" returnKeyType="search" autoCapitalize="none" />
      {q.length >= 2 ? (
        found.loading ? (
          <Loading label="Searching artists" height={80} />
        ) : found.error ? (
          <ErrorState message={found.error} onRetry={found.reload} />
        ) : found.data?.length ? (
          <Glass padding={4}>
            {found.data.map((a, i) => (
              <ListRow
                key={a.id}
                divider={i > 0}
                leading={<Cover uri={a.image.small ?? null} id={a.id} size={40} radius={20} />}
                title={a.name}
                subtitle={`@${a.handle}`}
                onPress={() => {
                  setChosen(a.id);
                  setQuery('');
                }}
              />
            ))}
          </Glass>
        ) : (
          <EmptyState icon="search" title="No artists found" body="Try another name." />
        )
      ) : picks.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
          {picks.map((p) => (
            <Chip key={p.id} label={p.name} active={p.id === active} onPress={() => setChosen(p.id)} />
          ))}
        </ScrollView>
      ) : null}

      {note ? <Toast icon="info" iconColor={colors.error} message={note} /> : null}

      {!active ? (
        history.loading ? (
          <Loading label="Finding your artists" />
        ) : (
          <EmptyState icon="users" title="Pick an artist" body="Follow artists or search above to see how to support them." />
        )
      ) : detail.loading ? (
        <Loading label="Loading the artist’s links" />
      ) : detail.error || !detail.data ? (
        <ErrorState message={detail.error ?? 'Could not load this artist.'} onRetry={detail.reload} />
      ) : (
        <>
          <Tap href={{ pathname: '/artist', params: { id: detail.data.id } }} accessibilityLabel={`Open ${detail.data.name}`}>
            <Row gap={14}>
              <Cover uri={detail.data.image} id={detail.data.id} size={64} radius={32} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <T size={22} weight={300} tracking={-0.5} numberOfLines={1}>
                  {detail.data.name}
                </T>
                <T size={13} color={colors.textSecondary}>
                  @{detail.data.handle}
                </T>
              </View>
              <Icon name="chevronRight" size={18} color={colors.textSecondary} />
            </Row>
          </Tap>

          <SectionHeader title="Support the artist" />
          <Glass padding={4}>
            {detail.data.links.map((l, i) => (
              <ListRow key={l.key} divider={i > 0} icon={l.icon} title={l.label} subtitle={l.detail} onPress={() => void open(l.url)} right={<Icon name="arrowRight" size={18} color={colors.textSecondary} />} />
            ))}
          </Glass>
          {detail.data.links.length === 1 ? (
            <T size={13} color={colors.textSecondary} align="center">
              {detail.data.name} hasn’t added a website, store or tip link yet. Their Audius profile is the best place to support them.
            </T>
          ) : null}
        </>
      )}
    </Screen>
  );
}
