import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';

import { Icon, IconButton, Row, T } from '../components';
import { chatError, loadMessage, whisperMeta, type ChatMessage } from '../lib/chat';
import { discardWhisperFile, loadWhisperViews, markWhisperViewed, openWhisperFile, reportWhisperScreenshot } from '../lib/chat-extras';
import { allowCapture, onScreenshot, preventCapture } from '../lib/chat-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../state/auth';
import { colors, withAlpha } from '../theme/tokens';

const BLUE = '#2B6BFF';
const CAPTURE_KEY = 'zoyra-whisper';

type Phase = 'loading' | 'ready' | 'viewing' | 'gone' | 'error';

/**
 * Whisper viewer (`/chat-whisper?id=<conversation>&msg=<message>`, MsgWhisper design). The photo is downloaded and
 * decrypted into a temp file up front; it is shown only while the finger is down. The first time it shows,
 * `mark_whisper_viewed` deletes this user's key envelope and hides the encrypted file from them; on release the
 * temp file is deleted and it's gone for good. No save / forward / share anywhere. Screenshots are blocked while
 * this screen is open (Android; iOS where supported) and reported to the sender ("X took a screenshot").
 */
export default function ChatWhisper() {
  const params = useLocalSearchParams<{ id?: string; msg?: string }>();
  const mid = typeof params.msg === 'string' ? params.msg : '';
  const cid = typeof params.id === 'string' ? params.id : '';
  const { user } = useAuth();
  const me = user?.id;
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [msg, setMsg] = useState<ChatMessage | null>(null);
  const marked = useRef(false);
  const uriRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!mid || !me) throw new Error('This photo is no longer available.');
      const [m, views] = await Promise.all([loadMessage(mid), loadWhisperViews([mid])]);
      if (!m || m.kind !== 'whisper') throw new Error('This photo is no longer available.');
      if (m.sender_id === me) throw new Error('You sent this view once photo. It can’t be opened on your side.');
      if (views.some((v) => v.user_id === me && v.viewed_at)) {
        if (alive) setPhase('gone');
        return;
      }
      const meta = whisperMeta(m);
      if (!meta?.key || !meta.path) throw new Error('This photo isn’t available on this device.');
      const p = await supabase.from('profiles').select('display_name').eq('id', m.sender_id).maybeSingle();
      const file = await openWhisperFile(meta.path, meta.key, meta.mime);
      if (!alive) {
        discardWhisperFile(file);
        return;
      }
      uriRef.current = file;
      setMsg(m);
      setFrom(((p.data as { display_name?: string } | null)?.display_name ?? '').split(' ')[0] || 'them');
      setUri(file);
      setPhase('ready');
    })().catch((e: unknown) => {
      if (!alive) return;
      setError(chatError(e, 'This photo is no longer available.'));
      setPhase('error');
    });
    return () => {
      alive = false;
    };
  }, [mid, me]);

  // Block capture while this screen is open; report screenshots that still happen.
  useEffect(() => {
    void preventCapture(CAPTURE_KEY);
    const off = onScreenshot(() => {
      if (mid) void reportWhisperScreenshot(mid);
    });
    return () => {
      off();
      void allowCapture(CAPTURE_KEY);
      discardWhisperFile(uriRef.current);
      uriRef.current = null;
      if (marked.current && mid) void markWhisperViewed(mid).catch(() => undefined);
    };
  }, [mid]);

  const close = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat-pro', params: { id: cid } }));

  const start = () => {
    if (phase !== 'ready' || !uri) return;
    setPhase('viewing');
    if (!marked.current && msg) {
      marked.current = true;
      void markWhisperViewed(msg.id).catch(() => undefined);
    }
  };
  const end = () => {
    if (phase !== 'viewing') return;
    discardWhisperFile(uriRef.current);
    uriRef.current = null;
    setUri(null);
    setPhase('gone');
    setTimeout(close, 900);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {phase === 'viewing' && uri ? (
        <Image source={{ uri }} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="contain" accessibilityLabel={`View once photo from ${from}`} accessibilityIgnoresInvertColors />
      ) : null}
      <Row gap={8} style={{ paddingTop: 56, paddingHorizontal: 12, opacity: phase === 'viewing' ? 0.6 : 1 }}>
        <IconButton icon="close" label="Close" size={44} bg={withAlpha(colors.white, 0.1)} onPress={close} />
        <Row gap={6} style={{ flex: 1, justifyContent: 'center' }}>
          <Icon name="eye" size={14} color={colors.textSecondary} />
          <T size={13} color={colors.textSecondary}>
            View once{from ? ` · from ${from}` : ''}
          </T>
        </Row>
        <View style={{ width: 44 }} />
      </Row>
      <Pressable
        onPressIn={start}
        onPressOut={end}
        disabled={phase !== 'ready' && phase !== 'viewing'}
        accessibilityRole="button"
        accessibilityLabel={phase === 'ready' ? 'Press and hold to view the photo' : phase === 'gone' ? 'Photo opened' : 'Loading photo'}
        accessibilityHint="The photo disappears when you let go"
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}
      >
        {phase === 'viewing' ? null : (
          <View style={{ alignItems: 'center', gap: 14, maxWidth: 300 }}>
            <View style={{ width: 88, height: 88, borderRadius: 44, backgroundColor: phase === 'gone' ? withAlpha(colors.white, 0.1) : BLUE, alignItems: 'center', justifyContent: 'center' }}>
              {phase === 'loading' ? <ActivityIndicator color={colors.white} /> : <Icon name={phase === 'gone' ? 'check' : phase === 'error' ? 'info' : 'eye'} size={36} color={colors.white} />}
            </View>
            <T size={20} weight={600} align="center">
              {phase === 'gone' ? 'Opened' : phase === 'error' ? 'Not available' : phase === 'loading' ? 'Decrypting…' : 'Press and hold to view'}
            </T>
            <T size={14} color={colors.textSecondary} align="center" lineHeight={20}>
              {phase === 'error' ? error : phase === 'gone' ? 'This view once photo is gone.' : 'Photo disappears when you let go. It cannot be saved or forwarded.'}
            </T>
          </View>
        )}
      </Pressable>
      <Row gap={8} style={{ justifyContent: 'center', paddingBottom: 40, opacity: phase === 'viewing' ? 0 : 1 }}>
        <Icon name="shield" size={14} color={colors.textSecondary} />
        <T size={12} color={colors.textSecondary}>
          {Platform.OS === 'web' ? 'View once photos are end-to-end encrypted' : `${from || 'They'} ${from ? 'is' : 'are'} told if you take a screenshot`}
        </T>
      </Row>
    </View>
  );
}
