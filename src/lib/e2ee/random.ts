import * as ExpoCrypto from 'expo-crypto';

/**
 * Installs `globalThis.crypto.getRandomValues` (what @noble/* use) from expo-crypto when the JS engine
 * doesn't provide one (Hermes). expo-crypto's getRandomValues is native: SecRandomCopyBytes on iOS,
 * java.security.SecureRandom on Android, both CSPRNGs. On web the browser's Web Crypto is used as is.
 * Imported for its side effect first thing in ./index.ts.
 */
type RandomFill = <T extends ArrayBufferView | null>(array: T) => T;
const g = globalThis as unknown as { crypto?: { getRandomValues?: RandomFill } };

if (typeof g.crypto?.getRandomValues !== 'function') {
  const fill: RandomFill = (array) => {
    if (array) ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
    return array;
  };
  if (g.crypto) {
    try {
      g.crypto.getRandomValues = fill;
    } catch {
      g.crypto = { ...g.crypto, getRandomValues: fill };
    }
  } else {
    g.crypto = { getRandomValues: fill };
  }
}

export const randomUUID = (): string => ExpoCrypto.randomUUID();
