import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  MIN_REFRESH_OPTIONS,
  settingsDefinition,
  type ClaudeLimitsSettings,
  type ClaudeLimitsState,
} from "../shared/limits";
import { formatAgo } from "./format";
import { LIMITS_QUERY_KEY, useClaudeLimits } from "./limits";

function statusHint(state: ClaudeLimitsState | undefined): string {
  if (!state?.enabled) return "Shown once plan limits are on.";
  if (state.missingClaude) return "Claude Code (claude) was not found on this host.";
  if (state.refreshing && !state.fetchedAt) return "Running /usage...";
  const how =
    state.method === "headless"
      ? "Read with claude -p /usage."
      : state.method === "interactive"
        ? "Read from /usage in an interactive Claude Code session."
        : "";
  const last = state.error
    ? ` Last run failed: ${state.error}`
    : state.fetchedAt
      ? ` Updated ${formatAgo(state.fetchedAt)}.`
      : "";
  return `${how}${last}`.trim() || "Not read yet.";
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(settingsDefinition);
  const limits = useClaudeLimits();
  const queryClient = useQueryClient();
  const [claudePath, setClaudePath] = useState<string | null>(null);

  if (settings.status !== "ready") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted }}>
        {settings.status === "loading" ? "Loading settings..." : settings.error}
      </Text>
    );
  }
  const values = settings.values;
  const current = values.claudeLimits;
  const save = (patch: Partial<ClaudeLimitsSettings>) =>
    void settings
      .save({ ...values, claudeLimits: { ...current, ...patch } }, settings.revision)
      .then((saved) => {
        if (saved) void queryClient.invalidateQueries({ queryKey: LIMITS_QUERY_KEY });
        return undefined;
      });
  const pathDirty = claudePath !== null && claudePath.trim() !== current.claudePath;

  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="Claude plan limits">
        <SettingsCard>
          <SettingsSwitch
            label="Show Claude plan limits"
            hint={`Off by default. When on, the daemon runs Claude Code's own /usage command on its host, at most every ${current.minRefreshMinutes} minutes and only while Paseo is open, and shows the 5-hour and weekly limits. Claude Code fetches them from Anthropic with its own sign-in; this plugin never reads your Claude token. /usage runs no model turn and uses none of your plan.`}
            value={current.enabled}
            onValueChange={(enabled) => save({ enabled })}
          />
          <SettingsSelect
            label="Minimum refresh interval"
            hint="Applies to manual refreshes too. Failed runs wait longer, up to an hour."
            value={String(current.minRefreshMinutes)}
            options={MIN_REFRESH_OPTIONS.map((minutes) => ({
              value: String(minutes),
              label: `${minutes} minutes`,
            }))}
            onValueChange={(minutes) => save({ minRefreshMinutes: Number(minutes) })}
          />
          <SettingsSwitch
            label="Interactive fallback"
            hint="With a claude setup-token token, claude -p /usage shows no plan limits. Then open /usage in an interactive Claude Code session in a pseudo-terminal (the system script command; Linux and macOS), in an empty folder of its own, and answer Claude Code's folder trust prompt for that folder."
            value={current.interactiveFallback}
            onValueChange={(interactiveFallback) => save({ interactiveFallback })}
          />
          <SettingsInput
            label="Claude Code path"
            hint="Empty: claude on the daemon's PATH, ~/.local/bin or ~/.claude/local."
            initialValue={current.claudePath}
            placeholder="claude"
            onChangeText={setClaudePath}
          />
          <SettingsAction
            label={settings.saveError ?? "Save the Claude Code path"}
            actionLabel="Save"
            disabled={!pathDirty || settings.saving}
            onPress={() => {
              save({ claudePath: (claudePath ?? "").trim() });
              setClaudePath(null);
            }}
          />
          <SettingsRow label="Status" hint={statusHint(limits.data)} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
