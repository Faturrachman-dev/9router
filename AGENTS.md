# 9router — agent notes

## Model capabilities & vision (2026-08-19)
- Capabilities source of truth: `open-sse/providers/capabilities.js` `getCapabilitiesForModel()` (pattern-based `vision`/`reasoning`/etc. per model).
- `/v1/models` (`src/app/api/v1/models/route.js`) emits per-model `input` (`["text","image"]` when vision) + `capabilities` object via enrichment pass — OpenAI clients gate image input on this.
- **CommandCode image input**: `open-sse/translator/request/openai-to-commandcode.js` maps OpenAI `image_url`/`image` → AI SDK v5 `{type:"image", image, mediaType}`. It USED to emit `"[image omitted]"` — never regress that; commandcode/`cmc/*` vision breaks silently.

## Two builds live in this repo (don't confuse them)
- **`.next/standalone/`** — plain `next build` output. Run directly:
  `PORT=20128 HOSTNAME=127.0.0.1 node .next/standalone/server.js`
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

