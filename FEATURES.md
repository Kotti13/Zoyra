ZOYRA - COMPLETE FEATURE DESIGN
=====================================
APP NAME: Zoyra
PROJECT: Industry-level Music Streaming App
DATE: 2026-11-13
STACK: React Native + Expo + TypeScript + Spotify SDK + Apple MusicKit

===============================================================================
1. AUTHENTICATION & ONBOARDING
===============================================================================
x
1.1 LOGIN / SIGNUP
- Email + Password signup/login
- Google OAuth login
- Apple Sign-In (iOS)
- Phone number + OTP verification
- Spotify account linking (OAuth 2.0 PKCE flow)
- Apple Music account linking
- Biometric login (Face ID / Touch ID / Fingerprint)
- "Remember me" persistent session with secure token storage (expo-secure-store)
- Password reset via email link
- Account deletion (GDPR/privacy compliance)

1.2 ONBOARDING FLOW
- Welcome carousel (3-4 screens with Lottie animations)
- Genre preference picker (grid of genres with haptic feedback on select)
- Favorite artists picker (search + suggestion chips)
- Language preference (for regional music: Tamil, Hindi, English, Spanish, Korean, etc.)
- Audio quality preference (Low/Normal/High/Lossless)
- Theme preference (Dark/Light/Auto/AMOLED Black)
- Push notification permission prompt
- Connect Spotify / Apple Music prompt
- Skip option on every step

1.3 USER PROFILE
- Display name, bio, profile picture (camera/gallery picker with crop)
- Listening stats (hours, top genres, top artists)
- Public/Private profile toggle
- Follower/Following system
- Listening activity feed
- Badge system (achievements based on listening habits)
- Linked accounts management (Spotify, Apple Music)

===============================================================================
2. HOME SCREEN
===============================================================================

2.1 DYNAMIC HOME FEED
- Time-based greeting ("Good morning" + user's name)
- Recently played (horizontal scroll, album art cards)
- Continue listening (resume where you left off)
- Made For You (AI-personalized playlists)
- Trending Now (country-based trending)
- New Releases (from followed artists)
- Top Charts (Global, Country, Genre-specific)
- Mood-based playlists (Happy, Chill, Workout, Focus, Sleep)
- Seasonal/Event playlists (Diwali, Christmas, Summer Hits)
- Friend activity (what friends are listening to)
- Genre spotlight sections
- Artist radio suggestions
- Podcast recommendations (if adding podcast support)

2.2 FUTURISTIC UI ELEMENTS
- Glassmorphism cards with blur backdrop
- Parallax scrolling on hero banners
- Animated gradient backgrounds that shift with mood/time of day
- Skeleton loading screens (shimmer effect)
- Pull-to-refresh with custom Lottie animation
- Smooth shared element transitions between screens
- Haptic feedback on interactions
- 3D album art tilt effect (gyroscope-based)
- Floating action button with spring animation
- Morphing search bar animation
- Card flip animations for "Discover" section
- Ambient color extraction from album art (dynamic theming)

===============================================================================
3. SEARCH & DISCOVERY
===============================================================================

3.1 SEARCH
- Real-time search with debounced API calls (300ms)
- Search categories: Songs, Artists, Albums, Playlists, Genres, Lyrics
- Voice search (speech-to-text)
- Search history (locally stored, clearable)
- Trending searches
- Search suggestions / autocomplete
- Fuzzy matching (typo tolerance)
- Multi-language search (search in any script/language)
- QR code scan to find songs/playlists
- Camera-based song recognition (like Shazam - via ACRCloud API)
- Search filters (year, genre, language, duration)
- "I'm Feeling Lucky" random song button

3.2 BROWSE / DISCOVER
- Genre grid with animated category cards
- Mood boards (visual mood-based discovery)
- Decade playlists (60s, 70s, 80s, 90s, 2000s, 2010s, 2020s)
- "Similar to [Artist]" discovery
- Daily Mix playlists (auto-generated)
- Discover Weekly equivalent
- Release Radar equivalent
- Collaborative filtering recommendations
- Context-aware suggestions (time of day, activity, weather)

===============================================================================
4. MUSIC PLAYBACK (CORE ENGINE)
===============================================================================

4.1 PLAYER CONTROLS
- Play / Pause (with animated toggle)
- Next / Previous track
- Seek bar with time elapsed / remaining
- Precise seeking with magnified time tooltip
- Shuffle mode (with smart shuffle - avoids same artist back-to-back)
- Repeat modes: Off / Repeat All / Repeat One
- Volume slider with system volume sync
- Playback speed control (0.5x to 2.0x)
- Sleep timer (15min, 30min, 45min, 1hr, end of track, custom)
- Crossfade between tracks (0-12 seconds, configurable)
- Gapless playback
- Audio normalization (consistent volume across tracks)

4.2 MINI PLAYER
- Persistent bottom bar showing current track
- Album art, song name (marquee if long), artist name
- Play/Pause, Next buttons
- Swipe up to expand to full player
- Swipe left/right to skip tracks
- Progress bar at top of mini player
- Long press for quick actions menu

4.3 FULL SCREEN PLAYER
- Large album art with shadow/glow effect
- Album art color extraction for dynamic background gradient
- Animated vinyl/CD spin effect (toggle-able)
- Blurred album art background
- Song title, artist (tappable to go to artist page), album
- Heart/Like button with animation
- Add to playlist button
- Share button
- More options (three-dot menu)
- Waveform visualization
- Canvas-style video loops (like Spotify Canvas)
- Swipe gestures (up: queue, down: minimize, left/right: skip)

4.4 AUDIO QUALITY
- Streaming quality settings:
  - Low (96 kbps) - save data
  - Normal (160 kbps)
  - High (320 kbps)
  - Lossless (FLAC/ALAC via Apple Music)
- WiFi vs Cellular quality settings (separate)
- Audio quality indicator in player
- Dolby Atmos / Spatial Audio support (Apple Music)
- Equalizer (10-band with presets: Rock, Pop, Jazz, Classical, Bass Boost, etc.)
- Custom EQ profiles (save/load)

4.5 BACKGROUND & SYSTEM INTEGRATION
- Background audio playback
- Lock screen controls (MediaSession API)
- Control Center / Notification shade controls
- CarPlay / Android Auto support
- Bluetooth metadata display
- AirPlay / Chromecast support
- Handoff between devices
- Siri / Google Assistant integration ("Hey Siri, play X")

===============================================================================
5. LYRICS DISPLAY
===============================================================================

5.1 SYNCED LYRICS
- Real-time synced lyrics (karaoke-style, line by line)
- Current line highlighted with glow/scale animation
- Auto-scroll following playback position
- Manual scroll with "tap to sync" return button
- Lyrics source: Musixmatch API / Spotify Lyrics API
- Full-screen lyrics mode
- Lyrics over blurred album art background
- Share lyrics as story card (Instagram-style image)

5.2 LYRICS FEATURES
- Translation toggle (translate lyrics to user's language)
- Romanization toggle (for non-Latin scripts: Japanese, Korean, Chinese, etc.)
- Tap lyric line to seek to that timestamp
- Font size adjustment
- Lyrics search ("find songs with these words")
- Save favorite lyrics/quotes
- Lyrics annotation/meaning (community or AI-generated)
- Sing-along mode with pitch detection (fun feature)

===============================================================================
6. QUEUE & PLAYBACK MANAGEMENT
===============================================================================

6.1 QUEUE
- View upcoming tracks
- Drag-to-reorder queue
- Swipe to remove from queue
- "Add to Queue" from any song context menu
- "Play Next" vs "Add to Queue" (play next = immediate, queue = end)
- Clear queue
- Save queue as playlist
- Queue history (previously played in session)
- Smart queue suggestions ("Add similar songs")

6.2 RECENTLY PLAYED
- Listening history with timestamps
- Resume playback from history
- Filter history by date range
- Clear history option
- History sync across devices

===============================================================================
7. LIBRARY / COLLECTION
===============================================================================

7.1 LIKED SONGS
- Heart button to like songs (with burst animation)
- "Liked Songs" auto-playlist
- Sort: Recently Added, Alphabetical, Artist, Album
- Filter by genre/language
- Bulk select & manage
- Download all liked songs

7.2 PLAYLISTS
- Create playlist (name, description, cover image)
- Custom playlist cover (choose from gallery or auto-generate collage)
- AI-generated playlist cover based on mood/genre
- Add/Remove songs
- Reorder songs (drag & drop)
- Collaborative playlists (invite friends to add songs)
- Playlist folders/categories
- Smart playlists (auto-update based on rules: genre, year, mood, etc.)
- Duplicate detection when adding songs
- Playlist duration & song count display
- Import playlists from Spotify/Apple Music/YouTube Music
- Export playlist as shareable link
- Playlist privacy: Public / Private / Collaborative
- Playlist description with hashtags

7.3 ALBUMS
- Save full albums to library
- Album view with track listing
- Album credits (producers, writers, engineers)
- Release date, label info
- Related albums suggestions

7.4 ARTISTS
- Follow artists
- Artist page: Bio, discography, top songs, related artists
- Artist events/concerts (integration with Songkick/Bandsintown)
- Artist radio (auto-generated mix)
- Notification on new releases from followed artists

7.5 DOWNLOADS / OFFLINE MODE
- Download songs, albums, playlists for offline
- Download quality settings
- Storage management (see space used, clear downloads)
- Auto-download favorites on WiFi
- Smart downloads (auto-download predicted listens)
- Offline mode indicator
- Downloaded content filter in library
- Download over WiFi only toggle
- Storage location selection (internal/SD card on Android)

===============================================================================
8. SOCIAL FEATURES
===============================================================================

8.1 SHARING
- Share song/album/playlist/artist via:
  - Deep link (opens in app)
  - Instagram/Snapchat/WhatsApp/Twitter story cards
  - Copy link
  - AirDrop / Nearby Share
  - QR code generation
- Share currently playing to social media with album art card
- Share lyrics snippet as image
- Share listening stats card

8.2 SOCIAL INTERACTIONS
- Follow friends
- See friends' listening activity (real-time)
- Collaborative playlists
- Send songs to friends (in-app messaging)
- Group listening session (listen together in sync)
- Song dedication feature
- Comment on playlists
- Leaderboards (top listeners for an artist)
- Music taste compatibility score with friends

===============================================================================
9. CONNECTIVITY & NETWORK HANDLING
===============================================================================

9.1 INTERNET STATUS MONITORING
- Real-time network state detection (NetInfo API)
- Connection type display (WiFi, 4G, 5G, 3G)
- Graceful degradation on slow connections:
  - Auto-switch to lower quality streaming
  - Prioritize cached content
  - Queue actions for when back online
- Offline mode auto-activation when no internet
- "No Internet" banner with retry button (animated)
- Background sync when connection restored
- Download pause/resume on connection change
- WiFi-only mode for streaming/downloads
- Data saver mode (reduce image quality, lower bitrate)
- Network speed test in settings
- Estimated data usage per hour display
- Monthly data usage tracker

9.2 CACHING STRATEGY
- Album art caching (memory + disk, LRU eviction)
- API response caching with TTL
- Search results caching
- Pre-fetch next tracks in queue
- Predictive caching (cache likely-to-play tracks)
- Clear cache option in settings with size display

===============================================================================
10. NOTIFICATIONS
===============================================================================

- New release from followed artist
- Playlist update notifications
- Friend activity notifications
- Weekly/Monthly listening report ready
- Concert/event near you (for followed artists)
- "Your Wrapped/Recap is ready" (year-end)
- Collaborative playlist activity
- Song recommendation push ("You might like...")
- Download complete notification
- Notification preferences (granular on/off per type)
- Quiet hours setting
- Rich notifications with album art and play button

===============================================================================
11. SETTINGS & PREFERENCES
===============================================================================

11.1 AUDIO SETTINGS
- Streaming quality (WiFi / Cellular separate)
- Download quality
- Equalizer
- Crossfade duration
- Gapless playback toggle
- Audio normalization toggle
- Mono audio toggle (accessibility)

11.2 PLAYBACK SETTINGS
- Autoplay similar songs when queue ends
- Canvas/video loops toggle
- Explicit content filter
- Default playback speed

11.3 DATA & STORAGE
- Data saver mode
- WiFi-only streaming
- WiFi-only downloads
- Cache size management
- Download storage location
- Clear all downloads
- Monthly data usage stats

11.4 DISPLAY & THEME
- Theme: Light / Dark / AMOLED Black / Auto (follows system)
- Accent color picker (or auto from album art)
- Font size (Small / Medium / Large)
- Compact mode toggle
- Animation toggle (reduce motion for accessibility)
- Language selection (app UI language)

11.5 PRIVACY & SECURITY
- Private session (don't log listening history)
- Profile visibility (Public / Private)
- Blocked users list
- Two-factor authentication
- Login activity / active sessions
- Data export (GDPR)
- Account deletion

11.6 CONNECTED SERVICES
- Spotify account link/unlink
- Apple Music account link/unlink
- Social accounts (for sharing)
- Smart home integration (Alexa, Google Home)
- Last.fm scrobbling

===============================================================================
12. FUTURISTIC / ADVANCED FEATURES
===============================================================================

12.1 AI-POWERED FEATURES
- AI DJ (like Spotify AI DJ - narrated transitions between songs)
- AI playlist generator ("Create a playlist for a rainy Sunday morning")
- Mood detection from selfie (camera → detect mood → suggest music)
- AI-powered song recommendations (collaborative + content-based filtering)
- Smart shuffle (AI-ordered shuffle based on listening patterns)
- Auto-generated playlist descriptions
- Voice commands for hands-free control
- AI lyrics explanation ("What does this song mean?")
- Music generation/remix (generate lo-fi version, slowed+reverb, etc.)

12.2 IMMERSIVE EXPERIENCES
- Spatial Audio with head tracking (AirPods Pro)
- 3D audio visualizer (WebGL/Three.js rendered)
- AR album art viewer (point camera, see 3D album art)
- Live concert streaming integration
- Music videos integration
- Behind-the-scenes content
- Artist stories (like Instagram stories from artists)
- Interactive music visualizer (reactive to audio frequencies)
- Ambient room mode (display art + visualizer on idle screen)

12.3 SMART FEATURES
- Sleep detection (auto-pause when user falls asleep via accelerometer)
- Driving mode (simplified UI, larger buttons, voice control)
- Workout mode (BPM-matched playlists based on heart rate via HealthKit)
- Focus/Study mode (auto-queue ambient, lo-fi, instrumental)
- Party mode (shared queue, guests can add songs via QR code)
- Karaoke mode (vocals removed + lyrics displayed)
- Alarm integration (wake up to favorite song)
- Calendar integration (auto-suggest party playlist for events)

12.4 GAMIFICATION
- Listening streaks (daily streak tracker)
- Achievement badges (First Playlist, 1000 Songs Played, Night Owl, etc.)
- XP system for engagement
- Leaderboards (friends, global, per-artist)
- Yearly Wrapped / Listening Report
  - Top songs, artists, genres
  - Total minutes listened
  - Listening personality type
  - Shareable cards with animations
- Music quiz (test knowledge about favorite artists)
- Song guess game (play snippet, guess the song)

12.5 ACCESSIBILITY
- Screen reader support (VoiceOver / TalkBack)
- Dynamic font sizing
- High contrast mode
- Reduce motion option
- Haptic feedback toggle
- Mono audio option
- Caption support for video content
- Keyboard navigation support
- Color blind friendly UI

===============================================================================
13. ANALYTICS & INSIGHTS (FOR USER)
===============================================================================

- Daily/Weekly/Monthly listening time
- Top artists, songs, genres, albums (by period)
- Listening pattern heatmap (time of day / day of week)
- Genre distribution pie chart
- Mood distribution over time
- New artists discovered this month
- Listening streak calendar
- Comparison with previous periods
- "On This Day" - what you listened to a year ago
- Shareable stat cards

===============================================================================
14. PERFORMANCE & TECHNICAL FEATURES
===============================================================================

14.1 APP PERFORMANCE
- App launch < 2 seconds (splash screen with animation)
- Smooth 60fps animations (React Native Reanimated)
- Lazy loading for lists (FlashList for virtualized lists)
- Image optimization (progressive loading, blurhash placeholders)
- Memory management (auto-cleanup on low memory)
- Crash reporting (Sentry / Crashlytics)
- Performance monitoring (app startup, screen load times)
- Bundle size optimization (code splitting)

14.2 SECURITY
- JWT token authentication with refresh tokens
- Certificate pinning for API calls
- Encrypted local storage (expo-secure-store)
- Biometric authentication
- Jailbreak/Root detection
- Anti-tampering checks
- Secure API key storage (never in client bundle)
- Rate limiting on auth endpoints

14.3 TESTING STRATEGY
- Unit tests (Jest)
- Component tests (React Native Testing Library)
- E2E tests (Detox / Maestro)
- API integration tests
- Performance benchmarks
- Accessibility audits

===============================================================================
15. MONETIZATION (FUTURE)
===============================================================================

- Free tier (ad-supported, shuffle-only, no offline)
- Premium tier (ad-free, offline, high quality, lyrics)
- Family plan
- Student discount
- Artist tipping / support
- Merchandise store integration
- Concert ticket sales (affiliate)
- In-app purchases (custom themes, visualizers)

===============================================================================
16. SCREEN MAP (ALL SCREENS)
===============================================================================

AUTH SCREENS:
  - Splash Screen (animated logo)
  - Welcome / Onboarding Carousel
  - Login Screen
  - Signup Screen
  - OTP Verification Screen
  - Forgot Password Screen
  - Genre Picker Screen
  - Artist Picker Screen
  - Language Picker Screen

MAIN SCREENS (Tab Navigation):
  - Home Screen
  - Search / Explore Screen
  - Library Screen
  - Profile Screen

SUB SCREENS:
  - Full Player Screen
  - Queue Screen
  - Lyrics Screen (full screen)
  - Artist Detail Screen
  - Album Detail Screen
  - Playlist Detail Screen
  - Genre Detail Screen
  - Settings Screen
  - Audio Settings Screen
  - Equalizer Screen
  - Theme Settings Screen
  - Privacy Settings Screen
  - Storage Management Screen
  - Notifications Settings Screen
  - About Screen
  - Edit Profile Screen
  - Followers/Following Screen
  - Friend Activity Screen
  - Listening Stats/Insights Screen
  - Yearly Wrapped Screen
  - Downloads Manager Screen
  - Recently Played Screen
  - Collaborative Playlist Invite Screen
  - Party Mode Screen
  - Sleep Timer Screen
  - Song Credits Screen

MODALS / OVERLAYS:
  - Mini Player (persistent bottom bar)
  - Song Options Bottom Sheet
  - Add to Playlist Bottom Sheet
  - Share Bottom Sheet
  - Sleep Timer Bottom Sheet
  - Create Playlist Modal
  - Filter/Sort Bottom Sheet
  - No Internet Overlay
  - Update Available Modal

===============================================================================
17. ANIMATIONS & MICRO-INTERACTIONS SPEC
===============================================================================

- Screen transitions: Shared element (album art morphs from list to player)
- Like button: Heart burst particle animation
- Play/Pause: Morphing icon animation (play triangle ↔ pause bars)
- Mini player expand: Smooth spring animation with gesture
- Pull to refresh: Custom music note bounce animation
- Skeleton loading: Shimmer effect on all content cards
- Tab bar: Animated icon + label transition
- Shuffle: Dice roll animation
- Download: Progress ring animation → checkmark
- Volume: Haptic detents at 0%, 50%, 100%
- Queue reorder: Smooth drag with shadow elevation
- Swipe actions: Rubberband physics
- Toast notifications: Slide in from top with spring
- Page indicators: Smooth dot morphing
- Search bar: Expand animation from icon to full width
- Theme switch: Smooth color crossfade (not jarring jump)

===============================================================================
TOTAL FEATURE COUNT: 200+ features across 17 categories
===============================================================================

IMPLEMENTATION PRIORITY:
  Phase 1 (MVP):     Auth, Home, Search, Player, Mini Player, Lyrics, Library
  Phase 2:           Playlists, Downloads, Queue, Settings, Themes
  Phase 3:           Social, Sharing, Notifications, Offline
  Phase 4:           AI features, Gamification, Analytics, Advanced
  Phase 5:           AR, Spatial Audio, Party Mode, Monetization

NEXT STEP: Run `npx create-expo-app zoyra --template blank-typescript`
           and start building Phase 1 components.
