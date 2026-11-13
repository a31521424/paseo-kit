import type { PluginTheme } from "@getpaseo/plugin";
import { memo, useMemo, useRef, useState } from "react";
import { Image, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from "react-native";
import { formatDuration, formatTimecode } from "../shared/media";

export interface FilmFrame {
  time: number;
  uri: string;
}

export interface TimelineProps {
  theme: PluginTheme;
  duration: number;
  fps: number | null;
  time: number;
  inPoint: number | null;
  outPoint: number | null;
  buffered: readonly [number, number][];
  frames: readonly FilmFrame[] | undefined;
  peaks: readonly number[] | undefined;
  /** Review notes to mark: a point, or a range when `end` is set. */
  markers?: readonly { time: number; end: number | null }[];
  compact?: boolean;
  /** The frame at the hovered time, when the parent has fetched it. */
  hoverUri?: string | null;
  onSeek(time: number): void;
  /** Dragging along the timeline: the time under the finger, then null on release. */
  onScrub?(time: number | null): void;
  /** Pointer hovering on the web: the time under it, or null when it leaves. */
  onHover?(time: number | null): void;
}

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** The ruler: ticks every few seconds with labels, spaced at least 80 px apart. */
const Ruler = memo(function Ruler({ theme, width, duration, height }: { theme: PluginTheme; width: number; duration: number; height: number }) {
  const step = TICK_STEPS.find((candidate) => (candidate / duration) * width >= 80) ?? 3600;
  const ticks: number[] = [];
  for (let tick = 0; tick <= duration + 1e-6 && ticks.length < 200; tick += step) ticks.push(tick);
  const minor = step / 5;
  const minorTicks: number[] = [];
  if ((minor / duration) * width >= 8) for (let tick = minor; tick < duration && minorTicks.length < 1000; tick += minor) minorTicks.push(tick);
  return (
    <View style={{ height, position: "relative" }} pointerEvents="none">
      {minorTicks.map((tick) => (
        <View key={`m${tick}`} style={{ position: "absolute", left: (tick / duration) * width, bottom: 0, width: 1, height: 3, backgroundColor: theme.colors.border }} />
      ))}
      {ticks.map((tick) => {
        const left = (tick / duration) * width;
        return (
          <View key={tick} style={{ position: "absolute", left, top: 0, bottom: 0, justifyContent: "flex-end" }}>
            {left < width - 30 ? (
              <Text style={{ position: "absolute", top: 0, left: 4, color: theme.colors.foregroundMuted, fontSize: 9, fontVariant: ["tabular-nums"] }}>
                {formatDuration(tick)}
              </Text>
            ) : null}
            <View style={{ width: 1, height: 6, backgroundColor: theme.colors.foregroundMuted, opacity: 0.6 }} />
          </View>
        );
      })}
    </View>
  );
});

const Filmstrip = memo(function Filmstrip({ theme, width, frames, height }: { theme: PluginTheme; width: number; frames: readonly FilmFrame[] | undefined; height: number }) {
  if (!frames || frames.length === 0) {
    return <View style={{ height, backgroundColor: theme.colors.surface2, borderRadius: 5 }} />;
  }
  const slot = width / frames.length;
  return (
    <View style={{ height, flexDirection: "row", overflow: "hidden", borderRadius: 5, backgroundColor: "#000" }} pointerEvents="none">
      {frames.map((frame) => (
        <Image key={frame.time} source={{ uri: frame.uri }} resizeMode="cover" style={{ width: slot, height }} />
      ))}
    </View>
  );
});

/** Bars of the waveform in one color; drawn twice, the played copy clipped to the playhead. */
const WaveBars = memo(function WaveBars({ bars, width, height, color }: { bars: readonly number[]; width: number; height: number; color: string }) {
  const barWidth = width / Math.max(1, bars.length);
  return (
    <View style={{ width, height, flexDirection: "row", alignItems: "center" }} pointerEvents="none">
      {bars.map((peak, index) => (
        <View
          key={index}
          style={{
            width: Math.max(1, barWidth - (barWidth > 2.5 ? 1 : 0)),
            marginRight: barWidth > 2.5 ? 1 : 0,
            height: Math.max(2, (peak / 100) * height * 0.92),
            backgroundColor: color,
            borderRadius: 1,
          }}
        />
      ))}
    </View>
  );
});

function useBars(peaks: readonly number[] | undefined, width: number): number[] {
  return useMemo(() => {
    if (!peaks || peaks.length === 0 || width <= 0) return [];
    const count = Math.max(8, Math.min(peaks.length, Math.floor(width / 3)));
    const result: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const from = Math.floor((index * peaks.length) / count);
      const to = Math.max(from + 1, Math.floor(((index + 1) * peaks.length) / count));
      let peak = 0;
      for (let cursor = from; cursor < to; cursor += 1) peak = Math.max(peak, peaks[cursor] ?? 0);
      result.push(peak);
    }
    return result;
  }, [peaks, width]);
}

export function Timeline(props: TimelineProps) {
  const { theme, duration, fps, time, inPoint, outPoint, buffered, frames, peaks, compact, hoverUri, markers } = props;
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const widthRef = useRef(0);
  const { colors } = theme;
  const bars = useBars(peaks, width);

  const rulerHeight = compact ? 0 : 18;
  const hasVideoLane = frames !== undefined;
  const stripHeight = hasVideoLane ? (compact ? 32 : 48) : 0;
  const waveHeight = peaks === undefined ? 0 : compact ? (hasVideoLane ? 20 : 36) : hasVideoLane ? 32 : 64;
  const gap = 4;
  const lanesTop = rulerHeight;
  const height = rulerHeight + stripHeight + (hasVideoLane && peaks !== undefined ? gap : 0) + waveHeight;
  const waveTop = lanesTop + stripHeight + (hasVideoLane ? gap : 0);

  const safeDuration = duration > 0 ? duration : 1;
  const x = (seconds: number) => (Math.max(0, Math.min(seconds, safeDuration)) / safeDuration) * width;
  const timeAt = (offsetX: number) => Math.max(0, Math.min(1, offsetX / Math.max(1, widthRef.current))) * safeDuration;

  const onLayout = (event: LayoutChangeEvent) => {
    widthRef.current = event.nativeEvent.layout.width;
    setWidth(event.nativeEvent.layout.width);
  };

  const fromEvent = (event: GestureResponderEvent) => timeAt(event.nativeEvent.locationX);
  const shown = drag ?? time;
  const marker = hover ?? drag;
  const thumbWidth = (stripHeight * 16) / 9;

  return (
    <View onLayout={onLayout} style={{ height: height + 2, position: "relative" }}>
      {width > 0 ? (
        <>
          {rulerHeight > 0 ? <Ruler theme={theme} width={width} duration={safeDuration} height={rulerHeight} /> : null}
          {hasVideoLane ? <Filmstrip theme={theme} width={width} frames={frames} height={stripHeight} /> : null}
          {peaks !== undefined ? (
            <View style={{ position: "absolute", left: 0, top: waveTop, width, height: waveHeight, borderRadius: 5, backgroundColor: colors.surface1, overflow: "hidden" }} pointerEvents="none">
              <WaveBars bars={bars} width={width} height={waveHeight} color={colors.foregroundMuted} />
              <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: x(shown), overflow: "hidden" }}>
                <WaveBars bars={bars} width={width} height={waveHeight} color={colors.accent} />
              </View>
            </View>
          ) : null}

          {/* What is buffered, as a hairline above the lanes. */}
          <View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: Math.max(0, lanesTop - 2), height: 2 }}>
            {buffered.map(([start, end]) => (
              <View
                key={`${start}`}
                style={{ position: "absolute", left: x(start), width: Math.max(1, x(end) - x(start)), height: 2, borderRadius: 1, backgroundColor: colors.foregroundMuted, opacity: 0.35 }}
              />
            ))}
          </View>

          {inPoint !== null || outPoint !== null ? (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: lanesTop,
                height: height - lanesTop,
                left: x(inPoint ?? 0),
                width: Math.max(2, x(outPoint ?? safeDuration) - x(inPoint ?? 0)),
                borderRadius: 4,
                borderWidth: 2,
                borderColor: colors.accent,
                borderLeftWidth: inPoint !== null ? 3 : 0,
                borderRightWidth: outPoint !== null ? 3 : 0,
              }}
            >
              <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.accent, opacity: 0.12 }} />
            </View>
          ) : null}

          {(markers ?? []).map((note, index) =>
            note.end !== null ? (
              <View key={`n${index}`} pointerEvents="none" style={{ position: "absolute", top: Math.max(0, lanesTop - 7), height: height - Math.max(0, lanesTop - 7), left: x(note.time), width: Math.max(4, x(note.end) - x(note.time)) }}>
                {/* A bar along the ruler, and a light wash over the lanes, so a commented range reads at a glance. */}
                <View style={{ height: 5, borderRadius: 3, backgroundColor: colors.statusWarning }} />
                <View style={{ flex: 1, marginTop: 2, backgroundColor: colors.statusWarning, opacity: 0.12, borderRadius: 3 }} />
              </View>
            ) : (
              <View key={`n${index}`} pointerEvents="none" style={{ position: "absolute", top: lanesTop, left: x(note.time) - 4, alignItems: "center" }}>
                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.statusWarning, borderWidth: 1.5, borderColor: colors.surface0 }} />
                <View style={{ width: 2, height: Math.max(0, height - lanesTop - 8), backgroundColor: colors.statusWarning, opacity: 0.55 }} />
              </View>
            ),
          )}

          {marker !== null ? (
            <>
              <View pointerEvents="none" style={{ position: "absolute", top: lanesTop, height: height - lanesTop, left: x(marker), width: 1, backgroundColor: colors.foreground, opacity: 0.5 }} />
              {hasVideoLane && hoverUri && hover !== null ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: lanesTop,
                    height: stripHeight,
                    width: thumbWidth,
                    left: Math.max(0, Math.min(width - thumbWidth, x(marker) - thumbWidth / 2)),
                    borderWidth: 2,
                    borderColor: colors.foreground,
                    borderRadius: 5,
                    overflow: "hidden",
                    backgroundColor: "#000",
                  }}
                >
                  <Image source={{ uri: hoverUri }} resizeMode="cover" style={{ width: "100%", height: "100%" }} />
                </View>
              ) : null}
              {rulerHeight > 0 ? (
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    top: 0,
                    height: rulerHeight - 2,
                    left: Math.max(0, Math.min(width - 86, x(marker) - 43)),
                    width: 86,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 4,
                    backgroundColor: colors.foreground,
                  }}
                >
                  <Text style={{ color: colors.surface0, fontSize: 10, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{formatTimecode(marker, fps)}</Text>
                </View>
              ) : null}
            </>
          ) : null}

          {/* Playhead: a line through the lanes with a knob on top. */}
          <View pointerEvents="none" style={{ position: "absolute", top: Math.max(0, lanesTop - 4), height: height - lanesTop + 6, left: x(shown) - 1, width: 2, borderRadius: 1, backgroundColor: colors.accent }} />
          <View pointerEvents="none" style={{ position: "absolute", top: Math.max(0, lanesTop - 7), left: x(shown) - 5, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.surface0 }} />

          {/* Takes every touch and pointer event, so locationX is always relative to the whole timeline. */}
          <View
            style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={(event) => {
              const at = fromEvent(event);
              setDrag(at);
              props.onScrub?.(at);
            }}
            onResponderMove={(event) => {
              const at = fromEvent(event);
              setDrag(at);
              props.onScrub?.(at);
            }}
            onResponderRelease={(event) => {
              const at = fromEvent(event);
              setDrag(null);
              props.onScrub?.(null);
              props.onSeek(at);
            }}
            onResponderTerminate={() => {
              setDrag(null);
              props.onScrub?.(null);
            }}
            {...({
              onPointerMove: (event: { nativeEvent: { offsetX?: number; locationX?: number } }) => {
                const offset = event.nativeEvent.offsetX ?? event.nativeEvent.locationX;
                if (offset === undefined) return;
                const at = timeAt(offset);
                setHover(at);
                props.onHover?.(at);
              },
              onPointerLeave: () => {
                setHover(null);
                props.onHover?.(null);
              },
            } as object)}
          />
        </>
      ) : null}
    </View>
  );
}
