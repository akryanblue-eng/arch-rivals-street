"use strict";
// Neal Spin diagnostic core — shared types.
//
// Implements ARS-NEAL-001 against the ArchRivals Showtime TechSpec v1.0
// (Sections 1 and 4). The architectural shift: the parser detects rotational
// INTENT across independent raw dimensions; a separate classifier maps those
// dimensions onto exactly one terminal result per attempt. There is no
// generic NealSpin_Fail anywhere in this taxonomy, by design.
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEAL_SPIN_RESULTS = void 0;
// Mutually exclusive terminal results. Exactly one per completed or
// interrupted attempt; the classifier can emit any of these except
// Fail_Abandonment, which only the tutorial controller can conclude
// (menu exit, or idle after a failure — lifecycle facts the trace
// cannot contain).
exports.NEAL_SPIN_RESULTS = [
    "Success",
    "Fail_Timing_Early",
    "Fail_Timing_Late",
    "Fail_Dexterity_Speed",
    "Fail_Dexterity_Path",
    "Fail_Hesitation",
    "Fail_Abandonment",
];
