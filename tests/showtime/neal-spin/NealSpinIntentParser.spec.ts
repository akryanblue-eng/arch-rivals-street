import { strict as assert } from "assert";
import { test } from "node:test";
import { defaultConfig } from "../../../src/showtime/neal-spin/NealSpinCalibration";
import { parseAttempt } from "../../../src/showtime/neal-spin/NealSpinIntentParser";
import { loadFixtures, makeTrace, rep } from "./traceUtils";

const config = defaultConfig("calibration");

test("clean 360° cw spin measures full coverage, cw direction, no breaks", () => {
  const dims = parseAttempt(makeTrace(10050, rep(30, { d: 12, dt: 16 })), config);
  assert.ok(Math.abs(dims.arcCoverageDeg - 360) < 0.01, `coverage ${dims.arcCoverageDeg}`);
  assert.equal(dims.dominantDirection, "cw");
  assert.equal(dims.dominantDirectionRatio, 1);
  assert.equal(dims.continuityBroken, false);
  assert.equal(dims.maxBacktrackDeg, 0);
  assert.equal(dims.timingOffsetMs, 0);
  assert.equal(dims.hesitation.occurred, false);
  // 360° over 480ms of motion = 750°/s.
  assert.ok(Math.abs(dims.angularVelocityDegPerSec - 750) < 1, `velocity ${dims.angularVelocityDegPerSec}`);
});

test("ccw spin is symmetric: same coverage, opposite direction", () => {
  const dims = parseAttempt(makeTrace(10050, rep(30, { d: -12, dt: 16 })), config);
  assert.ok(Math.abs(dims.arcCoverageDeg - 360) < 0.01);
  assert.equal(dims.dominantDirection, "ccw");
});

test("over-rotation beyond 360° accumulates without penalty", () => {
  const dims = parseAttempt(makeTrace(10050, rep(40, { d: 12, dt: 16 })), config);
  assert.ok(Math.abs(dims.arcCoverageDeg - 480) < 0.01, `coverage ${dims.arcCoverageDeg}`);
  assert.equal(dims.dominantDirection, "cw");
});

test("noisy arc: small counter-jitter lowers the ratio but keeps the direction", () => {
  const steps = Array.from({ length: 42 }, (_, i) =>
    (i + 1) % 6 === 0 ? { d: -1.5, dt: 14 } : { d: 12.5, dt: 14 },
  );
  const dims = parseAttempt(makeTrace(10050, steps), config);
  assert.equal(dims.dominantDirection, "cw");
  assert.ok(dims.dominantDirectionRatio > 0.6 && dims.dominantDirectionRatio < 1);
  assert.ok(dims.arcCoverageDeg > 400);
});

test("sub-epsilon jitter is not motion", () => {
  // 0.4° wiggles sit below MOTION_EPSILON_DEG: nothing moves, nothing counts.
  const steps = Array.from({ length: 20 }, (_, i) => ({ d: i % 2 === 0 ? 0.4 : -0.4, dt: 16 }));
  const dims = parseAttempt(makeTrace(10050, steps), config);
  assert.equal(dims.arcCoverageDeg, 0);
  assert.equal(dims.dominantDirection, "ambiguous");
  assert.equal(dims.activeMotionMs, 0);
});

test("pause of exactly 250ms is bridged into one chain", () => {
  const dims = parseAttempt(
    makeTrace(10050, [
      ...rep(15, { d: 12, dt: 16 }),
      ...rep(5, { d: 0, dt: 50 }),
      ...rep(15, { d: 12, dt: 16 }),
    ]),
    config,
  );
  assert.equal(dims.maxPauseMs, 250);
  assert.equal(dims.continuityBroken, false);
  assert.ok(Math.abs(dims.arcCoverageDeg - 360) < 0.01, `coverage ${dims.arcCoverageDeg}`);
});

test("pause of 251ms breaks continuity: coverage cannot cross the split", () => {
  const dims = parseAttempt(
    makeTrace(10050, [
      ...rep(15, { d: 12, dt: 16 }),
      ...rep(4, { d: 0, dt: 50 }),
      { d: 0, dt: 51 },
      ...rep(15, { d: 12, dt: 16 }),
    ]),
    config,
  );
  assert.equal(dims.maxPauseMs, 251);
  assert.equal(dims.continuityBroken, true);
  assert.ok(Math.abs(dims.arcCoverageDeg - 180) < 0.01, `coverage ${dims.arcCoverageDeg}`);
});

test("backtrack of exactly 30° is measured exactly", () => {
  const dims = parseAttempt(
    makeTrace(10050, [
      ...rep(30, { d: 10, dt: 16 }),
      ...rep(3, { d: -10, dt: 16 }),
      ...rep(3, { d: 10, dt: 16 }),
    ]),
    config,
  );
  assert.equal(dims.maxBacktrackDeg, 30);
  assert.equal(dims.dominantDirection, "cw");
});

test("backtrack of 31° is measured exactly", () => {
  const dims = parseAttempt(
    makeTrace(10050, [
      ...rep(30, { d: 10, dt: 16 }),
      { d: -10, dt: 16 },
      { d: -10, dt: 16 },
      { d: -11, dt: 16 },
      ...rep(3, { d: 10, dt: 16 }),
    ]),
    config,
  );
  assert.equal(dims.maxBacktrackDeg, 31);
});

test("alternating directions produce ambiguity", () => {
  const steps = Array.from({ length: 24 }, (_, i) => ({ d: i % 2 === 0 ? 9 : -9, dt: 16 }));
  const dims = parseAttempt(makeTrace(10050, steps), config);
  assert.equal(dims.dominantDirection, "ambiguous");
  assert.ok(dims.dominantDirectionRatio < 0.6);
});

test("60% segment share is exactly enough to hold a direction", () => {
  // 3 cw + 2 ccw moving segments: ratio 0.6, direction survives.
  const dims = parseAttempt(
    makeTrace(10050, [
      { d: 20, dt: 16 },
      { d: -20, dt: 16 },
      { d: 20, dt: 16 },
      { d: -20, dt: 16 },
      { d: 20, dt: 16 },
    ]),
    config,
  );
  assert.equal(dims.dominantDirectionRatio, 0.6);
  assert.equal(dims.dominantDirection, "cw");
});

test("timing offset is negative before the window and positive after it", () => {
  const early = parseAttempt(makeTrace(9900, rep(30, { d: 12, dt: 16 })), config);
  assert.equal(early.timingOffsetMs, -100);
  const late = parseAttempt(makeTrace(10700, rep(30, { d: 12, dt: 16 })), config);
  assert.equal(late.timingOffsetMs, 100);
  const inWindow = parseAttempt(makeTrace(10050, rep(30, { d: 12, dt: 16 })), config);
  assert.equal(inWindow.timingOffsetMs, 0);
});

test("hesitation: motion, then a stop >500ms before 90°, never resumed", () => {
  const dims = parseAttempt(
    makeTrace(10050, [...rep(5, { d: 8, dt: 16 }), ...rep(13, { d: 0, dt: 50 })]),
    config,
  );
  assert.equal(dims.hesitation.occurred, true);
  assert.equal(dims.hesitation.stopDurationMs, 650);
  assert.ok(Math.abs(dims.hesitation.coverageAtStopDeg - 40) < 0.01);
  assert.equal(dims.hesitation.resumedAfterStop, false);
});

test("a stop of exactly 500ms is not hesitation", () => {
  const dims = parseAttempt(
    makeTrace(10050, [...rep(5, { d: 8, dt: 16 }), ...rep(10, { d: 0, dt: 50 })]),
    config,
  );
  assert.equal(dims.hesitation.occurred, false);
});

test("a long stop after 90° coverage is not hesitation", () => {
  const dims = parseAttempt(
    makeTrace(10050, [...rep(12, { d: 8, dt: 16 }), ...rep(13, { d: 0, dt: 50 })]),
    config,
  );
  // 96° of motion before the stall: past the hesitation ceiling.
  assert.equal(dims.hesitation.occurred, false);
});

test("stillness before any motion is not hesitation", () => {
  const dims = parseAttempt(
    makeTrace(10050, [...rep(13, { d: 0, dt: 50 }), ...rep(30, { d: 12, dt: 16 })]),
    config,
  );
  assert.equal(dims.hesitation.occurred, false);
});

test("recovered hesitation: resumption is observed and the new chain stands alone", () => {
  const dims = parseAttempt(
    makeTrace(10050, [
      ...rep(5, { d: 8, dt: 16 }),
      ...rep(13, { d: 0, dt: 50 }),
      ...rep(30, { d: 12, dt: 16 }),
    ]),
    config,
  );
  assert.equal(dims.hesitation.occurred, true);
  assert.equal(dims.hesitation.resumedAfterStop, true);
  assert.ok(Math.abs(dims.arcCoverageDeg - 360) < 0.01, `coverage ${dims.arcCoverageDeg}`);
});

test("empty and single-sample traces produce zeroed dimensions", () => {
  const empty = parseAttempt(
    { inputMethod: "touch", center: { x: 400, y: 300 }, samples: [], windowOpenMs: 10000, windowCloseMs: 10600 },
    config,
  );
  assert.equal(empty.arcCoverageDeg, 0);
  assert.equal(empty.dominantDirection, "ambiguous");
  assert.equal(empty.timingOffsetMs, 0);
  assert.equal(empty.sampleCount, 0);
});

test("fixture traces parse to their recorded expectations", () => {
  for (const fixture of loadFixtures()) {
    const dims = parseAttempt(fixture.trace, config);
    const label = fixture.name;
    if (fixture.expected.dominantDirection !== undefined) {
      assert.equal(dims.dominantDirection, fixture.expected.dominantDirection, label);
    }
    if (fixture.expected.minArcCoverageDeg !== undefined) {
      assert.ok(dims.arcCoverageDeg >= fixture.expected.minArcCoverageDeg, `${label}: ${dims.arcCoverageDeg}`);
    }
    if (fixture.expected.maxBacktrackDeg !== undefined) {
      assert.equal(dims.maxBacktrackDeg, fixture.expected.maxBacktrackDeg, label);
    }
    if (fixture.expected.continuityBroken !== undefined) {
      assert.equal(dims.continuityBroken, fixture.expected.continuityBroken, label);
    }
    if (fixture.expected.hesitationOccurred !== undefined) {
      assert.equal(dims.hesitation.occurred, fixture.expected.hesitationOccurred, label);
    }
    if (fixture.expected.hesitationResumed !== undefined) {
      assert.equal(dims.hesitation.resumedAfterStop, fixture.expected.hesitationResumed, label);
    }
    if (fixture.expected.timingOffsetMs !== undefined) {
      assert.equal(dims.timingOffsetMs, fixture.expected.timingOffsetMs, label);
    }
  }
});

test("effective arc excludes backtracking: 240 forward + 30 reverse is 240, not 270", () => {
  const dims = parseAttempt(
    makeTrace(10050, [...rep(24, { d: 10, dt: 16 }), ...rep(3, { d: -10, dt: 16 })]),
    config,
  );
  assert.ok(Math.abs(dims.arcCoverageDeg - 240) < 0.01, `coverage ${dims.arcCoverageDeg}`);
  assert.equal(dims.maxBacktrackDeg, 30);
});

test("a long sample gap containing real movement is motion, not hesitation", () => {
  // 40° of motion, then one 600ms gap during which the angle advanced 45°:
  // the player kept moving — the input stream just delivered late. No stop.
  const dims = parseAttempt(
    makeTrace(10050, [...rep(5, { d: 8, dt: 16 }), { d: 45, dt: 600 }, ...rep(5, { d: 8, dt: 16 })]),
    config,
  );
  assert.equal(dims.hesitation.occurred, false);
});
