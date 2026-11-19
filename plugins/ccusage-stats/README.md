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

Claude plan limits (5-hour and weekly) are optional and off by default: turn them on in the plugin's settings. When on, the daemon runs Claude Code's own `/usage` on its host, at most every 5 minutes (configurable) and only while a Paseo view is open; with a `claude setup-token` token it opens `/usage` in an interactive Claude Code session through the system `script` command. Claude Code fetches the numbers with its own sign-in; the plugin never reads a Claude token and makes no network requests of its own. See [OVERVIEW.md](OVERVIEW.md#claude-plan-limits-optional-off-by-default).

## Develop

```bash
npm run typecheck
npm test                       # parser, terminal and reader tests (node --test, no extra dependencies)
npm run usage:live             # runs claude -p /usage on this host and prints what was parsed
npm run usage:live interactive # the interactive fallback
paseo plugin reload ccusage-stats
paseo plugin logs ccusage-stats
```
