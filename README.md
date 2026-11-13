# paseo-kit

[![typecheck](https://github.com/a31521424/paseo-kit/actions/workflows/typecheck.yml/badge.svg)](https://github.com/a31521424/paseo-kit/actions/workflows/typecheck.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A collection of [Paseo](https://paseo.sh) plugins. Each plugin lives in `plugins/<id>/` and is a
complete, self-contained Paseo plugin project.

## Plugins

| ID | Name | What it does |
| --- | --- | --- |
| [`host-monitor`](plugins/host-monitor) | Host monitor | CPU, RAM, disk and network speed of the daemon host in the sidebar footer, with a history popover. |
| [`ccusage-stats`](plugins/ccusage-stats) | Token usage | Token usage and estimated cost of your coding agents via [ccusage](https://github.com/ccusage/ccusage): today's total, day/week/month breakdown by agent, and a per-session composer pill. |
| [`file-download`](plugins/file-download) | Download file | Cmd+S or Ctrl+S downloads the file you are previewing, including files outside the workspace such as `/tmp`. |
| [`tab-recovery`](plugins/tab-recovery) | Closed agents | Lists the agents whose tab was closed (which archives them) in the current workspace and reopens one with a press. |
| [`media-studio`](plugins/media-studio) | Media studio | Review the images, video and audio agents make: chat cards, a streaming player with a filmstrip and waveform timeline, timecoded notes to the agent, large uploads and downloads, files on SSH hosts. |

### host-monitor

- One sidebar footer line: CPU, RAM and disk percentage with small meters, then download and upload speed under one icon.
- Yellow above 70%, red above 90%; on a narrow sidebar network speed is dropped first, then disk.
- Popover with about three minutes of history per metric, usage of each local disk, uptime and load average.
- Samples every 2 s on the daemon, keeps history in memory. Network speed needs Linux.

### ccusage-stats

- Sidebar footer line with today's tokens, a meter of today's cost against your typical day (median of active days in the last 28) and estimated cost.
- Popover with day / week / month totals, change against the previous period and a stacked chart;
  the day view also states your typical day and average daily cost.
- Full **Token usage** screen (also in the Command Center): 30 days / 12 weeks / 12 months of history,
  cost per million tokens, cache hit rate, per-agent and per-model breakdown, recent sessions.
- A composer pill on each agent with the token total of its current provider session.
- Counts every agent ccusage supports (Claude Code, Codex, Gemini CLI, OpenCode, Amp, ...).
  Costs are offline estimates at API list prices. Nothing is sent off the host.

### file-download

- Cmd+S on macOS or Ctrl+S on Windows and Linux downloads the file preview you are looking at,
  including files outside the workspace such as `/tmp` output. "Download current file" in the
  Command Center does the same.
- On any other tab, such as an agent, the shortcut does nothing. Inside Paseo's file editor it still
  saves your edits.
- "Open downloads" lists the downloads since the page loaded; nothing is discovered or listed on its own.
- Transfers go in 4 MB pieces over the Paseo connection, so they work through relays and reverse
  proxies. Up to 1 GB per file. Desktop app and browser only.

### tab-recovery

- Closing an agent's tab archives it. The **Closed agents** panel lists the archived top-level
  agents of the workspace, newest first.
- Reopen unarchives the agent, resumes its session and opens its tab again, like the Unarchive button
  in an archived agent's tab. The daemon side runs `paseo agent reload`, so the `paseo` CLI must be on
  the daemon's PATH.

### media-studio

- Agents get a `preview_media` tool that shows a render, cut, frame or mix in the chat as a card
  with a player. After each turn, a card below the reply collects the media the turn showed and the
  media files it created or changed.
- The player streams from the daemon, so large files start in about a second and seek instantly.
  H.264 plays as it is; other formats become a 720p proxy on the fly (VideoToolbox or NVENC when
  available). Timeline with timecode, filmstrip, waveform, hover frames, frame steps, in and out
  points, loop and editor keys.
- Long-GOP renders seek in about a second: the stretch from the playhead to the next keyframe is
  encoded on the fly at near-original quality, then the original takes over.
- Editor tools: playback position, in/out and speed remembered per file (across tab switches,
  reloads and re-renders), type a timecode to jump, flip between two versions at the same moment,
  safe-area and 9:16 / 4:5 / 1:1 crop guides, and EBU R128 loudness and true peak against −14 LUFS.
- Notes to an agent carry the file, timecode, in/out range and the current frame as an image. They
  can be sent while the agent works (they join its current task), are listed and pinned on the
  timeline, and copy out as a timecoded list.
- **Media** panel: recent media or folders, uploads by button or drag and drop, downloads written to
  disk as they arrive. Transfers go over the Paseo connection in 4 MB pieces, so direct connections,
  reverse proxies and tunnels work without an extra port.
- Files on an SSH host (`alias:/path`, aliases from `~/.ssh/config`) are processed by that host's
  ffmpeg, for agents that render on a GPU server.
- Needs ffmpeg on the daemon host and Paseo 0.15.3 or later. Playback and uploads need the desktop
  app or a browser.

See each plugin's `OVERVIEW.md` for details and limits.

## Requirements

- Paseo **0.11.1** or later (daemon and app); **0.15.3** or later for `media-studio`.
- Plugins enabled on the daemon: **Settings → Plugins → Enable plugins**, or `"pluginsEnabled": true`
  in the daemon's `config.json` followed by `paseo reload`.
- Node.js with npm on the daemon host (for installing dependencies).

## Dependencies

paseo-kit does not vendor any third-party code. Dependencies are declared per plugin in
`plugins/<id>/package.json` and pinned by the committed `package-lock.json`.

**Runtime environment**

| Dependency | Version | Notes |
| --- | --- | --- |
| [Paseo](https://github.com/getpaseo/paseo) daemon and app | >= 0.11.1 | Declared as `requirements.paseo` in each `paseo-plugin.json`. |
| Node.js and npm | Node 22+ recommended | On the daemon host, for installing dependencies and the `ccusage-stats` build step. |
| `paseo` CLI | same as the daemon | On the daemon's PATH, for `tab-recovery` to restore agents. Present with a standard install. |
| Linux `/proc` | - | `host-monitor` network speed, available memory and the disk list. Other systems show CPU, RAM and the root disk only. |
| ffmpeg (ffprobe optional) | 6 or later recommended | On the daemon host for `media-studio`, with libx264; also on any SSH host whose files it previews. |
| `ssh` client | - | Only for `media-studio` files on SSH hosts; keys must work without a prompt. |

**Runtime npm dependencies** (installed with the plugin)

| Package | Version | License | Used by |
| --- | --- | --- | --- |
| [`ccusage`](https://github.com/ccusage/ccusage) | 20.0.29 | MIT | `ccusage-stats` |
| `@ccusage/ccusage-<platform>-<arch>` | 20.0.29 | MIT | `ccusage-stats` (native binary, optional dependency of `ccusage`) |

`host-monitor`, `file-download`, `tab-recovery` and `media-studio` have no runtime npm dependencies.

**Provided by Paseo at runtime** (`devDependencies`, installed locally only for typechecking)

| Package | Version | License |
| --- | --- | --- |
| [`@getpaseo/plugin`](https://github.com/getpaseo/paseo) | 0.11.1 (`media-studio`: 0.15.3) | Apache-2.0 (Paseo) |
| `react` | 19.1.0 | MIT |
| `react-native` | 0.81.5 | MIT |
| `@tanstack/react-query` | ^5.90.11 | MIT |
| `zod` | ^4.4.3 | MIT |

**Development only**

| Package | Version | License |
| --- | --- | --- |
| `typescript` | ^5.9.3 | Apache-2.0 |
| `@types/node` | ^22.0.0 | MIT |
| `@types/react` | ~19.2.0 | MIT |

## Install

### Install with an agent

Copy this prompt into a Paseo agent running on the target machine. It installs or updates all
plugins from GitHub. To install only some, remove the other IDs from step 3.

```text
Install the paseo-kit Paseo plugins from https://github.com/a31521424/paseo-kit on this machine's Paseo daemon. Never restart the Paseo daemon; it would kill running agents.
1. Run `paseo --version` and require 0.11.1 or later. Run `npm --version`; npm must be on the daemon's PATH because ccusage-stats runs `npm ci --omit=dev` when it installs.
2. Get `home` from `paseo daemon status --json` and read `pluginsEnabled` in `<home>/config.json` (missing means false). If it is not true, stop and ask me before enabling it, and warn me that plugins are trusted, unsandboxed code with access to this machine. If I agree, set only that field to true, keep the rest of the file, and run `paseo reload --json`.
3. Run `paseo plugin ls`. For each ID in `host-monitor`, `ccusage-stats`, `file-download`, `tab-recovery` and `media-studio`: if it is not installed, run `paseo plugin install github:a31521424/paseo-kit:plugins/<id>`; if its SOURCE is already this GitHub repository, run `paseo plugin update <id> --yes`; if it is installed from any other source, ask me before removing and reinstalling it.
4. Run `paseo plugin ls` and require every plugin to be `running` with no error. If one fails, show me its error and `paseo plugin logs <id>`.
5. Report each plugin's SOURCE and REVISION.
```

### From GitHub

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/host-monitor
paseo plugin install github:a31521424/paseo-kit:plugins/ccusage-stats
paseo plugin install github:a31521424/paseo-kit:plugins/file-download
paseo plugin install github:a31521424/paseo-kit:plugins/tab-recovery
paseo plugin install github:a31521424/paseo-kit:plugins/media-studio
```

`ccusage-stats` declares `build: [["npm", "ci", "--omit=dev"]]`, so Paseo installs the bundled
ccusage binary from the committed lockfile. The other plugins only use host-provided libraries.
Update later with `paseo plugin update <id>`.

### From a local clone

```bash
git clone https://github.com/a31521424/paseo-kit.git
cd paseo-kit
npm run install:all

paseo plugin install "$PWD/plugins/host-monitor"
paseo plugin install "$PWD/plugins/ccusage-stats"
paseo plugin install "$PWD/plugins/file-download"
paseo plugin install "$PWD/plugins/tab-recovery"
paseo plugin install "$PWD/plugins/media-studio"
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

Licensed under the [Apache License, Version 2.0](LICENSE), the same license as
[Paseo](https://github.com/getpaseo/paseo). See [NOTICE](NOTICE). Third-party dependencies keep their
own licenses, listed under [Dependencies](#dependencies).
