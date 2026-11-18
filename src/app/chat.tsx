import { Redirect, useLocalSearchParams } from 'expo-router';

/**
 * Legacy chat screen (`/chat?id=`). Chats live in /chat-pro now (end-to-end encrypted sending, decryption,
 * media). Old deep links and notification rows land here and are forwarded with the same params.
 */
export default function LegacyChat() {
  const params = useLocalSearchParams<Record<string, string>>();
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return <Redirect href={{ pathname: '/chat-pro', params: clean }} />;
}
