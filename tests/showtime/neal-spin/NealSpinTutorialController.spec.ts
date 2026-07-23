import { strict as assert } from "assert";
import { test } from "node:test";
import { defaultConfig, NealSpinConfig } from "../../../src/showtime/neal-spin/NealSpinCalibration";
import { NealSpinTutorialController } from "../../../src/showtime/neal-spin/NealSpinTutorialController";
import { NealSpinTelemetryEvent } from "../../../src/showtime/neal-spin/NealSpinTypes";
import { CENTER, makeTrace, rep, Step, WINDOW_CLOSE_MS, WINDOW_OPEN_MS } from "./traceUtils";

class CapturingSink {
  events: NealSpinTelemetryEvent[] = [];
  emit(event: NealSpinTelemetryEvent): void {
    this.events.push(event);
  }
  ofType<T extends NealSpinTelemetryEvent["type"]>(
    type: T,
  ): Extract<NealSpinTelemetryEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<NealSpinTelemetryEvent, { type: T }> => e.type === type,
    );
  }
}

function makeController(configure?: (config: NealSpinConfig) => void) {
  const config = defaultConfig("production");
  config.velocityFloor.touch = { status: "calibrated", floorDegPerSec: 300 };
  config.velocityFloor.controller = { status: "calibrated", floorDegPerSec: 300 };
  configure?.(config);
  const sink = new CapturingSink();
  const controller = new NealSpinTutorialController({
    config,
    sink,
    sessionId: "session-test",
    sessionStartMs: 0,
  });
  return { controller, sink };
}

const context = {
  inputMethod: "touch" as const,
  center: CENTER,
  windowOpenMs: WINDOW_OPEN_MS,
  windowCloseMs: WINDOW_CLOSE_MS,
};

function runAttempt(
  controller: NealSpinTutorialController,
  t0: number,
  steps: Step[],
  endMs: number,
) {
  controller.beginAttempt(context, t0);
  for (const sample of makeTrace(t0, steps).samples) {
    controller.feedSample(sample);
  }
  return controller.endAttempt(endMs);
}

const CLEAN_SPIN = rep(30, { d: 12, dt: 16 });
const STALL = [...rep(5, { d: 8, dt: 16 }), ...rep(13, { d: 0, dt: 50 })];

test("a successful attempt emits exactly one intent score and one success event", () => {
  const { controller, sink } = makeController();
  const result = runAttempt(controller, 10050, CLEAN_SPIN, 10600);
  assert.equal(result, "Success");
  assert.equal(sink.ofType("Event_Input_Intent_Score").length, 1);
  assert.equal(sink.ofType("Event_NealSpin_Success").length, 1);
  assert.equal(sink.ofType("Event_Failure_Type").length, 0);
});

test("every attempt yields exactly one terminal result and one failure class at most", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, CLEAN_SPIN, 10600); // Success
  runAttempt(controller, 9900, CLEAN_SPIN, 10600); // Fail_Timing_Early
  runAttempt(controller, 10050, rep(10, { d: 12, dt: 16 }), 10600); // Fail_Dexterity_Path
  const scores = sink.ofType("Event_Input_Intent_Score");
  const successes = sink.ofType("Event_NealSpin_Success");
  const failures = sink.ofType("Event_Failure_Type");
  assert.equal(scores.length, 3); // one per attempt, no more, no less
  assert.equal(successes.length + failures.length, 3); // one terminal each
  assert.deepEqual(
    failures.map((f) => f.failure_class),
    ["Fail_Timing_Early", "Fail_Dexterity_Path"],
  );
});

test("lifecycle misuse throws instead of double-terminating", () => {
  const { controller } = makeController();
  assert.throws(() => controller.endAttempt(0));
  assert.throws(() => controller.feedSample({ tMs: 0, x: 0, y: 0 }));
  controller.beginAttempt(context, 10000);
  assert.throws(() => controller.beginAttempt(context, 10001));
  controller.endAttempt(10600);
  assert.throws(() => controller.endAttempt(10600));
});

test("no runtime path emits a generic NealSpin_Fail", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600);
  runAttempt(controller, 10050, STALL, 10800);
  controller.beginAttempt(context, 10000);
  controller.menuExit(11000);
  for (const event of sink.events) {
    assert.ok(!JSON.stringify(event).includes("NealSpin_Fail"));
  }
});

test("timing ghost overlay: shown on early failure, holds 1.0s, fades 0.2s", () => {
  const { controller, sink } = makeController();
  const result = runAttempt(controller, 9900, CLEAN_SPIN, 10600);
  assert.equal(result, "Fail_Timing_Early");
  assert.equal(sink.ofType("Event_GhostOverlay_Shown").length, 1);

  const shownAt = 10600;
  const holding = controller.ghostOverlay.getState(shownAt + 999);
  assert.equal(holding.phase, "holding");
  assert.equal(holding.opacity, 1);
  assert.equal(holding.calloutText, "Too eager.");

  const fading = controller.ghostOverlay.getState(shownAt + 1100);
  assert.equal(fading.phase, "fading");
  assert.ok(Math.abs(fading.opacity - 0.5) < 0.01, `opacity ${fading.opacity}`);

  const hidden = controller.ghostOverlay.getState(shownAt + 1200);
  assert.equal(hidden.phase, "hidden");
});

test("late failure gets its own callout", () => {
  const { controller } = makeController();
  const result = runAttempt(controller, 10700, CLEAN_SPIN, 11300);
  assert.equal(result, "Fail_Timing_Late");
  assert.equal(controller.ghostOverlay.getState(11300 + 100).calloutText, "Missed the beat.");
});

test("the ghost never appears for non-timing failures", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, rep(10, { d: 12, dt: 16 }), 10600); // path failure
  assert.equal(sink.ofType("Event_GhostOverlay_Shown").length, 0);
  assert.equal(controller.ghostOverlay.getState(10650).phase, "hidden");
});

test("the ghost never remains visible during the active retry", () => {
  const { controller } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600);
  assert.equal(controller.ghostOverlay.getState(10700).phase, "holding");
  controller.beginAttempt(context, 10700); // retry begins mid-hold
  assert.equal(controller.ghostOverlay.getState(10750).phase, "hidden");
  controller.endAttempt(11200);
});

test("hesitation prompts: correct sequence, capped at two per session", () => {
  const { controller, sink } = makeController();
  assert.equal(runAttempt(controller, 10050, STALL, 10800), "Fail_Hesitation");
  assert.equal(runAttempt(controller, 10050, STALL, 10800), "Fail_Hesitation");
  assert.equal(runAttempt(controller, 10050, STALL, 10800), "Fail_Hesitation");
  const prompts = sink.ofType("Event_Hesitation_Prompt_Shown");
  assert.deepEqual(
    prompts.map((p) => p.prompt_text),
    ["Don't blink.", "Paint the floor."], // third hesitation: no third prompt
  );
  assert.equal(controller.hesitationPrompt.promptsShownThisSession, 2);
});

test("recovery fires on renewed motion and reports the recovered outcome", () => {
  const { controller, sink } = makeController();
  const recoveredSpin = [...rep(5, { d: 8, dt: 16 }), ...rep(13, { d: 0, dt: 50 }), ...rep(30, { d: 12, dt: 16 })];
  const result = runAttempt(controller, 10050, recoveredSpin, 11300);
  assert.equal(result, "Success");
  assert.equal(sink.ofType("Event_Hesitation_Recovery").length, 1);
  const outcomes = sink.ofType("Event_Hesitation_Recovery_Outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].outcome, "Success");
});

test("recovery never fires from time alone: a stall that stays stalled has no recovery", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, STALL, 20000); // plenty of wall time, no renewed motion
  assert.equal(sink.ofType("Event_Hesitation_Recovery").length, 0);
  assert.equal(sink.ofType("Event_Hesitation_Recovery_Outcome").length, 0);
});

test("menu exit mid-attempt terminates the attempt as abandonment", () => {
  const { controller, sink } = makeController();
  controller.beginAttempt(context, 10000);
  controller.feedSample({ tMs: 10050, x: 500, y: 300 });
  const result = controller.menuExit(10100);
  assert.equal(result, "Fail_Abandonment");
  const failures = sink.ofType("Event_Failure_Type");
  assert.deepEqual(failures.map((f) => f.failure_class), ["Fail_Abandonment"]);
  assert.equal(sink.ofType("Event_Abandonment").length, 1);
  assert.equal(sink.ofType("Event_Input_Intent_Score").length, 1); // interrupted attempts still report
});

test("idle abandonment after a failure fires strictly past 8s, exactly once", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600); // failure at t=10600
  controller.tick(10600 + 8000);
  assert.equal(sink.ofType("Event_Abandonment").length, 0); // exactly 8s: not yet
  controller.tick(10600 + 8001);
  assert.equal(sink.ofType("Event_Abandonment").length, 1);
  controller.tick(10600 + 20000);
  assert.equal(sink.ofType("Event_Abandonment").length, 1); // never repeats
  const abandonment = sink.ofType("Event_Abandonment")[0];
  assert.equal(abandonment.last_failure_class, "Fail_Timing_Early");
});

test("starting a new attempt disarms the idle abandonment watch", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600); // failure arms the watch
  runAttempt(controller, 10050, CLEAN_SPIN, 10600); // successful retry disarms it
  controller.tick(10600 + 9000); // well past 8s from the original failure
  assert.equal(sink.ofType("Event_Abandonment").length, 0);
});

test("success does not arm the abandonment watch", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, CLEAN_SPIN, 10600);
  controller.tick(10600 + 9000);
  assert.equal(sink.ofType("Event_Abandonment").length, 0);
});

test("intent score payloads carry raw dimensions and calibration state", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, CLEAN_SPIN, 10600);
  const score = sink.ofType("Event_Input_Intent_Score")[0];
  assert.ok(Math.abs(score.arc_coverage_deg - 360) < 0.01);
  assert.ok(score.angular_velocity_deg_per_sec > 700); // raw deg/s, not a normalized 0..1 score
  assert.equal(score.input_method, "touch");
  assert.equal(score.build_mode, "production");
  assert.deepEqual(score.velocity_floor_state, { status: "calibrated", floorDegPerSec: 300 });
  assert.equal(score.timing_offset_ms, 0);
});

test("an uncalibrated production config is refused at construction, not at play time", () => {
  const config = defaultConfig("production"); // floors uncalibrated
  const sink = new CapturingSink();
  assert.throws(
    () =>
      new NealSpinTutorialController({ config, sink, sessionId: "s", sessionStartMs: 0 }),
    /production build requires calibrated velocity floors.*touch.*controller/,
  );
  // A calibration build with the same floors is a legitimate configuration.
  const calibration = defaultConfig("calibration");
  new NealSpinTutorialController({ config: calibration, sink, sessionId: "s", sessionStartMs: 0 });
  // Partially calibrated production still refuses, naming the missing source.
  const partial = defaultConfig("production");
  partial.velocityFloor.touch = { status: "calibrated", floorDegPerSec: 300 };
  assert.throws(
    () => new NealSpinTutorialController({ config: partial, sink, sessionId: "s", sessionStartMs: 0 }),
    /uncalibrated: controller/,
  );
});

test("retry after a timing ghost reports how long the ghost was on screen", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600); // ghost shown at 10600
  controller.beginAttempt(context, 11350); // player watched for 750ms
  controller.endAttempt(12000);
  const reads = sink.ofType("Event_GhostOverlay_Read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0].time_elapsed_before_retry_ms, 750);
});

test("no ghost read event when no ghost was shown", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 10050, rep(10, { d: 12, dt: 16 }), 10600); // path failure: no ghost
  runAttempt(controller, 10050, CLEAN_SPIN, 10600);
  assert.equal(sink.ofType("Event_GhostOverlay_Read").length, 0);
});

test("ghost read is reported once per shown ghost, not on later retries", () => {
  const { controller, sink } = makeController();
  runAttempt(controller, 9900, CLEAN_SPIN, 10600); // ghost
  runAttempt(controller, 10050, CLEAN_SPIN, 10600); // retry 1: read reported
  runAttempt(controller, 10050, CLEAN_SPIN, 10600); // retry 2: nothing new
  assert.equal(sink.ofType("Event_GhostOverlay_Read").length, 1);
});
