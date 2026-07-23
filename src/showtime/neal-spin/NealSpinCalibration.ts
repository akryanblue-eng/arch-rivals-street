// Neal Spin calibration surface — every tunable lives here by name.
// No magic numbers are buried in the parser, classifier, controller, or UI:
// they all read from this module, so a calibration pass touches one file.
//
// Two kinds of value coexist here and must not be confused:
//   1. SPECIFICATION values — fixed by ArchRivals Showtime TechSpec v1.0
//      (Section 1). Changing these is a spec change, not a tuning pass.
//   2. CALIBRATION values — placeholders the TechSpec explicitly refuses to
//      guess (Section 5). These are represented as explicit uncalibrated
//      states, never as hardcoded numbers.

import { BuildMode, VelocityFloorBySource, VelocityFloorState } from "./NealSpinTypes";

// --- Specification values (TechSpec Section 1) -----------------------------

// Minimum effective rotation for a valid path. Over-rotation past 360° is
// accepted without penalty — there is deliberately no upper bound.
export const MIN_EFFECTIVE_ROTATION_DEG = 270;

// A single direction must own at least this fraction of moving segments,
// otherwise the attempt is directionally ambiguous.
export const DOMINANT_DIRECTION_MIN_RATIO = 0.6;

// Pauses up to and INCLUDING this duration are bridged; anything strictly
// greater breaks continuity. (Acceptance: exactly 250ms remains bridged.)
export const PAUSE_BRIDGE_MAX_MS = 250;

// Reversals up to and INCLUDING this many degrees are tolerated; anything
// strictly greater is a path failure. (Acceptance: exactly 30° tolerated.)
export const BACKTRACK_TOLERANCE_DEG = 30;

// Hesitation: motion has started, then stops for STRICTLY MORE than this,
// before coverage reaches HESITATION_MAX_COVERAGE_DEG.
export const HESITATION_STOP_MS = 500;
export const HESITATION_MAX_COVERAGE_DEG = 90;

// Abandonment: menu exit at any point, or strictly more than this much idle
// time following a failure.
export const ABANDONMENT_IDLE_MS = 8000;

// The animation state machine's live execution window.
export const LIVE_EXECUTION_WINDOW_MS = 600;

// Timing ghost overlay (TechSpec 1.3): hold exactly 1.0s, fade over 0.2s.
export const GHOST_OVERLAY_HOLD_MS = 1000;
export const GHOST_OVERLAY_FADE_MS = 200;

// Callout text rendered inside the Magic Circle (TechSpec 1.3 / 2.3).
export const TIMING_CALLOUT_DURATION_MS = 800;
export const TIMING_CALLOUT_FONT_PT = 28;
export const HESITATION_PROMPT_DURATION_MS = 800;
export const HESITATION_PROMPT_FADE_MS = 200;
export const HESITATION_PROMPT_FONT_PT = 32;
export const HESITATION_PROMPT_OPACITY = 0.7;

// Hesitation prompts fire at most this many times per session (TechSpec 2.3:
// "Do not fire a third."). The motion-triggered recovery line is not counted
// against this cap — it is a response to re-engagement, not a prompt.
export const HESITATION_PROMPT_SESSION_CAP = 2;

// A segment counts as "moving" only above this angular delta, so sensor
// jitter on a resting finger does not register as rotation. Named here
// rather than buried in the parser; it is measurement hygiene, not feel.
export const MOTION_EPSILON_DEG = 0.5;

// --- Calibration values (TechSpec Section 5 — placeholders, not guesses) ---

// Stage 1→2 scaffold transition: PROVISIONAL. Initial experimental value of
// 3 consecutive successes per the TechSpec; the final value must come from
// Stage 2a SCR telemetry. Nothing in this slice consumes it yet — it is
// declared so the number has exactly one, clearly-labeled home.
export const PROVISIONAL_STAGE_1_TO_2_CONSECUTIVE_SUCCESSES = 3;

// The velocity floor ships uncalibrated. Touch and controller are separate
// distributions and stay separate. Production builds fail closed on an
// uncalibrated floor (see NealSpinClassifier); calibration builds collect
// velocity data without gating on it.
export function uncalibratedVelocityFloors(): VelocityFloorBySource {
  return {
    touch: { status: "uncalibrated" },
    controller: { status: "uncalibrated" },
  };
}

// Sets a floor from observed successful completions for ONE input source:
// the 10th percentile (nearest-rank) of successful completion velocities.
// Per the TechSpec, the initial floor comes from touch data; controller
// input is then validated separately against its own distribution — which
// is why this function takes one source's samples and the caller assigns
// the result to one source's slot.
export function computeVelocityFloorFromSuccesses(
  successfulVelocitiesDegPerSec: number[],
): VelocityFloorState {
  if (successfulVelocitiesDegPerSec.length === 0) {
    return { status: "uncalibrated" };
  }
  const sorted = [...successfulVelocitiesDegPerSec].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(0.1 * sorted.length));
  return { status: "calibrated", floorDegPerSec: sorted[rank - 1] };
}

// The complete calibration bundle threaded through parser, classifier and
// controller. Constructed once per boot; tests construct their own.
export interface NealSpinConfig {
  buildMode: BuildMode;
  velocityFloor: VelocityFloorBySource;
  minEffectiveRotationDeg: number;
  dominantDirectionMinRatio: number;
  pauseBridgeMaxMs: number;
  backtrackToleranceDeg: number;
  hesitationStopMs: number;
  hesitationMaxCoverageDeg: number;
  abandonmentIdleMs: number;
  motionEpsilonDeg: number;
}

export function defaultConfig(buildMode: BuildMode): NealSpinConfig {
  return {
    buildMode,
    velocityFloor: uncalibratedVelocityFloors(),
    minEffectiveRotationDeg: MIN_EFFECTIVE_ROTATION_DEG,
    dominantDirectionMinRatio: DOMINANT_DIRECTION_MIN_RATIO,
    pauseBridgeMaxMs: PAUSE_BRIDGE_MAX_MS,
    backtrackToleranceDeg: BACKTRACK_TOLERANCE_DEG,
    hesitationStopMs: HESITATION_STOP_MS,
    hesitationMaxCoverageDeg: HESITATION_MAX_COVERAGE_DEG,
    abandonmentIdleMs: ABANDONMENT_IDLE_MS,
    motionEpsilonDeg: MOTION_EPSILON_DEG,
  };
}

// An uncalibrated production build is a CONFIGURATION defect, and it fails
// here — at initialization, against the build — never against the player.
// (Gate review on ARS-NEAL-001: without this check, fail-closed classification
// silently turned every valid production spin into Fail_Dexterity_Speed. The
// classifier retains that fail-closed branch purely as defense in depth for
// callers that bypass the controller; through the controller it is
// unreachable, because construction refuses first.)
export class NealSpinConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NealSpinConfigurationError";
  }
}

export function assertConfigLaunchable(config: NealSpinConfig): void {
  if (config.buildMode !== "production") return;
  const uncalibrated = (Object.keys(config.velocityFloor) as Array<
    keyof VelocityFloorBySource
  >).filter((source) => config.velocityFloor[source].status === "uncalibrated");
  if (uncalibrated.length > 0) {
    throw new NealSpinConfigurationError(
      `production build requires calibrated velocity floors; uncalibrated: ${uncalibrated.join(", ")}. ` +
        "Set them from playtest data (computeVelocityFloorFromSuccesses) or ship a calibration build.",
    );
  }
}
