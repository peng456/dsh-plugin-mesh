# AGENTS.md — operating guide for coding agents

This file is for AI agents working **on** this repository. If you only want to
**use** the plugin, read [`llms.txt`](./llms.txt) instead — it is short and factual.

Project: `dsh-plugin-mesh`, a cordis plugin for DeepSeek Harness (dsh). MIT.
Language note: `README.md` is Chinese and long (it contains design rationale and
post-mortems). This file is the English, task-oriented entry point.

---

## 1. What this codebase is

A dsh plugin has two halves that ship in one npm package:

| Half | Entry | Runs in |
|---|---|---|
| Host | `lib/index.js` | the dsh host process (Node) |
| Client | `client/client.js` | the browser/Electron renderer |

`client/client.js` is a **hand-written bundle**, not built by a bundler. It must
call `window.__ModuleLoader__.load({ id: "<package name>", factory })` and the `id`
must equal the package name exactly. It may only `require("react")` and
`require("react/jsx-runtime")`.

The plugin is mounted by `dsh.bundle.patch` → `cordis.patch.yml`, which does one
`insert` of `{ id: mesh, name: dsh-plugin-mesh }`. Client UI is declared by
`dsh.client.platform = "web"` plus an `exports["./client"]` entry.

There is a third, separate program: `sidecar/` is a **Go** binary that runs a
userspace Tailscale node (tsnet). It is compiled per platform, published as GitHub
release assets, and downloaded at runtime by `lib/tsnet/download.js`.

## 2. Zero to running (development)

```bash
npm install                       # dev deps only; @deepseek-ai/* come from the host
npm run check                     # fast, always run this first
npm test                          # full suite, ~90 s, network-free
```

To run a real isolated host (two instances can discover each other on one machine):

```bash
MACHINE=meshdev PORT=45918 ./dev-setup.sh meshtest /tmp/dsh-mesh-dev
DSH_HOME=/tmp/dsh-mesh-dev ELECTRON_RUN_AS_NODE=1 \
  "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" \
  dev-boot.mjs --profile meshtest --port 8877 --no-open
```

`dev-setup.sh` copies the plugin into the profile's `node_modules`; a **symlink
will not work** — dsh's profile package resolver rejects packages whose realpath
is outside `<profile>/node_modules`.

`dev-boot.mjs` exists because `desktop-cli.js` only installs the profile package
resolver inside `app.asar`; this installation is unpacked, so the resolver has to
be installed manually.

The dev host's web server is **not** behind DSH Desktop's request gate, so
`/mesh/api/*` can be driven with curl there — production cannot (it returns 403
unless the request carries the renderer token).

## 3. Hard constraints — do not violate

1. **Never let a probe failure look like a negative fact.** `ENOENT` means "not
   installed"; a timeout means "we did not get an answer". These must stay
   distinguishable and visible (`probeErrors`, `runtimesIncomplete`,
   `routeDecision`, `dispatchError`). Collapsing them caused a real incident: a
   busy Mac reported "no runtimes installed".
2. **Never leave a documented command that does not exist.** The README is served
   verbatim on the npm page, and the plugin catalog explicitly checks descriptions
   against code. A made-up flag was caught in review.
3. **Changing a schema `.default()` is usually not enough.** `cordis.patch.yml` in
   the repo and in the user's profile pin values that override the default. Check
   all three:
   ```bash
   grep -rn "theKey" cordis.patch.yml ~/.dsh/profiles/*/cordis.patch.yml
   ```
4. **`config:` in a patch is replaced wholesale, not merged.** Adding one key
   without restating the others silently resets them to schema defaults.
5. **Verify side-effecting scripts by running them, not by `bash -n`.** A reference
   to an undefined `$REPO_ROOT` passed syntax checking and turned "delayed restart"
   into a silent no-restart. Use `scripts/restart-dsh.sh --check-only` to exercise
   the preflight without touching the running app.
6. **`node --check` cannot catch TDZ.** `scripts/check-tdz.mjs` exists for that;
   keep it in `npm run check`.
7. **Do not trust "it looks fine".** This project has repeatedly shipped
   "wired but not actually connected" changes (a gate that was only mentioned in a
   comment, `install.sh` not copying `scripts/`, a placeholder that hid a missing
   file). When you add a gate, prove it has teeth: break the input and watch it fail.

## 4. Architecture map

```
lib/index.js          host half: config schema, discovery orchestration, peer HTTP
                      server, agent tools, UI routes, inbound task routing, wake logic
lib/discovery.js      UDP multicast registry, endpoint-level liveness, fingerprint claim
lib/scan.js           active subnet scan
lib/identity.js       persistent UUID + OS machine fingerprint (claim only)
lib/conversation.js   conversation key + reply target (both sides compute independently)
lib/capabilities.js   runtime/GPU/capability collection, sanitising, staleness
lib/prompt.js         task prompt text generation (pure, unit-tested)
lib/tsnet/            sidecar download/verify, process manager, tailnet HTTP bridge
client/client.js      renderer: sidebar icon + Mesh panel, hand-written bundle
sidecar/              Go: tsnet node + control HTTP API + port forwarding
scripts/              build/release/verify/push/submit tooling
docs/                 GitHub Pages showcase site
```

Key data flow for an inbound task: `POST /mesh/v1/task` → `handleInboundTask` →
`classifyInbound` (gates: noWake, min length, greeting, per-thread cap, cooldown) →
reuse the session bound to the conversation key, or create one via `wakeAgent` →
inject the prompt → the peer's agent replies by calling `mesh_run`.

## 5. Test map

| Suite | Command | Covers |
|---|---|---|
| Core | `npm run selftest` | discovery, endpoints, conversation keys (52) |
| Capabilities | `npm run selftest:caps` | sanitising, GPU parsing, retry-on-timeout, claim rules (64) |
| Client render | `npm run selftest:client` | bundle loads, `apply()` registers slots, component output (12) |
| Prompt | `npm run selftest:prompt` | reply target must be a machine name, not `machine/user` (10) |

`lib/_selftest-newsession.mjs` is a manual end-to-end check that needs a dev host
running; it is deliberately not part of `npm test` because it creates real agent
sessions (costs tokens).

Everything in `npm test` is **network-free** — the discovery self-test uses a
private multicast group so it cannot pollute a real LAN.

## 6. Releasing

```bash
npm run check && npm test
./scripts/release-plugin.sh --publish   # tarball -> GitHub release -> LAN mirror
npm publish                           # npm; publishConfig pins the public registry
```

Then upgrade other machines with the command printed by `release-plugin.sh`.
If the dsh host is on this machine, `scripts/restart-dsh.sh --install [delay]`
restarts it from launchd so the restart survives killing the app.

Notes:
- `scripts/check-tarball.mjs` validates the **published artifact**, not the source
  tree, because `files` in `package.json` decides what users actually get.
- npm's "staged publishing" makes a new version appear in metadata before its
  tarball is downloadable. Do not declare success until the tarball returns 200.
- Keep `llms.txt` and `docs/llms.txt` identical: `npm run check` verifies it.

## 7. Things that will waste your time if you do not know them

- **Android has no `/tmp`** (read-only root). Use `$TMPDIR`.
- **GUI-launched dsh inherits a minimal `PATH`**; runtime probes must augment it.
- **Windows**: `%LOCALAPPDATA%\Microsoft\WindowsApps` is full of zero-byte Store
  alias stubs — it must not be treated as evidence that a runtime exists.
- **git-over-https to github.com is blocked on the author's network.** Use
  `scripts/push-via-api.py` (exact commit replication via the REST API) instead of
  `git push`.
- **`github.io` reachability varies** in mainland China.
- The author's machines: a Mac (this repo), `hos` (Android), `文超-win` (Windows).
  Tasks are dispatched between them with `mesh_run`.

## 8. Contact

geekstartup@163.com · https://github.com/peng456/dsh-plugin-mesh/issues
