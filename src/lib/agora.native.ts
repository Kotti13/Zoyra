/**
 * Lazily loads react-native-agora (native code). Returns null in Expo Go or in a development build made
 * before the package was added, so the app never crashes there; the call screen then shows
 * "Calls need the latest app build". Web uses agora.ts (always null).
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type * as AgoraModule from 'react-native-agora';

export type Agora = typeof AgoraModule;

let cached: Agora | null | undefined;

export function loadAgora(): Agora | null {
  if (cached !== undefined) return cached;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    cached = null;
    return cached;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-agora') as Agora;
    // Touch the factory so a missing native module throws here, inside the try.
    cached = typeof mod?.createAgoraRtcEngine === 'function' ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}
