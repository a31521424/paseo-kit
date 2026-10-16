# tab-recovery

Reopen agent tabs that were closed by accident.

See [OVERVIEW.md](OVERVIEW.md) for what it does, how it works and its limits.

## Install

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/tab-recovery
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/tab-recovery && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later with plugins enabled on the daemon.

## Develop

```bash
npm run typecheck
paseo plugin reload tab-recovery
paseo plugin logs tab-recovery
```
