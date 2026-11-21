import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { Art, Cover, Glass, Icon, LinkText, ListRow, Row, Screen, ScreenHeader, SectionHeader, T, Tap, Toggle } from '../components';
import { uploadBanner } from '../lib/avatar';
import { bannerUnlockLevel, frameUnlockLevel, useProgress } from '../lib/levels';
import {
  FRAMES,
  FRAME_LABEL,
  FramedAvatar,
  MIGRATION_NOTE,
  PRESET_ARTS,
  PRESET_LABEL,
  ProfileBanner,
  artStops,
  useProfileCustom,
  type FrameKey,
  type PresetArt,
  type ProfileCustom,
} from '../lib/profile-custom';
import type { CatalogTrack } from '../lib/catalog';
import { useAuth } from '../state/auth';
import { useLibrary } from '../state/library';
import { colors } from '../theme/tokens';

const MAX_PINS = 3;

export default function CustomizeProfile() {
  const { user, profile, settings, updateSettings } = useAuth();
  const { custom, available, save } = useProfileCustom();
  const progress = useProgress(user?.id);
  const lib = useLibrary();
  const level = progress.data?.level.level ?? 1;

  const [draft, setDraft] = useState<ProfileCustom>(custom);
  const [nowPlaying, setNowPlaying] = useState(settings?.privacy.listening_activity ?? true);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  // Pick up the saved values once the profile loads/refreshes.
  const [base, setBase] = useState(custom);
  if (base !== custom) {
    setBase(custom);
    setDraft(custom);
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(custom) || nowPlaying !== (settings?.privacy.listening_activity ?? true);

  const locked = (need: number) => level < need;
  const lockedNote = (need: number) => setNote({ text: `Reach level ${need} to unlock this. See Levels and perks.`, error: true });

  const done = async () => {
    if (saving) return;
    if (!dirty) return router.back();
    setSaving(true);
    setNote(null);
    try {
      if (settings && settings.privacy.listening_activity !== nowPlaying) {
        await updateSettings({ privacy: { ...settings.privacy, listening_activity: nowPlaying } });
      }
      if (JSON.stringify(draft) !== JSON.stringify(custom)) {
        await save({ banner_art: draft.banner_art, banner_url: draft.banner_url, avatar_frame: draft.avatar_frame, showcase: draft.showcase, pinned_tracks: draft.pinned_tracks });
      }
      router.back();
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not save your changes', error: true });
    } finally {
      setSaving(false);
    }
  };

  const [uploading, setUploading] = useState(false);
  // Pick a wide photo, upload it to the public avatars bucket, stage it in the draft (saved with Done).
  const pickBanner = async () => {
    if (!user || uploading) return;
    setUploading(true);
    setNote(null);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) throw new Error('Allow photo access in Settings to pick a banner.');
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [16, 9], quality: 0.8 });
      if (res.canceled || !res.assets[0]) return;
      const url = await uploadBanner(user.id, res.assets[0].uri, res.assets[0].mimeType);
      setDraft((d) => ({ ...d, banner_url: url }));
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : 'Could not upload your banner', error: true });
    } finally {
      setUploading(false);
    }
  };

  const togglePin = (t: CatalogTrack) => {
    const has = draft.pinned_tracks.some((p) => p.id === t.id);
    if (!has && draft.pinned_tracks.length >= MAX_PINS) return setNote({ text: `You can pin up to ${MAX_PINS} songs.`, error: true });
    setDraft((d) => ({ ...d, pinned_tracks: has ? d.pinned_tracks.filter((p) => p.id !== t.id) : [...d.pinned_tracks, t] }));
  };

  const show = (k: keyof ProfileCustom['showcase'], v: boolean) => setDraft((d) => ({ ...d, showcase: { ...d.showcase, [k]: v } }));

  return (
    <Screen top={4} gap={16} backdrop={{ pattern: 'dots', mesh: 'rose' }}>
      <ScreenHeader
        title="Customize"
        right={saving ? <ActivityIndicator color={colors.accent} accessibilityLabel="Saving" /> : <LinkText label="Done" onPress={() => void done()} />}
      />

      {/* Banner + avatar */}
      <View style={{ marginBottom: 20 }}>
        <ProfileBanner banner={draft.banner_art} uri={draft.banner_url} />
        <View style={{ position: 'absolute', left: 16, bottom: -30 }}>
          <FramedAvatar
            uri={profile?.avatar_url}
            id={user?.id}
            name={profile?.display_name}
            preset={custom.avatar_art}
            frame={draft.avatar_frame}
            size={76}
            level={progress.data ? level : undefined}
          />
        </View>
        <Tap
          href="/avatar-picker"
          accessibilityLabel="Change avatar"
          style={{ position: 'absolute', right: 12, bottom: 12, height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: colors.overlay, flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <Icon name="camera" size={16} color={colors.text} />
          <T size={13} weight={600}>
            Change
          </T>
        </Tap>
      </View>

      {!available ? (
        <Glass padding={14}>
          <Row align="flex-start">
            <Icon name="info" size={20} color={colors.amber} />
            <T size={13} color={colors.textSecondary} lineHeight={18} style={{ flex: 1 }}>
              {MIGRATION_NOTE}
            </T>
          </Row>
        </Glass>
      ) : null}

      {/* Banner */}
      <SectionHeader title="Banner" action="Perks" href="/level-perks" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
        <Tap
          onPress={() => void pickBanner()}
          accessibilityLabel={uploading ? 'Uploading banner photo' : 'Upload banner photo'}
          style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: draft.banner_url ? colors.accent : colors.chipOutline, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iconGhost }}
        >
          {uploading ? <ActivityIndicator color={colors.accent} /> : <Icon name="camera" size={22} color={colors.text} glow={false} />}
        </Tap>
        {draft.banner_url ? (
          <Tap
            onPress={() => setDraft((d) => ({ ...d, banner_url: null }))}
            accessibilityLabel="Remove banner photo"
            style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: colors.chipOutline, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.iconGhost }}
          >
            <Icon name="close" size={20} color={colors.text} glow={false} />
          </Tap>
        ) : null}
        {PRESET_ARTS.map((a: PresetArt) => {
          const need = bannerUnlockLevel(a);
          const lock = locked(need);
          const on = draft.banner_art === a;
          return (
            <Tap
              key={a}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: lock }}
              accessibilityLabel={`${PRESET_LABEL[a]} banner${lock ? `, unlocks at level ${need}` : ''}`}
              onPress={() => (lock ? lockedNote(need) : setDraft((d) => ({ ...d, banner_art: a })))}
              style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: on ? colors.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}
            >
              <Art art={artStops(a)} size={52} radius={26} style={{ alignItems: 'center', justifyContent: 'center', opacity: lock ? 0.45 : 1 }}>
                {lock ? <Icon name="lock" size={18} color={colors.white} /> : null}
              </Art>
            </Tap>
          );
        })}
      </ScrollView>

      {/* Frame */}
      <SectionHeader title="Avatar frame" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16, flexGrow: 0 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16, paddingTop: 6 }}>
        {FRAMES.map((f: FrameKey) => {
          const need = frameUnlockLevel(f);
          const lock = locked(need);
          const on = draft.avatar_frame === f;
          return (
            <Tap
              key={f}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: lock }}
              accessibilityLabel={`${FRAME_LABEL[f]} frame${lock ? `, unlocks at level ${need}` : ''}`}
              onPress={() => (lock ? lockedNote(need) : setDraft((d) => ({ ...d, avatar_frame: f })))}
              style={{ alignItems: 'center', gap: 4 }}
            >
              <View style={{ opacity: lock ? 0.45 : 1 }}>
                <FramedAvatar uri={profile?.avatar_url} id={user?.id} name={profile?.display_name} preset={custom.avatar_art} frame={f} size={64} />
              </View>
              {on ? (
                <View style={{ position: 'absolute', top: -4, right: -4, width: 22, height: 22, borderRadius: 11, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="check" size={14} color={colors.onAccent} />
                </View>
              ) : null}
              <T size={11} color={lock ? colors.textTertiary : colors.textSecondary}>
                {lock ? `Level ${need}` : FRAME_LABEL[f]}
              </T>
            </Tap>
          );
        })}
      </ScrollView>

      {/* Showcase */}
      <SectionHeader title="Show on profile" />
      <Glass padding={4}>
        <ListRow title="Now playing" subtitle="Friends see it live" icon="speaker" right={<Toggle label="Now playing" value={nowPlaying} onChange={setNowPlaying} />} />
        <ListRow
          divider
          title="Pinned songs"
          subtitle={draft.pinned_tracks.length ? `${draft.pinned_tracks.length} of ${MAX_PINS} pinned` : `Up to ${MAX_PINS} tracks`}
          icon="pin"
          right={<Toggle label="Pinned songs" value={draft.showcase.pinned} onChange={(v) => show('pinned', v)} />}
        />
        <ListRow divider title="Badges" subtitle="Top 4 badges" icon="trophy" right={<Toggle label="Badges" value={draft.showcase.badges} onChange={(v) => show('badges', v)} />} />
        <ListRow divider title="Taste DNA" subtitle="Genre breakdown" icon="sliders" right={<Toggle label="Taste DNA" value={draft.showcase.taste} onChange={(v) => show('taste', v)} />} />
      </Glass>

      {draft.showcase.pinned ? (
        <View style={{ gap: 8 }}>
          <SectionHeader title="Pinned songs" action={choosing ? 'Close' : 'Choose'} onAction={() => setChoosing((c) => !c)} />
          {draft.pinned_tracks.length === 0 && !choosing ? (
            <T size={13} color={colors.textSecondary}>
              No songs pinned yet. Choose up to {MAX_PINS} from your liked songs.
            </T>
          ) : null}
          {(choosing ? lib.liked.slice(0, 50) : draft.pinned_tracks).map((t) => {
            const on = draft.pinned_tracks.some((p) => p.id === t.id);
            return (
              <Tap
                key={t.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${t.title} by ${t.artist.name}`}
                onPress={() => togglePin(t)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }}
              >
                <Cover artwork={t.artwork} id={t.id} size={44} radius={12} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <T size={15} weight={500} numberOfLines={1}>
                    {t.title}
                  </T>
                  <T size={13} color={colors.textSecondary} numberOfLines={1}>
                    {t.artist.name}
                  </T>
                </View>
                <Icon name={on ? 'checkBold' : 'plus'} size={20} color={on ? colors.accent : colors.textSecondary} />
              </Tap>
            );
          })}
          {choosing && lib.liked.length === 0 ? (
            <T size={13} color={colors.textSecondary}>
              Like some songs first, then pin your favourites here.
            </T>
          ) : null}
        </View>
      ) : null}

      {note ? (
        <T size={13} color={note.error ? colors.error : colors.textSecondary} align="center" accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
      {progress.error ? (
        <T size={12} color={colors.textSecondary} align="center">
          Couldn’t load your level, so level perks show as locked. {progress.error}
        </T>
      ) : null}
    </Screen>
  );
}
