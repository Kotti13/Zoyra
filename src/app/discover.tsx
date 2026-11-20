import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Art, Avatar, Cover, ErrorState, Glass, Icon, IconButton, Loading, Row, Screen, T, Tap, artFor, useAsync, type IconName } from '../components';
import { supabase } from '../lib/supabase';
import { StoriesRail } from '../lib/stories-ui';
import { useAuth } from '../state/auth';
import { colors, withAlpha, type ArtName } from '../theme/tokens';

type Insights = { minutes: number; plays: number; top_genres: { genre: string | null; plays: number }[] };

const sections = ['All', 'Activity', 'Picks', 'Create'] as const;

const picks: { title: string; body: string; icon: IconName; art: ArtName; href: Href }[] = [
  { title: 'AI playlist', body: 'Describe a vibe and get a playlist built from the catalogue', icon: 'sliders', art: 'red', href: '/ai-playlist' },
  { title: 'Mood scan', body: 'Snap a selfie or a scene and play music that matches the mood', icon: 'camera', art: 'orange', href: '/mood-scan' },
  { title: 'Blend', body: 'One playlist from your taste and a friend’s', icon: 'users', art: 'blue', href: '/blend' },
  { title: 'On this day', body: 'Songs that were on repeat on today’s date in past years', icon: 'clock', art: 'amber', href: '/memories' },
  { title: 'What is playing?', body: 'Listen to a song around you and find it', icon: 'mic', art: 'rose', href: '/identify' },
];

const more: { label: string; icon: IconName; href: Href }[] = [
  { label: 'Premieres', icon: 'star', href: '/premieres' },
  { label: 'Live', icon: 'cast', href: '/live-hub' },
  { label: 'Run mode', icon: 'bolt', href: '/workout-home' },
  { label: 'Charts', icon: 'chart', href: '/charts' },
];

const fmtMinutes = (m: number) => (m >= 60 ? `${(m / 60).toFixed(1).replace(/\.0$/, '')}` : String(Math.round(m)));

function StatCard({ label, sub, value, unit, href }: { label: string; sub: string; value: string; unit: string; href: Href }) {
  return (
    <Tap href={href} accessibilityLabel={`${label}: ${value} ${unit}`} style={{ width: 158 }}>
      <Glass radius={26} padding={16} style={{ height: 176, justifyContent: 'space-between' }}>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <View style={{ gap: 2 }}>
            <T size={15} weight={500}>
              {label}
            </T>
            <T size={12} color={colors.textSecondary}>
              {sub}
            </T>
          </View>
          <Icon name="chevronRight" size={16} color={colors.textSecondary} />
        </Row>
        <Row gap={6} align="baseline">
          <T size={44} weight={300} tracking={-1.5} lineHeight={46}>
            {value}
          </T>
          <T size={12} color={colors.textSecondary}>
            {unit}
          </T>
        </Row>
      </Glass>
    </Tap>
  );
}

export default function Discover() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const [section, setSection] = useState(0);
  const show = (s: (typeof sections)[number]) => section === 0 || sections[section] === s;

  const activity = useAsync(async () => {
    if (!uid) return null;
    const [ins, streak] = await Promise.all([supabase.rpc('listening_insights', { days: 7 }), supabase.rpc('listening_streak')]);
    if (ins.error) throw new Error(ins.error.message);
    if (streak.error) throw new Error(streak.error.message);
    const i = (ins.data ?? { minutes: 0, plays: 0, top_genres: [] }) as Insights;
    return { minutes: Number(i.minutes) || 0, plays: Number(i.plays) || 0, streak: typeof streak.data === 'number' ? streak.data : 0, topGenre: i.top_genres?.find((g) => g.genre)?.genre ?? null };
  }, [uid], 'app/discover:66');

  const name = profile?.display_name ?? 'Listener';
  const a = activity.data;

  return (
    <Screen onRefresh={activity.refresh} top={4} gap={18} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <IconButton icon="back" label="Back" href="back" />
        <Tap href="/profile" accessibilityLabel="Your profile">
          {profile?.avatar_url ? <Cover uri={profile.avatar_url} id={uid} size={40} radius={13} /> : <Avatar initial={name[0]?.toUpperCase()} art={artFor(uid)} size={40} radius={13} />}
        </Tap>
      </Row>

      <View style={{ alignItems: 'center', gap: 10, marginTop: 6 }}>
        <T size={14} weight={300} tracking={1} color={colors.peach}>
          ✦ Discover
        </T>
        <T size={46} weight={300} tracking={-1.5} lineHeight={48} align="center" accessibilityRole="header">
          {'Explore and\ncreate'}
        </T>
      </View>

      <Tap href="/search" accessibilityLabel="Search songs, artists and playlists">
        <View style={{ height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: withAlpha(colors.white, 0.03) }}>
          <Icon name="search" size={20} color={colors.textSecondary} />
          <T size={15} weight={300} color={colors.textSecondary}>
            Search
          </T>
        </View>
      </Tap>

      <StoriesRail />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {sections.map((label, i) => (
          <Tap key={label} onPress={() => setSection(i)} accessibilityState={{ selected: section === i }}>
            <View
              style={[
                { height: 40, paddingHorizontal: 18, borderRadius: 28, justifyContent: 'center' },
                section === i ? { backgroundColor: colors.text } : { borderWidth: 1, borderColor: colors.chipOutline, backgroundColor: withAlpha(colors.white, 0.03) },
              ]}
            >
              <T size={14} weight={500} color={section === i ? colors.onLight : colors.text}>
                {label}
              </T>
            </View>
          </Tap>
        ))}
      </ScrollView>

      {show('Activity') ? (
        <View style={{ gap: 12 }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T variant="section" accessibilityRole="header">
              Your activity
            </T>
            <Tap href="/insights" accessibilityLabel="Insights" style={{ minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' }}>
              <Icon name="chevronRight" size={20} color={colors.textSecondary} />
            </Tap>
          </Row>
          {!uid ? (
            <T size={14} color={colors.textSecondary}>
              Sign in to see your listening activity.
            </T>
          ) : activity.loading && !a ? (
            <Loading height={120} />
          ) : activity.error ? (
            <ErrorState message={activity.error} onRetry={activity.reload} />
          ) : a ? (
            <>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
                <StatCard label="Listening" sub="This week" value={fmtMinutes(a.minutes)} unit={a.minutes >= 60 ? 'hrs' : 'min'} href="/insights" />
                <StatCard label="Streak" sub={a.streak ? 'Keep it going' : 'Play a song today'} value={String(a.streak)} unit={a.streak === 1 ? 'day' : 'days'} href="/achievements" />
                <StatCard label="Plays" sub="This week" value={String(a.plays)} unit={a.plays === 1 ? 'play' : 'plays'} href="/recent" />
              </ScrollView>
              <T size={13} color={colors.textSecondary}>
                {a.plays ? `${a.plays} plays this week${a.topGenre ? `, mostly ${a.topGenre}` : ''}.` : 'No plays yet this week.'}
              </T>
            </>
          ) : null}
        </View>
      ) : null}

      {show('Picks') ? (
        <View style={{ gap: 12 }}>
          <T variant="section" accessibilityRole="header">
            Weekly picks
          </T>
          {picks.map((p) => (
            <Tap key={p.title} onPress={() => router.push(p.href)} accessibilityLabel={`${p.title}. ${p.body}`}>
              <Glass radius={26} padding={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <Art art={p.art} size={52} radius={17} style={{ alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={p.icon} size={22} color={colors.white} />
                </Art>
                <View style={{ flex: 1, gap: 2 }}>
                  <T size={16} weight={500}>
                    {p.title}
                  </T>
                  <T size={13} weight={300} color={colors.textSecondary} lineHeight={18}>
                    {p.body}
                  </T>
                </View>
                <Icon name="chevronRight" size={20} color={colors.textSecondary} />
              </Glass>
            </Tap>
          ))}
          <Row gap={8} align="flex-start">
            {more.map((m) => (
              <Tap key={m.label} href={m.href} accessibilityLabel={m.label} style={{ flex: 1, alignItems: 'center', gap: 6, minWidth: 0 }}>
                <Glass radius={26} style={{ width: 52, height: 52, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={m.icon} size={22} color={colors.accentLight} />
                </Glass>
                <T size={12} weight={500} align="center" numberOfLines={1}>
                  {m.label}
                </T>
              </Tap>
            ))}
          </Row>
        </View>
      ) : null}

      {show('Create') ? (
        <Tap href="/create" accessibilityLabel="Open Create studio. Remix, slow down and split songs in the studio">
          <View style={{ minHeight: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: colors.chipOutline }}>
            <Icon name="sliders" size={18} color={colors.textSecondary} />
            <T size={14} color={colors.textSecondary}>
              Open Create studio
            </T>
          </View>
        </Tap>
      ) : null}
    </Screen>
  );
}
