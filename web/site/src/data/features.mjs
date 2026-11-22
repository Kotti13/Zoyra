// Everything the site says about the app lives here, grouped the way the app groups it.
// `icon` is a key into ICONS in layout.mjs.

export const SITE = {
  name: 'Zoyra',
  tagline: 'Music is better together',
  description:
    'Zoyra is a social music app: search and play songs, follow synced lyrics, listen live with friends, share real links, and keep your chats private.',
  host: 'https://zoyra.site',
  github: 'https://github.com/Kotti13/Zoyra',
  shareHost: 'https://share.zoyra.site',
};

export const HIGHLIGHTS = [
  { icon: 'play', title: 'Search and play', text: 'Find any song, artist or album, with instant suggestions as you type, and start playing in about a second.' },
  { icon: 'lyrics', title: 'Lyrics that follow you', text: 'Time-synced lyrics scroll with the song, and jump with you when you seek forward or back.' },
  { icon: 'live', title: 'Listen together', text: 'Go live, host a room, or hop into a friend’s session. Everyone hears the same moment.' },
  { icon: 'link', title: 'Real share links', text: 'Share songs, playlists, profiles and live rooms as links that open the app and preview beautifully.' },
  { icon: 'lock', title: 'Private by design', text: 'End-to-end encrypted chats, per-feature privacy controls, two-factor sign-in and a block list.' },
  { icon: 'sparkle', title: 'Made for you', text: 'Daily mixes, an AI DJ, AI playlists and a mood scan that turns a photo into a playlist.' },
];

export const GROUPS = [
  {
    id: 'listen',
    title: 'Listen',
    blurb: 'A player that stays out of your way and does the small things right.',
    items: [
      { icon: 'search', title: 'Smart search', text: 'Songs first, then artists, with suggestions while you type. Results load without the list jumping around.' },
      { icon: 'play', title: 'Full-screen player', text: 'Large artwork, touch-to-seek bar, queue, speed control, sleep timer and a swipe-down mini player.' },
      { icon: 'lyrics', title: 'Synced lyrics and karaoke', text: 'Follow every line, share a lyric card, and sing along in karaoke mode.' },
      { icon: 'video', title: 'Music videos', text: 'Switch a song to its video, or browse trending videos right from Home.' },
      { icon: 'download', title: 'Offline downloads', text: 'Save songs as real files to listen without a connection or data.' },
      { icon: 'eq', title: 'Equalizer and sound', text: 'Tune the sound, change speed, and pick the audio quality that suits your data plan.' },
      { icon: 'car', title: 'Car mode', text: 'Big, simple controls for when your eyes belong on the road.' },
      { icon: 'wave', title: 'Identify a song', text: 'Hear something you love? Let Zoyra recognise it and add it to your library.' },
    ],
  },
  {
    id: 'discover',
    title: 'Discover',
    blurb: 'Fresh music from the places you actually listen.',
    items: [
      { icon: 'compass', title: 'Discover and charts', text: 'Charts, new releases and genre pages, with real cover art on every card.' },
      { icon: 'sparkle', title: 'AI DJ and AI playlists', text: 'Describe a vibe and get a playlist, or let the DJ keep the music going.' },
      { icon: 'camera', title: 'Mood from a photo', text: 'Snap or pick a picture and get music that fits the mood.' },
      { icon: 'mix', title: 'Daily mixes and radio', text: 'Mixes tuned to your genres, languages and artists, plus radio stations.' },
      { icon: 'mic', title: 'Podcasts and audiobooks', text: 'Shows and long listens live next to your music.' },
      { icon: 'ticket', title: 'Concerts, tickets and merch', text: 'See who is playing near you, and find merch from artists you follow.' },
    ],
  },
  {
    id: 'social',
    title: 'Together',
    blurb: 'Music is more fun with people. Zoyra is built around that.',
    items: [
      { icon: 'live', title: 'Live rooms', text: 'Go live, host a room, and let friends join the same moment from a single link.' },
      { icon: 'group', title: 'Group listening and parties', text: 'Share a queue with friends, take turns, and keep the party going.' },
      { icon: 'family', title: 'Family plans and invites', text: 'Bring the family in with one invite and manage everyone in one place.' },
      { icon: 'chat', title: 'Community and comments', text: 'Post to the community, comment on any track, reply to replies and edit your own words.' },
      { icon: 'note', title: 'Notes and stories', text: 'Pin a short note or a story to your profile so friends see what you are into.' },
      { icon: 'blend', title: 'Blend and taste compare', text: 'Mix two people’s tastes into one playlist, and see how well you match.' },
      { icon: 'trophy', title: 'Levels, badges and wrapped', text: 'Earn badges, climb the leaderboard and look back on your year in music.' },
    ],
  },
  {
    id: 'messages',
    title: 'Messages and calls',
    blurb: 'Chat and call inside the app, with privacy that is on by default.',
    items: [
      { icon: 'lock', title: 'End-to-end encrypted chats', text: 'Set up encryption, verify a friend, and restore your keys on a new phone.' },
      { icon: 'chat', title: 'Rich messaging', text: 'Voice messages, media, scheduled messages, whispers, capsules and in-chat search.' },
      { icon: 'phone', title: 'Calls and group calls', text: 'Voice calls with friends, one to one or in a group.' },
      { icon: 'shield', title: 'Control who reaches you', text: 'Message requests, a block list, last-seen controls and DM privacy settings.' },
    ],
  },
  {
    id: 'you',
    title: 'You',
    blurb: 'Make the app yours, and keep control of your data.',
    items: [
      { icon: 'palette', title: 'Themes and accents', text: 'Pick an accent colour or go full AMOLED black. The whole app follows.' },
      { icon: 'user', title: 'Profile your way', text: 'Avatar, banner photo, taste, playlists, QR code and public profile link.' },
      { icon: 'shield', title: 'Privacy and security', text: 'Two-factor sign-in, content controls, kids mode and a clear account-delete option.' },
      { icon: 'heart', title: 'Wellness', text: 'Sleep timers and gentle reminders so music helps rather than takes over.' },
      { icon: 'access', title: 'Accessibility', text: 'Readable text, clear touch targets and screen-reader labels throughout.' },
      { icon: 'game', title: 'Games and quizzes', text: 'Beat games and music quizzes to play on your own or with friends.' },
    ],
  },
];

export const STEPS = [
  { n: '1', title: 'Pick what you love', text: 'Choose genres, languages and artists. Every choice shows real artwork, so it is quick and fun.' },
  { n: '2', title: 'Play something now', text: 'Search, tap a song, and it starts. Lyrics, queue and downloads are one tap away.' },
  { n: '3', title: 'Bring your people', text: 'Share a link. Friends open the app on the right screen and join your room, playlist or profile.' },
];

export const STACK = [
  { name: 'Expo and React Native', text: 'One TypeScript codebase for iPhone and Android.' },
  { name: 'Supabase', text: 'Database, sign-in, realtime and 15 edge functions.' },
  { name: 'FastAPI gateway', text: 'A small Python service that finds songs, streams audio and fetches lyrics.' },
  { name: 'NewPipe extractor', text: 'A Java service that talks to the music source.' },
  { name: 'Cloudflare', text: 'Tunnels and DNS keep the backend reachable and the domain fast.' },
  { name: 'Vercel', text: 'Hosts the share-link pages that preview beautifully in chat apps.' },
];

export const NUMBERS = [
  { value: '190+', label: 'screens' },
  { value: '50+', label: 'database migrations' },
  { value: '15', label: 'server functions' },
  { value: 'Public', label: 'code on GitHub' },
];
