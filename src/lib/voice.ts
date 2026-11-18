/**
 * Voice search: on-device speech-to-text via expo-speech-recognition.
 *
 * The native module ships only in a development / store build, not in Expo Go. The package
 * calls `requireNativeModule` at import time (which throws in Expo Go), so it is never imported
 * statically here. We probe with `requireOptionalNativeModule` and fall back to an honest
 * "needs the development build" message instead of crashing.
 */
import { setAudioModeAsync } from 'expo-audio';
import { requireOptionalNativeModule } from 'expo';
import type { ExpoSpeechRecognitionModule as SpeechModuleValue, ExpoSpeechRecognitionErrorCode } from 'expo-speech-recognition';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

type SpeechModule = typeof SpeechModuleValue;
type EventSubscription = ReturnType<SpeechModule['addListener']>;

export const VOICE_NEEDS_DEV_BUILD = 'Voice search needs the development build.';

/** Stop listening after this long without a new partial result. */
const SILENCE_MS = 1600;
/** Hard cap on one listening session. */
const MAX_LISTEN_MS = 15000;

let cached: SpeechModule | null | undefined;

/** The speech module, or null when this build does not include it (Expo Go). Never throws. */
export function getSpeechModule(): SpeechModule | null {
  if (cached !== undefined) return cached;
  try {
    if (Platform.OS === 'web') {
      // The web build registers a Web Speech API shim; importing the package is safe there.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkg = require('expo-speech-recognition') as { ExpoSpeechRecognitionModule: SpeechModule };
      cached = pkg.ExpoSpeechRecognitionModule ?? null;
    } else {
      cached = requireOptionalNativeModule<SpeechModule>('ExpoSpeechRecognition');
    }
  } catch {
    cached = null;
  }
  return cached;
}

export function isVoiceSearchSupported() {
  return getSpeechModule() !== null;
}

function deviceLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

function errorMessage(code: ExpoSpeechRecognitionErrorCode, fallback: string): string | null {
  switch (code) {
    case 'aborted':
      return null; // we cancelled it
    case 'no-speech':
    case 'speech-timeout':
      return "Didn't catch that. Tap the mic and try again.";
    case 'not-allowed':
      return 'Microphone and speech recognition access are needed for voice search. Turn them on in Settings.';
    case 'service-not-allowed':
      return 'Speech recognition is turned off on this device.';
    case 'network':
      return 'Voice search needs a network connection.';
    case 'language-not-supported':
      return 'Voice search does not support your device language yet.';
    case 'audio-capture':
      return 'Could not use the microphone.';
    case 'busy':
      return 'The speech recognizer is busy. Try again in a moment.';
    default:
      return fallback || 'Voice search failed.';
  }
}

export type VoiceState = { state: 'idle' } | { state: 'starting' } | { state: 'listening'; transcript: string } | { state: 'error'; message: string };

type Options = {
  /** Live partial transcript while the user speaks. */
  onPartial: (text: string) => void;
  /** Final transcript once listening stops (only called with non-empty text). */
  onFinal: (text: string) => void;
  /** Called before listening starts, e.g. to pause playback. */
  onBeforeStart?: () => void;
};

/**
 * Tap-to-talk voice search. `start()` listens with live partial results, auto-stops after a
 * short silence (or when the recognizer finalises), then reports the final transcript.
 */
export function useVoiceSearch({ onPartial, onFinal, onBeforeStart }: Options) {
  const [voice, setVoice] = useState<VoiceState>({ state: 'idle' });
  const subs = useRef<EventSubscription[]>([]);
  const timers = useRef<{ silence?: ReturnType<typeof setTimeout>; max?: ReturnType<typeof setTimeout> }>({});
  const transcript = useRef('');
  const failed = useRef(false);
  const cb = useRef({ onPartial, onFinal, onBeforeStart });
  useEffect(() => {
    cb.current = { onPartial, onFinal, onBeforeStart };
  }, [onPartial, onFinal, onBeforeStart]);

  const clearTimers = () => {
    if (timers.current.silence) clearTimeout(timers.current.silence);
    if (timers.current.max) clearTimeout(timers.current.max);
    timers.current = {};
  };

  const cleanup = useCallback(() => {
    clearTimers();
    subs.current.forEach((s) => s.remove());
    subs.current = [];
  }, []);

  const restoreAudio = () => {
    if (Platform.OS === 'web') return;
    // Give the music player its playback session back.
    void setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' }).catch(() => {});
  };

  const stop = useCallback(() => {
    const mod = getSpeechModule();
    try {
      mod?.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const cancel = useCallback(() => {
    const mod = getSpeechModule();
    failed.current = true;
    try {
      mod?.abort();
    } catch {
      /* already stopped */
    }
    cleanup();
    restoreAudio();
    setVoice({ state: 'idle' });
  }, [cleanup]);

  const start = useCallback(async () => {
    const mod = getSpeechModule();
    if (!mod) {
      setVoice({ state: 'error', message: VOICE_NEEDS_DEV_BUILD });
      return;
    }
    if (subs.current.length) return; // already listening
    setVoice({ state: 'starting' });
    try {
      const perm = await mod.requestPermissionsAsync();
      if (!perm.granted) {
        setVoice({
          state: 'error',
          message: perm.canAskAgain ? 'Microphone and speech recognition access are needed for voice search.' : 'Microphone or speech recognition access is off. Turn it on in Settings.',
        });
        return;
      }
      if (!mod.isRecognitionAvailable()) {
        setVoice({ state: 'error', message: 'Speech recognition is not available on this device.' });
        return;
      }
    } catch (e) {
      setVoice({ state: 'error', message: e instanceof Error ? e.message : 'Could not start voice search.' });
      return;
    }

    transcript.current = '';
    failed.current = false;
    cleanup();
    cb.current.onBeforeStart?.();

    const armSilence = () => {
      if (timers.current.silence) clearTimeout(timers.current.silence);
      timers.current.silence = setTimeout(stop, SILENCE_MS);
    };

    subs.current = [
      mod.addListener('start', () => {
        setVoice({ state: 'listening', transcript: '' });
        timers.current.max = setTimeout(stop, MAX_LISTEN_MS);
      }),
      mod.addListener('result', (ev) => {
        const text = ev.results[0]?.transcript?.trim() ?? '';
        if (!text) return;
        transcript.current = text;
        cb.current.onPartial(text);
        setVoice({ state: 'listening', transcript: text });
        if (ev.isFinal) stop();
        else armSilence();
      }),
      mod.addListener('error', (ev) => {
        const msg = errorMessage(ev.error, ev.message);
        // A "no-speech" after we already heard words just means the user stopped talking.
        if (msg && !(transcript.current && (ev.error === 'no-speech' || ev.error === 'speech-timeout'))) {
          failed.current = true;
          setVoice({ state: 'error', message: msg });
        }
      }),
      mod.addListener('end', () => {
        cleanup();
        restoreAudio();
        const text = transcript.current.trim();
        if (failed.current) return;
        if (text) {
          setVoice({ state: 'idle' });
          cb.current.onFinal(text);
        } else {
          setVoice({ state: 'error', message: "Didn't catch that. Tap the mic and try again." });
        }
      }),
    ];

    try {
      mod.start({
        lang: deviceLocale(),
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
        addsPunctuation: false,
        iosTaskHint: 'search',
        androidIntentOptions: { EXTRA_LANGUAGE_MODEL: 'web_search' },
      });
    } catch (e) {
      cleanup();
      restoreAudio();
      setVoice({ state: 'error', message: e instanceof Error ? e.message : 'Could not start voice search.' });
    }
  }, [cleanup, stop]);

  // Never leave the mic running when the screen unmounts.
  useEffect(
    () => () => {
      if (subs.current.length) {
        try {
          getSpeechModule()?.abort();
        } catch {
          /* ignore */
        }
      }
      cleanup();
    },
    [cleanup],
  );

  const listening = voice.state === 'starting' || voice.state === 'listening';
  return { voice, listening, start, stop, cancel, dismiss: () => setVoice({ state: 'idle' }) };
}
