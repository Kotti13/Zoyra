import type { IconName } from '../components';

/**
 * Static index of every settings screen and its main rows, for Settings search.
 * `route` is a real file in src/app; `anchor` names the row on that screen (informational for now:
 * screens don't scroll to anchors yet, so search opens the screen).
 */
export type SettingsEntry = {
  title: string;
  /** Screen name shown under the title, e.g. "Playback". */
  section: string;
  route: string;
  icon: IconName;
  keywords: string[];
  anchor?: string;
};

type Screen = { section: string; route: string; icon: IconName; keywords: string[]; rows: [title: string, keywords: string[], anchor?: string][] };

const SCREENS: Screen[] = [
  {
    section: 'Settings',
    route: '/settings-hub',
    icon: 'sliders',
    keywords: ['all settings', 'preferences', 'options'],
    rows: [],
  },
  {
    section: 'Playback',
    route: '/playback-settings',
    icon: 'play',
    keywords: ['playback', 'player'],
    rows: [
      ['Crossfade', ['smooth transition', 'fade', 'blend', 'seconds'], 'crossfade'],
      ['Gapless playback', ['gap', 'silence', 'albums'], 'gapless'],
      ['Autoplay similar songs', ['autoplay', 'continue', 'radio', 'queue ends'], 'autoplay'],
      ['Resume where I left off', ['resume', 'restore', 'last song', 'position'], 'resume'],
    ],
  },
  {
    section: 'Audio quality',
    route: '/audio-quality',
    icon: 'speaker',
    keywords: ['audio quality', 'bitrate', 'kbps', 'sound quality'],
    rows: [
      ['Streaming quality', ['320', 'kbps', 'mp3', 'high', 'lossless', 'flac', 'hi-res'], 'streaming'],
      ['Download quality', ['downloads', 'offline', 'file size'], 'downloads'],
      ['Data per hour', ['mobile data', 'megabytes', 'mb', 'cellular'], 'data'],
      ['Spatial audio', ['dolby', 'atmos', '3d', 'surround'], 'spatial'],
    ],
  },
  {
    section: 'Audio',
    route: '/audio-settings',
    icon: 'speaker',
    keywords: ['audio', 'sound'],
    rows: [
      ['Smooth transition', ['crossfade', 'fade'], 'crossfade'],
      ['Gapless playback', ['gap'], 'gapless'],
      ['Normalize volume', ['loudness', 'volume level'], 'normalize'],
    ],
  },
  {
    section: 'Equalizer',
    route: '/equalizer',
    icon: 'sliders',
    keywords: ['equalizer', 'eq', 'bass', 'treble', 'presets', 'bands'],
    rows: [['Equalizer on', ['enable eq'], 'enabled']],
  },
  {
    section: 'Video',
    route: '/video-settings',
    icon: 'camera',
    keywords: ['video', 'music videos', 'youtube'],
    rows: [
      ['Autoplay next video', ['autoplay', 'up next'], 'autoplay'],
      ['Autoplay shorts', ['shorts', 'scroll'], 'shorts'],
      ['Wi-Fi only autoplay', ['mobile data', 'muted previews', 'wifi only previews', 'data saver'], 'previews'],
      ['Captions', ['subtitles', 'cc'], 'captions'],
      ['Caption language', ['subtitle language', 'captions language'], 'captionLanguage'],
    ],
  },
  {
    section: 'Lyrics',
    route: '/lyrics-settings',
    icon: 'mic',
    keywords: ['lyrics', 'words', 'karaoke'],
    rows: [
      ['Lyrics text size', ['font', 'bigger lyrics'], 'size'],
      ['Highlight style', ['fill', 'wave', 'static', 'animation'], 'highlight'],
      ['Open lyrics automatically', ['auto open'], 'auto'],
      ['Translation language', ['translate lyrics', 'translation', 'language'], 'translate'],
      ['Romanized lyrics', ['romanization', 'romanize', 'romaji', 'latin script'], 'romanize'],
    ],
  },
  {
    section: 'Devices',
    route: '/devices-connect',
    icon: 'cast',
    keywords: ['devices', 'connect', 'speaker', 'output'],
    rows: [
      ['Bluetooth', ['headphones', 'earbuds', 'pair'], 'bluetooth'],
      ['AirPlay and Cast', ['airplay', 'chromecast', 'cast', 'tv', 'spotify connect'], 'cast'],
      ['Car mode', ['car', 'driving', 'android auto', 'carplay'], 'car'],
      ['Network', ['wifi', 'mobile data', 'connection'], 'network'],
    ],
  },
  {
    section: 'Widgets and lock screen',
    route: '/widgets-lock',
    icon: 'lock',
    keywords: ['widgets', 'lock screen', 'home screen'],
    rows: [
      ['Lock screen controls', ['media controls', 'control center', 'notification', 'now playing'], 'lock'],
      ['Home screen widget', ['widget'], 'widget'],
      ['Status bar now playing', ['status bar', 'notification', 'live activity', 'dynamic island'], 'status'],
    ],
  },
  {
    section: 'Accessibility',
    route: '/accessibility',
    icon: 'eye',
    keywords: ['accessibility', 'a11y', 'vision'],
    rows: [
      ['Text size', ['font size', 'bigger text', 'larger', 'smaller', 'scale'], 'text'],
      ['Bold text', ['heavier', 'weight'], 'bold'],
      ['Reduce motion', ['animations', 'motion', 'calm', 'spinning'], 'motion'],
      ['Reduce lyric animation', ['lyrics', 'static highlight'], 'lyricMotion'],
      ['High contrast', ['contrast', 'borders'], 'contrast'],
      ['Colour blind friendly', ['color blind', 'colour', 'red green', 'daltonism'], 'colorBlind'],
      ['Screen reader hints', ['voiceover', 'talkback', 'screen reader'], 'hints'],
      ['Mono audio', ['mono', 'one ear', 'hearing'], 'mono'],
      ['Haptic feedback', ['haptics', 'vibration', 'vibrate'], 'haptics'],
    ],
  },
  {
    section: 'Content',
    route: '/content-controls',
    icon: 'filter',
    keywords: ['content', 'explicit', 'family', 'parental'],
    rows: [
      ['Explicit content', ['explicit', 'clean', 'swearing', 'parental advisory'], 'explicit'],
      ['Kid-safe mode', ['kids', 'children', 'family', 'safe'], 'kidSafe'],
      ['Hidden artists', ['hide artist', 'block artist', "don't play"], 'artists'],
      ['Hidden songs', ['hide song', 'hide track'], 'songs'],
    ],
  },
  {
    section: 'Notifications',
    route: '/notif-settings',
    icon: 'bell',
    keywords: ['notifications', 'alerts', 'push'],
    rows: [
      ['Push notifications', ['push', 'alerts'], 'push'],
      ['Quiet hours', ['do not disturb', 'mute overnight', 'night'], 'quiet'],
      ['New releases', ['releases', 'followed artists'], 'releases'],
      ['Friend activity', ['friends'], 'friends'],
      ['Weekly report', ['recap', 'summary'], 'weekly'],
    ],
  },
  {
    section: 'Privacy and security',
    route: '/privacy',
    icon: 'shield',
    keywords: ['privacy', 'security'],
    rows: [
      ['Private session', ['incognito', 'hide activity'], 'private'],
      ['Share activity', ['friends see what you play', 'listening activity'], 'activity'],
      ['Public profile', ['find you', 'discoverable'], 'public'],
      ['Download my data', ['export', 'json', 'gdpr'], 'export'],
      ['Delete account', ['remove account', 'close account'], 'delete'],
    ],
  },
  { section: 'Permissions', route: '/permissions?mode=manage', icon: 'eye', keywords: ['permissions', 'allow', 'microphone', 'camera', 'notifications', 'bluetooth', 'access'], rows: [] },
  { section: 'Chat backup', route: '/e2ee-setup', icon: 'lock', keywords: ['backup', 'encryption', 'e2ee', 'pin', 'restore', 'end-to-end'], rows: [] },
  { section: 'Two-factor authentication', route: '/two-factor', icon: 'lock', keywords: ['2fa', 'two-step', 'authenticator', 'mfa', 'security code'], rows: [] },
  { section: 'Blocked users', route: '/blocked', icon: 'user', keywords: ['block', 'unblock', 'blocked'], rows: [] },
  { section: 'Signed-in devices', route: '/sessions', icon: 'phone', keywords: ['sessions', 'devices', 'signed in', 'log out other devices'], rows: [] },
  {
    section: 'Data and storage',
    route: '/storage',
    icon: 'storage',
    keywords: ['storage', 'space', 'data'],
    rows: [
      ['Wi-Fi only streaming', ['mobile data', 'cellular', 'data saver'], 'wifiStreaming'],
      ['Wi-Fi only downloads', ['downloads', 'mobile data'], 'wifiDownloads'],
    ],
  },
  { section: 'Data usage', route: '/data-usage', icon: 'chart', keywords: ['data usage', 'mobile data', 'monthly limit', 'cellular'], rows: [] },
  { section: 'Cache and prefetch', route: '/cache', icon: 'storage', keywords: ['cache', 'clear cache', 'temporary files', 'artwork'], rows: [] },
  { section: 'Downloads', route: '/downloads', icon: 'download', keywords: ['downloads', 'offline', 'saved songs'], rows: [] },
  {
    section: 'Connection and data',
    route: '/net-status',
    icon: 'globe',
    keywords: ['connection', 'network', 'internet', 'wifi'],
    rows: [
      ['Offline mode', ['offline', 'downloads only'], 'offline'],
      ['Connection alerts', ['slow network', 'back online'], 'alerts'],
    ],
  },
  { section: 'Speed test', route: '/speed-test', icon: 'bolt', keywords: ['speed', 'ping', 'mbps', 'bandwidth'], rows: [] },
  {
    section: 'Display and theme',
    route: '/theme',
    icon: 'moon',
    keywords: ['display', 'theme', 'dark mode', 'appearance'],
    rows: [
      ['Accent colour', ['accent', 'color', 'red'], 'accent'],
      ['Match album art', ['cover colour', 'dynamic colour'], 'matchArt'],
      ['Compact mode', ['dense', 'compact'], 'compact'],
    ],
  },
  { section: 'Languages', route: '/languages', icon: 'globe', keywords: ['language', 'music languages', 'preferred languages'], rows: [] },
  { section: 'Sleep timer', route: '/sleep', icon: 'clock', keywords: ['sleep', 'timer', 'stop playing', 'fade out'], rows: [] },
  {
    section: 'Connected services',
    route: '/connected',
    icon: 'link',
    keywords: ['connected', 'apps', 'integrations'],
    rows: [['Spotify', ['import playlists', 'spotify'], 'spotify']],
  },
  { section: 'Scrobbling', route: '/scrobbling', icon: 'chart', keywords: ['scrobble', 'last.fm', 'lastfm', 'listenbrainz'], rows: [] },
  { section: 'Import playlists', route: '/import', icon: 'download', keywords: ['import', 'transfer', 'spotify playlists'], rows: [] },
  { section: 'Local files', route: '/local-music', icon: 'file', keywords: ['local', 'device music', 'mp3 files'], rows: [] },
  { section: 'Family plan', route: '/family', icon: 'users', keywords: ['family', 'members', 'invite', 'kids'], rows: [] },
  { section: 'Plans', route: '/plans', icon: 'star', keywords: ['premium', 'subscription', 'upgrade', 'plan', 'student'], rows: [] },
  { section: 'Billing', route: '/billing', icon: 'star', keywords: ['billing', 'payment', 'purchases', 'receipts'], rows: [] },
  { section: 'Help center', route: '/help', icon: 'info', keywords: ['help', 'support', 'faq', 'contact'], rows: [] },
  { section: 'About', route: '/about', icon: 'info', keywords: ['about', 'version', 'terms', 'licenses'], rows: [] },
];

export const SETTINGS_INDEX: SettingsEntry[] = SCREENS.flatMap((s) => [
  { title: s.section, section: 'Screen', route: s.route, icon: s.icon, keywords: s.keywords },
  ...s.rows.map(([title, keywords, anchor]) => ({ title, section: s.section, route: s.route, icon: s.icon, keywords, anchor })),
]);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Ranked search: every query word must match the title, section or a keyword (prefix match on
 * words). Title matches rank above keyword matches.
 */
export function searchSettings(query: string, limit = 30): SettingsEntry[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored: { e: SettingsEntry; score: number }[] = [];
  for (const e of SETTINGS_INDEX) {
    const title = norm(e.title);
    const section = norm(e.section);
    const kws = e.keywords.map(norm);
    let score = 0;
    let all = true;
    for (const w of words) {
      const inWords = (s: string) => s.split(' ').some((x) => x.startsWith(w)) || (w.length > 2 && s.includes(w));
      if (title.startsWith(w)) score += 6;
      else if (inWords(title)) score += 4;
      else if (kws.some(inWords)) score += 2;
      else if (inWords(section)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push({ e, score: score + (e.section === 'Screen' ? 0.5 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.e.title.localeCompare(b.e.title))
    .slice(0, limit)
    .map((x) => x.e);
}

/** Shortcuts shown before typing. */
export const POPULAR_SETTINGS: SettingsEntry[] = ['Sleep timer', 'Equalizer', 'Data and storage', 'Accessibility', 'Notifications']
  .map((t) => SETTINGS_INDEX.find((e) => e.title === t && e.section === 'Screen'))
  .filter((e): e is SettingsEntry => !!e);
