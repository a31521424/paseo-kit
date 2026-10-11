# paseo-kit

A collection of local [Paseo](https://paseo.sh) plugins. Each plugin lives in its own directory under
`plugins/<id>/` and is a complete, self-contained Paseo plugin project.

## Plugins

| ID | Name | Description |
| --- | --- | --- |
| [`host-monitor`](plugins/host-monitor) | Host monitor | Sidebar footer showing the daemon host's CPU, RAM, and network throughput, with a history popover. |
| [`ccusage-stats`](plugins/ccusage-stats) | Token usage | Token usage statistics from [ccusage](https://github.com/ryoppippi/ccusage): today's total, daily/weekly/monthly breakdown by agent, and usage for the current session. |

## Layout

```text
paseo-kit/
  package.json          # root scripts only: install:all, typecheck
  plugins/
    <id>/
      paseo-plugin.json # manifest: id, name, requirements.paseo
      OVERVIEW.md       # listing page shown inside Paseo
      package.json
      tsconfig.json
      index.client.tsx  # app entry
      index.server.ts   # daemon entry
      client/ server/ shared/
```

This repository does **not** use npm workspaces. Each plugin installs its own dependencies in
`plugins/<id>/node_modules`. `ccusage-stats` looks for the native ccusage binary in its own
plugin directory's `node_modules`, so hoisting dependencies to the root would break it.

## Install

Requires plugins to be enabled on the daemon (`pluginsEnabled: true` in the daemon's
`config.json`, or **Settings → Plugins → Enable plugins**).

```bash
npm run install:all     # or: (cd plugins/<id> && npm install)

paseo plugin install /absolute/path/to/paseo-kit/plugins/host-monitor
paseo plugin install /absolute/path/to/paseo-kit/plugins/ccusage-stats
```

Use absolute paths. The manifest `id` is the runtime ID. Paseo loads local plugins from
their source directory, so moving the repository requires `paseo plugin remove <id>` followed
by `paseo plugin install <new absolute path>`.

## Development

```bash
cd plugins/<id>
npm run typecheck              # or `npm run typecheck` at the root for all plugins
paseo plugin reload <id>       # load source changes
paseo plugin ls                # require status "running" with no error
paseo plugin logs <id>         # stdout/stderr of the plugin subprocess
```

Do not restart the daemon to pick up plugin changes; `paseo plugin reload <id>` is enough, and a
restart kills running agents.

Client code must work on desktop and mobile: React Native primitives only, colors from
`theme.colors`, layout from `layout.compact`. Audit client code with:

```bash
rg -n "document\.|window\.|localStorage|navigator\.|<[a-z]+[ >]|className=|onClick=" plugins/*/client/
```

TypeScript generics such as `useState<number | null>` also match this pattern. Any other match
outside `client/web.ts` is a bug.

## Adding a plugin

```bash
paseo plugin init "$PWD/plugins/<id>"
cd plugins/<id>
npm install
```

Then align it with the existing plugins: the same `@getpaseo/plugin` version and
`requirements.paseo` range, the same `tsconfig.json`, a `package.json` `name` matching the ID, and
a factual `OVERVIEW.md`. Add it to the table above.

## Trust and security

Paseo plugins are **trusted, unsandboxed code**. Server code runs as a daemon subprocess with full
access to the daemon machine's files, processes, credentials, and network. Client code runs
inside the Paseo app. Only install plugins whose source you have read. Never commit credentials,
and never log them from plugin code.
