const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** "5K", "1.2M": no unit suffix, for tight spaces like the sidebar. */
export function formatCompactRate(bytesPerSec: number): string {
  // Never more than four characters, so it fits the sidebar's fixed slot. Thresholds sit below
  // the rounding points: 9.96 would print as "10.0", 999.6 as "1000".
  if (bytesPerSec < 999.5) return `${Math.round(Math.max(bytesPerSec, 0))}`;
  let value = bytesPerSec / 1024;
  for (const unit of ["K", "M", "G"]) {
    if (value < 9.95) return `${value.toFixed(1)}${unit}`;
    if (value < 999.5 || unit === "G") return `${Math.round(value)}${unit}`;
    value /= 1024;
  }
  return "";
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "0%", "0.4%", "37%": one decimal below 10, so a nearly idle host does not read as zero. */
export function formatPercent(percent: number): string {
  const value = Math.min(Math.max(percent, 0), 100);
  if (value < 0.05) return "0%";
  // 9.95 and up would print as "10.0"; keep the text within the "100%" slot.
  if (value < 9.95) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}
