# dsh-plugin-mesh — English quickstart

> Discover other DeepSeek Harness (dsh) instances on your network and dispatch tasks
> between machines in both directions. No pairing codes, no IP entry, no Tailscale
> client to install.

[中文完整文档](README.md) · [llms.txt](llms.txt) (machine-oriented facts) · [AGENTS.md](AGENTS.md) (for coding agents)

---

## What it is

A dsh plugin. Install it on two or more machines and they find each other on the
LAN, show up in a sidebar panel, and accept tasks from one another. The receiving
machine wakes its own agent to do the work, and the result is dispatched back.

When machines are not on the same network, an optional bundled userspace Tailscale
node (tsnet) provides a second channel. It is a separate Go binary, downloaded per
platform on first use — end users need neither a Go toolchain nor the Tailscale
client.

## Install

```bash
dsh plugin add dsh-plugin-mesh                 # 'desktop' profile: in DSH Desktop's own terminal
dsh plugin --profile web add dsh-plugin-mesh   # other profiles: a normal terminal works
```

From source: `git clone https://github.com/peng456/dsh-plugin-mesh && cd dsh-plugin-mesh && ./install.sh`

**Restart the dsh host afterwards** — plugins load at startup. You should then see a
**Mesh** entry in the sidebar.

## Three steps

1. Install on every machine.
2. Restart dsh on every machine.
3. Open the **Mesh** panel. Seeing another machine means it worked.

If the panel is empty, check in this order: (a) same LAN, (b) the peer also installed
and restarted, (c) the peer's firewall allows TCP `45917` and UDP `45892`. Multicast
is often blocked by routers — the panel's **Scan subnet** button works around that.

## What you get

- **Zero-config discovery** — UDP multicast heartbeat on `239.255.42.99:45892`, plus
  an active subnet scan when multicast is blocked.
- **Capability cards** — each machine reports its runtimes (Node / Python / Go /
  Docker / …), CPU cores, memory and GPU, so you can tell before dispatching whether
  a machine can do the job.
- **Bidirectional dispatch** — the peer's agent can dispatch results back; both sides
  compute the same conversation key independently, without negotiation.
- **Two channels with automatic failover** — LAN first, tsnet as backup. The backup
  channel is actively probed even while the LAN is healthy, so it is known-good
  rather than assumed-good.
- **Traceable routing** — every task records why it went where it went, and why it
  failed if it did. Both are readable from the peer.

## Security defaults — read this

**With `requirePairing: false` (the default), any host that can reach TCP `45917` can
POST a task, and that task wakes an agent session** using the configured
`permissionPreset`. Discovery is intentionally public so you can see machines before
deciding to talk to them.

On an untrusted network (café, dorm, office):

1. Set `requirePairing: true` in your profile's `cordis.patch.yml`.
2. Make the pairing secret identical on both machines (the Mesh panel has a field for it).

Note the token travels in a plain HTTP header: it guards against stray devices on
the network, not against a network sniffer. It lives in `~/.dsh/mesh/state.json`
(mode 0600) and is never included in the multicast card.

## Configuration

Override by id in the profile's `cordis.patch.yml`:

```yaml
- id: mesh
  config:
    requirePairing: true
    permissionPreset: workspace-write
```

`config:` is replaced **wholesale**, not merged — restate any keys you want to keep.
The full key list with defaults is in [`llms.txt`](llms.txt#configuration).

## Requirements

- A dsh host that can load cordis plugins with a client half (DSH Desktop, or `dsh web`).
- Node >= 20 for development. `@deepseek-ai/*` packages are supplied by the host.

## More

| | |
|---|---|
| Full documentation (Chinese) | [README.md](README.md) |
| Machine-oriented facts / config table | [llms.txt](llms.txt) |
| Guide for coding agents | [AGENTS.md](AGENTS.md) |
| Showcase page (Chinese) | https://peng456.github.io/dsh-plugin-mesh/ |
| Issues | https://github.com/peng456/dsh-plugin-mesh/issues |
| Contact | geekstartup@163.com |

MIT licensed. Not affiliated with DeepSeek.
