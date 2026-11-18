import { useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';

import { ChipRow, Gradient, Icon, IconTile, Row, Screen, ScreenHeader, SectionHeader, T, Tap, type IconName, type NavTarget } from '../components';
import { radioState } from '../lib/radio';
import { usePlayerPick } from '../state/player';
import { art, colors } from '../theme/tokens';

type Category = 'Listen' | 'Play' | 'Watch' | 'Community';
type Entry = { title: string; subtitle: string; icon: IconName; href: NavTarget; color: string; cat: Category };

/** Every entry opens a real screen. */
const ENTRIES: Entry[] = [
  { title: 'Radio', subtitle: 'Endless stations', icon: 'cast', href: '/radio', color: colors.accentLight, cat: 'Listen' },
  { title: 'Audiobooks', subtitle: 'Free classics to listen to', icon: 'file', href: '/audiobooks', color: colors.orange, cat: 'Listen' },
  { title: 'Wind down', subtitle: 'Sleep, focus and breathing', icon: 'moon', href: '/wellness', color: colors.info, cat: 'Listen' },
  { title: 'Podcasts', subtitle: 'Shows and episodes', icon: 'mic', href: '/podcasts', color: colors.gold, cat: 'Listen' },
  { title: 'Games', subtitle: 'Play along to real songs', icon: 'bolt', href: '/games', color: colors.gold, cat: 'Play' },
  { title: 'Rewards', subtitle: 'Your level and perks', icon: 'trophy', href: '/rewards', color: colors.amber, cat: 'Play' },
  { title: 'Music videos', subtitle: 'Videos, shorts and live sets', icon: 'play', href: '/videos', color: colors.accentLight, cat: 'Watch' },
  { title: 'Live', subtitle: 'Listen along with hosts', icon: 'users', href: '/live-hub', color: colors.live, cat: 'Watch' },
  { title: 'Tickets', subtitle: 'Shows near you', icon: 'pin', href: '/tickets', color: colors.rose, cat: 'Watch' },
  { title: 'Concerts', subtitle: 'Full concert listings', icon: 'star', href: '/concerts', color: colors.orange, cat: 'Watch' },
  { title: 'Community', subtitle: 'The fan feed', icon: 'mail', href: '/community', color: colors.mint, cat: 'Community' },
  { title: 'Support artists', subtitle: 'Their own links and tips', icon: 'heart', href: '/merch', color: colors.like, cat: 'Community' },
];

const FILTERS = ['For you', 'Listen', 'Play', 'Watch', 'Community'] as const;

function Tile({ e }: { e: Entry }) {
  return (
    <Tap href={e.href} accessibilityLabel={`${e.title}. ${e.subtitle}`} style={{ width: '48%' }} pressScale={0.97}>
      <View style={{ minHeight: 132, borderRadius: 28, padding: 16, gap: 10, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.glassBorder }}>
        <IconTile icon={e.icon} color={e.color} size={44} />
        <View style={{ gap: 2 }}>
          <T size={16} weight={600} numberOfLines={1}>
            {e.title}
          </T>
          <T size={13} color={colors.textSecondary} numberOfLines={2}>
            {e.subtitle}
          </T>
        </View>
      </View>
    </Tap>
  );
}

export default function EntertainHub() {
  const [filter, setFilter] = useState(0);
  const station = useSyncExternalStore(radioState.subscribe, radioState.current, radioState.current);
  const { track, playing } = usePlayerPick('track', 'playing');
  const cat = FILTERS[filter];
  const shown = cat === 'For you' ? ENTRIES : ENTRIES.filter((e) => e.cat === cat);

  return (
    <Screen top={4} gap={20} backdrop={{ pattern: 'none' }}>
      <ScreenHeader title="" right={<Tap href="/search" accessibilityLabel="Search" style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="search" size={22} /></Tap>} />
      <View style={{ gap: 4 }}>
        <T variant="displayLight" accessibilityRole="header">
          Entertainment
        </T>
        <T size={15} color={colors.textSecondary}>
          Radio, stories, games, shows and more
        </T>
      </View>

      <ChipRow options={[...FILTERS]} initial={0} onChange={setFilter} />

      {cat === 'For you' || cat === 'Play' ? (
        <Tap href="/beat-game" accessibilityLabel="Play Beat Rush, a rhythm game">
          <Gradient colors={art.red} style={{ borderRadius: 32, padding: 22, minHeight: 190, justifyContent: 'flex-end', overflow: 'hidden' }}>
            <View style={{ position: 'absolute', top: 20, right: 20 }}>
              <Icon name="bolt" size={64} color={colors.white} strokeWidth={1.2} />
            </View>
            <T variant="overline" color={colors.white}>
              RHYTHM GAME
            </T>
            <T size={44} weight={300} tracking={-1.5} color={colors.white} lineHeight={48}>
              Beat <T size={44} weight={800} color={colors.white}>Rush</T>
            </T>
            <Row style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <T size={13} color={colors.white} style={{ opacity: 0.85, flex: 1 }}>
                Tap along to a real track and beat your best
              </T>
              <View style={{ height: 40, paddingHorizontal: 20, borderRadius: 20, backgroundColor: colors.white, justifyContent: 'center' }}>
                <T size={14} weight={700} color={colors.onLight}>
                  Play
                </T>
              </View>
            </Row>
          </Gradient>
        </Tap>
      ) : null}

      {station && (cat === 'For you' || cat === 'Listen') ? (
        <Tap href="/radio" accessibilityLabel={`${station.title} is on. Open Radio`}>
          <View style={{ borderRadius: 26, padding: 14, backgroundColor: colors.accentTint, borderWidth: 1, borderColor: colors.glassBorder }}>
            <Row>
              <IconTile icon="cast" color={colors.accentLight} size={40} />
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="overline" color={colors.accentLight}>
                  {playing ? 'ON NOW' : 'PAUSED'}
                </T>
                <T size={15} weight={600} numberOfLines={1}>
                  {station.title}
                </T>
                {track ? (
                  <T size={13} color={colors.textSecondary} numberOfLines={1}>
                    {track.title} · {track.artist.name}
                  </T>
                ) : null}
              </View>
              <Icon name="chevronRight" size={18} color={colors.textSecondary} />
            </Row>
          </View>
        </Tap>
      ) : null}

      <SectionHeader title={cat === 'For you' ? 'Explore' : cat} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 }}>
        {shown.map((e) => (
          <Tile key={e.title} e={e} />
        ))}
      </View>
    </Screen>
  );
}
