import { strict as assert } from "assert";
import { test } from "node:test";
import { defaultConfig, NealSpinConfig } from "../../../src/showtime/neal-spin/NealSpinCalibration";
import { classifyAttempt } from "../../../src/showtime/neal-spin/NealSpinClassifier";
import { parseAttempt } from "../../../src/showtime/neal-spin/NealSpinIntentParser";
import { IntentDimensions, NEAL_SPIN_RESULTS } from "../../../src/showtime/neal-spin/NealSpinTypes";
import { configForFixture, loadFixtures } from "./traceUtils";

// Hand-built dimensions: a valid, fast, in-window attempt unless overridden.
function mkDims(overrides: Partial<IntentDimensions> = {}): IntentDimensions {
  return {
    arcCoverageDeg: 360,
    dominantDirection: "cw",
    dominantDirectionRatio: 1,
    maxBacktrackDeg: 0,
    maxPauseMs: 0,
    continuityBroken: false,
    angularVelocityDegPerSec: 700,
    activeMotionMs: 500,
    timingOffsetMs: 0,
    hesitation: { occurred: false, stopDurationMs: 0, coverageAtStopDeg: 0, resumedAfterStop: false },
    totalDurationMs: 500,
    sampleCount: 30,
    ...overrides,
  };
}

function calibrated(floorDegPerSec: number): NealSpinConfig {
  const config = defaultConfig("production");
  config.velocityFloor.touch = { status: "calibrated", floorDegPerSec };
  config.velocityFloor.controller = { status: "calibrated", floorDegPerSec };
  return config;
}

test("a fully valid attempt succeeds", () => {
  assert.equal(classifyAttempt(mkDims(), calibrated(300), "touch"), "Success");
});

test("precedence 1: timing beats every other marginal dimension", () => {
  const config = calibrated(300);
  const wreck = {
    arcCoverageDeg: 40,
    dominantDirection: "ambiguous" as const,
    maxBacktrackDeg: 90,
    angularVelocityDegPerSec: 10,
    hesitation: { occurred: true, stopDurationMs: 900, coverageAtStopDeg: 10, resumedAfterStop: false },
  };
  assert.equal(classifyAttempt(mkDims({ ...wreck, timingOffsetMs: -50 }), config, "touch"), "Fail_Timing_Early");
  assert.equal(classifyAttempt(mkDims({ ...wreck, timingOffsetMs: 50 }), config, "touch"), "Fail_Timing_Late");
});

test("precedence 2: unresumed hesitation beats both dexterity classes", () => {
  const config = calibrated(300);
  const dims = mkDims({
    arcCoverageDeg: 40,
    angularVelocityDegPerSec: 20,
    hesitation: { occurred: true, stopDurationMs: 700, coverageAtStopDeg: 40, resumedAfterStop: false },
  });
  assert.equal(classifyAttempt(dims, config, "touch"), "Fail_Hesitation");
});

test("resumed hesitation falls through: valid trace succeeds, invalid is path", () => {
  const config = calibrated(300);
  const resumed = { occurred: true, stopDurationMs: 700, coverageAtStopDeg: 40, resumedAfterStop: true };
  assert.equal(classifyAttempt(mkDims({ hesitation: resumed }), config, "touch"), "Success");
  assert.equal(
    classifyAttempt(mkDims({ hesitation: resumed, arcCoverageDeg: 120 }), config, "touch"),
    "Fail_Dexterity_Path",
  );
});

test("a valid path below the velocity floor is Speed, never Path", () => {
  const dims = mkDims({ angularVelocityDegPerSec: 150 });
  assert.equal(classifyAttempt(dims, calibrated(300), "touch"), "Fail_Dexterity_Speed");
});

test("a slow, malformed gesture is Path, never a misleading Speed", () => {
  const dims = mkDims({ arcCoverageDeg: 120, angularVelocityDegPerSec: 150 });
  assert.equal(classifyAttempt(dims, calibrated(300), "touch"), "Fail_Dexterity_Path");
});

test("path boundaries: 270° exactly passes; below does not", () => {
  const config = calibrated(300);
  assert.equal(classifyAttempt(mkDims({ arcCoverageDeg: 270 }), config, "touch"), "Success");
  assert.equal(classifyAttempt(mkDims({ arcCoverageDeg: 269.999 }), config, "touch"), "Fail_Dexterity_Path");
});

test("over-rotation far beyond 360° incurs no penalty", () => {
  assert.equal(classifyAttempt(mkDims({ arcCoverageDeg: 700 }), calibrated(300), "touch"), "Success");
});

test("backtrack boundaries: exactly 30° tolerated; beyond is path failure", () => {
  const config = calibrated(300);
  assert.equal(classifyAttempt(mkDims({ maxBacktrackDeg: 30 }), config, "touch"), "Success");
  assert.equal(classifyAttempt(mkDims({ maxBacktrackDeg: 30.001 }), config, "touch"), "Fail_Dexterity_Path");
});

test("velocity floor boundary: exactly at the floor passes", () => {
  assert.equal(
    classifyAttempt(mkDims({ angularVelocityDegPerSec: 300 }), calibrated(300), "touch"),
    "Success",
  );
});

test("production build with an uncalibrated floor fails closed as Speed", () => {
  const config = defaultConfig("production"); // both floors uncalibrated
  assert.equal(classifyAttempt(mkDims(), config, "touch"), "Fail_Dexterity_Speed");
  assert.equal(classifyAttempt(mkDims(), config, "controller"), "Fail_Dexterity_Speed");
});

test("calibration build collects without gating: same dims succeed", () => {
  const config = defaultConfig("calibration");
  assert.equal(classifyAttempt(mkDims({ angularVelocityDegPerSec: 1 }), config, "touch"), "Success");
});

test("velocity floors are per-source: a calibrated touch floor never gates a controller attempt", () => {
  const config = defaultConfig("production");
  config.velocityFloor.touch = { status: "calibrated", floorDegPerSec: 100 };
  // Controller stays uncalibrated: fail closed for controller, pass for touch.
  assert.equal(classifyAttempt(mkDims(), config, "touch"), "Success");
  assert.equal(classifyAttempt(mkDims(), config, "controller"), "Fail_Dexterity_Speed");
});

test("classification is total, single-valued, and never a generic failure", () => {
  const config = calibrated(300);
  const timingValues = [-100, 0, 100];
  const hesitations = [
    { occurred: false, stopDurationMs: 0, coverageAtStopDeg: 0, resumedAfterStop: false },
    { occurred: true, stopDurationMs: 700, coverageAtStopDeg: 40, resumedAfterStop: false },
    { occurred: true, stopDurationMs: 700, coverageAtStopDeg: 40, resumedAfterStop: true },
  ];
  const coverages = [40, 270, 450];
  const directions = ["cw", "ambiguous"] as const;
  const backtracks = [0, 30, 45];
  const velocities = [10, 300, 900];

  for (const timingOffsetMs of timingValues) {
    for (const hesitation of hesitations) {
      for (const arcCoverageDeg of coverages) {
        for (const dominantDirection of directions) {
          for (const maxBacktrackDeg of backtracks) {
            for (const angularVelocityDegPerSec of velocities) {
              const result = classifyAttempt(
                mkDims({
                  timingOffsetMs,
                  hesitation,
                  arcCoverageDeg,
                  dominantDirection,
                  maxBacktrackDeg,
                  angularVelocityDegPerSec,
                }),
                config,
                "touch",
              );
              assert.ok(
                (NEAL_SPIN_RESULTS as readonly string[]).includes(result),
                `unknown result ${result}`,
              );
              assert.notEqual(result as string, "NealSpin_Fail");
              assert.notEqual(result, "Fail_Abandonment"); // classifier can never conclude abandonment
            }
          }
        }
      }
    }
  }
});

test("every recorded fixture classifies to its expected terminal result", () => {
  const fixtures = loadFixtures();
  assert.ok(fixtures.length >= 12, `expected a full fixture set, found ${fixtures.length}`);
  let sawTouch = false;
  let sawController = false;
  for (const fixture of fixtures) {
    const config = configForFixture(fixture);
    const dims = parseAttempt(fixture.trace, config);
    const result = classifyAttempt(dims, config, fixture.trace.inputMethod);
    assert.equal(result, fixture.expected.classification, fixture.name);
    if (fixture.trace.inputMethod === "touch") sawTouch = true;
    if (fixture.trace.inputMethod === "controller") sawController = true;
  }
  assert.ok(sawTouch && sawController, "fixture set must cover both input methods");
});
