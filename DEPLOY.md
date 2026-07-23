# Deploying fangornmd

fangornmd deploys as **one Node container** that serves everything on a single
port (default 8787):

- the built React SPA (`dist/`),
- the JSON API (`/api/*`),
- the live-collab Yjs relay (`/yjs/*`, WebSocket),
- the change-feed (`/api/events`, Server-Sent Events).

The server is a **self-custodial relay** — it holds no user keys. Users sign
their own on-chain settlements in the browser (Privy). The server's own wallet
is a *service key* used only for keyless reads, graph building, and IPFS pinning;
it needs no funds.

> **This runs as a single instance, by design.** The Yjs collaboration rooms and
> the per-user on-chain subscriptions live in this one process's memory. A second
> machine would put collaborators in rooms it can't see. Do **not** scale out or
> enable HA until there's a shared backing store (see [Scaling](#scaling-later)).

There are two ways to run it:

- **[Free, self-hosted](#free-self-hosting-no-cloud-bill)** — your own hardware +
  a free tunnel. No cloud bill. Start here if you don't want to pay.
- **[Managed on Fly.io](#1-prerequisites)** — a cheap always-on cloud machine.
  Not free, but nothing to keep running at home.

Both use the same container. Any host with persistent WebSockets/SSE, a volume,
and TLS works — see [Other hosts](#other-hosts).

---

## Free self-hosting (no cloud bill)

Host the **same container on hardware you already own** (a laptop, home server,
old PC, Raspberry Pi) and expose it through a free tunnel — no port-forwarding,
no static IP, and real HTTPS, which Privy and `wss://` both require. State lives
on the host disk, so it's persistent and free.

### Run the container

```bash
cp .env.example .env      # fill in the four values (see the table below)
docker compose up -d --build
```

Serves the app on `http://localhost:8787`, with state in `./docs` and
`./.fangorn` on the host. `docker-compose.yml` passes `VITE_PRIVY_APP_ID` as a
build arg (required — it's inlined into the bundle at build time).

Now expose it with **one** of these:

### Option A — Tailscale Funnel (recommended: free, stable URL, no domain)

Gives a stable public `https://<machine>.<tailnet>.ts.net` URL. Free, no domain
to buy, WebSockets supported.

```bash
# one-time: install Tailscale, then enable HTTPS + Funnel in the admin console
curl -fsSL https://tailscale.com/install.sh | sh

tailscale up
tailscale funnel --bg 8787
tailscale funnel status          # prints your public URL
```

### Option B — Cloudflare Tunnel (free, your own domain)

If you own a domain on Cloudflare, a named tunnel gives `wiki.yourdomain.com`,
persistent, nothing exposed on your router. Create a tunnel token in the Zero
Trust dashboard (Networks → Tunnels), point its public hostname at
`http://fangornmd:8787`, then:

```bash
echo "CLOUDFLARE_TUNNEL_TOKEN=..." >> .env
docker compose -f docker-compose.yml -f compose.tunnel.yml up -d --build
```

### Option C — Cloudflare quick tunnel (zero setup, throwaway URL)

For a one-off demo. No account, no domain — but the URL changes every run.

```bash
cloudflared tunnel --url http://localhost:8787   # prints a *.trycloudflare.com URL
```

### The gotcha for all three: Privy allowed origins

Privy only accepts logins from origins you've allow-listed. Add your tunnel URL
to your Privy app's **allowed origins / domains** in the
[dashboard](https://dashboard.privy.io), or login silently fails. `localhost` is
allowed by default; a public URL is not. This is why the stable-URL options
(A/B) beat C — you allow-list once instead of every restart.

Everything else — the [config model](#2-configuration-model-read-this-once),
[state/volume](#5-state-and-the-volume) durability, the single-instance
constraint, and [troubleshooting](#6-troubleshooting) — applies here too. Read
those sections; they're written host-agnostically.

---

## 1. Prerequisites

| Need | Why |
|------|-----|
| [`flyctl`](https://fly.io/docs/flyctl/install/) + a Fly account | deploy target |
| Docker running locally | `fly deploy --local-only` builds the image on your machine |
| A **Privy app** ([dashboard](https://dashboard.privy.io)) | browser login + embedded wallets |
| **Pinata** JWT + gateway | IPFS pinning of commit/vertex blocks |
| A throwaway **service wallet** private key | constructs the keyless engine (no funds needed) |

Fill these into `.env` locally first (copy from `.env.example`) so you can test
with `pnpm dev` before deploying. The deploy reads them separately (below).

---

## 2. Configuration model (read this once)

There are **two** kinds of config, and one variable that is confusingly *both*:

- **Build-time** — `VITE_PRIVY_APP_ID`. Vite inlines every `VITE_*` var into the
  browser bundle when it builds. It must be present at `vite build`, which runs
  *inside* `docker build`. This is why it lives in `fly.toml` under
  `[build.args]` and in the `Dockerfile` as `ARG` → `ENV`. It is a **public**
  value (shipped to every browser), so baking it into the image is fine. The
  Dockerfile's `ENV` also carries it to runtime, where the server reuses it to
  verify Privy login tokens — so you do *not* set it as a secret.

- **Runtime secrets** — `ETH_PRIVATE_KEY`, `PINATA_JWT`, `PINATA_GATEWAY`. These
  must never be baked into the image. Set them with `fly secrets set`; Fly
  injects them as encrypted env at runtime.

- **Runtime plain env** — `PORT=8787`, `DATA_DIR=/app/data`. In `fly.toml`
  `[env]`. `DATA_DIR` points the working trees + repo store at the mounted
  volume; `dist/` stays in the image.

| Variable | Where it goes | Secret? |
|----------|---------------|---------|
| `VITE_PRIVY_APP_ID` | `fly.toml` `[build.args]` (public) | no |
| `ETH_PRIVATE_KEY` | `fly secrets set` | **yes** |
| `PINATA_JWT` | `fly secrets set` | **yes** |
| `PINATA_GATEWAY` | `fly secrets set` | yes-ish |
| `PORT`, `DATA_DIR` | `fly.toml` `[env]` | no |

---

## 3. First deploy

```bash
# App names are global — edit `app = "..."` in fly.toml if this one is taken.
fly apps create fangornmd

# Persistent state lives on one volume (single instance → one volume, one region).
fly volumes create fangornmd_data --size 1 --region iad --yes

# Runtime secrets (the service key needs no funds and never signs a user tx).
fly secrets set \
  ETH_PRIVATE_KEY=0x... \
  PINATA_JWT=... \
  PINATA_GATEWAY=your-gateway.mypinata.cloud

# Set the Privy app id in fly.toml [build.args] (public value), then:
#   --ha=false   forces ONE machine (the design requires it)
#   --local-only builds with your Docker daemon (the image copies host
#                node_modules, so this avoids uploading a huge context)
fly deploy --ha=false --local-only
```

When it's up:

```bash
fly open          # opens https://<app>.fly.dev
fly logs          # tail server logs
```

You should see the boot banner in the logs and the login gate in the browser.

---

## 4. Redeploy

After any code change:

```bash
fly deploy --ha=false --local-only
```

The volume (working trees + repo lists) survives redeploys. See the durability
note under [State](#5-state-and-the-volume).

Changed the Privy app? Edit `VITE_PRIVY_APP_ID` in `fly.toml` `[build.args]` and
redeploy — a rebuild is required because it's inlined into the bundle.

---

## 5. State and the volume

The volume mounted at `/app/data` (via `DATA_DIR`) holds:

- `docs/<address>/<namespace>/*.md` — each user's local working tree.
- `.fangorn/users/<address>.json` — each user's tracked repos + local head pointers.

What survives what:

| Event | Working trees & repo lists | In-flight Yjs edits |
|-------|:--:|:--:|
| Redeploy / machine restart | ✅ persisted on volume | ❌ dropped to last autosave (~600ms) |
| Volume destroyed | ❌ gone | ❌ gone |

Even total state loss is recoverable for **published** notes — they live on-chain
and re-`pull` from Fangorn. Only *unpublished* local edits are lost.

Back up the volume before risky changes:

```bash
fly volumes list
fly volumes snapshots create <volume-id>
```

---

## 6. Troubleshooting

**Login gate says "Set `VITE_PRIVY_APP_ID`" / login does nothing.**
The bundle built without the app id. Confirm `VITE_PRIVY_APP_ID` is set in
`fly.toml` `[build.args]` and redeploy (it's build-time — a runtime env won't fix
a bundle that's already built).

**Live co-editing never connects (presence bar empty, edits don't sync).**
The `/yjs` WebSocket isn't reaching the server. Check `force_https = true` in
`fly.toml` (the browser uses `wss://` on an HTTPS page) and that
`internal_port = 8787` matches `PORT`. `fly logs` shows the upgrade attempts;
a `401` there means the auth token/address didn't verify.

**Deploy created two machines / volume errors.**
You omitted `--ha=false`. Fly defaults to 2 machines for HA, but there's only one
volume and the app must be single-instance. Scale back down:

```bash
fly scale count 1
```

**Publish fails with a gas/fee error in the browser.**
Unrelated to deploy — the user's Privy wallet needs Arbitrum Sepolia ETH.

**Server won't boot — "Missing ETH_PRIVATE_KEY / …".**
A required secret isn't set. `fly secrets list` to check, `fly secrets set` to fix
(setting a secret triggers a redeploy).

---

## Scaling (later)

Single-instance is a prototype constraint, not a permanent one. To run more than
one machine you need the two in-process stores to become shared:

- **Yjs rooms** → a shared relay backend (e.g. `y-redis`) so any machine can serve
  any room.
- **On-chain subscriptions / SSE** → a shared pub/sub (Redis) fan-out instead of
  per-process `fangorn.subscribe`.

Until then: `--ha=false`, `min_machines_running = 1`, `auto_stop_machines = off`.

## Other hosts

The container is host-agnostic. Any target that gives you **persistent
WebSockets + SSE, a mounted volume, HTTPS, and a single instance** works
(Render, Railway, a VPS with Caddy in front). Reuse the same Dockerfile; pass
`VITE_PRIVY_APP_ID` as a build arg, the three secrets as runtime env, and set
`DATA_DIR` to wherever the volume mounts.
