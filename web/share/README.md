# Zoyra share links (`web/share`)

A small Vercel project with no framework. It makes Zoyra share links unfurl into rich cards in WhatsApp, iMessage, Telegram, X, Slack and Discord. It also makes the same links open the app directly.

| Link | Shows | In-app route |
| --- | --- | --- |
| `/t/:id` | song (Audius id or `yt_…`) | `/track-detail?id=` |
| `/l/:id` | lyric card for a song | `/track-detail?id=` |
| `/p/:id` | user playlist (uuid, public only) or catalogue playlist | `/playlist?id=` / `/playlist?catalog=` |
| `/a/:id` | album | `/album?id=` |
| `/ar/:id` | artist (Audius id or `yta_<name>`) | `/artist?id=` |
| `/u/:username` or `/u/:uuid` | profile (minimal card if private) | `/public-profile?username=` / `?id=` |
| `/.well-known/apple-app-site-association` | iOS Universal Links | |
| `/.well-known/assetlinks.json` | Android App Links | |

Every page is rendered on the server and includes:

- Open Graph tags: `og:title`, `og:description`, `og:image` (absolute https), `og:url`, `og:type` (`music.song`, `music.playlist`, `music.album` or `profile`).
- Twitter tags with `summary_large_image`.
- A canonical URL.
- A dark red landing page with the cover art, the title, an **Open in Zoyra** button and store buttons. The button uses `zoyra://…`, or `intent://` on Android so it falls back to Play.

## Where the data comes from

- **Songs, albums and artists** use the same public Audius API as the app (`src/lib/catalog.ts`). `yt_` songs use the Zoyra backend when `ZOYRA_API_URL` is set, otherwise YouTube oEmbed.
- **Playlists and profiles** come from Supabase, using the anon (publishable) key only. They are read through two `SECURITY DEFINER` RPCs in `supabase/migrations/20261115290000_share_cards.sql`, which return only public fields:
  - `share_playlist_card(pid)` returns a row only when `visibility = 'public'`. Private and collaborative playlists return nothing, so the page shows "private or no longer exists". If the owner's profile is private, the owner's name is left out.
  - `share_profile_card(lookup)` returns the name, @username, bio, avatar and counts for a public profile. For a private profile it returns only `is_private = true`.
  - The service-role key is never used. The tables stay RLS-locked to `authenticated`.

**Apply the migration before the first deploy** with `npx supabase db push`, or paste the file into the SQL editor. Until you do, profile and playlist links render a "couldn't load" page (HTTP 503).

## Deploy (one command)

```bash
npx vercel login                 # once
cd web/share && npx vercel --prod
# or, from the repo root:  npm run share:deploy
```

On the first run, Vercel asks you to link a project. Name it `zoyra-share` so the URL is `https://share.zoyra.site`. If that name is taken, use whatever URL you get and set it as `PUBLIC_HOST` below **and** as `EXPO_PUBLIC_SHARE_HOST` in the app.

### Environment variables

Set these in Vercel → Project → Settings → Environment Variables (Production), or with `npx vercel env add NAME production`, then redeploy:

| Name | Value |
| --- | --- |
| `PUBLIC_HOST` | `https://share.zoyra.site`. The ONE place the web side sets its domain. Must equal the app's `EXPO_PUBLIC_SHARE_HOST`. |
| `SUPABASE_URL` | Same value as `EXPO_PUBLIC_SUPABASE_URL`. |
| `SUPABASE_ANON_KEY` | Same value as `EXPO_PUBLIC_SUPABASE_KEY` (anon or `sb_publishable_…`). **Never the service-role key.** |
| `APPLE_TEAM_ID` | 10-character Team ID, from developer.apple.com → Membership, or `npx eas-cli credentials -p ios`. The appID becomes `<TEAMID>.com.zoyra.app`. |
| `ANDROID_SHA256_FINGERPRINTS` | Comma-separated SHA-256 fingerprints, in the form `AA:BB:…` (32 bytes). See below. |
| `APP_STORE_URL` (optional) | `https://apps.apple.com/app/id…`. Turns on the App Store button and the Smart App Banner. |
| `PLAY_STORE_URL` (optional) | Defaults to `https://play.google.com/store/apps/details?id=com.zoyra.app`. |
| `ZOYRA_API_URL` (optional) | Gives better titles for `yt_` songs. |

**Getting the Android fingerprints:**

- **EAS keystore** (dev, preview and internal APKs): run `npx eas-cli credentials -p android`, pick a build profile, and copy **SHA256 Fingerprint**.
- **Play Store builds:** Google re-signs these with the *App signing key*. In Play Console, go to your app → Test and release → Setup → **App signing** and copy the SHA-256 of the **App signing key certificate**.
- Add **both** fingerprints, separated by a comma.

### Checks after deploying

```bash
curl -i https://share.zoyra.site/.well-known/apple-app-site-association   # 200, application/json, no redirect
curl -i https://share.zoyra.site/.well-known/assetlinks.json
node scripts/check-og.mjs https://share.zoyra.site/t/<audiusTrackId>        # validates OG/Twitter tags + image
```

You can also check with these tools:

- Google's Digital Asset Links tester: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://share.zoyra.site&relation=delegate_permission/common.handle_all_urls`
- An AASA validator, such as Branch's.
- On a device, run `adb shell pm verify-app-links --re-verify com.zoyra.app`, then `adb shell pm get-app-links com.zoyra.app`.

## Local testing

```bash
node --test test/*.test.mjs      # renderer + data layer with fetch mocks (no network)
npx vercel dev                   # full local server (needs `npx vercel env pull .env.local`)
```

## Changing the domain later (e.g. `share.zoyra.app`)

1. Add the domain in Vercel → Domains, then set `PUBLIC_HOST` and redeploy.
2. App: set `EXPO_PUBLIC_SHARE_HOST=https://share.zoyra.app` in `.env` and in the EAS environment variables. `app.config.js` derives `ios.associatedDomains` and `android.intentFilters` from it.
3. **Make a new native build** (`eas build`). Associated domains and intent filters live in the binary, and an OTA update can't change them. Old `zoyra-share.vercel.app` links keep working on the web as long as that deployment stays up.

## Cache

| Content | `Cache-Control` |
| --- | --- |
| Catalogue pages | `s-maxage=3600, stale-while-revalidate=86400` |
| Playlist and profile pages | `s-maxage=600, stale-while-revalidate=600` (so going private takes effect within about 10–20 min at the edge) |
| 404 | `s-maxage=300` |
| Upstream errors (503) | `s-maxage=30` |

## Known limits

- **WhatsApp, iMessage, Facebook and X cache previews per URL**, for days in WhatsApp's case. A changed cover or title won't show on links that were already shared. Use Facebook's Sharing Debugger to refresh Meta's cache.
- **Instagram:** Stories and feed posts can't carry link cards. The only option is the Link sticker, which shows just the domain. DMs do unfurl.
- **Universal Links don't fire** when you paste a link into Safari's address bar, or on a link to the same domain from the landing page. That's why the page has an "Open in Zoyra" (`zoyra://`) button.
- iOS fetches the AASA through Apple's CDN when the app is installed or updated, and can take up to about 24 h to see changes. Android verifies App Links when the app is installed.
- Profile links use the @username when there is one. If the user renames, old links show "No one goes by @…" in the app and a 404 card on the web.
- Song pages show metadata and artwork only. No audio is served from this site.
