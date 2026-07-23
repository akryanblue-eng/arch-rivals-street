// Neal Spin diagnostic core — shared types.
//
// Implements ARS-NEAL-001 against the ArchRivals Showtime TechSpec v1.0
// (Sections 1 and 4). The architectural shift: the parser detects rotational
// INTENT across independent raw dimensions; a separate classifier maps those
// dimensions onto exactly one terminal result per attempt. There is no
// generic NealSpin_Fail anywhere in this taxonomy, by design.

export type InputMethod = "touch" | "controller";

export type RotationDirection = "cw" | "ccw" | "ambiguous";

// One recorded input sample. Positions are screen-space; the parser converts
// to angles around the Magic Circle center supplied with the trace. tMs is
// milliseconds on the same monotonic clock as the animation window bounds.
export interface AttemptSample {
  tMs: number;
  x: number;
  y: number;
}

// A complete recorded attempt, as captured from touch or controller input.
export interface NealSpinAttemptTrace {
  inputMethod: InputMethod;
  center: { x: number; y: number };
  samples: AttemptSample[];
  // Animation state machine's live spin window (TechSpec 1.2): input
  // registered before windowOpenMs is Timing_Early, after windowCloseMs is
  // Timing_Late. Normally windowCloseMs - windowOpenMs === LIVE_EXECUTION_WINDOW_MS.
  windowOpenMs: number;
  windowCloseMs: number;
}

// Raw hesitation observations (TechSpec 1.2: motion begins, stops for
// >500ms before 90° coverage). resumedAfterStop distinguishes a recovered
// hesitation — which per TechSpec 2.3 can still end in Success and emits
// Event_Hesitation_Recovery_Outcome — from an attempt that died in the stop.
export interface HesitationObservation {
  occurred: boolean;
  stopDurationMs: number;
  coverageAtStopDeg: number;
  resumedAfterStop: boolean;
}

// The parser's full multidimensional snapshot of one attempt. Every field is
// a RAW measurement (degrees, milliseconds, ratios) — never a normalized or
// pre-judged score — because these values feed calibration (TechSpec 4.1,
// Event_Input_Intent_Score) and normalizing at the source would make later
// tuning guesswork.
export interface IntentDimensions {
  arcCoverageDeg: number; // cumulative rotation in the dominant direction; >360 is fine
  dominantDirection: RotationDirection;
  dominantDirectionRatio: number; // moving segments in dominant direction / all moving segments
  maxBacktrackDeg: number; // largest contiguous reversal against the dominant direction
  maxPauseMs: number; // longest run without angular progress
  continuityBroken: boolean; // maxPauseMs > pauseBridgeMaxMs
  angularVelocityDegPerSec: number; // arcCoverageDeg over active motion time
  activeMotionMs: number; // total time spent in moving segments
  timingOffsetMs: number; // 0 in-window; negative = ms early; positive = ms late
  hesitation: HesitationObservation;
  totalDurationMs: number;
  sampleCount: number;
}

// Mutually exclusive terminal results. Exactly one per completed or
// interrupted attempt; the classifier can emit any of these except
// Fail_Abandonment, which only the tutorial controller can conclude
// (menu exit, or idle after a failure — lifecycle facts the trace
// cannot contain).
export const NEAL_SPIN_RESULTS = [
  "Success",
  "Fail_Timing_Early",
  "Fail_Timing_Late",
  "Fail_Dexterity_Speed",
  "Fail_Dexterity_Path",
  "Fail_Hesitation",
  "Fail_Abandonment",
] as const;

export type NealSpinResult = (typeof NEAL_SPIN_RESULTS)[number];

export type NealSpinFailure = Exclude<NealSpinResult, "Success">;

// Velocity floor calibration state (TechSpec 1.1 + Section 5): the floor is
// a PLACEHOLDER until set from the 10th percentile of successful touch
// completions. It is represented explicitly — never as a hardcoded guess —
// and production builds fail closed while uncalibrated.
export type VelocityFloorState =
  | { status: "uncalibrated" }
  | { status: "calibrated"; floorDegPerSec: number };

// Touch and controller distributions stay separate (TechSpec Section 5):
// one shared threshold would quietly turn controller players into lab rats
// wearing tiny sneakers.
export interface VelocityFloorBySource {
  touch: VelocityFloorState;
  controller: VelocityFloorState;
}

// calibration: collect velocity data, do not gate success on it.
// production: gate on the floor; an uncalibrated floor fails closed.
export type BuildMode = "calibration" | "production";

// ---------------------------------------------------------------------------
// Telemetry payloads (TechSpec 4.1). Raw dimensions only.
// ---------------------------------------------------------------------------

export interface EventInputIntentScore {
  type: "Event_Input_Intent_Score";
  session_id: string;
  attempt_number: number;
  input_method: InputMethod;
  arc_coverage_deg: number;
  dominant_direction: RotationDirection;
  dominant_direction_ratio: number;
  angular_velocity_deg_per_sec: number;
  active_motion_ms: number;
  max_pause_ms: number;
  continuity_broken: boolean;
  backtrack_deg: number;
  timing_offset_ms: number;
  hesitation_occurred: boolean;
  hesitation_stop_ms: number;
  hesitation_coverage_at_stop_deg: number;
  total_duration_ms: number;
  sample_count: number;
  velocity_floor_state: VelocityFloorState;
  build_mode: BuildMode;
}

export interface EventFailureType {
  type: "Event_Failure_Type";
  failure_class: NealSpinFailure;
  session_id: string;
  attempt_number: number;
  input_method: InputMethod;
}

export interface EventNealSpinSuccess {
  type: "Event_NealSpin_Success";
  session_id: string;
  attempt_number: number;
  input_method: InputMethod;
  // Only scaffold Stage 1 exists in this slice; the Stage 1→2 threshold is
  // provisional pending Stage 2a SCR telemetry (see NealSpinCalibration).
  scaffold_stage: 1;
}

export interface EventGhostOverlayShown {
  type: "Event_GhostOverlay_Shown";
  failure_class: "Fail_Timing_Early" | "Fail_Timing_Late";
  session_id: string;
  attempt_number: number;
}

// Fired when the player begins a retry after a timing ghost was shown,
// carrying how long the ghost had been on screen: did they pause to read it,
// or blow straight past? Enables modality attribution on TTC (TechSpec 4.1).
export interface EventGhostOverlayRead {
  type: "Event_GhostOverlay_Read";
  session_id: string;
  time_elapsed_before_retry_ms: number;
}

export interface EventHesitationPromptShown {
  type: "Event_Hesitation_Prompt_Shown";
  session_id: string;
  prompt_text: string;
  activation_count_this_session: number;
}

export interface EventHesitationRecovery {
  type: "Event_Hesitation_Recovery";
  session_id: string;
  time_to_reengage_ms: number;
}

export interface EventHesitationRecoveryOutcome {
  type: "Event_Hesitation_Recovery_Outcome";
  session_id: string;
  outcome: NealSpinResult;
}

export interface EventAbandonment {
  type: "Event_Abandonment";
  session_id: string;
  last_failure_class: NealSpinFailure | null;
  attempts_this_session: number;
  time_in_tutorial_ms: number;
}

export type NealSpinTelemetryEvent =
  | EventInputIntentScore
  | EventFailureType
  | EventNealSpinSuccess
  | EventGhostOverlayShown
  | EventGhostOverlayRead
  | EventHesitationPromptShown
  | EventHesitationRecovery
  | EventHesitationRecoveryOutcome
  | EventAbandonment;

export interface TelemetrySink {
  emit(event: NealSpinTelemetryEvent): void;
}
