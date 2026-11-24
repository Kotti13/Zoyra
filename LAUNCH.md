# Zoyra launch checklist

Four pieces, each hosted separately and joined by addresses and keys. Do them in this order: the later steps need values
from the earlier ones.

```
App (phones) ──► Supabase  (database, login, functions)          already hosted by Supabase
     │      └──► Backend   (services/gateway + services/newpipe)  YOU host this
     └─────────► Web share (web/share, link previews)             Vercel
```

**Status when this was written (2026-11-22)** — tick them off as you go:

- [x] Supabase project is live (`vmdkgkgyzflvqsvecava`, Sydney). Migrations are applied up to `20261122110000`.
- [ ] Migration `20261122120000_share_live_card.sql` is **not applied yet** (live-room link previews need it).
- [ ] Supabase secrets missing: `ANTHROPIC_API_KEY`, `TICKETMASTER_API_KEY`, `LASTFM_*`, `ACRCLOUD_*`, `STEMS_*`,
      `REVENUECAT_WEBHOOK_AUTH`, `PUSH_WEBHOOK_SECRET` (set: `YOUTUBE_API_KEY`, Agora, Supabase's own).
- [x] Web share is live at `https://share.zoyra.site`.
- [ ] Web share has **no `APPLE_TEAM_ID`** (the iOS file says `TEAMID_NOT_SET`) and **no Android fingerprints**: shared links
      cannot open the app directly yet, only the web page.
- [ ] Web share is the **old version**: `/lv/…` (live), `/rm/…`, `/fam/…`, `/inv/…` links return 404 until redeployed.
- [ ] Backend is **not deployed**: it only runs on a development Mac.
- [ ] The app's `.env` points at a development address (this Mac's local network) — not usable in a store build.

---

## 1. Supabase

| Step | Command / place |
| --- | --- |
| Apply the pending migration | `supabase db push` |
| Set the server keys (hidden prompts, press Enter to skip any) | `bash scripts/set-supabase-secrets.sh` |
| Where the keys come from | listed at the top of `scripts/set-supabase-secrets.sh` |

Anthropic's key turns on four screens at once (AI DJ, AI playlist, lyrics translate/romanize, mood from photo). Each key you
skip leaves its feature showing "needs setup".

## 2. Backend (the two folders `services/gateway` + `services/newpipe`)

Host the **repository root**: the root `Dockerfile` builds both into one container. Full options: `services/HOSTING.md`.

| Setting on the host | Value |
| --- | --- |
| `ZOYRA_API_KEY` | a long random string (`openssl rand -hex 24`). The app sends it. |
| `NEWPIPE_TOKEN` | another long random string. Setting it also starts the music service. |
| `TRUST_PROXY` | `true` when behind a proxy / load balancer |
| `PORT` | whatever the host gives you (default 8080) |
| `REDIS_URL` | optional (cache and rate limits survive restarts) |
| `SUPABASE_JWT_SECRET` or `SUPABASE_JWKS_URL` | only for the gateway's `/v1/*` routes, not for the app's music routes |

- Give it an `https://` address (the app needs HTTPS in store builds).
- Allow at least 1 GB of memory; pick a region near your listeners.
- **Test right after deploying** (cloud servers are sometimes blocked by YouTube):
  `curl -H "X-Zoyra-Key: <key>" "https://<backend>/api/search?q=hello"` → should list songs.
  Then play one song from the app on mobile data.

## 3. Web share (`web/share` on Vercel)

Redeploy so the new link types go live: `cd web/share && npx vercel --prod`.

| Vercel setting (Production) | Value |
| --- | --- |
| `PUBLIC_HOST` | `https://share.zoyra.site` (must equal the app's `EXPO_PUBLIC_SHARE_HOST`) |
| `SUPABASE_URL` | same as the app's `EXPO_PUBLIC_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | same as the app's `EXPO_PUBLIC_SUPABASE_KEY`. **Never the service-role key.** |
| `APPLE_TEAM_ID` | 10 characters: developer.apple.com → Membership, or `npx eas-cli credentials -p ios` |
| `ANDROID_SHA256_FINGERPRINTS` | both the EAS key and the Play App Signing key, comma separated (`npx eas-cli credentials -p android`; Play Console → Setup → App signing) |
| `APP_STORE_URL`, `PLAY_STORE_URL` | store links (optional, turns on the store buttons) |
| `ZOYRA_API_URL` | leave unset (the page then uses YouTube's own lookup for song titles) |

After deploying, check:

```
curl -s https://share.zoyra.site/.well-known/apple-app-site-association   # must NOT say TEAMID_NOT_SET
curl -s https://share.zoyra.site/.well-known/assetlinks.json              # fingerprints must not be []
curl -s -o /dev/null -w "%{http_code}\n" https://share.zoyra.site/lv/<a-live-session-id>   # 200 once the migration is applied
```

## 4. The app

Values are built into the app, so change them, then make a new build. Cloud builds do **not** read your local `.env`: set
them in EAS (`npx eas-cli env:create`, once per name, for the build profile you use).

| App setting | Value |
| --- | --- |
| `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_KEY` | your Supabase project |
| `EXPO_PUBLIC_ZOYRA_API_URL` | the backend's `https://` address from step 2 |
| `EXPO_PUBLIC_ZOYRA_API_KEY` | the same value as the backend's `ZOYRA_API_KEY` |
| `EXPO_PUBLIC_SHARE_HOST` | `https://share.zoyra.site` (same as `PUBLIC_HOST`) |
| `EXPO_PUBLIC_SENTRY_DSN` | your Sentry project address (empty = crash reporting off) |
| `EXPO_PUBLIC_SPOTIFY_CLIENT_ID`, `EXPO_PUBLIC_REVENUECAT_*` | already set locally; add them to EAS too |

Build: `npx eas-cli build --profile production --platform all` (or `--profile preview` for a test APK first).
**A new build is required** whenever a link type is added (`app.config.js` registers `/t /p /a /ar /u /l /s /lv /rm /fam /inv`
with iOS and Android).

## 5. Check everything together (on a real phone, mobile data)

- [ ] Sign up a new account: genres → languages → artists show pictures.
- [ ] Search a song, play it, seek, skip, download it.
- [ ] Open lyrics; seek and watch them follow.
- [ ] Share a song, a playlist, a profile and a live room into WhatsApp: each arrives as a **link** with a preview card.
- [ ] Tap that link on a second phone: the app opens on the right screen (and the store page if the app is not installed).
- [ ] Comments and community: post, reply to a reply, edit.
- [ ] Force a test crash and see it in Sentry (after the DSN is set).

## Known limits

- Playing audio through YouTube breaks YouTube's terms and can get an app rejected from a store.
- The backend streams all audio itself: about 128 kbps per listener.
- The Docker image has not been built by the author (Docker was unavailable); both services and the start script were tested
  directly.
- iOS caches the app-link file for up to about 24 hours.
