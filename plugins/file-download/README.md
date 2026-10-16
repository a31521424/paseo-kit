# file-download

Download the file you are previewing with Cmd+S or Ctrl+S, including files outside the workspace.

See [OVERVIEW.md](OVERVIEW.md) for what it does, how it works and its limits.

## Install

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/file-download
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/file-download && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.11.1 or later with plugins enabled on the daemon.

## Develop

```bash
npm run typecheck
paseo plugin reload file-download
paseo plugin logs file-download
```
