/**
 * Maps the helper's monitors (physical pixels, authoritative) to Electron
 * displays and to Chromium desktop-capture sources. Pure parts are exported
 * for tests; the Electron calls live in `resolveCaptureTargets`.
 */
import type { MonitorInfo } from '@remote-desktop/webrtc';
import type { NativeMonitor } from '../native/protocol';
import type { CaptureArea } from './policy';

export interface PhysicalDisplay {
  /** Electron display id. */
  id: string;
  rect: CaptureArea;
  scaleFactor: number;
}

export interface CaptureTarget {
  monitor: NativeMonitor;
  displayId: string | null;
}

/** Pairs each monitor with the Electron display at the same physical origin. */
export function matchDisplays(
  monitors: readonly NativeMonitor[],
  displays: readonly PhysicalDisplay[],
): CaptureTarget[] {
  return monitors.map((monitor) => {
    const exact = displays.find((d) => d.rect.x === monitor.x && d.rect.y === monitor.y);
    // Rounding between DIP and physical can be off by a pixel at fractional scales.
    const near =
      exact ??
      displays.find(
        (d) => Math.abs(d.rect.x - monitor.x) <= 2 && Math.abs(d.rect.y - monitor.y) <= 2,
      );
    return { monitor, displayId: near?.id ?? null };
  });
}

export function toMonitorInfo(monitor: NativeMonitor): MonitorInfo {
  return {
    id: monitor.id,
    name: monitor.name,
    primary: monitor.primary,
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
    scaleFactor: monitor.scaleFactor,
  };
}

export function areaOf(monitor: NativeMonitor): CaptureArea {
  return { x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height };
}

/** Which monitor contains a physical point (used by "follow active monitor"). */
export function monitorAt(
  monitors: readonly NativeMonitor[],
  x: number,
  y: number,
): NativeMonitor | null {
  return (
    monitors.find((m) => x >= m.x && y >= m.y && x < m.x + m.width && y < m.y + m.height) ?? null
  );
}
