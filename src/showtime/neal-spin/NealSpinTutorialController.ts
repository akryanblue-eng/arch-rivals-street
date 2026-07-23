// Neal Spin tutorial controller — attempt lifecycle, interventions, telemetry.
//
// Owns the invariants the spec is built on:
//   - Every completed or interrupted attempt produces EXACTLY ONE terminal
//     result, and an attempt can never emit two failure classes.
//   - Interventions are capped and conditional: hesitation prompts at most
//     twice per session, the recovery line only ever on renewed motion, the
//     timing ghost only on timing failures and never during an active retry.
//   - Abandonment is a lifecycle fact (menu exit, or idling after a failure)
//     that only this controller can observe — the classifier never sees it.
//   - Every event is validated before it reaches the sink; a malformed
//     payload throws instead of silently corrupting the calibration dataset.

import { NealSpinConfig } from "./NealSpinCalibration";
import { classifyAttempt } from "./NealSpinClassifier";
import { parseAttempt } from "./NealSpinIntentParser";
import {
  buildAbandonmentEvent,
  buildFailureEvent,
  buildGhostOverlayShownEvent,
  buildHesitationPromptShownEvent,
  buildHesitationRecoveryEvent,
  buildHesitationRecoveryOutcomeEvent,
  buildIntentScoreEvent,
  buildSuccessEvent,
  validateEvent,
} from "./NealSpinTelemetry";
import {
  AttemptSample,
  InputMethod,
  NealSpinAttemptTrace,
  NealSpinFailure,
  NealSpinResult,
  NealSpinTelemetryEvent,
  TelemetrySink,
} from "./NealSpinTypes";
import { HesitationPrompt } from "./ui/HesitationPrompt";
import { TimingGhostOverlay } from "./ui/TimingGhostOverlay";

export interface AttemptContext {
  inputMethod: InputMethod;
  center: { x: number; y: number };
  windowOpenMs: number;
  windowCloseMs: number;
}

export class NealSpinTutorialController {
  readonly ghostOverlay = new TimingGhostOverlay();
  readonly hesitationPrompt = new HesitationPrompt();

  private readonly config: NealSpinConfig;
  private readonly sink: TelemetrySink;
  private readonly sessionId: string;
  private readonly sessionStartMs: number;

  private attemptNumber = 0;
  private active: { context: AttemptContext; samples: AttemptSample[] } | null = null;

  // Live-intervention state for the active attempt.
  private hesitationDetectedThisAttempt = false;
  private hesitationDetectedAtMs = 0;
  private recoveryFiredThisAttempt = false;
  private promptShownThisAttempt = false;

  // Abandonment watch: armed by a failure, disarmed by the next attempt.
  private lastFailure: { failureClass: NealSpinFailure; atMs: number } | null = null;
  private abandonmentEmitted = false;

  constructor(args: {
    config: NealSpinConfig;
    sink: TelemetrySink;
    sessionId: string;
    sessionStartMs: number;
  }) {
    this.config = args.config;
    this.sink = args.sink;
    this.sessionId = args.sessionId;
    this.sessionStartMs = args.sessionStartMs;
  }

  beginAttempt(context: AttemptContext): void {
    if (this.active) {
      throw new Error("beginAttempt while an attempt is active: end it first");
    }
    this.attemptNumber += 1;
    this.active = { context, samples: [] };
    this.hesitationDetectedThisAttempt = false;
    this.recoveryFiredThisAttempt = false;
    this.promptShownThisAttempt = false;
    // A fresh attempt is an active retry: a stale timing ghost must not
    // survive into it.
    this.ghostOverlay.notifyRetryStarted();
    // Starting a new attempt is engagement — the idle-abandonment watch on
    // the previous failure ends here.
    this.lastFailure = null;
  }

  // Feed one input sample into the active attempt. Live hesitation
  // detection runs here: prompts fire mid-attempt (that is their point),
  // while terminal classification waits for the attempt to end.
  feedSample(sample: AttemptSample): void {
    if (!this.active) throw new Error("feedSample without an active attempt");
    this.active.samples.push(sample);

    const dims = parseAttempt(this.buildTrace(), this.config);

    if (dims.hesitation.occurred && !this.hesitationDetectedThisAttempt) {
      this.hesitationDetectedThisAttempt = true;
      this.hesitationDetectedAtMs = sample.tMs;
      const prompt = this.hesitationPrompt.promptForHesitation();
      if (prompt) {
        this.promptShownThisAttempt = true;
        this.emit(
          buildHesitationPromptShownEvent({
            sessionId: this.sessionId,
            promptText: prompt.text,
            activationCountThisSession: this.hesitationPrompt.promptsShownThisSession,
          }),
        );
      }
    }

    if (
      this.hesitationDetectedThisAttempt &&
      !this.recoveryFiredThisAttempt &&
      dims.hesitation.resumedAfterStop
    ) {
      this.recoveryFiredThisAttempt = true;
      const recovery = this.hesitationPrompt.onMotionResumed();
      if (recovery) {
        this.emit(
          buildHesitationRecoveryEvent({
            sessionId: this.sessionId,
            timeToReengageMs: sample.tMs - this.hesitationDetectedAtMs,
          }),
        );
      }
    }
  }

  // Normal end of an attempt (window expired, gesture finished). Returns the
  // attempt's single terminal result.
  endAttempt(nowMs: number): NealSpinResult {
    if (!this.active) throw new Error("endAttempt without an active attempt");
    const { context } = this.active;
    const dims = parseAttempt(this.buildTrace(), this.config);
    const result = classifyAttempt(dims, this.config, context.inputMethod);
    return this.finalize(result, dims.timingOffsetMs, nowMs);
  }

  // The player bailed to the menu mid-attempt: the attempt is interrupted
  // and its one terminal result is Fail_Abandonment.
  menuExit(nowMs: number): NealSpinResult | null {
    if (this.active) {
      return this.finalize("Fail_Abandonment", 0, nowMs);
    }
    // Menu exit between attempts still abandons the session when a failure
    // was pending — there is just no attempt to attach a result to.
    if (this.lastFailure && !this.abandonmentEmitted) {
      this.emitAbandonment(nowMs);
    }
    return null;
  }

  // Host game loop heartbeat. The ONLY thing a timer may do in this system
  // is detect idle abandonment after a failure — prompts never fire here.
  tick(nowMs: number): void {
    if (
      !this.active &&
      this.lastFailure &&
      !this.abandonmentEmitted &&
      nowMs - this.lastFailure.atMs > this.config.abandonmentIdleMs
    ) {
      this.emitAbandonment(nowMs);
    }
  }

  private buildTrace(): NealSpinAttemptTrace {
    const { context, samples } = this.active!;
    return {
      inputMethod: context.inputMethod,
      center: context.center,
      samples,
      windowOpenMs: context.windowOpenMs,
      windowCloseMs: context.windowCloseMs,
    };
  }

  // Single exit point for every attempt: emits the intent snapshot, exactly
  // one terminal event, and the conditional interventions. `active` is
  // cleared before emitting so no re-entrant path can double-terminate.
  private finalize(result: NealSpinResult, timingOffsetMs: number, nowMs: number): NealSpinResult {
    const { context } = this.active!;
    const dims = parseAttempt(this.buildTrace(), this.config);
    this.active = null;

    this.emit(
      buildIntentScoreEvent({
        sessionId: this.sessionId,
        attemptNumber: this.attemptNumber,
        inputMethod: context.inputMethod,
        dims,
        velocityFloorState: this.config.velocityFloor[context.inputMethod],
        buildMode: this.config.buildMode,
      }),
    );

    if (result === "Success") {
      this.emit(
        buildSuccessEvent({
          sessionId: this.sessionId,
          attemptNumber: this.attemptNumber,
          inputMethod: context.inputMethod,
        }),
      );
    } else {
      this.emit(
        buildFailureEvent({
          sessionId: this.sessionId,
          attemptNumber: this.attemptNumber,
          inputMethod: context.inputMethod,
          failureClass: result,
        }),
      );
      this.lastFailure = { failureClass: result, atMs: nowMs };
      this.abandonmentEmitted = false;
    }

    if (result === "Fail_Timing_Early" || result === "Fail_Timing_Late") {
      this.ghostOverlay.show(result, timingOffsetMs, nowMs);
      this.emit(
        buildGhostOverlayShownEvent({
          sessionId: this.sessionId,
          attemptNumber: this.attemptNumber,
          failureClass: result,
        }),
      );
    }

    // Did the coaching teach? Only meaningful when the player actually
    // re-engaged after a prompt (TechSpec 2.3).
    if (this.promptShownThisAttempt && this.recoveryFiredThisAttempt) {
      this.emit(
        buildHesitationRecoveryOutcomeEvent({ sessionId: this.sessionId, outcome: result }),
      );
    }

    if (result === "Fail_Abandonment") {
      this.emitAbandonment(nowMs);
    }

    return result;
  }

  private emitAbandonment(nowMs: number): void {
    this.abandonmentEmitted = true;
    this.emit(
      buildAbandonmentEvent({
        sessionId: this.sessionId,
        lastFailureClass: this.lastFailure ? this.lastFailure.failureClass : null,
        attemptsThisSession: this.attemptNumber,
        timeInTutorialMs: nowMs - this.sessionStartMs,
      }),
    );
  }

  private emit(event: NealSpinTelemetryEvent): void {
    const problems = validateEvent(event);
    if (problems.length > 0) {
      throw new Error(`invalid telemetry payload for ${event.type}: ${problems.join("; ")}`);
    }
    this.sink.emit(event);
  }
}
