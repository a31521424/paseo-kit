# host-monitor

CPU, memory, disk and network usage of the daemon host in the sidebar footer. A separate Latency line shows round-trip time through Paseo plugin RPC, with recent history and failure details on press.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works and its limits.

## Install

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/host-monitor
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/host-monitor && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later with plugins enabled on the daemon.

## Develop

```bash
npm run typecheck
node --test test/latency.test.mjs
paseo plugin reload host-monitor
paseo plugin logs host-monitor
```
