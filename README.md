# paseo-kit

[![typecheck](https://github.com/a31521424/paseo-kit/actions/workflows/typecheck.yml/badge.svg)](https://github.com/a31521424/paseo-kit/actions/workflows/typecheck.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A collection of [Paseo](https://paseo.sh) plugins. Each plugin lives in `plugins/<id>/` and is a
complete, self-contained Paseo plugin project.

## Plugins

| ID | Name | What it does |
| --- | --- | --- |
| [`host-monitor`](plugins/host-monitor) | Host monitor | CPU, RAM and network speed of the daemon host in the sidebar footer, with a history popover. |
| [`ccusage-stats`](plugins/ccusage-stats) | Token usage | Token usage and estimated cost of your coding agents via [ccusage](https://github.com/ccusage/ccusage): today's total, day/week/month breakdown by agent, and a per-session composer pill. |

### host-monitor

- One sidebar footer line: CPU and RAM percentage with small meters, download and upload speed.
- Yellow above 70%, red above 90%; network speed is dropped first on a narrow sidebar.
- Popover with about three minutes of history per metric, uptime and load average.
- Samples every 2 s on the daemon, keeps history in memory. Network speed needs Linux.

### ccusage-stats

- Sidebar footer line with today's tokens, a per-agent split bar and estimated cost.
- Popover with day / week / month totals, change against the previous period and a stacked chart.
- Full **Token usage** screen (also in the Command Center): 30 days / 12 weeks / 12 months of history,
  cost per million tokens, cache hit rate, per-agent and per-model breakdown, recent sessions.
- A composer pill on each agent with the token total of its current provider session.
- Counts every agent ccusage supports (Claude Code, Codex, Gemini CLI, OpenCode, Amp, ...).
  Costs are offline estimates at API list prices. Nothing is sent off the host.

See each plugin's `OVERVIEW.md` for details and limits.

## Requirements

- Paseo **0.11.1** or later (daemon and app).
- Plugins enabled on the daemon: **Settings → Plugins → Enable plugins**, or `"pluginsEnabled": true`
  in the daemon's `config.json` followed by `paseo reload`.
- Node.js with npm on the daemon host (for installing dependencies).

## Install

### From GitHub

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/host-monitor
paseo plugin install github:a31521424/paseo-kit:plugins/ccusage-stats
```

`ccusage-stats` declares `build: [["npm", "ci", "--omit=dev"]]`, so Paseo installs the bundled
ccusage binary from the committed lockfile. `host-monitor` only uses host-provided libraries.
Update later with `paseo plugin update <id>`.

### From a local clone

```bash
git clone https://github.com/a31521424/paseo-kit.git
cd paseo-kit
npm run install:all

paseo plugin install "$PWD/plugins/host-monitor"
paseo plugin install "$PWD/plugins/ccusage-stats"
paseo plugin ls
```

Paseo loads directory plugins from the source directory itself. If you move the clone, run
`paseo plugin remove <id>` and install again from the new absolute path.

## Development

```bash
npm run typecheck              # all plugins; or `npm run typecheck` inside plugins/<id>
paseo plugin reload <id>       # load source changes
paseo plugin ls                # require status "running" with no error
paseo plugin logs <id>         # stdout/stderr of the plugin's daemon subprocess
```

Do not restart the daemon to pick up plugin changes. `paseo plugin reload <id>` is enough, and a
restart kills running agents.

Client code must work on desktop and mobile: React Native primitives only, text colors from
`theme.colors`, spacing from `layout.compact`. Audit client code with:

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" plugins/*/client/
```

TypeScript generics such as `useState<number | null>` also match. Anything else outside
`client/web.ts` is a bug.

### Repository layout

```text
paseo-kit/
  package.json            root scripts only: install:all, typecheck
  plugins/
    <id>/
      paseo-plugin.json   manifest: id, name, description, requirements.paseo
      OVERVIEW.md         listing page shown inside Paseo
      package.json
      package-lock.json
      tsconfig.json
      index.client.tsx    app entry
      index.server.ts     daemon entry
      client/  server/  shared/
```

This repository intentionally does **not** use npm workspaces. Each plugin installs its own
dependencies in `plugins/<id>/node_modules`. `ccusage-stats` looks for the native ccusage binary in
its own plugin directory, so hoisting dependencies to the root would break it.

### Adding a plugin

```bash
paseo plugin init "$PWD/plugins/<id>"
cd plugins/<id>
npm install
```

Then align it with the existing plugins: the same `@getpaseo/plugin` version and
`requirements.paseo` range, the same `tsconfig.json`, a `package.json` `name` matching the ID, and a
factual `OVERVIEW.md`. Add it to the plugin table above and to the CI matrix in
`.github/workflows/typecheck.yml`.

## Trust and security

Paseo plugins are **trusted, unsandboxed code**. Server code runs as a daemon subprocess with full
access to the daemon machine's files, processes, credentials and network. Client code runs inside the
Paseo app. Read the source before installing any plugin, including these. Never commit credentials,
and never log them from plugin code.

## License

[MIT](LICENSE)
