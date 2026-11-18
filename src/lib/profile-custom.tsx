/**
 * Profile customisation: preset gradient avatar, banner, avatar frame, what to show on the profile and
 * pinned songs. Stored on `profiles` (migration 20261113210000_profile_custom.sql):
 *   avatar_art   text   — preset gradient key, used when avatar_url is null
 *   banner_art   text   — banner gradient key
 *   avatar_frame text   — ring around the avatar
 *   showcase     jsonb  — { pinned, badges, taste } toggles
 *   pinned_tracks jsonb — up to 3 CatalogTrack snapshots
 * `avatar_url` stays an image URL only, so every existing <Cover uri={avatar_url}> keeps working.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { Art, Cover, Gradient, Sticker, T, artFor } from '../components';
import type { CatalogTrack } from './catalog';
import { supabase } from './supabase';
import { useAuth } from '../state/auth';
import { art, colors, radius, type ArtName } from '../theme/tokens';

/* ------------------------------------------------------------------ palettes */

type Stops = readonly [string, string, ...string[]];

const artTable = art as unknown as Record<string, readonly [string, string] | undefined>;
const tok = colors as unknown as Record<string, string | undefined>;
/** Violet arrives with the "glass 2" tokens; fall back to rose until then. */
export const violet = tok.violet ?? colors.rose;

/** Deep link that opens someone's public profile (scanned from Profile QR). */
export const profileLink = (id: string) => `zoyra://public-profile?id=${encodeURIComponent(id)}`;

/** Preset avatar / banner gradients (the six art gradients of the design). */
export const PRESET_ARTS = ['coral', 'violet', 'rose', 'amber', 'blue', 'green'] as const;
export type PresetArt = (typeof PRESET_ARTS)[number];

export const PRESET_LABEL: Record<PresetArt, string> = { coral: 'Cyan', violet: 'Violet', rose: 'Rose', amber: 'Amber', blue: 'Blue', green: 'Green' };

export function artStops(key: string | null | undefined): readonly [string, string] {
  return (key && artTable[key]) || (key === 'violet' ? [violet, colors.bgTertiary] : art.coral);
}

export const FRAMES = ['glow', 'sunset', 'mint', 'none', 'rainbow', 'gold'] as const;
export type FrameKey = (typeof FRAMES)[number];

export const FRAME_LABEL: Record<FrameKey, string> = { glow: 'Glow', sunset: 'Sunset', mint: 'Mint', none: 'Plain', rainbow: 'Rainbow', gold: 'Legend gold' };

export function frameStops(f: FrameKey): Stops {
  switch (f) {
    case 'glow':
      return [colors.accent, violet, colors.like];
    case 'sunset':
      return [colors.amber, colors.like];
    case 'mint':
      return [colors.success, colors.info];
    case 'rainbow':
      return [colors.like, colors.amber, colors.success, colors.info, colors.accent];
    case 'gold':
      return [colors.amber, colors.white, colors.amber];
    case 'none':
      return [colors.track, colors.track];
  }
}

/* ------------------------------------------------------------------ data */

export type Showcase = { pinned: boolean; badges: boolean; taste: boolean };

export type ProfileCustom = {
  avatar_art: PresetArt | null;
  banner_art: PresetArt;
  avatar_frame: FrameKey;
  showcase: Showcase;
  pinned_tracks: CatalogTrack[];
};

/** Columns to select when reading another user's profile (public-profile). */
export const CUSTOM_COLS = 'avatar_art, banner_art, avatar_frame, showcase, pinned_tracks';

export const DEFAULT_CUSTOM: ProfileCustom = {
  avatar_art: null,
  banner_art: 'coral',
  avatar_frame: 'glow',
  showcase: { pinned: true, badges: true, taste: true },
  pinned_tracks: [],
};

const isPreset = (v: unknown): v is PresetArt => typeof v === 'string' && (PRESET_ARTS as readonly string[]).includes(v);
const isFrame = (v: unknown): v is FrameKey => typeof v === 'string' && (FRAMES as readonly string[]).includes(v);

/** Read the customisation fields from any profiles row (unknown/missing values fall back to defaults). */
export function parseCustom(row: unknown): ProfileCustom {
  const r = (row ?? {}) as Record<string, unknown>;
  const sc = (r.showcase ?? {}) as Record<string, unknown>;
  const pins = Array.isArray(r.pinned_tracks) ? (r.pinned_tracks as CatalogTrack[]).filter((t) => t && typeof t.id === 'string').slice(0, 3) : [];
  return {
    avatar_art: isPreset(r.avatar_art) ? r.avatar_art : null,
    banner_art: isPreset(r.banner_art) ? r.banner_art : DEFAULT_CUSTOM.banner_art,
    avatar_frame: isFrame(r.avatar_frame) ? r.avatar_frame : DEFAULT_CUSTOM.avatar_frame,
    showcase: {
      pinned: typeof sc.pinned === 'boolean' ? sc.pinned : true,
      badges: typeof sc.badges === 'boolean' ? sc.badges : true,
      taste: typeof sc.taste === 'boolean' ? sc.taste : true,
    },
    pinned_tracks: pins,
  };
}

export const MIGRATION_NOTE = 'Profile customisation needs the latest database update. Ask the team to apply migration 20261113210000_profile_custom.';

/** The signed-in user's customisation, plus a saver. `available` is false until the migration is applied. */
export function useProfileCustom() {
  const { user, profile, refresh } = useAuth();
  const raw = profile as unknown as Record<string, unknown> | null;
  const available = !!raw && 'avatar_frame' in raw;
  const custom = useMemo(() => parseCustom(raw), [raw]);

  const save = useCallback(
    async (patch: Partial<ProfileCustom> & { avatar_url?: string | null }) => {
      if (!user) throw new Error('Sign in first');
      if (!available && Object.keys(patch).some((k) => k !== 'avatar_url')) throw new Error(MIGRATION_NOTE);
      const { error } = await supabase
        .from('profiles')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      if (error) throw new Error(/column .* does not exist|schema cache/i.test(error.message) ? MIGRATION_NOTE : error.message);
      await refresh();
    },
    [user, available, refresh],
  );

  return { custom, available, save };
}

/* ------------------------------------------------------------------ views */

export const initialOf = (name: string | null | undefined) => (name || 'Z').trim().charAt(0).toUpperCase() || 'Z';

/**
 * Avatar with the user's frame ring: photo if there is one, else their preset gradient
 * (or a stable gradient from their id) with their initial. Optional level sticker.
 */
export function FramedAvatar({
  uri,
  id,
  name,
  preset,
  frame = 'glow',
  size = 48,
  level,
  style,
}: {
  uri?: string | null;
  id?: string;
  name?: string | null;
  preset?: string | null;
  frame?: FrameKey;
  size?: number;
  level?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pad = size >= 64 ? 5 : size >= 40 ? 4 : 2;
  const border = size >= 40 ? 3 : 2;
  const inner = size - pad * 2;
  const face = inner - border * 2;
  const letter = initialOf(name);
  const fill = preset ? artStops(preset) : (art[artFor(id) as ArtName] as readonly [string, string]);
  return (
    <View style={[{ width: size, height: size }, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Gradient colors={frameStops(frame)} style={{ width: size, height: size, borderRadius: size / 2, padding: pad }}>
        <View style={{ width: inner, height: inner, borderRadius: inner / 2, borderWidth: border, borderColor: colors.bg, overflow: 'hidden' }}>
          {uri ? (
            <Cover uri={uri} id={id} size={face} radius={face / 2} />
          ) : (
            <Art art={fill} size={face} radius={face / 2} style={{ alignItems: 'center', justifyContent: 'center' }}>
              <T weight={700} size={Math.round(size * 0.33)} color={colors.white}>
                {letter}
              </T>
            </Art>
          )}
        </View>
      </Gradient>
      {level ? <Sticker label={String(level)} style={{ position: 'absolute', right: -4, bottom: 2, borderWidth: 3, borderColor: colors.bg, paddingHorizontal: 8 }} /> : null}
    </View>
  );
}

/** Profile banner strip in the chosen gradient. */
export function ProfileBanner({ banner, height = 120, children }: { banner: string; height?: number; children?: ReactNode }) {
  const [a, b] = artStops(banner);
  return (
    <Gradient colors={[a, b, violet]} style={{ height, borderRadius: radius.xxl, overflow: 'hidden' }}>
      {children}
    </Gradient>
  );
}
