import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { ScrollView, Text } from "react-native";
import {
  displaySettings,
  hiddenMetrics,
  METRICS,
  withMetricShown,
  type MetricKey,
} from "../shared/settings";

const LABELS: Record<MetricKey, string> = {
  cpu: "CPU usage",
  cpuTemp: "CPU temperature",
  memory: "RAM",
  disk: "Disk",
  network: "Network speed",
  gpu: "GPU usage",
  gpuTemp: "GPU temperature",
  vram: "VRAM",
  gpuPower: "GPU power",
};

// A host that cannot report a figure leaves it out of the line, whatever the switch says.
const HINTS: Partial<Record<MetricKey, string>> = {
  cpuTemp: "Linux hosts with a CPU sensor",
  gpu: "NVIDIA only",
  gpuTemp: "NVIDIA only",
  vram: "NVIDIA only",
  gpuPower: "NVIDIA only",
};

/** The metrics the sidebar line shows for this host on this device. */
export function DisplaySettings({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Sidebar">
        <SettingsCard>
          <SettingsAction
            label="The saved display settings cannot be read"
            hint={settings.error}
            actionLabel="Reset"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, revision } = settings;
  const hidden = hiddenMetrics(values, host.id);
  const setShown = (metric: MetricKey, shown: boolean) => {
    void settings.save(withMetricShown(values, host.id, metric, shown), revision);
  };
  return (
    <SettingsSection title={`Sidebar line for ${host.label}`}>
      <SettingsCard>
        {METRICS.map((metric) => (
          <SettingsSwitch
            key={metric}
            label={LABELS[metric]}
            hint={HINTS[metric]}
            value={!hidden.includes(metric)}
            disabled={settings.saving}
            onValueChange={(shown) => setShown(metric, shown)}
          />
        ))}
      </SettingsCard>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 8 }}>
        Applies to this device, while the sidebar shows this host. With every metric off, the line
        disappears for this host. Other hosts have their own settings.
      </Text>
      {settings.saveError ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12, marginTop: 4 }}>
          {settings.saveError}
        </Text>
      ) : null}
    </SettingsSection>
  );
}

/**
 * The same settings as a plugin screen, which the popover opens with `openScreen`: unlike
 * `openSettings`, that closes the sidebar drawer on a phone first.
 */
export function DisplayScreen(props: PluginScreenProps) {
  const { theme, layout } = props;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24 }}
    >
      <DisplaySettings {...props} />
    </ScrollView>
  );
}
