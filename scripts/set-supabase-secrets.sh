#!/usr/bin/env bash
# Sets the server-side API keys the app's Supabase functions need. Run it, paste each key when asked (input is hidden,
# nothing is printed or saved); press Enter to skip a key you don't have yet. Re-run any time to add more.
#
#   bash scripts/set-supabase-secrets.sh
#
# Where to get each key:
#   ANTHROPIC_API_KEY      https://console.anthropic.com  → API keys   (AI DJ, AI playlists, lyrics translate, mood from photo)
#   TICKETMASTER_API_KEY   https://developer.ticketmaster.com           (concerts near you)
#   LASTFM_API_KEY / LASTFM_SHARED_SECRET   https://www.last.fm/api/account/create   (scrobbling)
#   ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET   https://www.acrcloud.com   (song identification)
#   REVENUECAT_WEBHOOK_AUTH   any long random string, then put the same value in RevenueCat's webhook settings
#   PUSH_WEBHOOK_SECRET       any long random string (also stored as Vault secret 'push_webhook_secret')
set -euo pipefail
cd "$(dirname "$0")/.."

KEYS=(ANTHROPIC_API_KEY TICKETMASTER_API_KEY LASTFM_API_KEY LASTFM_SHARED_SECRET ACRCLOUD_HOST ACRCLOUD_ACCESS_KEY ACRCLOUD_ACCESS_SECRET REVENUECAT_WEBHOOK_AUTH PUSH_WEBHOOK_SECRET)
args=()
for k in "${KEYS[@]}"; do
  read -r -s -p "$k (Enter to skip): " v || true
  echo
  [ -n "${v:-}" ] && args+=("$k=$v")
done

if [ ${#args[@]} -eq 0 ]; then echo "Nothing entered, nothing changed."; exit 0; fi
supabase secrets set "${args[@]}"
echo "Set ${#args[@]} secret(s). Functions pick them up on their next call."
