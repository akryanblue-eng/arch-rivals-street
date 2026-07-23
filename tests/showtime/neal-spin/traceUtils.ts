// Shared helpers for the Neal Spin specs: synthetic trace construction and
// fixture loading. Fixture JSONs are recorded-trace artifacts committed under
// fixtures/ — the loader resolves them from the source tree whether the specs
// run compiled (dist-tests/) or directly from source.

import * as fs from "fs";
import * as path from "path";
import {
  defaultConfig,
  NealSpinConfig,
} from "../../../src/showtime/neal-spin/NealSpinCalibration";
import {
  AttemptSample,
  BuildMode,
  InputMethod,
  NealSpinAttemptTrace,
} from "../../../src/showtime/neal-spin/NealSpinTypes";

export const CENTER = { x: 400, y: 300 };
export const RADIUS = 100;
export const WINDOW_OPEN_MS = 10000;
export const WINDOW_CLOSE_MS = 10600;

export function pointAt(angleDeg: number, tMs: number): AttemptSample {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    tMs,
    x: CENTER.x + RADIUS * Math.cos(rad),
    y: CENTER.y + RADIUS * Math.sin(rad),
  };
}

export interface Step {
  d: number; // angular delta in degrees; 0 holds still
  dt: number; // milliseconds since previous sample
}

export function rep(n: number, step: Step): Step[] {
  return Array.from({ length: n }, () => ({ ...step }));
}

export function makeTrace(
  t0: number,
  steps: Step[],
  inputMethod: InputMethod = "touch",
): NealSpinAttemptTrace {
  let angle = 0;
  let t = t0;
  const samples: AttemptSample[] = [pointAt(angle, t)];
  for (const s of steps) {
    angle += s.d;
    t += s.dt;
    samples.push(pointAt(angle, t));
  }
  return {
    inputMethod,
    center: CENTER,
    samples,
    windowOpenMs: WINDOW_OPEN_MS,
    windowCloseMs: WINDOW_CLOSE_MS,
  };
}

// --- Fixtures --------------------------------------------------------------

export interface FixtureFile {
  name: string;
  description: string;
  trace: NealSpinAttemptTrace;
  config: {
    buildMode: BuildMode;
    touchFloorDegPerSec: number | null;
    controllerFloorDegPerSec: number | null;
  };
  expected: {
    classification: string;
    dominantDirection?: string;
    minArcCoverageDeg?: number;
    maxBacktrackDeg?: number;
    continuityBroken?: boolean;
    hesitationOccurred?: boolean;
    hesitationResumed?: boolean;
    timingOffsetMs?: number;
  };
}

function fixturesDir(): string {
  const compiled = path.join(__dirname, "fixtures"); // running from source
  if (fs.existsSync(compiled)) return compiled;
  // Running from dist-tests/tests/showtime/neal-spin: fixtures stay in the
  // source tree (JSON is not compiled), four levels up from here.
  return path.resolve(__dirname, "../../../..", "tests/showtime/neal-spin/fixtures");
}

export function loadFixtures(): FixtureFile[] {
  const dir = fixturesDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as FixtureFile);
}

export function configForFixture(fixture: FixtureFile): NealSpinConfig {
  const config = defaultConfig(fixture.config.buildMode);
  if (fixture.config.touchFloorDegPerSec !== null) {
    config.velocityFloor.touch = {
      status: "calibrated",
      floorDegPerSec: fixture.config.touchFloorDegPerSec,
    };
  }
  if (fixture.config.controllerFloorDegPerSec !== null) {
    config.velocityFloor.controller = {
      status: "calibrated",
      floorDegPerSec: fixture.config.controllerFloorDegPerSec,
    };
  }
  return config;
}
