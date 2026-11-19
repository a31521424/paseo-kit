// A live check on this host: runs Claude Code's /usage the way the plugin does and prints what
// was parsed. `node ... test/usage-live.ts [headless|interactive]`. Claude Code signs in by
// itself; nothing here reads a token.
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { locateClaude, runHeadless, runInteractive } from "../server/claude-usage";
import { parseUsageText } from "../server/usage-text";

mkdirSync(path.join(os.tmpdir(), "paseo-ccusage-stats-usage"), { recursive: true });
const mode = process.argv[2] === "interactive" ? "interactive" : "headless";
const claude = await locateClaude(process.env.CLAUDE_PATH ?? "");
if (!claude) throw new Error("claude not found");
const started = Date.now();
// USAGE_LIVE_DIR: run the interactive session in another folder, for example a new one to see
// the folder trust prompt answered.
const dir = process.env.USAGE_LIVE_DIR;
if (dir) mkdirSync(dir, { recursive: true });
const text = mode === "headless" ? await runHeadless(claude) : await runInteractive(claude, dir);
const limits = parseUsageText(text);
const show = (ms: number | null | undefined) => (ms ? new Date(ms).toString() : null);
console.log(
  JSON.stringify(
    {
      mode,
      claude,
      seconds: (Date.now() - started) / 1000,
      fiveHour: limits?.fiveHour && {
        ...limits.fiveHour,
        resetsAtLocal: show(limits.fiveHour.resetsAt),
      },
      sevenDay: limits?.sevenDay && {
        ...limits.sevenDay,
        resetsAtLocal: show(limits.sevenDay.resetsAt),
      },
      partial: limits?.partial ?? null,
    },
    null,
    2,
  ),
);
process.exit(limits ? 0 : 1);
