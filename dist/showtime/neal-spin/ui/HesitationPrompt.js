"use strict";
// Hesitation micro-prompt (TechSpec 2.3) — pure state machine, no rendering.
//
// Encouragement in the game's own voice, rendered low-opacity inside the
// Magic Circle near the player's feet — never a modal, toast, or HUD element.
//
// Sequence per session:
//   1st hesitation  → "Don't blink."
//   2nd hesitation  → "Paint the floor."
//   3rd+            → nothing. Hard cap of two prompts per session.
// Recovery: "Keep it moving." fires when the player's motion resumes after a
// prompt. It is structurally motion-triggered — this class has no clock, no
// tick method, and no timer to fire it from; the only path to the recovery
// line is the controller reporting renewed motion.
Object.defineProperty(exports, "__esModule", { value: true });
exports.HesitationPrompt = exports.HESITATION_RECOVERY_PROMPT = exports.HESITATION_PROMPTS = void 0;
const NealSpinCalibration_1 = require("../NealSpinCalibration");
exports.HESITATION_PROMPTS = ["Don't blink.", "Paint the floor."];
exports.HESITATION_RECOVERY_PROMPT = "Keep it moving.";
function display(text) {
    return {
        text,
        fontPt: NealSpinCalibration_1.HESITATION_PROMPT_FONT_PT,
        opacity: NealSpinCalibration_1.HESITATION_PROMPT_OPACITY,
        durationMs: NealSpinCalibration_1.HESITATION_PROMPT_DURATION_MS,
        fadeMs: NealSpinCalibration_1.HESITATION_PROMPT_FADE_MS,
        placement: "magic-circle-feet",
    };
}
class HesitationPrompt {
    constructor() {
        this.promptsShown = 0;
        this.recoveryArmed = false;
    }
    // Called by the controller when a hesitation is detected. Returns the
    // prompt to display, or null when the session cap is exhausted.
    promptForHesitation() {
        if (this.promptsShown >= NealSpinCalibration_1.HESITATION_PROMPT_SESSION_CAP)
            return null;
        const text = exports.HESITATION_PROMPTS[this.promptsShown];
        this.promptsShown += 1;
        this.recoveryArmed = true;
        return display(text);
    }
    // Called by the controller when angular motion resumes. Returns the
    // recovery line exactly once per shown prompt; null when no prompt is
    // awaiting recovery. There is deliberately no time-based path here.
    onMotionResumed() {
        if (!this.recoveryArmed)
            return null;
        this.recoveryArmed = false;
        return display(exports.HESITATION_RECOVERY_PROMPT);
    }
    get promptsShownThisSession() {
        return this.promptsShown;
    }
    resetSession() {
        this.promptsShown = 0;
        this.recoveryArmed = false;
    }
}
exports.HesitationPrompt = HesitationPrompt;
