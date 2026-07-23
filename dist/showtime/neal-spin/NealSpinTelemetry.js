"use strict";
// Neal Spin telemetry (TechSpec 4.1).
//
// Constructs and validates the diagnostic events this slice owns. Raw values
// only: degrees, milliseconds, counts, ratios — never pre-normalized scores,
// because these payloads are the calibration dataset (velocity floor,
// scaffold thresholds) and normalizing at the source would make later tuning
// guesswork. Touch and controller stay distinguishable via input_method on
// every per-attempt event so their distributions can be separated downstream.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildIntentScoreEvent = buildIntentScoreEvent;
exports.buildFailureEvent = buildFailureEvent;
exports.buildSuccessEvent = buildSuccessEvent;
exports.buildGhostOverlayShownEvent = buildGhostOverlayShownEvent;
exports.buildHesitationPromptShownEvent = buildHesitationPromptShownEvent;
exports.buildHesitationRecoveryEvent = buildHesitationRecoveryEvent;
exports.buildHesitationRecoveryOutcomeEvent = buildHesitationRecoveryOutcomeEvent;
exports.buildAbandonmentEvent = buildAbandonmentEvent;
exports.validateEvent = validateEvent;
const NealSpinTypes_1 = require("./NealSpinTypes");
function buildIntentScoreEvent(args) {
    const { dims } = args;
    return {
        type: "Event_Input_Intent_Score",
        session_id: args.sessionId,
        attempt_number: args.attemptNumber,
        input_method: args.inputMethod,
        arc_coverage_deg: dims.arcCoverageDeg,
        dominant_direction: dims.dominantDirection,
        dominant_direction_ratio: dims.dominantDirectionRatio,
        angular_velocity_deg_per_sec: dims.angularVelocityDegPerSec,
        active_motion_ms: dims.activeMotionMs,
        max_pause_ms: dims.maxPauseMs,
        continuity_broken: dims.continuityBroken,
        backtrack_deg: dims.maxBacktrackDeg,
        timing_offset_ms: dims.timingOffsetMs,
        hesitation_occurred: dims.hesitation.occurred,
        hesitation_stop_ms: dims.hesitation.stopDurationMs,
        hesitation_coverage_at_stop_deg: dims.hesitation.coverageAtStopDeg,
        total_duration_ms: dims.totalDurationMs,
        sample_count: dims.sampleCount,
        velocity_floor_state: args.velocityFloorState,
        build_mode: args.buildMode,
    };
}
function buildFailureEvent(args) {
    return {
        type: "Event_Failure_Type",
        failure_class: args.failureClass,
        session_id: args.sessionId,
        attempt_number: args.attemptNumber,
        input_method: args.inputMethod,
    };
}
function buildSuccessEvent(args) {
    return {
        type: "Event_NealSpin_Success",
        session_id: args.sessionId,
        attempt_number: args.attemptNumber,
        input_method: args.inputMethod,
        scaffold_stage: 1,
    };
}
function buildGhostOverlayShownEvent(args) {
    return {
        type: "Event_GhostOverlay_Shown",
        failure_class: args.failureClass,
        session_id: args.sessionId,
        attempt_number: args.attemptNumber,
    };
}
function buildHesitationPromptShownEvent(args) {
    return {
        type: "Event_Hesitation_Prompt_Shown",
        session_id: args.sessionId,
        prompt_text: args.promptText,
        activation_count_this_session: args.activationCountThisSession,
    };
}
function buildHesitationRecoveryEvent(args) {
    return {
        type: "Event_Hesitation_Recovery",
        session_id: args.sessionId,
        time_to_reengage_ms: args.timeToReengageMs,
    };
}
function buildHesitationRecoveryOutcomeEvent(args) {
    return {
        type: "Event_Hesitation_Recovery_Outcome",
        session_id: args.sessionId,
        outcome: args.outcome,
    };
}
function buildAbandonmentEvent(args) {
    return {
        type: "Event_Abandonment",
        session_id: args.sessionId,
        last_failure_class: args.lastFailureClass,
        attempts_this_session: args.attemptsThisSession,
        time_in_tutorial_ms: args.timeInTutorialMs,
    };
}
// ---------------------------------------------------------------------------
// Payload validation. Returns a list of problems; empty means valid. The
// controller validates every event before emitting so a malformed payload is
// a loud engineering error, not a silent hole in the calibration dataset.
// ---------------------------------------------------------------------------
function finite(name, value, problems) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        problems.push(`${name} must be a finite number, got ${String(value)}`);
    }
}
function nonEmptyString(name, value, problems) {
    if (typeof value !== "string" || value.length === 0) {
        problems.push(`${name} must be a non-empty string`);
    }
}
function validateEvent(event) {
    const problems = [];
    nonEmptyString("session_id", event.session_id, problems);
    switch (event.type) {
        case "Event_Input_Intent_Score": {
            finite("attempt_number", event.attempt_number, problems);
            finite("arc_coverage_deg", event.arc_coverage_deg, problems);
            finite("dominant_direction_ratio", event.dominant_direction_ratio, problems);
            finite("angular_velocity_deg_per_sec", event.angular_velocity_deg_per_sec, problems);
            finite("active_motion_ms", event.active_motion_ms, problems);
            finite("max_pause_ms", event.max_pause_ms, problems);
            finite("backtrack_deg", event.backtrack_deg, problems);
            finite("timing_offset_ms", event.timing_offset_ms, problems);
            finite("hesitation_stop_ms", event.hesitation_stop_ms, problems);
            finite("hesitation_coverage_at_stop_deg", event.hesitation_coverage_at_stop_deg, problems);
            finite("total_duration_ms", event.total_duration_ms, problems);
            finite("sample_count", event.sample_count, problems);
            if (!["cw", "ccw", "ambiguous"].includes(event.dominant_direction)) {
                problems.push(`dominant_direction invalid: ${String(event.dominant_direction)}`);
            }
            if (!["touch", "controller"].includes(event.input_method)) {
                problems.push(`input_method invalid: ${String(event.input_method)}`);
            }
            break;
        }
        case "Event_Failure_Type": {
            finite("attempt_number", event.attempt_number, problems);
            // The whole point of the taxonomy: a generic failure is not a value.
            if (!NealSpinTypes_1.NEAL_SPIN_RESULTS.includes(event.failure_class) ||
                event.failure_class === "Success" ||
                event.failure_class === "NealSpin_Fail") {
                problems.push(`failure_class invalid: ${String(event.failure_class)}`);
            }
            break;
        }
        case "Event_NealSpin_Success":
            finite("attempt_number", event.attempt_number, problems);
            break;
        case "Event_GhostOverlay_Shown":
            finite("attempt_number", event.attempt_number, problems);
            if (event.failure_class !== "Fail_Timing_Early" && event.failure_class !== "Fail_Timing_Late") {
                problems.push(`ghost overlay only exists for timing failures, got ${String(event.failure_class)}`);
            }
            break;
        case "Event_Hesitation_Prompt_Shown":
            nonEmptyString("prompt_text", event.prompt_text, problems);
            finite("activation_count_this_session", event.activation_count_this_session, problems);
            break;
        case "Event_Hesitation_Recovery":
            finite("time_to_reengage_ms", event.time_to_reengage_ms, problems);
            break;
        case "Event_Hesitation_Recovery_Outcome":
            if (!NealSpinTypes_1.NEAL_SPIN_RESULTS.includes(event.outcome)) {
                problems.push(`outcome invalid: ${String(event.outcome)}`);
            }
            break;
        case "Event_Abandonment":
            finite("attempts_this_session", event.attempts_this_session, problems);
            finite("time_in_tutorial_ms", event.time_in_tutorial_ms, problems);
            break;
    }
    return problems;
}
