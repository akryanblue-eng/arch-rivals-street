// Timing ghost overlay (TechSpec 1.3) — pure state machine, no rendering.
//
// On a Timing_Early or Timing_Late failure only: show the player's input
// position against the ideal window, hold for exactly 1.0s, fade over 0.2s,
// and never remain visible during an active retry. The host renderer polls
// getState(nowMs) each frame and draws whatever this returns; all timing
// decisions live here so they are testable to the millisecond.

import {
  GHOST_OVERLAY_FADE_MS,
  GHOST_OVERLAY_HOLD_MS,
  LIVE_EXECUTION_WINDOW_MS,
  TIMING_CALLOUT_DURATION_MS,
  TIMING_CALLOUT_FONT_PT,
} from "../NealSpinCalibration";

export type TimingFailureKind = "Fail_Timing_Early" | "Fail_Timing_Late";

export const TIMING_CALLOUTS: Record<TimingFailureKind, string> = {
  Fail_Timing_Early: "Too eager.",
  Fail_Timing_Late: "Missed the beat.",
};

export interface GhostOverlayState {
  phase: "hidden" | "holding" | "fading";
  opacity: number; // 1 while holding, 1→0 across the fade
  kind: TimingFailureKind | null;
  // Normalized positions along the window bar for the comparison render:
  // the perfect window's center is 0.5; the player's marker lands left of
  // the bar for early input and right of it for late, clamped to [0, 1].
  perfectMarkerPos: number;
  playerMarkerPos: number;
  // Callout text renders inside the Magic Circle for 0.8s (TechSpec 1.3),
  // shorter than the overlay's own 1.0s hold.
  calloutText: string | null;
  calloutVisible: boolean;
  calloutFontPt: number;
}

const HIDDEN: GhostOverlayState = {
  phase: "hidden",
  opacity: 0,
  kind: null,
  perfectMarkerPos: 0.5,
  playerMarkerPos: 0.5,
  calloutText: null,
  calloutVisible: false,
  calloutFontPt: TIMING_CALLOUT_FONT_PT,
};

export class TimingGhostOverlay {
  private shownAtMs: number | null = null;
  private kind: TimingFailureKind | null = null;
  private playerMarkerPos = 0.5;

  // Only timing failures may summon the ghost. Passing any other class is a
  // programming error upstream; the overlay refuses rather than rendering a
  // misleading diagnostic.
  show(kind: TimingFailureKind, timingOffsetMs: number, nowMs: number): void {
    this.kind = kind;
    this.shownAtMs = nowMs;
    // Map the signed offset onto the bar: an input a full window-length
    // early sits at 0, in-window center at 0.5, a full window-length late
    // at 1. Clamped so extreme offsets still render on the bar.
    const normalized = 0.5 + timingOffsetMs / (2 * LIVE_EXECUTION_WINDOW_MS);
    this.playerMarkerPos = Math.max(0, Math.min(1, normalized));
  }

  // The active retry must never show a stale ghost: hide immediately.
  notifyRetryStarted(): void {
    this.shownAtMs = null;
    this.kind = null;
  }

  getState(nowMs: number): GhostOverlayState {
    if (this.shownAtMs === null || this.kind === null) return HIDDEN;
    const elapsed = nowMs - this.shownAtMs;

    if (elapsed >= GHOST_OVERLAY_HOLD_MS + GHOST_OVERLAY_FADE_MS) {
      this.shownAtMs = null;
      this.kind = null;
      return HIDDEN;
    }

    const fading = elapsed >= GHOST_OVERLAY_HOLD_MS;
    return {
      phase: fading ? "fading" : "holding",
      opacity: fading ? 1 - (elapsed - GHOST_OVERLAY_HOLD_MS) / GHOST_OVERLAY_FADE_MS : 1,
      kind: this.kind,
      perfectMarkerPos: 0.5,
      playerMarkerPos: this.playerMarkerPos,
      calloutText: TIMING_CALLOUTS[this.kind],
      calloutVisible: elapsed < TIMING_CALLOUT_DURATION_MS,
      calloutFontPt: TIMING_CALLOUT_FONT_PT,
    };
  }
}
