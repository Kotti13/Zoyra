import { useState, useSyncExternalStore } from 'react';
import { ScrollView, View } from 'react-native';

import { Gradient, Icon, IconTile, Row, Screen, T, Tap, type IconName, type NavTarget } from '../components';
import { radioState } from '../lib/radio';
import { usePlayerPick } from '../state/player';
import { art, artCycle, colors, withAlpha } from '../theme/tokens';

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

function Tile({ e, i }: { e: Entry; i: number }) {
  return (
    <Tap href={e.href} accessibilityLabel={`${e.title}. ${e.subtitle}`} style={{ width: '48.5%' }} pressScale={0.97}>
      <Gradient colors={art[artCycle[i % artCycle.length]]} style={{ height: 128, borderRadius: 28, overflow: 'hidden' }}>
        {/* Big faint glyph in the corner: gives each tile its own character */}
        <View pointerEvents="none" style={{ position: 'absolute', right: -10, top: -8, transform: [{ rotate: '-14deg' }], opacity: 0.2 }}>
          <Icon name={e.icon} size={92} color={colors.white} strokeWidth={1.4} glow={false} />
        </View>
        <Gradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.8)]} angle={180} style={{ flex: 1, justifyContent: 'flex-end', paddingLeft: 14, paddingRight: 10, paddingBottom: 12, gap: 2 }}>
          <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: withAlpha(colors.white, 0.22), borderWidth: 1, borderColor: withAlpha(colors.white, 0.35), alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
            <Icon name={e.icon} size={19} color={colors.white} strokeWidth={2} glow={false} />
          </View>
          <T size={16} weight={700} numberOfLines={1}>
            {e.title}
          </T>
          <T size={11} color={colors.peach} numberOfLines={1}>
            {e.subtitle}
          </T>
        </Gradient>
      </Gradient>
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
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'coral' }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T size={36} weight={300} tracking={-1} accessibilityRole="header" style={{ flex: 1 }} numberOfLines={1}>
          Entertainment
        </T>
        <Tap href="/search" accessibilityLabel="Search" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: withAlpha(colors.white, 0.1), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="search" size={20} />
        </Tap>
      </Row>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {FILTERS.map((label, i) => (
          <Tap key={label} onPress={() => setFilter(i)} accessibilityState={{ selected: filter === i }}>
            <View
              style={[
                { height: 38, paddingHorizontal: 16, borderRadius: 19, justifyContent: 'center' },
                filter === i ? { backgroundColor: colors.text } : { backgroundColor: withAlpha(colors.white, 0.06), borderWidth: 1, borderColor: withAlpha(colors.white, 0.12) },
              ]}
            >
              <T size={13} weight={600} color={filter === i ? colors.playerBg : colors.text}>
                {label}
              </T>
            </View>
          </Tap>
        ))}
      </ScrollView>

      {cat === 'For you' || cat === 'Play' ? (
        <Tap href="/beat-game" accessibilityLabel="Play Beat Rush, a rhythm game">
          <Gradient colors={art.red} style={{ borderRadius: 32, height: 210, overflow: 'hidden' }}>
            <View pointerEvents="none" style={{ position: 'absolute', right: '-12%', top: '6%', width: '70%', aspectRatio: 1, borderRadius: 999, borderWidth: 1, borderColor: withAlpha(colors.white, 0.18) }} />
            <View pointerEvents="none" style={{ position: 'absolute', right: '6%', top: '14%', width: '36%', aspectRatio: 1, borderRadius: 999, backgroundColor: withAlpha(colors.white, 0.18) }} />
            <Gradient colors={[withAlpha(colors.bg, 0), withAlpha(colors.bg, 0.9)]} angle={180} style={{ flex: 1, justifyContent: 'space-between', padding: 14 }}>
              <View style={{ alignSelf: 'flex-start', height: 26, paddingHorizontal: 12, borderRadius: 13, backgroundColor: withAlpha(colors.black, 0.5), justifyContent: 'center' }}>
                <T size={11} weight={700} tracking={0.6}>
                  RHYTHM GAME
                </T>
              </View>
              <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 4, paddingBottom: 2 }}>
                <View style={{ flex: 1, gap: 4 }}>
                  <T size={30} weight={300} tracking={-1} lineHeight={30}>
                    Beat <T size={30} weight={800} tracking={-1}>Rush</T>
                  </T>
                  <T size={13} color={colors.peach} numberOfLines={2}>
                    Tap along to a real track and beat your best
                  </T>
                </View>
                <View style={{ height: 42, paddingHorizontal: 20, borderRadius: 21, backgroundColor: colors.accent, justifyContent: 'center' }}>
                  <T size={14} weight={700} color={colors.onAccent}>
                    Play
                  </T>
                </View>
              </Row>
            </Gradient>
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

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 12 }}>
        {shown.map((e, i) => (
          <Tile key={e.title} e={e} i={i} />
        ))}
      </View>
    </Screen>
  );
}
