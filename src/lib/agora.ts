/**
 * Web / fallback build of the Agora loader (see agora.native.ts). react-native-agora is native only,
 * so calls are unavailable here and the call screen shows "Calls need the latest app build".
 */
import type * as AgoraModule from 'react-native-agora';

export type Agora = typeof AgoraModule;

export function loadAgora(): Agora | null {
  return null;
}
