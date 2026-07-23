"use strict";
// Neal Spin intent parser (TechSpec 1.1).
//
// Converts a recorded attempt trace into raw intent dimensions. The parser
// measures; it never judges — pass/fail lives entirely in the classifier.
//
// Measurement model:
//   - Samples become angles about the Magic Circle center; consecutive
//     samples form segments with a time delta and an angular delta
//     (normalized to (-180, 180], so wraparound never fabricates rotation).
//   - Positive angular delta is "cw" in screen coordinates (y grows down).
//   - A segment "moves" only above MOTION_EPSILON_DEG, so a resting finger's
//     sensor jitter is not rotation.
//   - Pauses up to pauseBridgeMaxMs are BRIDGED: moving segments on either
//     side belong to the same arc chain. A longer pause SPLITS the attempt
//     into separate chains — rotation does not accumulate across the split.
//     This is what "breaks continuity" means, and it is why a player who
//     hesitates early and then recovers with a complete spin can still
//     succeed: the post-recovery chain stands on its own.
//   - The reported arc/direction/backtrack/velocity dimensions describe the
//     BEST chain (largest dominant-direction coverage) — the candidate spin.
//     Pause, duration, timing, and hesitation dimensions describe the whole
//     attempt.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAttempt = parseAttempt;
function normalizeDelta(deg) {
    let d = deg % 360;
    if (d > 180)
        d -= 360;
    if (d <= -180)
        d += 360;
    return d;
}
// Angular deltas are quantized to a millionth of a degree. The boundary
// semantics are exact by specification (a 30.000° backtrack is tolerated, a
// 250ms pause is bridged), and without quantization the atan2 round trip's
// ~1e-13 float noise could push a spec-exact gesture across a threshold.
// One micro-degree is far below any real input's precision.
function quantizeDelta(deg) {
    return Math.round(deg * 1e6) / 1e6;
}
function toAngleDeg(sample, center) {
    return (Math.atan2(sample.y - center.y, sample.x - center.x) * 180) / Math.PI;
}
function buildSegments(trace, config) {
    const segments = [];
    for (let i = 1; i < trace.samples.length; i++) {
        const dtMs = trace.samples[i].tMs - trace.samples[i - 1].tMs;
        const dAngleDeg = quantizeDelta(normalizeDelta(toAngleDeg(trace.samples[i], trace.center) - toAngleDeg(trace.samples[i - 1], trace.center)));
        segments.push({
            dtMs,
            dAngleDeg,
            moving: Math.abs(dAngleDeg) >= config.motionEpsilonDeg,
        });
    }
    return segments;
}
function chainDominant(chain) {
    const movingSegments = chain.cwSegments + chain.ccwSegments;
    if (movingSegments === 0) {
        return { direction: "ambiguous", ratio: 0, coverageDeg: 0 };
    }
    const cwLeads = chain.cwSegments >= chain.ccwSegments;
    const ratio = (cwLeads ? chain.cwSegments : chain.ccwSegments) / movingSegments;
    const coverageDeg = cwLeads ? chain.coverageCwDeg : chain.coverageCcwDeg;
    return { direction: cwLeads ? "cw" : "ccw", ratio, coverageDeg };
}
function parseAttempt(trace, config) {
    const segments = buildSegments(trace, config);
    // --- Chain construction: bridge short pauses, split on long ones. -------
    // A pause is time without angular progress: every non-moving segment's dt
    // counts toward the current pause run. A MOVING segment with dt above the
    // bridge limit is also a split (the input stream had a hole), but its dt
    // is motion time, not pause time.
    const chains = [];
    let current = null;
    let pauseRunMs = 0;
    let maxPauseMs = 0;
    // Hesitation bookkeeping (whole-attempt scope).
    let motionStarted = false;
    let grossRotationDeg = 0; // cumulative |dAngle| of moving segments so far
    let hesitation = {
        occurred: false,
        stopDurationMs: 0,
        coverageAtStopDeg: 0,
        resumedAfterStop: false,
    };
    let coverageAtRunStartDeg = 0;
    const closePauseRun = () => {
        if (pauseRunMs > 0) {
            maxPauseMs = Math.max(maxPauseMs, pauseRunMs);
            if (motionStarted &&
                !hesitation.occurred &&
                pauseRunMs > config.hesitationStopMs &&
                coverageAtRunStartDeg < config.hesitationMaxCoverageDeg) {
                hesitation = {
                    occurred: true,
                    stopDurationMs: pauseRunMs,
                    coverageAtStopDeg: coverageAtRunStartDeg,
                    resumedAfterStop: false,
                };
            }
            pauseRunMs = 0;
        }
    };
    let backtrack = { runVsCw: 0, runVsCcw: 0, maxVsCw: 0, maxVsCcw: 0 };
    const chainBacktracks = [];
    const startChain = () => {
        current = {
            coverageCwDeg: 0,
            coverageCcwDeg: 0,
            cwSegments: 0,
            ccwSegments: 0,
            maxBacktrackDeg: 0,
            activeMotionMs: 0,
        };
        backtrack = { runVsCw: 0, runVsCcw: 0, maxVsCw: 0, maxVsCcw: 0 };
    };
    const closeChain = () => {
        if (current) {
            chains.push(current);
            chainBacktracks.push(backtrack);
            current = null;
        }
    };
    for (const seg of segments) {
        if (!seg.moving) {
            pauseRunMs += seg.dtMs;
            if (pauseRunMs > config.pauseBridgeMaxMs) {
                closeChain();
            }
            continue;
        }
        // Moving segment. A delivery hole longer than the bridge limit splits
        // the chain even though this segment itself is motion.
        if (seg.dtMs > config.pauseBridgeMaxMs) {
            maxPauseMs = Math.max(maxPauseMs, seg.dtMs);
            closeChain();
        }
        closePauseRun();
        if (motionStarted && hesitation.occurred) {
            hesitation.resumedAfterStop = true;
        }
        motionStarted = true;
        if (!current)
            startChain();
        const chain = current;
        chain.activeMotionMs += seg.dtMs;
        const magnitude = Math.abs(seg.dAngleDeg);
        if (seg.dAngleDeg > 0) {
            chain.coverageCwDeg += magnitude;
            chain.cwSegments += 1;
            backtrack.runVsCw = 0;
            backtrack.runVsCcw += magnitude;
            backtrack.maxVsCcw = Math.max(backtrack.maxVsCcw, backtrack.runVsCcw);
        }
        else {
            chain.coverageCcwDeg += magnitude;
            chain.ccwSegments += 1;
            backtrack.runVsCcw = 0;
            backtrack.runVsCw += magnitude;
            backtrack.maxVsCw = Math.max(backtrack.maxVsCw, backtrack.runVsCw);
        }
        grossRotationDeg += magnitude;
        coverageAtRunStartDeg = grossRotationDeg;
    }
    closePauseRun();
    closeChain();
    // --- Pick the best chain: the candidate spin. ---------------------------
    let best = null;
    let bestBacktrack = null;
    let bestCoverage = -1;
    for (let i = 0; i < chains.length; i++) {
        const { coverageDeg } = chainDominant(chains[i]);
        if (coverageDeg > bestCoverage) {
            bestCoverage = coverageDeg;
            best = chains[i];
            bestBacktrack = chainBacktracks[i];
        }
    }
    let arcCoverageDeg = 0;
    let dominantDirection = "ambiguous";
    let dominantDirectionRatio = 0;
    let maxBacktrackDeg = 0;
    let activeMotionMs = 0;
    if (best && bestBacktrack) {
        const dom = chainDominant(best);
        arcCoverageDeg = dom.coverageDeg;
        dominantDirectionRatio = dom.ratio;
        dominantDirection = dom.ratio >= config.dominantDirectionMinRatio ? dom.direction : "ambiguous";
        maxBacktrackDeg = dom.direction === "ccw" ? bestBacktrack.maxVsCcw : bestBacktrack.maxVsCw;
        activeMotionMs = best.activeMotionMs;
    }
    const angularVelocityDegPerSec = activeMotionMs > 0 ? arcCoverageDeg / (activeMotionMs / 1000) : 0;
    // --- Timing: input registration vs. the animation window. ---------------
    let timingOffsetMs = 0;
    if (trace.samples.length > 0) {
        const t0 = trace.samples[0].tMs;
        if (t0 < trace.windowOpenMs) {
            timingOffsetMs = t0 - trace.windowOpenMs; // negative: early
        }
        else if (t0 > trace.windowCloseMs) {
            timingOffsetMs = t0 - trace.windowCloseMs; // positive: late
        }
    }
    const totalDurationMs = trace.samples.length >= 2
        ? trace.samples[trace.samples.length - 1].tMs - trace.samples[0].tMs
        : 0;
    return {
        arcCoverageDeg,
        dominantDirection,
        dominantDirectionRatio,
        maxBacktrackDeg,
        maxPauseMs,
        continuityBroken: maxPauseMs > config.pauseBridgeMaxMs,
        angularVelocityDegPerSec,
        activeMotionMs,
        timingOffsetMs,
        hesitation,
        totalDurationMs,
        sampleCount: trace.samples.length,
    };
}
