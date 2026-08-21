# Troubleshooting

Operational bug notes for this fork. Facts of record also live in Engram (project `9router`).

## Rebuild is slow / noisy — what turbopack does and does NOT accelerate (2026-08-21)

`next build --turbopack` only speeds the **compile** phase (~30s warm, ~48s cool, ~2.6min cold).
The tail is turbopack-independent and is ~37% of wall time:

| phase | ~time | turbopack helps? |
|---|---|---|
| compile | 30–48s | ✅ this IS turbopack |
| collect page data (15 workers) | ~10s | ❌ runs your server code 15× |
| generate static pages | ~3s | ❌ |
| finalizing / output-file-tracing (@vercel/nft) | ~12s | ❌ |

Keep `.next/cache` (~550M) between builds — drop only `.next/standalone`. `rm -rf .next` forces a
cold compile. `rebuild.bat` already deletes standalone only.

### Two build-time drags — fixed, keep them fixed

**1. `[ServerInit] Error initializing outbound proxy` ×15 during "Collecting page data".**
`src/lib/network/initOutboundProxy.js` fired a module-scope `setImmediate(() => ensureOutboundProxyInitialized())`
(→ `getSettings()` → SQLite) with **no build-phase guard**. Every page-data worker imported a route →
imported this module → hit `better-sqlite3` at build under Node v20 (ABI 115; module built for ABI 127) →
error spam ×15. Not a data-wipe (refusing-fallback guard held). Fixed by wrapping the `setImmediate` in
`if (!isBuildPhase)` where `isBuildPhase` = `NEXT_PHASE` is `phase-production-build` / `phase-export` /
`phase-static` — mirrors the guard already in `src/shared/services/bootstrap.js`.
Do **not** "fix" this by building under hermes v22 — that would make bootstrap side effects actually RUN
at build (downloads cloudflared, inits DNS, etc.).

**2. `Failed to copy traced files ... ENOENT mkdir .next\standalone\C:\FATUR\...` (can go fatal `Build error occurred`).**
`@vercel/nft` (the output-file tracer) bundles **any string literal that resolves to a real path on the
build machine**. Machine-specific absolute-path literals were followed and copied into standalone:
- `src/lib/serviceManager.js` — `TABBIT_DIR`, `SANDBOXIE_START`, `TABBIT_BROWSER`, and `cwd`
  `C:/Tools/morph-proxy-py`, `C:/Tools/fingerprint-chromium` (×2).
- `src/app/api/v1/admin/logs/route.js` — `LOG_PATHS.proxy` / `.router`.
- `src/lib/tunnel/tailscale/tailscale.js` — `WINDOWS_TAILSCALE_BIN`.

Fix: build each path via `.join()` so the analyzer can't const-fold it —
`const wp = (...seg) => seg.join("/")` then `wp("C:", "FATUR", ...)` (tailscale uses `[...].join("\\")`).
A method call is opaque to nft's static evaluator (it only folds bare literals and `a + b` of literals).
**`outputFileTracingExcludes` globs do NOT match drive-letter absolute paths** — tried `"C:/FATUR/**/*"`,
no effect, and the malformed glob correlated with flipping the ENOENT warning to a fatal error. Hide at
source, don't use excludes.

### Benign remainder
~34 `Encountered unexpected file in NFT` warnings from `src/app/api/oauth/kiro/auto-import/route.js`
(dynamic `readdir` / `readFile(join(homedir(), ...))`) are cosmetic and non-fatal — the paths are
genuinely runtime-dynamic and can't be statically narrowed. Leave them.

### Verified after fixes
Build exit 0; ServerInit errors 0 (was 15+); ENOENT copy-fails 0 (was 3); `Build error occurred` 0;
DB ABI errors 0. muse-spark keyless POST → 200, tokens billed, driver = `better-sqlite3`.

## Usage > Details drawer: redacted payloads, suffix, size, and scope. (2026-08-21)
`GET /api/usage/request-details` redacts every body to `{"redacted":true}` (17 B) so the list never leaks prompts.
The drawer must render from `GET /api/v1/admin/request-body/:id` (`loadFullBodyWithFallback`). Gotchas:
- Suffix mapping is strict: `id` → `request`, `id+"_preq"` → `providerRequest`, `id+"_pres"` → `providerResponse`,
  `id+"_resp"` → final `response`. Using `:providerRequest` etc. 404s (was `"_preq"` → regression → fixed).
- `TruncatedSection` must live inside `RequestDetailsTab` (needs `fullBodies`/`bodySources` state). Nesting it
  inside `CollapsibleSection` → `ReferenceError: TruncatedSection is not defined` on Detail click (regression).
- Size: when the list row is redacted, `JSON.stringify({redacted:true}).length` is always 17 B. The label must
  derive from the fetched full body (`fullData`) or `originalSize` when truncated; eagerly `fetchFullBody` for
  redacted entries so the first paint shows real bytes.
- Cost: `Usage > Details` table header is `Cost` then `Latency`; row is same order. Swapping → columns misaligned.
- Keep `src/app/api/v1/admin/request-body/[id]/route.js` and `src/lib/db/repos/requestDetailsRepo.js`
  (`loadFullBody`, `loadFullBodyWithFallback`, `BODY_SUFFIX_FIELD`, disk ring-buffer `9router-full-bodies`) —
  deleting them breaks Show Full / Download.
