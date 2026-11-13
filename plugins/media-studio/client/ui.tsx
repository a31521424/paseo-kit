import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type PressableStateCallbackType, type StyleProp, type ViewStyle } from "react-native";

// Building blocks shared by the panel, the file panel and the chat cards. Controls are quiet by
// default (no border, a soft background on hover or press) so the media stays the focus; only the
// one primary action of an area is filled. Colors come from the Paseo theme, so every theme works.

/** React Native Web adds `hovered` to the pressable state. */
function isHovered(state: PressableStateCallbackType): boolean {
  return (state as PressableStateCallbackType & { hovered?: boolean }).hovered === true;
}

export function IconButton({
  theme,
  icon,
  label,
  onPress,
  active,
  disabled,
  size = "md",
  primary,
}: {
  theme: PluginTheme;
  icon: string;
  /** Accessible name; also what screen readers announce. */
  label: string;
  onPress(): void;
  active?: boolean;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  /** The filled, round main action of a toolbar, such as Play. */
  primary?: boolean;
}) {
  const { colors } = theme;
  const box = size === "lg" ? 38 : size === "sm" ? 26 : 30;
  const glyph = size === "lg" ? 18 : size === "sm" ? 14 : 16;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      disabled={disabled}
      onPress={onPress}
      style={(state) => ({
        width: box,
        height: box,
        borderRadius: primary ? box / 2 : 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary
          ? colors.accent
          : state.pressed || isHovered(state) || active
            ? colors.surface2
            : "transparent",
        opacity: disabled ? 0.4 : state.pressed && primary ? 0.85 : 1,
      })}
    >
      <Icon name={icon} size={glyph} color={primary ? colors.accentForeground : active ? colors.accent : colors.foreground} />
    </Pressable>
  );
}

export function Button({
  theme,
  icon,
  label,
  onPress,
  disabled,
  primary,
  active,
  busy,
  compact,
  accessibilityLabel,
}: {
  theme: PluginTheme;
  icon?: string;
  label?: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  active?: boolean;
  busy?: boolean;
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  const { colors } = theme;
  const foreground = primary ? colors.accentForeground : active ? colors.accent : colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      disabled={disabled || busy}
      onPress={onPress}
      style={(state) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: compact ? 26 : 30,
        paddingHorizontal: label ? (compact ? 9 : 12) : compact ? 5 : 7,
        borderRadius: 7,
        backgroundColor: primary ? colors.accent : state.pressed || isHovered(state) || active ? colors.surface2 : colors.surface1,
        opacity: disabled ? 0.45 : state.pressed && primary ? 0.85 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon ? (
        <Icon name={icon} size={compact ? 14 : 15} color={foreground} />
      ) : null}
      {label ? (
        <Text numberOfLines={1} style={{ color: foreground, fontSize: compact ? 12 : 13, fontWeight: "500" }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A quiet text toggle for toolbars: speed, quality. */
export function TextToggle({ theme, label, onPress, accessibilityLabel, active }: { theme: PluginTheme; label: string; onPress(): void; accessibilityLabel: string; active?: boolean }) {
  const { colors } = theme;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={(state) => ({
        height: 30,
        minWidth: 30,
        paddingHorizontal: 8,
        borderRadius: 7,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: state.pressed || isHovered(state) ? colors.surface2 : "transparent",
      })}
    >
      <Text style={{ color: active ? colors.accent : colors.foreground, fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{label}</Text>
    </Pressable>
  );
}

/** Visually joins related controls on a soft surface. */
export function Group({ theme, children, style }: { theme: PluginTheme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 2, padding: 2, borderRadius: 9, backgroundColor: theme.colors.surface1 }, style]}>
      {children}
    </View>
  );
}

/** A pill: a filter, a toggle, or a piece of context with an optional action. */
export function Chip({
  theme,
  label,
  icon,
  active,
  onPress,
  count,
  trailingIcon,
  accessibilityLabel,
  mono,
  dense,
}: {
  theme: PluginTheme;
  label: string;
  icon?: string;
  active?: boolean;
  onPress?: () => void;
  count?: number;
  trailingIcon?: string;
  accessibilityLabel?: string;
  mono?: boolean;
  /** Tighter padding, for a row of filters in a narrow column. */
  dense?: boolean;
}) {
  const { colors } = theme;
  const color = active ? colors.foreground : colors.foregroundMuted;
  const content = (state?: PressableStateCallbackType) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: dense ? 4 : 5,
    height: 26,
    paddingHorizontal: dense ? 7 : 10,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: active ? colors.border : "transparent",
    backgroundColor: active ? colors.surface2 : state && (state.pressed || isHovered(state)) ? colors.surface1 : "transparent",
    maxWidth: "100%" as const,
    minWidth: 0,
  });
  const inner = (
    <>
      {icon ? <Icon name={icon} size={13} color={active ? colors.accent : colors.foregroundMuted} /> : null}
      <Text numberOfLines={1} style={{ color, fontSize: 12, fontWeight: active ? "600" : "500", flexShrink: 1, fontVariant: mono ? ["tabular-nums"] : undefined }}>
        {label}
      </Text>
      {count !== undefined ? <Text style={{ color: colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{count}</Text> : null}
      {trailingIcon ? <Icon name={trailingIcon} size={12} color={colors.foregroundMuted} /> : null}
    </>
  );
  if (!onPress) return <View style={content()}>{inner}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label} accessibilityState={{ selected: !!active }} onPress={onPress} style={(state) => content(state)}>
      {inner}
    </Pressable>
  );
}

export function Segmented<Value extends string>({
  theme,
  value,
  options,
  onChange,
}: {
  theme: PluginTheme;
  value: Value;
  options: readonly { value: Value; label: string; icon?: string }[];
  onChange(value: Value): void;
}) {
  const { colors } = theme;
  return (
    <View style={{ flexDirection: "row", padding: 2, gap: 2, borderRadius: 9, backgroundColor: colors.surface1 }}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={(state) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 10,
              height: 26,
              borderRadius: 7,
              backgroundColor: selected ? colors.surface0 : isHovered(state) ? colors.surface2 : "transparent",
              borderWidth: 1,
              borderColor: selected ? colors.border : "transparent",
            })}
          >
            {option.icon ? <Icon name={option.icon} size={13} color={selected ? colors.foreground : colors.foregroundMuted} /> : null}
            <Text style={{ color: selected ? colors.foreground : colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "600" : "500" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ theme, label, tone = "muted" }: { theme: PluginTheme; label: string; tone?: "muted" | "accent" | "warning" }) {
  const { colors } = theme;
  const color = tone === "accent" ? colors.accent : tone === "warning" ? colors.statusWarning : colors.foregroundMuted;
  return (
    <View style={{ paddingHorizontal: 6, height: 18, justifyContent: "center", borderRadius: 5, backgroundColor: colors.surface2 }}>
      <Text numberOfLines={1} style={{ color, fontSize: 10, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}

/** A key cap for shortcut hints. */
export function Kbd({ theme, children }: { theme: PluginTheme; children: string }) {
  const { colors } = theme;
  return (
    <View style={{ minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 5, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

export function ProgressBar({ theme, value, tone }: { theme: PluginTheme; value: number; tone?: "accent" | "danger" | "success" | "warning" }) {
  const { colors } = theme;
  const color = tone === "danger" ? colors.statusDanger : tone === "success" ? colors.statusSuccess : tone === "warning" ? colors.statusWarning : colors.accent;
  return (
    <View style={{ height: 3, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: 3, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

export function Message({
  theme,
  icon,
  text,
  loading,
  tone,
  children,
  style,
}: {
  theme: PluginTheme;
  icon?: string;
  text: string;
  loading?: boolean;
  tone?: "danger" | "muted";
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const color = tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={[{ alignItems: "center", justifyContent: "center", gap: 10, padding: 20 }, style]}>
      {loading ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : icon ? <Icon name={icon} size={22} color={color} /> : null}
      {text ? <Text style={{ color, fontSize: 13, textAlign: "center" }}>{text}</Text> : null}
      {children}
    </View>
  );
}

/** Removes the browser's focus outline from a text field that draws its own frame (web only). */
export const NO_OUTLINE = { outlineWidth: 0, outlineStyle: "none" } as unknown as Record<string, never>;

export function kindIcon(kind: string): string {
  if (kind === "video") return "Film";
  if (kind === "audio") return "AudioLines";
  if (kind === "image") return "Image";
  if (kind === "directory") return "Folder";
  return "File";
}

/** "3 min ago", "yesterday", or a date; short enough for a list row. */
export function timeAgo(iso: string, locale: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.round((then - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(seconds);
  if (abs < 60) return format.format(seconds, "second");
  if (abs < 3600) return format.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(seconds / 3600), "hour");
  if (abs < 7 * 86_400) return format.format(Math.round(seconds / 86_400), "day");
  return new Date(then).toLocaleDateString(locale);
}
