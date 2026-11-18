import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';

import { Art, Cover, Glass, Icon, LinkText, ListRow, Screen, ScreenHeader, SectionHeader, T, Tap, TextField, Toggle } from '../components';
import { useSpotifyLink } from '../lib/spotify';
import { uploadAvatar } from '../lib/avatar';
import { useAuth } from '../state/auth';
import { colors, fonts } from '../theme/tokens';

const USERNAME_RE = /^[a-z0-9_.]{3,30}$/;

/** Pick a square photo and upload it to the public `avatars` bucket under the user's folder. */
async function pickAndUploadAvatar(userId: string): Promise<string | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Allow photo access in Settings to change your picture.');
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
  if (res.canceled || !res.assets[0]) return null;
  return uploadAvatar(userId, res.assets[0].uri, res.assets[0].mimeType);
}

export default function EditProfile() {
  const { user, profile, settings, updateProfile, updateSettings } = useAuth();
  const [name, setName] = useState(profile?.display_name ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [bioFocused, setBioFocused] = useState(false);
  const [isPublic, setPublic] = useState(!(profile?.is_private ?? false));
  const [activity, setActivity] = useState(settings?.privacy.listening_activity ?? true);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; username?: string; form?: string }>({});
  const [note, setNote] = useState<{ text: string; ok: boolean }>();
  const [photoOk, setPhotoOk] = useState(false);
  const spotify = useSpotifyLink();

  const initial = (name || profile?.display_name || 'Z').trim().charAt(0).toUpperCase();

  const changePhoto = async () => {
    if (uploading) return;
    if (!user) return setErrors((e) => ({ ...e, form: 'Sign in to change your photo.' }));
    setUploading(true);
    setPhotoOk(false);
    setErrors((e) => ({ ...e, form: undefined }));
    try {
      const url = await pickAndUploadAvatar(user.id);
      if (url) {
        await updateProfile({ avatar_url: url });
        setPhotoOk(true);
      }
    } catch (e) {
      setErrors((x) => ({ ...x, form: e instanceof Error ? e.message : 'Could not update your photo' }));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (saving) return;
    if (!user) return setErrors({ form: 'Sign in to edit your profile.' });
    const u = username.trim().toLowerCase();
    const next: typeof errors = {};
    if (!name.trim()) next.name = 'Display name cannot be empty';
    if (u && !USERNAME_RE.test(u)) next.username = '3–30 characters: lowercase letters, numbers, _ or .';
    setErrors(next);
    if (next.name || next.username) return;
    setSaving(true);
    try {
      await updateProfile({ display_name: name.trim(), username: u || null, bio: bio.trim(), is_private: !isPublic });
      if (settings && settings.privacy.listening_activity !== activity) {
        await updateSettings({ privacy: { ...settings.privacy, listening_activity: activity } });
      }
      router.back();
    } catch (e) {
      const m = e instanceof Error ? e.message : 'Could not save your profile';
      if (/duplicate|unique/i.test(m)) setErrors({ username: 'That username is taken' });
      else setErrors({ form: m });
    } finally {
      setSaving(false);
    }
  };

  const linkSpotify = async () => {
    if (spotify.busy) return;
    setNote(undefined);
    try {
      if (spotify.account) {
        await spotify.disconnect();
        return setNote({ ok: true, text: 'Spotify disconnected. Your imported playlists stay in your library.' });
      }
      const r = await spotify.connect();
      if (r) setNote({ ok: r.ok, text: r.message });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not update the Spotify link.' });
    }
  };

  return (
    <Screen backdrop={{ pattern: 'lines', mesh: 'peach' }} top={4} gap={16}>
      <ScreenHeader
        title="Edit profile"
        right={saving ? <ActivityIndicator color={colors.accent} /> : <LinkText label="Save" onPress={() => void save()} />}
      />

      <View style={{ alignItems: 'center' }}>
        <Tap accessibilityLabel="Change photo" onPress={() => void changePhoto()} style={{ width: 104, height: 104 }}>
          {profile?.avatar_url ? (
            <Cover uri={profile.avatar_url} id={user?.id} size={104} radius={52} />
          ) : (
            <Art art="coral" size={104} radius={52} style={{ alignItems: 'center', justifyContent: 'center' }}>
              <T size={36} weight={700}>
                {initial}
              </T>
            </Art>
          )}
          {uploading ? (
            <View style={{ position: 'absolute', inset: 0, borderRadius: 52, backgroundColor: colors.shade, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={colors.white} />
            </View>
          ) : null}
          <View
            style={{
              position: 'absolute',
              right: -2,
              bottom: -2,
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: colors.accent,
              borderWidth: 3,
              borderColor: colors.bg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Icon name="camera" size={18} color={colors.onAccent} />
          </View>
        </Tap>
      </View>

      {photoOk && !errors.form ? (
        <T size={13} color={colors.success} align="center" accessibilityLiveRegion="polite">
          Profile photo updated.
        </T>
      ) : null}
      {errors.form ? (
        <T size={13} color={colors.error} align="center" accessibilityLiveRegion="polite">
          {errors.form}
        </T>
      ) : null}

      <TextField label="Display name" placeholder="Name" value={name} onChangeText={setName} error={errors.name} />
      <TextField label="Username" placeholder="username" value={username} onChangeText={(v) => setUsername(v.toLowerCase())} autoCapitalize="none" autoCorrect={false} error={errors.username} />

      <View style={{ gap: 6 }}>
        <T variant="caption" color={colors.textSecondary}>
          Bio
        </T>
        <TextInput
          accessibilityLabel="Bio"
          multiline
          value={bio}
          onChangeText={setBio}
          maxLength={160}
          placeholder="A line about your taste"
          onFocus={() => setBioFocused(true)}
          onBlur={() => setBioFocused(false)}
          placeholderTextColor={colors.textTertiary}
          style={{
            height: 96,
            borderRadius: 20,
            backgroundColor: colors.bgTertiary,
            borderWidth: 1,
            borderColor: bioFocused ? colors.accent : colors.border,
            paddingVertical: 12,
            paddingHorizontal: 14,
            color: colors.text,
            fontFamily: fonts.regular,
            fontSize: 16,
            textAlignVertical: 'top',
          }}
        />
      </View>

      <Glass padding={4}>
        <ListRow title="Public profile" subtitle="Anyone can see your playlists" minHeight={64} right={<Toggle label="Public profile" value={isPublic} onChange={setPublic} />} />
        <ListRow divider title="Show listening activity" subtitle="Friends see what you play" minHeight={64} right={<Toggle label="Show activity" value={activity} onChange={setActivity} />} />
      </Glass>

      <SectionHeader title="Linked accounts" />
      <Glass padding={4}>
        <ListRow
          title="Spotify"
          subtitle={
            spotify.account === undefined
              ? 'Checking…'
              : spotify.account
                ? `Connected as ${spotify.account}`
                : spotify.configured
                  ? 'Not connected'
                  : 'Needs Spotify app setup'
          }
          minHeight={64}
          right={
            spotify.busy || spotify.account === undefined ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <LinkText label={spotify.account ? 'Disconnect' : 'Connect'} onPress={() => void linkSpotify()} />
            )
          }
        />
        <ListRow divider title="Apple Music" subtitle="Not available in this version. It needs a signed MusicKit token." minHeight={64} right={false} />
      </Glass>
      {note ? (
        <T size={13} lineHeight={18} color={note.ok ? colors.textSecondary : colors.error} align="center" accessibilityLiveRegion="polite">
          {note.text}
        </T>
      ) : null}
    </Screen>
  );
}
