# host-monitor

CPU, memory, disk, network and NVIDIA GPU usage and temperatures of the daemon host in the sidebar footer.

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

Requires Paseo 0.16.0 or later with plugins enabled on the daemon.

## Develop

```bash
npm run typecheck
npm test
paseo plugin reload host-monitor
paseo plugin logs host-monitor
```
