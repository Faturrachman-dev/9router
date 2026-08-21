# 9router — agent notes

## Model capabilities & vision (2026-08-19)
- Capabilities source of truth: `open-sse/providers/capabilities.js` `getCapabilitiesForModel()` (pattern-based `vision`/`reasoning`/etc. per model).
- `/v1/models` (`src/app/api/v1/models/route.js`) emits per-model `input` (`["text","image"]` when vision) + `capabilities` object via enrichment pass — OpenAI clients gate image input on this.
- **CommandCode image input**: `open-sse/translator/request/openai-to-commandcode.js` maps OpenAI `image_url`/`image` → AI SDK v5 `{type:"image", image, mediaType}`. It USED to emit `"[image omitted]"` — never regress that; commandcode/`cmc/*` vision breaks silently.

## Two builds live in this repo (don't confuse them)
- **`.next/standalone/`** — plain `next build` output. Run via **`custom-server.js`**, NOT `server.js`:
  `PORT=20128 HOSTNAME=127.0.0.1 node .next/standalone/custom-server.js`
  (0.5.55: `custom-server.js` stamps `x-9r-real-ip`+`x-9r-peer-token`; bare `server.js` = every
  request treated "remote" → `401 "API key required for remote API access"`. Build must use
  DEFAULT tracing — `NEXT_TRACING_ROOT_MODE` unset — or standalone `server.js` gets nested/omitted.)
- **`cli/app/`** — build **bare `9router` command runs** (global bin is
  symlink → `~/tools/9router/cli`). Bundled via `cli/scripts/build-cli.js`uses
  `custom-server.js` (injects real socket IP), binds `0.0.0.0` by default
  (LAN-exposed — use `9router -H 127.0.0.1` for local-only), interactive menu,
  `--max-old-space-size=6144`detached, auto-restart.

**They are NOT same.** source edit (e.g. `src/lib/serviceManager.js`) only
reaches bare `9router` after rebuilding `cli/app`

```bash
npm --prefix ~/tools/9router/cli run build   # runs next build + repacks cli/app
```

Runs `next build` then copies `.next/standalone` → `cli/app`. Do this after ANY
source change you want short `9router` command to pick up.

## After an upstream merge (v0.5.55+) — rebuild recipe
Merging upstream stacks regressions. Recurring recipe:
1. `npm install` — merges bring new deps (e.g. `@node-saml/node-saml`); skipping = `Module not found` build fail.
2. `9router --rebuild` — plain `npm run build` (default tracing) + launchers now self-heal.
3. Launchers (`9router.bat`/`start.bat`/`rebuild.bat` + master-control `services.json`) all run
   `.next/standalone/custom-server.js` and overlay `.next/server` → standalone via `fs.cpSync`
   (turbopack omits `[root-of-the-server]__*._.js` SSR chunks → dashboard `ChunkLoadError`; xcopy/robocopy
   choke on `[bracket]` names, cpSync/`cp -rf` don't).
4. If keyless-local routing breaks (Pi/Muse `401 "Missing API key"`): 0.5.55 flipped
   `settingsRepo.js` default `requireApiKey:true` — no local bypass in `src/sse/handlers/chat.js`.
   Set `requireApiKey:false` in `settings.data` (single-row `settings` table, id=1) for keyless loopback.
- master-control (`C:\Users\hafiz\master-control\services.json`, dash :7788) caches cfg in memory:
  after editing, `POST :7788/api/config/reload` THEN restart the service.
- Full 5-regression writeup + verified fixes → Engram #220.

## What persists vs. what's build-specific
- **SQLite DB** (`%APPDATA%\9router\db\data.sqlite`) is shared across both builds —
  upstream providers (e.g. `morph/*`) survive regardless of which build runs.
- **Managed services** (services page) are compiled from `serviceManager.js`
  `DEFAULT_SERVICES` into whichever build runs → rebuild `cli/app` to carry them.
  `loadConfig()` only patches EXISTING default ids; NEW service must be added to
  `DEFAULT_SERVICES` source + rebuilt.

## Facts → Engram (project `9router`)
Resolved bugs, integration configs, and admin quick-refs live in Engram, not here. `mem_search` when you need them:
- morph-proxy integration (upstream `morph/*` `C:/Tools/morph-proxy-py` 8790)
- EADDRINUSE fix on port 20128 (kill-all-PIDs + 6s poll in `cli/cli.js`)
- Admin API quick-ref (`/api/v1/admin/services` `--svc-*`health)
- v0.5.55 upgrade — 5 stacked regressions (saml dep, standalone tracing, chunk overlay, custom-server local trust, requireApiKey flip) + rebuild recipe (#220)

