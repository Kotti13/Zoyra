import { File } from 'expo-file-system';

import { supabase } from './supabase';

/**
 * Upload a picked/camera image to the public `avatars` bucket under the user's folder and return its URL.
 * Reads the file with expo-file-system: `fetch(fileUri).arrayBuffer()` is unreliable on Android
 * (empty body or "Network request failed"), which broke profile photo uploads.
 */
export async function uploadAvatar(userId: string, uri: string, mimeType?: string | null, kind: 'avatar' | 'banner' = 'avatar'): Promise<string> {
  let body: ArrayBuffer;
  try {
    body = await new File(uri).arrayBuffer();
  } catch {
    // Some pickers hand back content:// URIs the File API can't open; fall back to fetch.
    body = await (await fetch(uri)).arrayBuffer();
  }
  if (!body.byteLength) throw new Error('Could not read that photo. Try another one.');
  if (body.byteLength > 8 * 1024 * 1024) throw new Error('That photo is too large (max 8 MB).');
  const type = mimeType && mimeType.startsWith('image/') ? mimeType : 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : type === 'image/heic' ? 'heic' : 'jpg';
  const path = `${userId}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from('avatars').upload(path, body, { contentType: type, upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);
  return supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
}

/** Same bucket and checks as the avatar upload, stored as `<user_id>/banner-*.ext`. */
export const uploadBanner = (userId: string, uri: string, mimeType?: string | null) => uploadAvatar(userId, uri, mimeType, 'banner');
