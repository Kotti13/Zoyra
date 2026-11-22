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

## Which folder to host

The backend is **two folders**: `services/gateway` (Python) and `services/newpipe` (Java). Both must run together, on the
same machine. You don't have to pick between them:

- **One deploy from the repo root.** The root `Dockerfile` builds both into one container (the gateway, plus the NewPipe
  service when `NEWPIPE_TOKEN` is set). Point any host that builds a Dockerfile at the **repository root**
  (build context `.`, Dockerfile `./Dockerfile`) and set `ZOYRA_API_KEY` and `NEWPIPE_TOKEN`. Container port: `$PORT`
  (default 8080). Memory: allow at least 1 GB.
- **Docker Compose** (`services/gateway/docker-compose.yml`) runs them as separate containers, plus Redis.
- The database, accounts and server functions live on **Supabase**, which is already hosted; `web/share` is the share-link
  page and deploys separately (Vercel). Neither is part of this backend.

## Option B: a server with Docker (no platform limits: you pay only for the server and its bandwidth)

On a Linux VPS: `git clone` the repo, then
`docker build -t zoyra-backend .` and
`docker run -d --restart unless-stopped -p 8080:8080 -e ZOYRA_API_KEY=... -e NEWPIPE_TOKEN=... -e TRUST_PROXY=true zoyra-backend`
Put HTTPS in front (for example Caddy) and use a region near your listeners. Test that YouTube answers from that server
before relying on it: cloud addresses are sometimes blocked.
(The Docker image has not been built by the author, because Docker was not available; the start script and both services
were tested directly, together.)

## Option C: a spare laptop as the server (step by step)

Works well at home: a home address is less likely to be blocked by YouTube than a cloud server. The cost is that the
laptop must stay on, awake and online.

**1. Make the laptop always-on**
- Plug it in; use wired ethernet if you can.
- Mac: System Settings > Battery > Options > "Prevent automatic sleeping when the display is off", or run
  `caffeinate -s` in a terminal. Windows: Settings > Power > Sleep = Never (plugged in). Linux: disable suspend.
- Keep the lid open, or enable a lid-closed mode (on a Mac, closed-lid use needs power plus an external display, or an
  app like Amphetamine).

**2. Install Docker** (Docker Desktop on Mac/Windows; `docker.io` on Linux). This is the easiest route because the root
`Dockerfile` builds both services.

**3. Get the code and make two keys**
```
git clone https://github.com/Kotti13/Zoyra.git && cd Zoyra
openssl rand -hex 24    # ZOYRA_API_KEY (the app sends it)
openssl rand -hex 24    # NEWPIPE_TOKEN (gateway to music service; setting it also starts the music service)
```

**4. Build and run** (restarts by itself after a reboot)
```
docker build -t zoyra-backend .
docker run -d --name zoyra --restart unless-stopped -p 8080:8080 \
  -e ZOYRA_API_KEY=<key1> -e NEWPIPE_TOKEN=<key2> -e TRUST_PROXY=true \
  zoyra-backend
curl -H "X-Zoyra-Key: <key1>" "http://localhost:8080/api/search?q=hello"     # should list songs
```
Logs: `docker logs -f zoyra`. Update later with `git pull`, then rebuild and `docker rm -f zoyra`, and run again.
No Docker? Use Option A (`scripts/run-backend.sh`) instead.

**5. Give it an https address** (phones outside your home cannot reach the laptop directly)
- Quick test: `cloudflared tunnel --url http://localhost:8080` prints a `https://….trycloudflare.com` address that changes
  on every restart. Fine for testing, not for a store build.
- Permanent (needs a free Cloudflare account and a domain you own):
  ```
  cloudflared tunnel login
  cloudflared tunnel create zoyra
  cloudflared tunnel route dns zoyra api.<your-domain>
  # ~/.cloudflared/config.yml:
  #   tunnel: zoyra
  #   credentials-file: ~/.cloudflared/<tunnel-id>.json
  #   ingress:
  #     - hostname: api.<your-domain>
  #       service: http://localhost:8080
  #     - service: http_status:404
  cloudflared service install      # runs at boot
  ```
- No domain: Tailscale Funnel (`tailscale funnel 8080`) gives a fixed `https://<machine>.<tailnet>.ts.net` address.

**6. Point the app at it.** In EAS set `EXPO_PUBLIC_ZOYRA_API_URL=https://<address>` and
`EXPO_PUBLIC_ZOYRA_API_KEY=<key1>` (`npx eas-cli env:create`), then make a new build. For the dev app, put them in `.env`
and restart Expo.

**7. Test on mobile data** (not your wifi): search, play, seek, download.

**Limits:** if the laptop sleeps, loses power or loses internet, music stops. Home upload speed caps listeners (see Notes).
Keep the keys private: anyone with `ZOYRA_API_KEY` can use your backend.

## Notes
- Each listener uses about 128 kbps; 100 listeners is roughly 13 Mbps of upload.
- First play of a song that was not looked up in advance takes about a second; the app looks up the top three search
  results ahead of time.
- Playing audio through YouTube breaks YouTube's terms and may get an app rejected from a store.
