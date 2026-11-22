import { View } from 'react-native';

import { Button, Icon, Sheet, T, Tap, type IconName, IconBadge } from '../components';
import { usePlayerPick } from '../state/player';
import { colors, withAlpha } from '../theme/tokens';

const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedLabel = (r: number) => `${Number.isInteger(r) ? r.toFixed(r === 1 ? 1 : 0) : String(r)}×`;

/**
 * What really works in this build: playback speed (applied to the native player and remembered), and Smooth
 * transition / normalisation (Settings › Playback). Slowed and Nightcore are speed presets: the native player
 * keeps the pitch where it is, so they change tempo only. The Equalizer screen saves bands to the account but the
 * native player has no equalizer stage yet, so it (and Bass boost) does not change the sound; reverb, 8D and
 * spatial audio need a real-time audio engine too. Those tiles are shown dimmed and marked unavailable instead of
 * as switches that do nothing.
 */
const GLASS = { backgroundColor: 'rgba(255,255,255,0.07)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' } as const;

type Tile = { label: string; icon: IconName; sub?: string; rate?: number };
const tiles: Tile[] = [
  { label: 'Normal', icon: 'play', rate: 1 },
  { label: 'Slowed', icon: 'moon', rate: 0.85, sub: '0.85× tempo' },
  { label: 'Nightcore', icon: 'bolt', rate: 1.25, sub: '1.25× tempo' },
  { label: '8D audio', icon: 'headphones' },
  { label: 'Bass boost', icon: 'speaker' },
  { label: 'Spatial', icon: 'spatial' },
];

const links: { title: string; sub: string; icon: IconName; href: '/equalizer' | '/playback-settings' }[] = [
  { title: 'Equalizer', sub: 'Saved to your account, not applied to the sound yet', icon: 'sliders', href: '/equalizer' },
  { title: 'Smooth transition', sub: 'Crossfade between songs and normalise volume', icon: 'bolt', href: '/playback-settings' },
];
const unavailable = ['Equalizer and Bass boost', 'Reverb', '8D audio', 'Spatial audio'];

export default function FxSheet() {
  const { rate, setRate } = usePlayerPick('rate');

  return (
    <Sheet>
      <T size={18} weight={600} accessibilityRole="header">
        Speed and sound
      </T>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {tiles.map((t) => {
          const available = t.rate !== undefined;
          const on = available && Math.abs(rate - (t.rate as number)) < 0.001;
          return (
            <Tap
              key={t.label}
              onPress={available ? () => setRate(t.rate as number) : undefined}
              disabled={!available}
              accessibilityLabel={available ? `${t.label}${t.sub ? `, ${t.sub}` : ''}` : `${t.label}, not available`}
              accessibilityState={{ disabled: !available, ...(available ? { selected: on } : null) }}
              style={[
                { width: '31.5%', flexGrow: 1, height: 78, borderRadius: 22, alignItems: 'center', justifyContent: 'center', gap: 6 },
                on ? { backgroundColor: colors.accent, shadowColor: colors.accent, shadowOpacity: 0.4, shadowRadius: 11, shadowOffset: { width: 0, height: 8 } } : GLASS,
                !available && { opacity: 0.4 },
              ]}
            >
              <Icon name={t.icon} size={22} color={colors.white} />
              <T size={12} weight={600}>
                {t.label}
              </T>
              {t.sub ? (
                <T size={10} color={on ? colors.white : colors.textSecondary} style={{ marginTop: -4 }}>
                  {t.sub}
                </T>
              ) : null}
            </Tap>
          );
        })}
      </View>

      <T size={11} weight={700} tracking={1.4} color={colors.textSecondary} style={{ marginHorizontal: 4, marginTop: 2, marginBottom: -6 }}>
        PLAYBACK SPEED
      </T>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        {speeds.map((s) => {
          const on = Math.abs(s - rate) < 0.001;
          return (
            <Tap
              key={s}
              onPress={() => setRate(s)}
              accessibilityLabel={`Speed ${speedLabel(s)}`}
              accessibilityState={{ selected: on }}
              style={[{ flex: 1, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }, on ? { backgroundColor: colors.accent } : GLASS]}
            >
              <T size={13} weight={700}>
                {speedLabel(s)}
              </T>
            </Tap>
          );
        })}
      </View>

      <View style={[{ paddingVertical: 4, paddingHorizontal: 12, borderRadius: 26 }, GLASS]}>
        {links.map((e, i) => (
          <Tap
            key={e.title}
            href={e.href}
            accessibilityLabel={`${e.title}. ${e.sub}`}
            style={[{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 4, minHeight: 62 }, i > 0 && { borderTopWidth: 1, borderTopColor: withAlpha(colors.white, 0.07) }]}
          >
            <IconBadge icon={e.icon} size={38} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <T size={15} weight={600}>
                {e.title}
              </T>
              <T size={12} color={colors.textSecondary} numberOfLines={1}>
                {e.sub}
              </T>
            </View>
            <Icon name="chevronRight" size={16} color={colors.textSecondary} />
          </Tap>
        ))}
      </View>

      <T size={12} color={colors.textSecondary}>
        {`${unavailable.join(', ')} are not available yet: they need a real-time audio engine that this player does not have. Slowed and Nightcore change the tempo only.`}
      </T>

      <Button label="Done" href="back" height={52} />
    </Sheet>
  );
}
