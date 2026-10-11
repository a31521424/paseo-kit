# ccusage-stats

Token usage and estimated cost of your coding agents, powered by ccusage.

See [OVERVIEW.md](OVERVIEW.md) for what it shows, how it works and its limits.

## Install

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/ccusage-stats
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/ccusage-stats && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later with plugins enabled on the daemon.

## Develop

```bash
npm run typecheck
paseo plugin reload ccusage-stats
paseo plugin logs ccusage-stats
```
