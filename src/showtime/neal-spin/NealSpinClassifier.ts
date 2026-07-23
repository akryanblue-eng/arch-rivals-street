// Neal Spin failure classifier (TechSpec 1.2).
//
// Maps one attempt's raw intent dimensions onto EXACTLY ONE terminal result.
// The precedence below is specification, deterministic, and total — there is
// no code path that returns nothing, two things, or a generic NealSpin_Fail.
//
//   1. Timing early/late — input registered outside the animation window.
//   2. Hesitation — its exact stop condition was met and the player never
//      resumed. (A resumed hesitation classifies on the full trace, which is
//      how Event_Hesitation_Recovery_Outcome can legitimately be Success.)
//   3. Dexterity speed — ONLY when the path is valid but calibrated angular
//      velocity is insufficient. A slow, malformed gesture must read as a
//      path problem, never a misleading speed problem.
//   4. Dexterity path — insufficient coverage, ambiguous direction, or
//      excessive backtracking on the best arc chain.
//   5. Success.
//
// The velocity gate honors calibration state (TechSpec Section 5):
//   - calibration builds collect velocity but never gate on it;
//   - production builds with an uncalibrated floor FAIL CLOSED. Through the
//     controller this branch is unreachable — assertConfigLaunchable refuses
//     to construct an uncalibrated production config at initialization, so
//     the defect surfaces against the build, not the player. The branch
//     remains as defense in depth for callers that bypass the controller,
//     and telemetry's velocity_floor_state keeps the cause visible.

import { NealSpinConfig } from "./NealSpinCalibration";
import { IntentDimensions, InputMethod, NealSpinResult } from "./NealSpinTypes";

type VelocityGate = "pass" | "fail";

function velocityGate(
  dims: IntentDimensions,
  config: NealSpinConfig,
  inputMethod: InputMethod,
): VelocityGate {
  if (config.buildMode === "calibration") {
    // Collect, don't gate: raw velocity still lands in telemetry.
    return "pass";
  }
  const floor = config.velocityFloor[inputMethod];
  if (floor.status === "uncalibrated") {
    return "fail"; // fail closed in production
  }
  return dims.angularVelocityDegPerSec >= floor.floorDegPerSec ? "pass" : "fail";
}

export function classifyAttempt(
  dims: IntentDimensions,
  config: NealSpinConfig,
  inputMethod: InputMethod,
): Exclude<NealSpinResult, "Fail_Abandonment"> {
  // 1. Timing.
  if (dims.timingOffsetMs < 0) return "Fail_Timing_Early";
  if (dims.timingOffsetMs > 0) return "Fail_Timing_Late";

  // 2. Hesitation, when the attempt died in the stop.
  if (dims.hesitation.occurred && !dims.hesitation.resumedAfterStop) {
    return "Fail_Hesitation";
  }

  // 3 & 4. Path validity decides which dexterity axis may speak.
  const pathValid =
    dims.arcCoverageDeg >= config.minEffectiveRotationDeg &&
    dims.dominantDirection !== "ambiguous" &&
    dims.maxBacktrackDeg <= config.backtrackToleranceDeg;

  if (!pathValid) return "Fail_Dexterity_Path";

  if (velocityGate(dims, config, inputMethod) === "fail") {
    return "Fail_Dexterity_Speed";
  }

  // 5.
  return "Success";
}
