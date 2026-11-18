import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { hardenedFetch } from './http';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_KEY;

if (!url || !key) {
  throw new Error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_KEY in .env');
}

export const supabase = createClient(url, key, {
  // Normalises headers / GET bodies so Android's expo/fetch (OkHttp) can't reject a request before sending it,
  // and retries once if it does (src/lib/http.ts).
  global: { fetch: hardenedFetch },
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    flowType: 'pkce', // OAuth (Google/Apple) returns ?code= exchanged in auth-callback
  },
});

// Refresh tokens only while the app is in the foreground (Supabase React Native guidance).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}
