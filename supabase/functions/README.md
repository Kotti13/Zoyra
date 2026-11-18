# Zoyra Edge Functions

Deno functions in `supabase/functions/<name>/index.ts`; shared helpers in `_shared/`.
Each one returns JSON with CORS headers. When a secret is missing, it returns
**HTTP 503 `{ "error": "not_configured", "service": "<name>" }`**. The app shows "needs <service> setup" and never fakes success.

Client call: `supabase.functions.invoke('<name>', { body })`. The SDK attaches the user's JWT.
With `invoke`, a non-2xx response arrives as `error` (a `FunctionsHttpError`). To read the JSON body, use `await error.context.json()`.

Common error bodies: `401 { error: 'unauthorized' }`, `400 { error: 'invalid_body', message }`,
`502 { error: '<x>_failed', message }`, `422 { error: 'ai_failed' }` (the model declined).

| Function | Auth | Secret(s) | `service` in 503 |
|---|---|---|---|
| delete-account | user JWT | (built-in service role) | `supabase` |
| ai-playlist | user JWT | `ANTHROPIC_API_KEY` | `anthropic` |
| ai-dj | user JWT | `ANTHROPIC_API_KEY` | `anthropic` |
| mood-from-photo | user JWT | `ANTHROPIC_API_KEY` | `anthropic` |
| recognize-song | user JWT | `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` (+ optional `ACRCLOUD_HUM_HOST/_ACCESS_KEY/_ACCESS_SECRET` for hum / sing mode) | `acrcloud` |
| concerts | user JWT | `TICKETMASTER_API_KEY` | `ticketmaster` |
| youtube | user JWT | `YOUTUBE_API_KEY` | `youtube` |
| lyrics-ai | user JWT | `ANTHROPIC_API_KEY` | `anthropic` |
| lastfm | user JWT | `LASTFM_API_KEY`, `LASTFM_SHARED_SECRET` | `lastfm` |
| stems | user JWT | `STEMS_API_URL`, `STEMS_API_KEY` | `stem separation` |
| new-releases | `x-webhook-secret` header (pg_cron, hourly) | `PUSH_WEBHOOK_SECRET` | `new-releases` |
| push | `x-webhook-secret` header | `PUSH_WEBHOOK_SECRET` (+ optional `EXPO_ACCESS_TOKEN`) | `push` |
| revenuecat-webhook | `Authorization` header | `REVENUECAT_WEBHOOK_AUTH` | `revenuecat` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

AI functions call the Anthropic Messages API (`claude-sonnet-5-5`, `anthropic-version: 2023-06-01`).
They opt into server-side refusal fallbacks (`anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: "default"`).
If the API rejects that with a 400, the function retries once without it.

---

## Contracts

### delete-account
```ts
await supabase.functions.invoke('delete-account', { body: {} });
// 200 → { ok: true }
```
Deletes `avatars/<uid>/*` and `covers/<uid>/*`, then calls `auth.admin.deleteUser(uid)`. Profile rows cascade. The client should sign out afterwards.

### ai-playlist
```ts
await supabase.functions.invoke('ai-playlist', {
  body: { prompt: 'rainy sunday lo-fi for studying', length: 20, exclude: ['D7KyD'] },
});
// 200 → { title: 'Rainy Sunday Study', description: 'Soft lo-fi beats…', trackIds: ['Wn5Ja', 'Q1rKe', …] }
// 404 → { error: 'no_tracks' }
```
`length` must be 10, 20 or 40. Any other value becomes 20. Claude returns a plan `{ title, description, searches[], genres[], moods[] }`.
The function then queries Audius `/tracks/search` for each search and `/tracks/trending?genre=` for each genre, and builds the list:
- dedupes tracks and drops anything in `exclude`
- allows at most **2 songs per artist**
- drops non-streamable, stream-gated and deleted tracks

The client re-fetches the tracks by id (`/v1/tracks/<id>`).

### ai-dj
```ts
await supabase.functions.invoke('ai-dj', {
  body: { tracks: [{ title: 'Midnight City', artist: 'Kavi', genre: 'Electronic' }], userName: 'Sam', mood: 'Chill' },
});
// 200 → { lines: ['Hey Sam, sliding into the night with Midnight City by Kavi…'] }
```
Returns one line per track, for at most 5 tracks. Each line is 25 words or fewer and is meant to be spoken with expo-speech.

### mood-from-photo
```ts
await supabase.functions.invoke('mood-from-photo', { body: { imageBase64: '<base64>', mediaType: 'image/jpeg' } });
// 200 → { mood: 'Chill', confidence: 0.82, reason: 'Soft evening light over a calm beach' }
```
`mood` is one of `Chill | Focus | Workout | Sleep | Happy | Party | Sad | Romantic`. The image must be 5 MB or smaller (413 `image_too_large` otherwise). The image is never stored.

### recognize-song
```ts
await supabase.functions.invoke('recognize-song', { body: { audioBase64: '<base64 m4a>', mimeType: 'audio/mp4' } });
// 200 → { match: { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', isrc: 'USUG11904206' } }
// 200 → { match: null }   // nothing recognised
```
Uses the ACRCloud `POST https://$ACRCLOUD_HOST/v1/identify` endpoint with an HMAC-SHA1 signature. Send a clip of about 10 seconds; the limit is 5 MB (413 `audio_too_large` otherwise).

### concerts
```ts
await supabase.functions.invoke('concerts', { body: { lat: 51.5, lng: -0.12, keyword: 'Fred again', page: 0 } });
// or GET /functions/v1/concerts?city=London&page=1
// 200 → { events: [{ id, name, artist, date, venue, city, imageUrl, url, priceMin?, priceMax?, currency? }] }
```
Proxies the Ticketmaster Discovery API (`classificationName=music`, sorted by date, 20 per page).
- `lat` + `lng` → searches a 100 km radius around that point.
- otherwise `city` → searches that city.
- `date` is an ISO string or `null`; `venue`, `city`, `imageUrl` and `url` may also be `null`.

### push (server-to-server)
```http
POST /functions/v1/push
x-webhook-secret: <PUSH_WEBHOOK_SECRET>
{ "user_id": "<uuid>", "title": "Ana", "body": "hey!",
  "data": { "url": "/chat?id=<conversation_id>", "kind": "message", "notification_id": "<uuid>", "category": "messages" } }
→ { "sent": 1, "removed": 0 }  |  { "sent": 0, "skipped": "category_off" | "disabled" | "no_tokens", "removed": 0 }
```
`data` is forwarded to Expo unchanged, so the device gets `{ url, kind, notification_id }`. The trigger always sets those three keys.
Loads the user's `push_tokens` and checks `user_settings.notifications` first:
- `push: false` mutes all pushes for the user.
- otherwise `data.category` is looked up as a toggle key. Toggles that are unset use the app's defaults: `friend_activity` and `recommendations` are off, everything else is on.

It then sends to Expo (`https://exp.host/--/api/v2/push/send`, with `Bearer EXPO_ACCESS_TOKEN` if that is set) and deletes tokens that return `DeviceNotRegistered`. Quiet hours are not enforced on the server, because no timezone is stored.

### revenuecat-webhook (server-to-server)
RevenueCat → `POST /functions/v1/revenuecat-webhook`. The `Authorization` header must equal `REVENUECAT_WEBHOOK_AUTH`.
- `INITIAL_PURCHASE`, `RENEWAL`, `PRODUCT_CHANGE`, `UNCANCELLATION` and `NON_RENEWING_PURCHASE` set `profiles.plan` from the entitlement ids. Priority is `family` > `premium` > `student`, falling back to the product id, then to `premium`.
- `EXPIRATION` sets the plan to `free`.
- `CANCELLATION` sets the plan to `free` only for a refund (`cancel_reason = CUSTOMER_SUPPORT`) or once the period has already expired. Otherwise the user keeps access until `EXPIRATION`.
- `TEST` and other events → 200 `{ ok: true, ignored }`.

`app_user_id` must be the Supabase user id, so the app must call `Purchases.logIn(user.id)`. If `app_user_id` is anonymous, the function looks for a uuid in `original_app_user_id` and then `aliases`.

---

## Database side (migration `20261113180000_phase3.sql`)

- `push_tokens(user_id, token unique, platform, updated_at)`, own-row RLS for select, insert, update and delete. The client upserts with `onConflict: 'token'`.
  If a device token is still saved under another account, that upsert fails RLS. `supabase.rpc('register_push_token', { p_token, p_platform })` reassigns the token in that case.
- `room_messages(id, room_id, user_id, body, created_at)`. Room members can read and insert (`is_room_member`). The table is in `supabase_realtime`.
- Insert triggers on `messages`, `dedications`, `follows` and `playlist_collaborators` call `public.notify_user(...)`, which:
  1. always inserts a `public.notifications` row, so the in-app inbox works without push. `kind` is `message` | `dedication` | `follow` | `collab_invite`. `payload` always has `title`, `body`, `actor_name` and `url` (the client navigates to `payload.url`):
     - `message`: `conversation_id`, `sender_id`, `message_id`, url `/chat?id=<conversation_id>`
     - `dedication`: `sender_id`, `dedication_id`, `track_title`, `track`, url `/messages`
     - `follow`: `follower_id`, url `/followers`
     - `collab_invite`: `playlist_id`, plus `owner_id` (the recipient was added) or `user_id` (the owner is told someone joined), url `/playlist?id=<playlist_id>`
  2. if the Vault secret `push_webhook_secret` exists, calls `net.http_post` to the `push` function with `x-webhook-secret` and `data = { url, kind, notification_id, category }`. If the secret is missing or pg_net fails, it skips silently.

  Push categories: `messages`, `dedications`, `new_followers`, `playlist_updates`.

---

## Setup

```bash
# AI (playlist, DJ, mood from photo)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

# Song recognition (ACRCloud console → project → host / access key / secret)
supabase secrets set ACRCLOUD_HOST=identify-eu-west-1.acrcloud.com ACRCLOUD_ACCESS_KEY=... ACRCLOUD_ACCESS_SECRET=...

# Concerts
supabase secrets set TICKETMASTER_API_KEY=...

# Push: pick one random value and use it in BOTH places (edge secret + Vault)
supabase secrets set PUSH_WEBHOOK_SECRET=<long-random-string>
supabase secrets set EXPO_ACCESS_TOKEN=...          # optional, only if "enhanced push security" is on

# RevenueCat (dashboard → Integrations → Webhooks → Authorization header value)
supabase secrets set REVENUECAT_WEBHOOK_AUTH="Bearer <long-random-string>"
```

Then add the same push secret to the database Vault. Run this in the SQL editor:
```sql
select vault.create_secret('<long-random-string>', 'push_webhook_secret');
-- to rotate later:
-- select vault.update_secret((select id from vault.secrets where name = 'push_webhook_secret'), '<new value>');
```

Deploy. `push` and `revenuecat-webhook` are called without a user JWT, so they need `--no-verify-jwt`, or `verify_jwt = false` in `config.toml`:
```bash
supabase functions deploy delete-account ai-playlist ai-dj mood-from-photo recognize-song concerts lyrics-ai lastfm stems
supabase functions deploy push revenuecat-webhook --no-verify-jwt
```
RevenueCat webhook URL: `https://vmdkgkgyzflvqsvecava.supabase.co/functions/v1/revenuecat-webhook`.
