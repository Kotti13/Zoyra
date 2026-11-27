# Zoyra

Music streaming and social app for iOS, Android and web. Built with Expo SDK 58, React Native 0.88, TypeScript and Expo Router, on a Supabase backend.

- Full feature list: [FEATURES.md](FEATURES.md)
- Deploying the backend, Supabase and share pages: [LAUNCH.md](LAUNCH.md)
- Backend hosting notes: [services/HOSTING.md](services/HOSTING.md)
- Third-party licences: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

## Repository layout

| Path | What |
| --- | --- |
| `src/app/` | Screens (Expo Router). Only routes live here. |
| `src/` (other) | Components, hooks, and logic in `src/lib/` |
| `supabase/` | Postgres migrations and edge functions |
| `services/gateway/` | FastAPI music and lyrics gateway |
| `services/newpipe/` | JVM stream-extraction service |
| `web/share/` | Link-preview pages (Vercel) |
| `web/site/` | Marketing and download site |
| `plugins/`, `patches/` | Expo config plugins and `patch-package` patches |

## Getting started

Requires Node 22 and npm.

```bash
npm ci
cp .env.example .env     # fill in EXPO_PUBLIC_* values
npx expo start
```

The app uses native modules (Agora, CallKeep, notifications), so Expo Go is not enough. Use a development build:

```bash
npx expo run:ios          # or run:android
# or in the cloud
npx eas-cli@latest build --profile development
```

Server-side secrets (Anthropic, Ticketmaster, RevenueCat webhook and others) go in Supabase secrets, never in `.env`. The full list is in `.env.example`.

## Scripts

```bash
npm run lint          # expo lint
npm run typecheck     # tsc --noEmit
npm run share:test    # tests for web/share
node scripts/gen-notices.js   # regenerate THIRD-PARTY-NOTICES.md
```

Run lint and typecheck before every commit.

## Building

| Goal | How |
| --- | --- |
| Android APK (preview) | `npm run build:preview`, or the `android-apk.yml` GitHub workflow |
| iOS, Apple Developer account | `eas build -p ios --profile testflight`, then `eas submit -p ios --profile testflight` |
| iOS, no Apple account | Run the **iOS unsigned IPA** GitHub workflow, then install with [SideStore](https://sidestore.io), AltStore or Sideloadly |
| OTA update | `npm run update:preview` or `npm run update:production` |

### Free iOS install (no Apple Developer account)

1. Add the repo secret `IOS_ENV_FILE` with the full contents of your `.env`.
2. GitHub, Actions, **iOS unsigned IPA**, Run workflow.
3. Download the `Zoyra-unsigned-ipa` artifact (kept 14 days).
4. Sign and install with SideStore, AltStore or Sideloadly using a free Apple ID.

Limits set by Apple for free IDs:

- The signature expires every 7 days. SideStore and AltStore can refresh it automatically.
- No push notifications, VoIP calls, notification extension or share links. The workflow sets `FREE_BUILD=1`, which removes the notification extension.
- A paid Apple Developer account ($99/year) removes these limits.

## Licence

Proprietary. All rights reserved. See [LICENSE](LICENSE). Open-source components keep their own licences, listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Before a commercial release, review the legal risk of the YouTube stream extraction in `services/newpipe/` (YouTube Terms of Service, GPL-3.0 NewPipe Extractor, app-store policies).
