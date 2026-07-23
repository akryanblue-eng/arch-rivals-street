"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NealSpinTutorialController = void 0;
const NealSpinCalibration_1 = require("./NealSpinCalibration");
const NealSpinClassifier_1 = require("./NealSpinClassifier");
const NealSpinIntentParser_1 = require("./NealSpinIntentParser");
const NealSpinTelemetry_1 = require("./NealSpinTelemetry");
const HesitationPrompt_1 = require("./ui/HesitationPrompt");
const TimingGhostOverlay_1 = require("./ui/TimingGhostOverlay");
class NealSpinTutorialController {
    constructor(args) {
        this.ghostOverlay = new TimingGhostOverlay_1.TimingGhostOverlay();
        this.hesitationPrompt = new HesitationPrompt_1.HesitationPrompt();
        this.attemptNumber = 0;
        this.active = null;
        // Live-intervention state for the active attempt.
        this.hesitationDetectedThisAttempt = false;
        this.hesitationDetectedAtMs = 0;
        this.recoveryFiredThisAttempt = false;
        this.promptShownThisAttempt = false;
        // Abandonment watch: armed by a failure, disarmed by the next attempt.
        this.lastFailure = null;
        this.abandonmentEmitted = false;
        // When a timing ghost was shown for the previous attempt, the next retry
        // reports how long it had been on screen (Event_GhostOverlay_Read).
        this.ghostShownAtMs = null;
        // An uncalibrated production config is refused here, at initialization —
        // a configuration defect must fail against the build, not the player.
        (0, NealSpinCalibration_1.assertConfigLaunchable)(args.config);
        this.config = args.config;
        this.sink = args.sink;
        this.sessionId = args.sessionId;
        this.sessionStartMs = args.sessionStartMs;
    }
    beginAttempt(context, nowMs) {
        if (this.active) {
            throw new Error("beginAttempt while an attempt is active: end it first");
        }
        this.attemptNumber += 1;
        this.active = { context, samples: [] };
        this.hesitationDetectedThisAttempt = false;
        this.recoveryFiredThisAttempt = false;
        this.promptShownThisAttempt = false;
        // Did the player let the timing ghost display before retrying, or blow
        // straight past it? Reported before the ghost is dismissed below.
        if (this.ghostShownAtMs !== null) {
            this.emit((0, NealSpinTelemetry_1.buildGhostOverlayReadEvent)({
                sessionId: this.sessionId,
                timeElapsedBeforeRetryMs: Math.max(0, nowMs - this.ghostShownAtMs),
            }));
            this.ghostShownAtMs = null;
        }
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
    feedSample(sample) {
        if (!this.active)
            throw new Error("feedSample without an active attempt");
        this.active.samples.push(sample);
        const dims = (0, NealSpinIntentParser_1.parseAttempt)(this.buildTrace(), this.config);
        if (dims.hesitation.occurred && !this.hesitationDetectedThisAttempt) {
            this.hesitationDetectedThisAttempt = true;
            this.hesitationDetectedAtMs = sample.tMs;
            const prompt = this.hesitationPrompt.promptForHesitation();
            if (prompt) {
                this.promptShownThisAttempt = true;
                this.emit((0, NealSpinTelemetry_1.buildHesitationPromptShownEvent)({
                    sessionId: this.sessionId,
                    promptText: prompt.text,
                    activationCountThisSession: this.hesitationPrompt.promptsShownThisSession,
                }));
            }
        }
        if (this.hesitationDetectedThisAttempt &&
            !this.recoveryFiredThisAttempt &&
            dims.hesitation.resumedAfterStop) {
            this.recoveryFiredThisAttempt = true;
            const recovery = this.hesitationPrompt.onMotionResumed();
            if (recovery) {
                this.emit((0, NealSpinTelemetry_1.buildHesitationRecoveryEvent)({
                    sessionId: this.sessionId,
                    timeToReengageMs: sample.tMs - this.hesitationDetectedAtMs,
                }));
            }
        }
    }
    // Normal end of an attempt (window expired, gesture finished). Returns the
    // attempt's single terminal result.
    endAttempt(nowMs) {
        if (!this.active)
            throw new Error("endAttempt without an active attempt");
        const { context } = this.active;
        const dims = (0, NealSpinIntentParser_1.parseAttempt)(this.buildTrace(), this.config);
        const result = (0, NealSpinClassifier_1.classifyAttempt)(dims, this.config, context.inputMethod);
        return this.finalize(result, dims.timingOffsetMs, nowMs);
    }
    // The player bailed to the menu mid-attempt: the attempt is interrupted
    // and its one terminal result is Fail_Abandonment.
    menuExit(nowMs) {
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
    tick(nowMs) {
        if (!this.active &&
            this.lastFailure &&
            !this.abandonmentEmitted &&
            nowMs - this.lastFailure.atMs > this.config.abandonmentIdleMs) {
            this.emitAbandonment(nowMs);
        }
    }
    buildTrace() {
        const { context, samples } = this.active;
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
    finalize(result, timingOffsetMs, nowMs) {
        const { context } = this.active;
        const dims = (0, NealSpinIntentParser_1.parseAttempt)(this.buildTrace(), this.config);
        this.active = null;
        this.emit((0, NealSpinTelemetry_1.buildIntentScoreEvent)({
            sessionId: this.sessionId,
            attemptNumber: this.attemptNumber,
            inputMethod: context.inputMethod,
            dims,
            velocityFloorState: this.config.velocityFloor[context.inputMethod],
            buildMode: this.config.buildMode,
        }));
        if (result === "Success") {
            this.emit((0, NealSpinTelemetry_1.buildSuccessEvent)({
                sessionId: this.sessionId,
                attemptNumber: this.attemptNumber,
                inputMethod: context.inputMethod,
            }));
        }
        else {
            this.emit((0, NealSpinTelemetry_1.buildFailureEvent)({
                sessionId: this.sessionId,
                attemptNumber: this.attemptNumber,
                inputMethod: context.inputMethod,
                failureClass: result,
            }));
            this.lastFailure = { failureClass: result, atMs: nowMs };
            this.abandonmentEmitted = false;
        }
        if (result === "Fail_Timing_Early" || result === "Fail_Timing_Late") {
            this.ghostOverlay.show(result, timingOffsetMs, nowMs);
            this.ghostShownAtMs = nowMs;
            this.emit((0, NealSpinTelemetry_1.buildGhostOverlayShownEvent)({
                sessionId: this.sessionId,
                attemptNumber: this.attemptNumber,
                failureClass: result,
            }));
        }
        // Did the coaching teach? Only meaningful when the player actually
        // re-engaged after a prompt (TechSpec 2.3).
        if (this.promptShownThisAttempt && this.recoveryFiredThisAttempt) {
            this.emit((0, NealSpinTelemetry_1.buildHesitationRecoveryOutcomeEvent)({ sessionId: this.sessionId, outcome: result }));
        }
        if (result === "Fail_Abandonment") {
            this.emitAbandonment(nowMs);
        }
        return result;
    }
    emitAbandonment(nowMs) {
        this.abandonmentEmitted = true;
        this.emit((0, NealSpinTelemetry_1.buildAbandonmentEvent)({
            sessionId: this.sessionId,
            lastFailureClass: this.lastFailure ? this.lastFailure.failureClass : null,
            attemptsThisSession: this.attemptNumber,
            timeInTutorialMs: nowMs - this.sessionStartMs,
        }));
    }
    emit(event) {
        const problems = (0, NealSpinTelemetry_1.validateEvent)(event);
        if (problems.length > 0) {
            throw new Error(`invalid telemetry payload for ${event.type}: ${problems.join("; ")}`);
        }
        this.sink.emit(event);
    }
}
exports.NealSpinTutorialController = NealSpinTutorialController;
