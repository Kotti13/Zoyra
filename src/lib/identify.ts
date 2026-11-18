/**
 * Song identification (screen: identify). Records a short clip with expo-audio, sends it to the
 * `recognize-song` function (ACRCloud) and reports the match. The recording is deleted right after;
 * nothing is stored. 'listen' = music playing around you, 'hum' = hum or sing the tune (needs the
 * separate ACRCloud humming project on the server, otherwise it says so).
 */
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, type RecordingOptions } from 'expo-audio';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { recognizeSong, type SongMatch } from './ai';
import { usePlayerActions } from '../state/player';

export type IdentifyMode = 'listen' | 'hum';
export const IDENTIFY_SECONDS: Record<IdentifyMode, number> = { listen: 8, hum: 12 };

const RECORDING: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64000 };

export type IdentifyState =
  | { state: 'idle' }
  | { state: 'listening'; left: number; total: number }
  | { state: 'identifying' }
  | { state: 'nomatch' }
  | { state: 'error'; message: string; settings?: boolean };

export function useIdentify(onMatch: (m: NonNullable<SongMatch>, mode: IdentifyMode) => void) {
  const recorder = useAudioRecorder(RECORDING);
  const { pause, getState } = usePlayerActions();
  const [st, setSt] = useState<IdentifyState>({ state: 'idle' });
  const run = useRef(0); // bumps on cancel / unmount so a running clip stops quietly
  const busy = st.state === 'listening' || st.state === 'identifying';
  const matchRef = useRef(onMatch);
  useEffect(() => {
    matchRef.current = onMatch;
  });

  const start = useCallback(
    async (mode: IdentifyMode) => {
      if (busy) return;
      const id = ++run.current;
      const alive = () => run.current === id;
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setSt({ state: 'error', settings: !perm.canAskAgain, message: perm.canAskAgain ? 'Microphone permission is needed to identify songs.' : 'Microphone access is off. Turn it on in Settings.' });
        return;
      }
      let uri: string | null = null;
      try {
        if (getState().playing) pause(); // don't identify our own music
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        const total = IDENTIFY_SECONDS[mode];
        for (let left = total; left > 0; left--) {
          if (!alive()) return;
          setSt({ state: 'listening', left, total });
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!alive()) return;
        await recorder.stop();
        uri = recorder.uri;
        setSt({ state: 'identifying' });
        if (!uri) throw new Error('Nothing was recorded');
        const audioBase64 = await new File(uri).base64();
        const res = await recognizeSong(audioBase64, Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4', mode);
        if (!alive()) return;
        if (!res.ok) {
          setSt({ state: 'error', message: res.reason === 'not_configured' ? `${mode === 'hum' ? 'Hum and sing search' : 'Song recognition'} needs ${res.service} setup on the server.` : `Could not identify: ${res.message}` });
          return;
        }
        const m = res.data.match;
        if (!m) return setSt({ state: 'nomatch' });
        setSt({ state: 'idle' });
        matchRef.current(m, mode);
      } catch (e) {
        if (alive()) setSt({ state: 'error', message: e instanceof Error ? e.message : 'Recording failed' });
      } finally {
        if (recorder.isRecording) await recorder.stop().catch(() => {});
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
        if (uri) {
          try {
            new File(uri).delete(); // never keep the recording
          } catch {
            /* already gone */
          }
        }
      }
    },
    [busy, getState, pause, recorder],
  );

  const cancel = useCallback(() => {
    run.current++;
    setSt({ state: 'idle' });
    if (recorder.isRecording) void recorder.stop().catch(() => {});
  }, [recorder]);

  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  return { st, busy, start, cancel };
}
