import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Cover, Icon, ModalCard, Row, Segmented, T, Tap, TextField } from '../components';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { useLibrary, type UserPlaylist } from '../state/library';
import { colors, shadow } from '../theme/tokens';

const visibilities: UserPlaylist['visibility'][] = ['public', 'private', 'collaborative'];

/** Upload a picked image to the public `covers` bucket under the user's folder; returns its public URL. */
async function uploadCover(userId: string, playlistId: string, asset: ImagePicker.ImagePickerAsset) {
  const ext = (asset.mimeType?.split('/')[1] ?? asset.uri.split('.').pop() ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const path = `${userId}/${playlistId}-${Date.now()}.${ext}`;
  const body = await (await fetch(asset.uri)).arrayBuffer();
  const { error } = await supabase.storage.from('covers').upload(path, body, { contentType: asset.mimeType ?? 'image/jpeg', upsert: true });
  if (error) throw new Error(error.message);
  return supabase.storage.from('covers').getPublicUrl(path).data.publicUrl;
}

/**
 * New playlist, or `?edit=<playlistId>` to edit an existing one you own (name, description, visibility,
 * cover). Collaborators can edit the name and description only.
 */
export default function CreatePlaylist() {
  const { user } = useAuth();
  const { createPlaylist, updatePlaylist, playlists, reload } = useLibrary();
  const params = useLocalSearchParams<{ edit?: string }>();
  const editing = typeof params.edit === 'string' && params.edit ? playlists.find((p) => p.id === params.edit) ?? null : null;
  const isEdit = !!editing;
  const isOwner = !!editing && !!user && editing.owner_id === user.id;
  const [name, setName] = useState(editing?.title ?? '');
  const [desc, setDesc] = useState(editing?.description ?? '');
  const [vis, setVis] = useState(editing ? Math.max(0, visibilities.indexOf(editing.visibility)) : 1);
  const [cover, setCover] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const pickCover = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 });
      if (!res.canceled && res.assets[0]) setCover(res.assets[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open your photos');
    }
  };

  const save = async () => {
    const title = name.trim();
    if (!title || busy || !editing || !user) return;
    setBusy(true);
    setError(undefined);
    try {
      let cover_url: string | undefined;
      if (cover && isOwner) {
        try {
          cover_url = await uploadCover(user.id, editing.id, cover);
        } catch {
          // keep the old cover; the rest still saves
        }
      }
      await updatePlaylist(editing.id, {
        title,
        description: desc,
        ...(isOwner ? { visibility: visibilities[vis] } : {}),
        ...(cover_url ? { cover_url } : {}),
      });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your changes');
      setBusy(false);
    }
  };

  const create = async () => {
    const title = name.trim();
    if (!title || busy) return;
    if (!user) {
      setError('Sign in to create playlists');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const p = await createPlaylist({ title, description: desc.trim(), visibility: visibilities[vis] });
      if (cover) {
        try {
          const url = await uploadCover(user.id, p.id, cover);
          await supabase.from('playlists').update({ cover_url: url }).eq('id', p.id);
          await reload();
        } catch {
          // Playlist exists; a failed cover upload shouldn't block opening it.
        }
      }
      router.replace({ pathname: '/playlist', params: { id: p.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the playlist');
      setBusy(false);
    }
  };

  return (
    <ModalCard>
      <T size={20} weight={600} align="center" accessibilityRole="header">
        {isEdit ? 'Edit playlist' : 'New playlist'}
      </T>

      <View style={{ alignItems: 'center' }}>
        <View style={{ width: 120, height: 120 }}>
          <Cover uri={cover?.uri ?? editing?.cover_url ?? undefined} id={editing?.id ?? (name.trim() || 'new-playlist')} size={120} radius={26} />
          {isEdit && !isOwner ? null : (
          <Tap
            accessibilityLabel={cover ? 'Change cover photo' : 'Add cover photo'}
            onPress={pickCover}
            style={[
              {
                position: 'absolute',
                right: -8,
                bottom: -8,
                width: 44,
                height: 44,
                borderRadius: 22,
                backgroundColor: colors.accent,
                borderWidth: 3,
                borderColor: colors.surface,
                alignItems: 'center',
                justifyContent: 'center',
              },
              shadow.stickerSm,
            ]}
          >
            <Icon name="camera" size={20} color={colors.onAccent} />
          </Tap>
          )}
        </View>
      </View>

      <TextField label="Name" placeholder="My playlist" value={name} onChangeText={setName} maxLength={100} autoFocus={!isEdit} error={error} />
      <TextField label="Description" placeholder="Add a description" value={desc} onChangeText={setDesc} maxLength={300} />

      {isEdit && !isOwner ? null : <Segmented options={['Public', 'Private', 'Collaborative']} initial={vis} onChange={setVis} />}

      <Row>
        <Button label="Cancel" variant="glass" style={{ flex: 1 }} href="back" />
        {isEdit ? (
          <Button label={busy ? 'Saving…' : 'Save'} variant={name.trim() && !busy ? 'primary' : 'disabled'} style={{ flex: 1 }} onPress={() => void save()} />
        ) : (
          <Button label={busy ? 'Creating…' : 'Create'} variant={name.trim() && !busy ? 'primary' : 'disabled'} style={{ flex: 1 }} onPress={create} />
        )}
      </Row>
    </ModalCard>
  );
}
