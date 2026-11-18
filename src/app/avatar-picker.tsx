import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { Art, Button, Glass, Icon, Sheet, T, Tap, type IconName } from '../components';
import { FramedAvatar, MIGRATION_NOTE, PRESET_ARTS, PRESET_LABEL, artStops, initialOf, useProfileCustom, type PresetArt } from '../lib/profile-custom';
import { uploadAvatar } from '../lib/avatar';
import { useAuth } from '../state/auth';
import { colors } from '../theme/tokens';

type Source = 'camera' | 'gallery';

/** Take or pick a square photo and upload it to the public `avatars` bucket under the user's folder. */
async function captureAndUpload(userId: string, source: Source): Promise<string | null> {
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 };
  let res: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Allow camera access in Settings to take a photo.');
    res = await ImagePicker.launchCameraAsync(opts);
  } else {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) throw new Error('Allow photo access in Settings to pick a picture.');
    res = await ImagePicker.launchImageLibraryAsync(opts);
  }
  if (res.canceled || !res.assets[0]) return null;
  return uploadAvatar(userId, res.assets[0].uri, res.assets[0].mimeType);
}

/** What the Save button will write. */
type Draft = { kind: 'photo'; url: string } | { kind: 'preset'; art: PresetArt } | null;

export default function AvatarPicker() {
  const { user, profile, updateProfile } = useAuth();
  const { custom, available, save } = useProfileCustom();
  const [draft, setDraft] = useState<Draft>(null);
  const [busy, setBusy] = useState<Source | 'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!user) {
    return (
      <Sheet>
        <T variant="section">Sign in to change your photo</T>
        <Button label="Sign in" href="/login" />
      </Sheet>
    );
  }

  // What the preview shows: the staged choice, else what's saved now.
  const previewUri = draft?.kind === 'photo' ? draft.url : draft?.kind === 'preset' ? null : profile?.avatar_url;
  const previewArt = draft?.kind === 'preset' ? draft.art : custom.avatar_art;
  const selectedArt = draft?.kind === 'preset' ? draft.art : !profile?.avatar_url && draft?.kind !== 'photo' ? custom.avatar_art : null;

  const pick = async (source: Source) => {
    if (busy) return;
    setBusy(source);
    setError(null);
    try {
      const url = await captureAndUpload(user.id, source);
      if (url) setDraft({ kind: 'photo', url });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not upload your photo');
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (busy || !draft) return;
    setBusy('save');
    setError(null);
    try {
      if (draft.kind === 'photo') await updateProfile({ avatar_url: draft.url });
      else await save({ avatar_url: null, avatar_art: draft.art });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your photo');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy('remove');
    setError(null);
    try {
      await updateProfile({ avatar_url: null });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove your photo');
    } finally {
      setBusy(null);
    }
  };

  const sources: { key: Source; label: string; icon: IconName }[] = [
    { key: 'camera', label: 'Camera', icon: 'camera' },
    { key: 'gallery', label: 'Gallery', icon: 'library' },
  ];

  return (
    <Sheet gap={12}>
      <T variant="section" accessibilityRole="header">
        Profile photo
      </T>

      <View style={{ alignItems: 'center', paddingVertical: 8 }}>
        <FramedAvatar uri={previewUri} id={user.id} name={profile?.display_name} preset={previewArt} frame={custom.avatar_frame} size={104} />
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        {sources.map((s) => (
          <Tap key={s.key} accessibilityLabel={`Choose a photo from ${s.label}`} onPress={() => void pick(s.key)} style={{ flex: 1 }}>
            <Glass radius={32} style={{ height: 88, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
              {busy === s.key ? <ActivityIndicator color={colors.accent} /> : <Icon name={s.icon} size={24} color={colors.text} />}
              <T size={13} weight={600}>
                {s.label}
              </T>
            </Glass>
          </Tap>
        ))}
      </View>

      <T variant="caption" weight={700} tracking={0.5} color={colors.textSecondary}>
        GRADIENT AVATARS
      </T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ gap: 12, paddingHorizontal: 16 }}>
        {PRESET_ARTS.map((a) => {
          const on = selectedArt === a;
          return (
            <Tap
              key={a}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${PRESET_LABEL[a]} gradient avatar`}
              onPress={() => setDraft({ kind: 'preset', art: a })}
              style={{ width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: on ? colors.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}
            >
              <Art art={artStops(a)} size={48} radius={24} style={{ alignItems: 'center', justifyContent: 'center' }}>
                <T weight={700} size={18} color={colors.white}>
                  {initialOf(profile?.display_name)}
                </T>
              </Art>
            </Tap>
          );
        })}
      </ScrollView>
      {!available ? (
        <T size={12} color={colors.textSecondary} lineHeight={16}>
          {MIGRATION_NOTE}
        </T>
      ) : null}

      {error ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {error}
        </T>
      ) : null}

      {busy === 'save' ? (
        <View style={{ height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} accessibilityLabel="Saving" />
        </View>
      ) : (
        <Button label="Save photo" variant={draft && !busy ? 'primary' : 'disabled'} onPress={() => void commit()} />
      )}

      {profile?.avatar_url ? (
        <Tap accessibilityLabel="Remove photo" onPress={() => void remove()} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }}>
          {busy === 'remove' ? <ActivityIndicator color={colors.like} /> : <Icon name="trash" size={18} color={colors.like} />}
          <T size={14} weight={600} color={colors.like}>
            Remove photo
          </T>
        </Tap>
      ) : null}
    </Sheet>
  );
}
