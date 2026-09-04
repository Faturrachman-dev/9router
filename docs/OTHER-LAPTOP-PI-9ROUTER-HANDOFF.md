# Other-laptop Pi / 9Router handoff

Updated: 2026-09-05

This document is for the agent continuing the Pi integration repair on another
laptop. It records the verified state of the 9router source and the boundary
between versioned source code and machine-local runtime configuration.

## Executive diagnosis

The problem is probably two independent issues:

1. The customized source is on the local/services-overlay branch, not the
   fork's default master branch. master is currently 11 commits behind.
2. Provider connections, provider nodes, API keys, and settings are stored in
   9router's local SQLite database. They do not travel with git clone.

The reported combination of 401 Invalid API key, zero provider connections,
zero provider nodes, and a missing cmc/... model is therefore primarily a
missing runtime provider configuration. Rebuilding source code alone cannot
recreate that configuration.

The exact origin of the 401 must still be identified:

- API key required for remote API access or Missing API key indicates
  9router's own client-auth gate.
- Invalid API key returned by the upstream provider indicates that the
  provider connection is absent, stale, or has an invalid upstream key.

## Verified repository state

Remote fork:

~~~text
https://github.com/Faturrachman-dev/9router
~~~

Authoritative customized branch:

~~~text
local/services-overlay
~~~

Verified commit on that branch:

~~~text
68ca645e319fbd729315ddecdafeae7ac0f89c0d
feat(headroom): preserve provider-specific payloads
~~~

At the time of this handoff, local HEAD and
origin/local/services-overlay match exactly. The fork's default branch is
master at 699edac3; it contains none of the 11 commits unique to the custom
branch.

Do not assume that a plain clone used the customized branch. Verify it:

~~~powershell
cd C:\path\to\9router
git fetch origin
git branch --show-current
git rev-parse HEAD
git rev-parse origin/local/services-overlay
~~~

For a fresh clone, use the branch explicitly:

~~~powershell
git clone --branch local/services-overlay https://github.com/Faturrachman-dev/9router.git
~~~

For an existing clone, preserve any local work and switch explicitly:

~~~powershell
git fetch origin
git switch local/services-overlay
git pull --ff-only origin local/services-overlay
~~~

If the local branch does not exist:

~~~powershell
git switch --track -c local/services-overlay origin/local/services-overlay
~~~

Expected source commit is 68ca645e. Do not use git reset --hard while
investigating another laptop's worktree.

## Build and runtime distinction

This repository has two different builds:

- .next/standalone/ is the normal standalone build. It must be launched with
  custom-server.js, which preserves local socket trust metadata.
- cli/app/ is the generated bundle used by the installed 9router command.
  Source changes do not reach the short 9router command until the CLI build
  is run.

After checking out the correct branch:

~~~powershell
cd C:\path\to\9router
npm install
npm --prefix cli run build
~~~

If the build reports a project-looping path such as
cli/node_modules/9router-app, inspect that path first: a stray junction or
symlink back into the repository has previously caused Turbopack to loop.
Remove only that verified stray link, then retry the build.

Do not launch the standalone bundle with bare server.js. On affected builds,
that makes requests look remote and can produce a router-side 401 even when
the client is using loopback. Use the repository's custom-server.js or the
rebuilt CLI launcher.

## Runtime configuration boundary

On Windows, 9router's runtime database is normally:

~~~text
C:\Users\<user>\AppData\Roaming\9router\db\data.sqlite
~~~

The path is derived from %APPDATA% in src/lib/dataDir.js; the database file
is selected in src/lib/db/paths.js. No SQLite/database file is tracked in
GitHub. The database contains local provider connections, nodes, settings,
and other runtime state.

Therefore a fresh clone can have correct source while showing no configured
providers. The agent should either:

- add the required provider connection and node through the 9router dashboard;
  or
- securely restore a known-good database/configuration backup from the main
  laptop.

Never print API keys, cookies, or raw database contents into chat or logs.
Make a backup before replacing a database, and stop 9router before copying
database files.

## CommandCode / cmc model behavior

The source defines the CommandCode provider alias cmc in
open-sse/providers/registry/commandcode.js. That source registration does not
provide credentials and does not create a provider node or a dynamic model
catalog entry.

After a valid CommandCode connection is configured, verify:

~~~powershell
curl.exe -s http://127.0.0.1:20128/api/health
curl.exe -s http://127.0.0.1:20128/v1/models
~~~

The desired cmc/... model must appear in /v1/models before asking Pi to use
it. If it is absent, troubleshoot the 9router provider connection/catalog
first; changing Pi's model string will not fix an empty router catalog.

## Pi-side checks

Verify that Pi points to the local router endpoint and that its configured
model exactly matches a model advertised by /v1/models.

Check these separately:

1. Pi-to-router authentication: if 9router requires an API key, Pi must send
   the router's client key. Do not disable authentication blindly.
2. Router-to-provider authentication: the configured 9router provider node must
   contain a valid upstream credential.
3. Model availability: the requested cmc/... model must be present in the
   current router catalog.

The report's zero provider connections and zero provider nodes means item 2 is
not configured on the other laptop, regardless of whether item 1 is also wrong.

## What is and is not part of this repository

Important source locations:

- src/ — main 9router application and database/API logic
- open-sse/ — provider registry, request translation, streaming, and Headroom
  integration
- cli/ — installed CLI build and packaging
- tests/ — unit and integration tests
- custom-server.js — standalone server wrapper for local/peer trust handling

The recent customized work includes Headroom and CommandCode changes, notably:

- open-sse/rtk/headroom.js
- open-sse/translator/request/openai-to-commandcode.js
- related tests under tests/unit/

Engram and Master Control are external services/directories, not supplied by a
normal 9router clone. Their absence is separate from the provider 401 and does
not prevent a manually started, correctly configured 9router from serving Pi.

## Definition of done

The repair is complete when all of these are true on the other laptop:

- git rev-parse HEAD is 68ca645e or a newer intentional commit on
  local/services-overlay.
- origin/local/services-overlay matches the checked-out source commit.
- npm install and npm --prefix cli run build complete successfully.
- 9router is running through the correct custom server/CLI build on
  127.0.0.1:20128.
- /api/health responds successfully.
- /v1/models contains the intended cmc/... model.
- The relevant provider connection/node exists in the local database and its
  upstream credential is valid.
- A real Pi request succeeds without exposing any credential in diagnostics.

