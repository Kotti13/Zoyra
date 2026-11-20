/**
 * Chat mood theme: the chat's background glow and accent follow the song playing. Per chat, on this device
 * (`chat.mood.<conversation>` pref, 'auto' by default; 'off' in Chat info › Chat mood). No image decoding:
 * the colour comes from the track's genre (palette below), else a stable hash of the track id, so it's free.
 */
import { usePref } from './prefs';

export type ChatMoodMode = 'auto' | 'off';

export function useChatMood(cid: string | undefined): readonly [ChatMoodMode, (m: ChatMoodMode) => void] {
  const [mode, setMode] = usePref<ChatMoodMode>(`chat.mood.${cid ?? 'none'}`, 'auto');
  return [mode === 'off' ? 'off' : 'auto', setMode] as const;
}

const GENRE: [RegExp, string][] = [
  [/hip.?hop|rap|trap/i, '#FF6F91'],
  [/r&b|rnb|soul/i, '#C86BFF'],
  [/electro|edm|house|techno|dance/i, '#2B9BFF'],
  [/rock|metal|punk|grunge/i, '#FA2D48'],
  [/pop/i, '#FF6B81'],
  [/jazz|blues/i, '#FDCB6E'],
  [/lo.?fi|chill|ambient|sleep/i, '#5AC8C8'],
  [/classical|piano|orchestr/i, '#B8A6FF'],
  [/country|folk|acoustic/i, '#E0A458'],
  [/indie|alternative/i, '#8A4BFF'],
  [/reggae|latin|afro/i, '#1FBF8F'],
];
const PALETTE = ['#FA2D48', '#FF6F91', '#FF6B81', '#8A4BFF', '#2B9BFF', '#1FBF8F', '#FDCB6E', '#C86BFF'];

/** Mood colour for a track (null without one). */
export function moodColor(track: { id: string; genre?: string | null } | null | undefined): string | null {
  if (!track?.id) return null;
  const g = track.genre ?? '';
  for (const [re, c] of GENRE) if (re.test(g)) return c;
  let h = 0;
  for (let i = 0; i < track.id.length; i++) h = (h * 33 + track.id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
