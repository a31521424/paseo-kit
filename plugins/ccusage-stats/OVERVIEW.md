Shows how many tokens your coding agents use on the machine the Paseo daemon runs on, and what that usage would cost at API prices. Numbers come from [ccusage](https://github.com/ccusage/ccusage), which reads the agents' local session logs. Claude Code, Codex, Gemini CLI, Copilot CLI, OpenCode, Antigravity, Grok Build, Amp, Pi and the other agents ccusage supports are counted together.

## Where it appears

A line in the sidebar footer, styled like the built-in usage summary, shows today's total tokens, a small meter and today's estimated cost. The meter compares today's estimated cost, split by agent, with a tick that marks a typical day: the average cost over the active days of the last 14, with idle days skipped. Cost is used rather than tokens because cache reads make up most of the token count while costing next to nothing. The tick sits mid-track, so a half-full meter means an average day; past double the average the track stretches and the tick slides left. With no usage in the last 14 days, the typical day defaults to about $33, which is 20% of the monthly API-equivalent value of a $200 Claude plan (about $4,970) as measured by [SemiAnalysis](https://newsletter.semianalysis.com/p/anthropic-subscriptions-offer-5x), spread over 30 days. The tick is muted while the default is in use. The popover's day view states the typical day in numbers. On a narrow sidebar the bar and then the cost are dropped.

Press the line for a popover. Switch between day, week and month to see the current period's total, the change against the previous one, and a stacked column chart of recent periods. Press a column to inspect that period. Below the chart, each agent's tokens, share and cost are listed. **Details** opens a full screen with longer history (30 days, 12 weeks or 12 months), cost per million tokens, cache hit rate, the input, output and cache split, a per-agent list that expands into models, and the most recent sessions. The screen is also in the Command Center as **Open token usage**.

Each agent's composer gets a pill with the token total of that agent's current session. Press it for the session's cost, token split and models. The pill stays hidden until ccusage has recorded usage for the session, so agents ccusage cannot read show no pill.

## How sessions are matched

Paseo stores each agent's provider session id. For Claude Code this is the session id ccusage reports; for Codex it is the thread id at the end of ccusage's rollout name. The plugin matches on that id exactly, so a session pill never mixes in other sessions from the same folder. Other providers match when their ccusage session id is the provider session id. An agent that has not started a provider session yet shows no pill. When an agent is resumed into a new provider session, the pill follows the new session.

## Freshness

The daemon runs ccusage once for all views and caches the result for a minute. When an agent finishes a turn, the cache is refreshed a few seconds later if someone has looked at the numbers in the last 15 minutes. While a refresh runs, the previous numbers are shown. If a refresh fails, older numbers stay visible with a warning.

## Setup and limits

ccusage is bundled with the plugin, so nothing needs to be on the daemon's `PATH`. The bundled build covers macOS, Linux and Windows on x64 and arm64; elsewhere a `ccusage` on the daemon's `PATH` is used. Requires Paseo 0.11.1 or later.

Days and weeks use the daemon's timezone, and weeks start on Monday. Costs come from the pricing table built into ccusage (`--offline`), so nothing is fetched from the network. They are estimates of API list prices, not what a subscription plan bills. Only usage written to logs on the daemon's machine is counted; agents on other machines and logs that an agent has deleted or rotated are not. The plugin reads local log files and sends nothing off the host.
