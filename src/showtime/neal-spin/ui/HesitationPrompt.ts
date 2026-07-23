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

import {
  HESITATION_PROMPT_DURATION_MS,
  HESITATION_PROMPT_FADE_MS,
  HESITATION_PROMPT_FONT_PT,
  HESITATION_PROMPT_OPACITY,
  HESITATION_PROMPT_SESSION_CAP,
} from "../NealSpinCalibration";

export const HESITATION_PROMPTS = ["Don't blink.", "Paint the floor."] as const;
export const HESITATION_RECOVERY_PROMPT = "Keep it moving.";

export interface HesitationPromptDisplay {
  text: string;
  fontPt: number;
  opacity: number;
  durationMs: number;
  fadeMs: number;
  // Render placement contract, not pixel coordinates: inside the Magic
  // Circle zone near the player's feet (TechSpec 2.3).
  placement: "magic-circle-feet";
}

function display(text: string): HesitationPromptDisplay {
  return {
    text,
    fontPt: HESITATION_PROMPT_FONT_PT,
    opacity: HESITATION_PROMPT_OPACITY,
    durationMs: HESITATION_PROMPT_DURATION_MS,
    fadeMs: HESITATION_PROMPT_FADE_MS,
    placement: "magic-circle-feet",
  };
}

export class HesitationPrompt {
  private promptsShown = 0;
  private recoveryArmed = false;

  // Called by the controller when a hesitation is detected. Returns the
  // prompt to display, or null when the session cap is exhausted.
  promptForHesitation(): HesitationPromptDisplay | null {
    if (this.promptsShown >= HESITATION_PROMPT_SESSION_CAP) return null;
    const text = HESITATION_PROMPTS[this.promptsShown];
    this.promptsShown += 1;
    this.recoveryArmed = true;
    return display(text);
  }

  // Called by the controller when angular motion resumes. Returns the
  // recovery line exactly once per shown prompt; null when no prompt is
  // awaiting recovery. There is deliberately no time-based path here.
  onMotionResumed(): HesitationPromptDisplay | null {
    if (!this.recoveryArmed) return null;
    this.recoveryArmed = false;
    return display(HESITATION_RECOVERY_PROMPT);
  }

  get promptsShownThisSession(): number {
    return this.promptsShown;
  }

  resetSession(): void {
    this.promptsShown = 0;
    this.recoveryArmed = false;
  }
}
