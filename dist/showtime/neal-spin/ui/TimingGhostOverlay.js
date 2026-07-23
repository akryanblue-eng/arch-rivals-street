"use strict";
// Timing ghost overlay (TechSpec 1.3) — pure state machine, no rendering.
//
// On a Timing_Early or Timing_Late failure only: show the player's input
// position against the ideal window, hold for exactly 1.0s, fade over 0.2s,
// and never remain visible during an active retry. The host renderer polls
// getState(nowMs) each frame and draws whatever this returns; all timing
// decisions live here so they are testable to the millisecond.
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimingGhostOverlay = exports.TIMING_CALLOUTS = void 0;
const NealSpinCalibration_1 = require("../NealSpinCalibration");
exports.TIMING_CALLOUTS = {
    Fail_Timing_Early: "Too eager.",
    Fail_Timing_Late: "Missed the beat.",
};
const HIDDEN = {
    phase: "hidden",
    opacity: 0,
    kind: null,
    perfectMarkerPos: 0.5,
    playerMarkerPos: 0.5,
    calloutText: null,
    calloutVisible: false,
    calloutFontPt: NealSpinCalibration_1.TIMING_CALLOUT_FONT_PT,
};
class TimingGhostOverlay {
    constructor() {
        this.shownAtMs = null;
        this.kind = null;
        this.playerMarkerPos = 0.5;
    }
    // Only timing failures may summon the ghost. Passing any other class is a
    // programming error upstream; the overlay refuses rather than rendering a
    // misleading diagnostic.
    show(kind, timingOffsetMs, nowMs) {
        this.kind = kind;
        this.shownAtMs = nowMs;
        // Map the signed offset onto the bar: an input a full window-length
        // early sits at 0, in-window center at 0.5, a full window-length late
        // at 1. Clamped so extreme offsets still render on the bar.
        const normalized = 0.5 + timingOffsetMs / (2 * NealSpinCalibration_1.LIVE_EXECUTION_WINDOW_MS);
        this.playerMarkerPos = Math.max(0, Math.min(1, normalized));
    }
    // The active retry must never show a stale ghost: hide immediately.
    notifyRetryStarted() {
        this.shownAtMs = null;
        this.kind = null;
    }
    getState(nowMs) {
        if (this.shownAtMs === null || this.kind === null)
            return HIDDEN;
        const elapsed = nowMs - this.shownAtMs;
        if (elapsed >= NealSpinCalibration_1.GHOST_OVERLAY_HOLD_MS + NealSpinCalibration_1.GHOST_OVERLAY_FADE_MS) {
            this.shownAtMs = null;
            this.kind = null;
            return HIDDEN;
        }
        const fading = elapsed >= NealSpinCalibration_1.GHOST_OVERLAY_HOLD_MS;
        return {
            phase: fading ? "fading" : "holding",
            opacity: fading ? 1 - (elapsed - NealSpinCalibration_1.GHOST_OVERLAY_HOLD_MS) / NealSpinCalibration_1.GHOST_OVERLAY_FADE_MS : 1,
            kind: this.kind,
            perfectMarkerPos: 0.5,
            playerMarkerPos: this.playerMarkerPos,
            calloutText: exports.TIMING_CALLOUTS[this.kind],
            calloutVisible: elapsed < NealSpinCalibration_1.TIMING_CALLOUT_DURATION_MS,
            calloutFontPt: NealSpinCalibration_1.TIMING_CALLOUT_FONT_PT,
        };
    }
}
exports.TimingGhostOverlay = TimingGhostOverlay;
