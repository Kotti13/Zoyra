/**
 * Lightweight 30-second preview player for Notes (a note's song clip, and the clip picker in note-compose).
 * A separate expo-audio player, NOT the main queue in src/state/player.tsx:
 *  - starting a preview pauses the main player and remembers whether it was playing;
 *  - stopping resumes it, unless the user started something else in the meantime;
 *  - plays [start, start + len) once and stops (no loop), with a 0..1 `progress` for a bar / ring;
 *  - stops when the main player starts, when the app goes to the background, and on unmount
 *    (the sheet / screen closing).
 * Source: the track's own `streamUrl` (non-Audius items) or `catalog.streamUrl(id)` — the same rule as the
 * player. Device-library (local) tracks can't be in notes and are refused.
 */
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { catalog } from './catalog';
import { isLocalTrack } from './local-music';
import type { NoteTrack } from './notes';
import { usePlayerActions, usePlayerPick } from '../state/player';

/** Clip length for notes (seconds). */
export const NOTE_CLIP_LEN = 30;

export type NotePreview = {
  /** Key of the clip that is loaded / playing (`trackId@start`), or null. */
  activeKey: string | null;
  playing: boolean;
  loading: boolean;
  /** 0..1 through the clip. */
  progress: number;
  /** Whole seconds left in the clip. */
  remaining: number;
  /** Duration of the loaded file in seconds (0 until known). */
  duration: number;
  error: string | null;
  /** Plays `len` seconds of `track` from `start` (seconds). */
  start: (track: Pick<NoteTrack, 'id' | 'streamUrl'>, start: number, len?: number) => void;
  stop: () => void;
  /** Start if this clip isn't playing, stop otherwise. */
  toggle: (track: Pick<NoteTrack, 'id' | 'streamUrl'>, start: number, len?: number) => void;
};

export const clipKey = (trackId: string, start: number) => `${trackId}@${Math.max(0, Math.floor(start))}`;

/** Where a note's clip starts / how long it is (older notes have no clip: 0 / 30). */
export function noteClip(t: Pick<NoteTrack, 'clip_start' | 'clip_len'> | null | undefined): { start: number; len: number } {
  const start = typeof t?.clip_start === 'number' && t.clip_start >= 0 ? Math.floor(t.clip_start) : 0;
  const len = typeof t?.clip_len === 'number' && t.clip_len > 0 ? Math.min(NOTE_CLIP_LEN, t.clip_len) : NOTE_CLIP_LEN;
  return { start, len };
}

const sourceUri = (t: Pick<NoteTrack, 'id' | 'streamUrl'>) => t.streamUrl ?? catalog.streamUrl(t.id);

export function useNotePreview(): NotePreview {
  const player = useAudioPlayer(null, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  const main = usePlayerActions();
  const { playing: mainPlaying } = usePlayerPick('playing');

  const [clip, setClip] = useState<{ key: string; start: number; len: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Seek + play waiting for the new source to load. */
  const pending = useRef<{ start: number } | null>(null);
  /** True from a new clip's start until its first seek is done (progress hidden meanwhile). */
  const [seeking, setSeeking] = useState(false);
  const loadedUri = useRef<string | null>(null);
  /** Main-player track we paused (resume it after the preview if nothing else started). */
  const resumeId = useRef<string | null>(null);
  const activeRef = useRef(false);

  const finish = useCallback(
    (resume: boolean) => {
      pending.current = null;
      activeRef.current = false;
      setSeeking(false);
      try {
        player.pause();
      } catch {
        // player already released (unmount)
      }
      setClip(null);
      const id = resumeId.current;
      resumeId.current = null;
      if (resume && id) {
        const s = main.getState();
        if (s.track?.id === id && !s.playing) s.play();
      }
    },
    [player, main],
  );

  const stop = useCallback(() => finish(true), [finish]);

  const start = useCallback(
    (track: Pick<NoteTrack, 'id' | 'streamUrl'>, from: number, len = NOTE_CLIP_LEN) => {
      setError(null);
      if (isLocalTrack(track as { id: string })) {
        setError('This song can’t be previewed.');
        return;
      }
      const s = main.getState();
      if (s.playing && s.track) {
        resumeId.current = s.track.id;
        s.pause();
      }
      const at = Math.max(0, Math.floor(from));
      const uri = sourceUri(track);
      activeRef.current = true;
      setClip({ key: clipKey(track.id, at), start: at, len: Math.max(1, Math.min(NOTE_CLIP_LEN, len)) });
      setSeeking(true);
      if (loadedUri.current === uri && player.isLoaded) {
        player.pause();
        void player
          .seekTo(at)
          .catch(() => undefined)
          .then(() => {
            setSeeking(false);
            if (activeRef.current) player.play();
          });
        return;
      }
      loadedUri.current = uri;
      pending.current = { start: at };
      player.replace({ uri });
    },
    [player, main],
  );

  // Player events (outside render): new source loaded → jump to the clip, then play (so the intro isn't
  // heard first); end of the clip / file → stop and give the main player back.
  const clipRef = useRef<{ start: number; len: number } | null>(null);
  useEffect(() => {
    clipRef.current = clip;
  }, [clip]);
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (st) => {
      const p = pending.current;
      if (p && st.isLoaded) {
        pending.current = null;
        void player
          .seekTo(p.start)
          .catch(() => undefined)
          .then(() => {
            setSeeking(false);
            if (activeRef.current) player.play();
          });
        return;
      }
      const c = clipRef.current;
      if (!c || pending.current || !activeRef.current) return;
      if (st.didJustFinish || (st.playing && st.currentTime >= c.start + c.len - 0.15)) finish(true);
    });
    return () => sub.remove();
  }, [player, finish]);

  // The user started the main player (lock screen, mini player…): the preview gives way, no resume.
  useEffect(() => {
    if (mainPlaying && activeRef.current) {
      resumeId.current = null;
      finish(false);
    }
  }, [mainPlaying, finish]);

  // Backgrounded: stop.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' && activeRef.current) finish(true);
    });
    return () => sub.remove();
  }, [finish]);

  // Unmount (sheet / screen closed): stop and resume the main player.
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  }, [finish]);
  useEffect(() => () => finishRef.current(true), []);

  // A failed load surfaces as "loaded" never happening; give up after a while.
  useEffect(() => {
    if (!seeking) return;
    const t = setTimeout(() => {
      if (pending.current) {
        setError('Couldn’t load this song.');
        finish(true);
      }
    }, 15_000);
    return () => clearTimeout(t);
  }, [seeking, finish]);

  const elapsed = clip && !seeking ? Math.max(0, Math.min(clip.len, status.currentTime - clip.start)) : 0;
  const playing = !!clip && status.playing;
  return {
    activeKey: clip?.key ?? null,
    playing,
    loading: !!clip && (seeking || status.isBuffering) && !status.playing,
    progress: clip ? elapsed / clip.len : 0,
    remaining: clip ? Math.max(0, Math.ceil(clip.len - elapsed)) : 0,
    duration: status.isLoaded ? status.duration : 0,
    error,
    start,
    stop,
    toggle: (track, from, len) => {
      if (clip && clip.key === clipKey(track.id, from)) stop();
      else start(track, from, len);
    },
  };
}

/** Clip length for a song of `duration` seconds: 30 s, or the whole song when it's shorter (0 = unknown). */
export function clipLenFor(duration: number): number {
  return duration > 0 && duration < NOTE_CLIP_LEN ? Math.max(1, Math.floor(duration)) : NOTE_CLIP_LEN;
}

/** Latest start (whole seconds) for a 30 s clip in a song of `duration` seconds. */
export function maxClipStart(duration: number): number {
  return duration > NOTE_CLIP_LEN ? Math.floor(duration - NOTE_CLIP_LEN) : 0;
}

/** Default clip start: 30% into the song (a rough chorus guess), kept inside the song. */
export function defaultClipStart(duration: number): number {
  return Math.min(maxClipStart(duration), Math.max(0, Math.floor(duration * 0.3)));
}
