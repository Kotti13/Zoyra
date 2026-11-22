# Hosting the Zoyra backend

Two services: the **gateway** (Python, the app's `/api/*` routes) and the **NewPipe service** (Java, finds songs and
streams). The gateway streams all audio itself, so both must run on the same machine.

## Option A: at home or on any always-on machine (free, no sleeping)

1. `cp services/gateway/.env.example services/gateway/.env` and set:
   - `NEWPIPE_BASE=http://127.0.0.1:8090`
   - `NEWPIPE_TOKEN=` a long random string (`openssl rand -hex 24`)
   - `ZOYRA_API_KEY=` another long random string (the app sends this)
2. `bash scripts/run-backend.sh --check`, then `bash scripts/run-backend.sh` (first run builds the NewPipe service and
   creates the gateway's virtualenv). Needs Java 17+, gradle, Python 3.12+, ffmpeg.
3. Give it an `https://` address (production phone builds need HTTPS), either one:
   - Tailscale Funnel: `tailscale funnel 8080`
   - Cloudflare quick tunnel: `cloudflared tunnel --url http://localhost:8080` (address changes on restart; a named
     tunnel gives a fixed one)
4. Check: `curl -H "X-Zoyra-Key: <key>" "https://<address>/api/search?q=hello"`
5. In the app's `.env`: `EXPO_PUBLIC_ZOYRA_API_URL=https://<address>` and `EXPO_PUBLIC_ZOYRA_API_KEY=<same key>`, then
   make a new app build (these values are built in).

### Start automatically on a Mac
```
cp scripts/com.zoyra.backend.plist ~/Library/LaunchAgents/
sed -i '' "s#REPO_PATH#$(pwd)#g" ~/Library/LaunchAgents/com.zoyra.backend.plist
launchctl load ~/Library/LaunchAgents/com.zoyra.backend.plist     # starts now and at every login
launchctl unload ~/Library/LaunchAgents/com.zoyra.backend.plist   # to stop it
```
Log: `/tmp/zoyra-backend.log`. The Mac must stay on and awake (System Settings > Battery/Energy).

## Option B: a small server with Docker

`cd services/gateway && docker compose up -d --build` starts Redis, the NewPipe service (not exposed) and the gateway
on port 8080. Put HTTPS in front (for example Caddy) and use a region near your listeners. Set `TRUST_PROXY=true`
behind a proxy. Test that YouTube answers from that server before relying on it: cloud addresses are sometimes blocked.
(The Docker images have not been built or run by the author; the services themselves were tested directly.)

## Notes
- Each listener uses about 128 kbps; 100 listeners is roughly 13 Mbps of upload.
- First play of a song that was not looked up in advance takes about a second; the app looks up the top three search
  results ahead of time.
- Playing audio through YouTube breaks YouTube's terms and may get an app rejected from a store.
