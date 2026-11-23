# Zoyra: Feature Inventory

Music streaming + social app. Expo SDK 58 / React Native 0.88 / TypeScript, Expo Router, Supabase backend, Python gateway + NewPipe service for music/lyrics.

This file lists what the codebase actually contains (screens in `src/app/`, logic in `src/lib/`, server in `supabase/` and `services/`). The earlier planning spec (Spotify SDK / Apple MusicKit era) is in git history (`git show a210db3:FEATURES.md`).

Features marked **needs setup** work in code but depend on a server key or deployment that is not live yet (see [LAUNCH.md](LAUNCH.md)).

---

## 1. Architecture at a glance

| Layer | What | Where |
| --- | --- | --- |
| Mobile app | iOS + Android (portrait, dark-first), web via react-native-web | `src/`, `app.json`, `eas.json` |
| Database / Auth / Realtime | Supabase (Postgres + RLS, 50+ migrations) | `supabase/migrations/` |
| Edge functions | AI, push, billing webhook, recognition, concerts, etc. | `supabase/functions/` |
| Music gateway | FastAPI proxy: Audius, YouTube, Spotify metadata, lyrics, Last.fm, ListenBrainz, LibriVox, Ticketmaster | `services/gateway/` |
| Music stream service | NewPipe (JVM) for YouTube audio extraction | `services/newpipe/` |
| Share pages | Link-preview cards on Vercel (`/s`, `/u`, `/lv`, `/rm`, `/fam`, `/inv`), app-link files (AASA, assetlinks) | `web/share/` |
| Marketing site | Landing + Download page (APK, Play Protect note) | `web/site/` |
| Calls | Agora RTC + CallKeep + VoIP push | `src/lib/agora*.ts`, `call*.ts`, `voip-push` function |
| Payments | RevenueCat (store subscriptions + gifts) | `src/lib/payments.ts`, `revenuecat-webhook` |
| Crash reporting | Sentry | `src/lib/crash-reporting.ts` |
| OTA / updates | expo-updates, in-app update screen | `update.tsx`, `src/lib/updates.ts` |

Navigation: 4 tabs (**Home, Search, Library, Profile**) plus ~200 stack/sheet screens.

---

## 2. Account, login and onboarding

- Email + password signup / login (`signup`, `login`), show/hide password.
- Phone number + OTP (`otp`) with readable provider errors.
- Social OAuth callback handling (`auth-callback`).
- Forgot / reset password via email link (`forgot`, `reset-password`).
- Two-factor authentication with authenticator app (`two-factor`, `mfa-verify`).
- Biometric / device lock (expo-local-authentication) for app and per-chat lock.
- Multi-account switcher (`account-switcher`, `src/lib/accounts.ts`).
- Active sessions list and sign-out of other devices (`sessions`).
- Re-authentication before sensitive actions (`src/lib/reauth.ts`).
- Account deletion (`delete-account` edge function) and data export of everything stored about the user (`privacy`).
- Welcome poster, animated splash, onboarding with genre / artist / language picks (`welcome`, `splash`, `onboarding`, `onboarding-picks.ts`).
- Permission walkthrough: notifications, mic, camera, location, full-screen call alerts (`permissions`).

## 3. Home

- Greeting and personalised board of entry cards (`(tabs)/index`).
- Recently played (live-synced across devices) (`recent`).
- Daily Mix tiles; hidden songs/artists and kid-unsafe explicit tracks filtered (`daily-mix`).
- New releases board with filter chips, hourly new-release push (`new-releases`, `new-releases` function).
- Charts with podium for top 3 (`charts`).
- Discover, genre pages, mood boards (moods, activities, decades) (`discover`, `genre`, `mood-boards`).
- Radio stations with LIVE badge (`radio`).
- Wrapped: yearly listening recap with shareable cards (`wrapped`).
- On This Day memories: song you played most on today's date in earlier years (`memories`).
- Notes row in inbox and stories row.

## 4. Search

- Catalogue search for songs, artists, albums, playlists, videos (`(tabs)/search`).
- Recent searches (last 5 per user), clear.
- Voice search via speech recognition.
- Filter and sort sheet (`filter-sort`).
- Settings search (`settings-search`, `settings-index.ts`).
- Chat search across messages, decrypted on device (`chat-search`).

## 5. Playback engine

- Full player with artwork effects, seek bar, shuffle / repeat, like, add to playlist, share (`player`).
- Background audio + lock-screen / notification media controls (expo-audio, foreground service).
- Queue management: reorder, play next, add to queue (`queue`).
- Gapless / crossfade and playback preferences (`playback-settings`).
- Sleep timer: minutes or end-of-track, with live countdown (`sleep`, `sleep-sheet`).
- Playback speed and FX sheet (`fx-sheet`).
- 10-band equalizer (`equalizer`, `audio-settings`).
- Audio quality choices with estimated data per minute (`audio-quality`).
- Buffering / stall screen with live stall timer, slow-network and back-online states (`player-buffering`, `slow-net`, `back-online`, `net-status`).
- Car mode: big controls (`car-mode`).
- Lock-screen widget preview (`widgets-lock`).
- Track detail and credits (`track-detail`, `credits`).
- Song options sheet: Like, Playlist, Download, Share, Dedicate, etc. (`song-options`).
- Stats for nerds (`stats-nerds`).
- Karaoke: big synced lines with word fill, tap-to-jump, mic (`karaoke`).
- Stem separation for vocals/instrument split (**needs setup**: `stems` function).
- Scrobbling to Last.fm (**needs setup**: `lastfm` keys) (`scrobbling`).

## 6. Lyrics

- Time-synced lyrics from LRCLIB with FILL / WAVE / WORD styles (`lyrics`, `lyrics-sync.ts`).
- Lyrics focus mode: one big line at a time (`lyrics-focus`).
- Lyrics settings: size, style, translate / romanize target language (`lyrics-settings`).
- AI translate and romanize (**needs setup**: `ANTHROPIC_API_KEY`) (`lyrics-ai`).
- Share lyrics card: pick up to 4 lines, choose a card style (`lyrics-share`).
- Send a lyric line into chat (`chat-attach?mode=lyric`).
- Lyric ticker and sync checker script (`scripts/check-lyrics-sync.ts`).

## 7. Library

- Liked songs, saved albums (stored as tagged playlist copies), followed artists (`(tabs)/library`).
- Playlists: create with cover upload, edit, reorder, delete (`create-playlist`, `playlist`).
- Add to playlist, showing playlists that already contain the song (`add-to-playlist`).
- Collaborative playlists and invites (`invite`).
- Import playlists from other sources, with what each source still needs (`import`).
- Playlist file import/export (`src/lib/playlistFile.ts`).
- Local device music via media library (`local-music`).
- Downloads and offline mode: downloaded tracks play from local files (`downloads`, `offline`, `offline-home`, `src/state/downloads.tsx`).
- Storage and cache management: sizes, clear image cache (`storage`, `cache`).
- Data usage tracking with monthly cap setting (`data-usage`, `src/lib/usage.ts`).
- Speed test (`speed-test`).
- Podcasts and shows with episode downloads (`podcasts`, `podcast-show`, `EpisodeDownload`).
- Audiobooks via LibriVox with chapter playback (`audiobooks`).
- Albums and artist pages: hero banner, top tracks, follow, links (`album`, `artist`, `artists`, `merch`).

## 8. AI features

All AI calls run in Supabase edge functions on Claude. **Needs setup** until `ANTHROPIC_API_KEY` is set.

- AI Playlist: describe a vibe in text, with negations like "no heavy drums" (`ai-playlist`).
- AI DJ: mixes sources, dedupes, max 2 tracks per artist (`ai-dj`).
- Mood scan: mood from a photo (`mood-scan`, `mood-from-photo`).
- Lyrics translate / romanize (`lyrics-ai`).
- Smart covers (`src/lib/smart-covers.ts`).

## 9. Song recognition

- Identify: record a short clip, server match, open result (`identify`, `identify-result`).
- Hum / sing mode (`identify?mode=hum`) (**needs setup**: ACRCloud keys, `recognize-song`).

## 10. Videos

- Video hub by category, backed by YouTube search/charts (`videos`).
- Player with comments sheet, options, settings, full-screen, and Shorts pager (`video-player`, `video-comments`, `video-options`, `video-settings`, `video-full`, `video-shorts`).
- Autoplay next and captions preferences.
- Premieres (`premieres`).
- **Needs setup**: `YOUTUBE_API_KEY` (set).

## 11. Social

- Follow / followers / following lists (`followers`).
- Public profile, @username share links, profile QR code with scanner (`public-profile`, `profile-qr`, `qr-scanner`).
- Friends and taste matching: cosine similarity of listening (`friends`, `taste-compare`, `profile-taste`).
- Blend: one playlist from your listening and a friend's last 90 days (`blend`).
- Profile customization: banner image, frames, avatars, bio (`edit-profile`, `customize-profile`, `avatar-picker`).
- Profile activity feed, playlists of any user (`profile-activity`, `profile-playlists`, `profile-more`).
- Track comments with replies (`track-comments`), community posts with replies and edit (`community`).
- Stories: 24-hour full-screen stories from followed people (`stories`).
- Notes: 60-char or song note shown to mutuals for 24 hours, with viewers / likes / replies (`note-compose`, `note-viewers`).
- Dedications: send a song to someone with a message (`dedication`).
- Nearby share: short-lived code, scan to receive a song (`nearby-share`).
- Stats share links that open in-app (`shared`).
- Share sheet for songs, with block / lock / privacy-aware errors (`share-sheet`).
- Invite and referral flows (`invite`).

## 12. Messaging (Chat Pro)

- Inbox with pin, archive, message requests (`messages`, `message-requests`).
- 1:1 chat with end-to-end encryption (`chat-pro`, `chat-e2ee.ts`, `src/lib/e2ee/`).
- E2EE setup, PIN-protected backup and restore, safety-number verification (`e2ee-setup`, `e2ee-restore`, `e2ee-verify`).
- Group chats: create, info, admins, rename, photo, member rules (`new-group`, `group-chat`, `group-info`).
- New message picker showing active now, taste match, mutuals, locked reasons (`new-message`).
- Message actions: reply (swipe), react with any emoji, star, forward, unsend, delete for me, remind me (`chat-actions`, `confirm-unsend`, `remind-me`, `swipe-reply.tsx`).
- Attachments: photos, voice notes (lock/cancel drag), songs, lyric lines, whisper (view-once) photos (`chat-attach`, `chat-voice`, `chat-whisper`).
- Scheduled messages and time capsules (`chat-scheduled`, `chat-capsule`).
- Starred messages vault, chat media gallery, chat search (`starred`, `chat-media`, `chat-search`).
- Disappearing messages: Off / 24 h / 7 days / 90 days (`chat-tools`).
- Chat lock with Face ID / Touch ID / passcode (`chat-lock`).
- Per-chat notification settings and mute (`chat-notifications`).
- Privacy: DM privacy, last seen and online, restrict, block with report email (`dm-privacy`, `last-seen`, `restricted`, `blocked`, `confirm-block`, `blocked-done`).
- Chat mood and catch-up summaries (`chat-mood.ts`, `chat-catchup.tsx`).
- **Forever friends**: opt-in permanent bond (can't be blocked), gold ring with streak, request / accept flow, vault (`forever*` screens).

## 13. Calls and live

- 1:1 voice and video calls (Agora), picture-in-picture, native call UI via CallKeep, VoIP push on iOS (`call`, `native-call.ts`, `voip-push`).
- Group calls (`group-call`).
- Group listening rooms with share code and link (`group-listening`, `party`).
- Live hub, go live (scheduled slots), live room with link preview cards (`live-hub`, `go-live`, `live-room`).
- Listen-along inside calls (`call-listen.ts`).

## 14. Entertainment and gamification

- Entertain hub (`entertain-hub`).
- Games: Beat Rush rhythm game (`beat-game`), quiz with ring timer (`quiz`), games hub (`games`).
- Leaderboards (`leaderboard`).
- XP, levels, level perks (banners and avatar frames unlocked by level) (`level-perks`, `src/lib/levels.ts`).
- Achievements, badges, weekly streak (`achievements`, `badges`).
- Rewards (`rewards`).
- Concerts and tickets via Ticketmaster (**needs setup**) (`concerts`, `tickets`).

## 15. Wellness and fitness

- Wellness sessions built from live searches (`wellness`).
- Run mode: tempo picker, GPS distance / pace, pedometer steps / cadence, tempo-matched music, pause/resume (`workout-home`, `run-session`).
- Run summary: totals, GPS route snapshot, past runs, songs played, share (`workout-summary`).
- Insights: listening time charts by period (`insights`).

## 16. Safety, family and kids

- Family plan: up to 6 accounts, join by code or link (`family`, `join-family`).
- Kids mode: explicit hidden, messaging restricted, guarded screens (`kids-mode`, `KidsGuard.tsx`).
- Content controls: hide explicit, hide specific songs or artists (`content-controls`, `content-filter.ts`).
- Restricted accounts and DM request gating.

## 17. Notifications

- In-app notification center with grouping (`notifications`).
- Push via Expo (`push` function, webhook secret), VoIP push for calls.
- Push settings: per-type toggles and quiet hours (default 11 pm to 7 am) (`push-settings`, `notif-settings`).
- Reminders (`reminders.ts`).

## 18. Settings and personalization

- Settings hub tile grid and full settings list (`settings-hub`, `settings`).
- Theme: dark / light / auto, accent system documented in [THEME.md](THEME.md) (`theme`).
- Languages (`languages`).
- Accessibility: text size, reduce motion, a11y helpers (`accessibility`, `src/lib/a11y.ts`).
- Playback, audio, video, lyrics, data, storage, notifications, privacy, devices settings.
- Connected services: Spotify (PKCE) and Last.fm (`connected`, `spotify-callback`, `scrobbling`).
- Device connect (`devices-connect`).
- Help, About, update screen (`help`, `about`, `update`).

## 19. Monetization

- Plans: **Free, Premium, Family, Student** (`plans`).
- Premium perks listed in app: ad-free, offline downloads, lossless audio, AI DJ and AI playlists.
- Purchase and restore through RevenueCat; plan column set only by the server webhook, never the client (`billing`, `revenuecat-webhook`).
- Manage subscription via store.
- Gift Premium: 1 / 3 / 12 months by store gift products, redeem by code (`gift-premium`).

## 20. Backend services

**Supabase edge functions:** `agora-token`, `ai-dj`, `ai-playlist`, `concerts`, `delete-account`, `lastfm`, `lyrics-ai`, `mood-from-photo`, `new-releases`, `push`, `recognize-song`, `revenuecat-webhook`, `stems`, `voip-push`, `youtube`.

**Gateway routers (`services/gateway/app/routers/`):** audius, concerts, lastfm, librivox, listenbrainz, lyrics, meta, newpipe, spotify, youtube, zoyra_compat. Includes Redis-optional cache, rate limiting and JWT auth for `/v1/*`.

**Database domains (migrations):** core profiles / playlists / likes, follows (realtime), safety and family, scrobble, sessions, live, workouts, videos, notification center, content controls, entertain, games and community, chat (requests, privacy, E2EE, groups, search, pin/archive, notes, forever, extras, disappearing, scheduled), calls and group calls, share cards and snapshots, track comments, blend / memories / stories, gifts / kids / nearby share.

## 21. Web

- **Share pages** (`web/share`, Vercel): link-preview cards and deep-link files for profiles, stats, live rooms, rooms, family, invites.
- **Marketing site** (`web/site`): landing page and Download page with Play Protect explanation.
- Release: Android preview APK builds auto-increment `versionCode`.

## 22. Known gaps (from LAUNCH.md, 2026-11-22)

- Backend (gateway + NewPipe) not deployed to a public HTTPS host.
- Server secrets missing: `ANTHROPIC_API_KEY`, `TICKETMASTER_API_KEY`, `LASTFM_*`, `ACRCLOUD_*`, `STEMS_*`, `REVENUECAT_WEBHOOK_AUTH`, `PUSH_WEBHOOK_SECRET`.
- Migration `20261122120000_share_live_card.sql` not applied.
- Web share needs `APPLE_TEAM_ID` and Android fingerprints for direct app opening; redeploy needed for `/lv`, `/rm`, `/fam`, `/inv` links.
- App `.env` points at a local development address.
