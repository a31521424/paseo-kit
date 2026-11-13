import { z } from "zod";

/** The agent tool's name. Providers prefix it, for example `mcp__paseo__preview_media`. */
export const PREVIEW_TOOL_NAME = "preview_media";
export const CARD_KIND = "media-cards";
export const CARD_VERSION = 1;
/** Most files one card shows; the rest are counted in `more`. */
export const CARD_MAX_FILES = 12;

export const cardSchema = z.object({
  /** `tool`: the agent called preview_media. `turn`: files a finished turn created or changed. */
  source: z.enum(["tool", "turn"]),
  title: z.string().nullable(),
  note: z.string().nullable(),
  /** Directory relative paths resolve against; null means the agent's working directory. */
  cwd: z.string().nullable(),
  paths: z.array(z.string()).max(CARD_MAX_FILES),
  more: z.number().int().nonnegative(),
  /** How many of `paths`, from the start, the agent showed with the tool; the rest changed on disk. */
  shown: z.number().int().nonnegative().default(0),
  state: z.enum(["running", "done", "failed"]),
  error: z.string().nullable(),
});
export type CardData = z.input<typeof cardSchema>;

export function isPreviewToolName(name: string): boolean {
  if (name === PREVIEW_TOOL_NAME) return true;
  return [`__${PREVIEW_TOOL_NAME}`, `.${PREVIEW_TOOL_NAME}`, `/${PREVIEW_TOOL_NAME}`, `:${PREVIEW_TOOL_NAME}`].some((suffix) =>
    name.endsWith(suffix),
  );
}

const toolInputSchema = z.object({
  paths: z.array(z.string()).min(1),
  title: z.string().nullish(),
  note: z.string().nullish(),
});

/** Reads the tool's input from a timeline tool call, which providers report as an object or JSON text. */
export function parseToolInput(input: unknown): z.infer<typeof toolInputSchema> | null {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = toolInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
