const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

const HOOP_LEFT = { x: 80, y: 300 };
const HOOP_RIGHT = { x: 820, y: 300 };

const state = {
  players: [
    { id: "A1", x: 200, y: 300, vx: 0, vy: 0, team: "A", pressure: 0, visual: makeVisual(200, 300) },
    { id: "A2", x: 250, y: 350, vx: 0, vy: 0, team: "A", pressure: 0, visual: makeVisual(250, 350) },
    { id: "B1", x: 700, y: 300, vx: 0, vy: 0, team: "B", pressure: 0, visual: makeVisual(700, 300) },
    { id: "B2", x: 650, y: 350, vx: 0, vy: 0, team: "B", pressure: 0, visual: makeVisual(650, 350) }
  ],
  // Center court (450,300), matching resetAfterScore()'s tip-off spot: player
  // start positions are symmetric around this point (A1/B1 200 vs 250 from
  // center, A2/B2 200 vs 250), but the ball previously spawned at x=300 —
  // only 100 units from team A's starting pair and 350+ from team B's,
  // handing team A first possession before any gameplay logic even runs.
  ball: { x: 450, y: 300, vx: 0, vy: 0, owner: null, shotClock: 0, shotClockOwner: null, inAir: false },
  score: { A: 0, B: 0 },
  gameOver: false,
  winner: null
};

const POINTS_PER_BASKET = 2;
const WIN_SCORE = 11;

const keys = {};
window.addEventListener("keydown", e => keys[e.key] = true);
window.addEventListener("keyup", e => keys[e.key] = false);

// Cosmetic-only presentation state: per-player visual, ball trail, transient
// effects (impact flash, score popups), screen shake, and camera zoom. This
// entire layer is read-only with respect to game logic: it observes
// state.players / state.ball / state.score each frame and never writes back
// into anything gameplay code reads (position, possession, pressure,
// aiState, score). Animation timing must never become an input to steals,
// movement, scoring, or possession.
function makeVisual(x, y) {
  return { squash: 1, angle: 0, facing: 1, bob: 0, bobPhase: 0, flash: 0, lunge: 0, prevX: x, prevY: y };
}

const ballTrail = [];
const effects = [];
let shakeMagnitude = 0;
let zoom = 1;
let zoomFocusX = 450;
let zoomFocusY = 300;
let ballPop = 0; // purely a drawn-radius bump on the ball, never touches its real x/y/vx/vy

function triggerBallPop() {
  ballPop = 1;
}

// Dribble signature: a rhythmic bounce read purely off the ball's own
// position delta each frame (identical to the carrier's delta while
// owned, since updateBall() snaps ball.x/y to the carrier exactly) — no
// dependency on player.visual internals, so this stays fully self-
// contained. bounce only ever affects drawBall()'s drawn radius/offset,
// never state.ball.x/y/vx/vy.
const ballVisual = { prevX: 300, prevY: 300, bouncePhase: 0, bounce: 0 };

function updateBallVisual() {
  const ball = state.ball;
  const dx = ball.x - ballVisual.prevX;
  const dy = ball.y - ballVisual.prevY;
  const speed = Math.sqrt(dx * dx + dy * dy);

  if (ball.owner && speed > 0.1) {
    ballVisual.bouncePhase += 0.9;
    ballVisual.bounce = Math.abs(Math.sin(ballVisual.bouncePhase));
  } else {
    ballVisual.bounce *= 0.8;
    if (ballVisual.bounce < 0.02) ballVisual.bounce = 0;
  }

  ballVisual.prevX = ball.x;
  ballVisual.prevY = ball.y;
}

// Camera: a fixed zoom-to-fill factor plus horizontal follow of the ball.
// Two separate rects on purpose: CAMERA_FIT controls how tightly zoomed in
// the view is (smaller = more zoomed), CAMERA_PAN_BOUNDS controls how far
// the camera's center may travel — deliberately wider than the court so
// court-edge geometry (hoops, backboards) never clips against the canvas
// edge even when the existing shot/score zoom-pulse (unchanged, below)
// briefly stacks extra zoom on top of this base. Purely a world-to-screen
// mapping for rendering — world coordinates (HOOP_LEFT, clampToCourt's
// bounds, the 450/300 reset point, etc.) are untouched.
const CAMERA_FIT = { width: 700, height: 460 };
const CAMERA_PAN_BOUNDS = { left: -40, right: 940, top: 10, bottom: 590 };
const CAMERA_ZOOM = 1.55;
let cameraX = 450;
let cameraY = 300;

// Vertical dead zone: as long as the ball stays within CAMERA_DEADZONE_Y of
// center court, the camera holds steady at y=300 instead of chasing every
// small vertical wiggle. Only once the ball crosses that band does the
// camera start easing to follow — keeping the ball at the edge of the
// zone, not centered on it — so normal possession play doesn't turn the
// camera into a nervous drone operator.
const CAMERA_DEADZONE_Y = 50;

function updateCamera() {
  cameraX += (state.ball.x - cameraX) * 0.06;

  let targetY = 300;
  if (state.ball.y > 300 + CAMERA_DEADZONE_Y) {
    targetY = state.ball.y - CAMERA_DEADZONE_Y;
  } else if (state.ball.y < 300 - CAMERA_DEADZONE_Y) {
    targetY = state.ball.y + CAMERA_DEADZONE_Y;
  }
  cameraY += (targetY - cameraY) * 0.06;
}

function getCameraTransform() {
  const scale = Math.max(canvas.width / CAMERA_FIT.width, canvas.height / CAMERA_FIT.height) * CAMERA_ZOOM;

  const halfW = canvas.width / scale / 2;
  const halfH = canvas.height / scale / 2;

  let x = cameraX;
  const minX = CAMERA_PAN_BOUNDS.left + halfW;
  const maxX = CAMERA_PAN_BOUNDS.right - halfW;
  x = minX <= maxX ? Math.max(minX, Math.min(maxX, x)) : (CAMERA_PAN_BOUNDS.left + CAMERA_PAN_BOUNDS.right) / 2;

  let y = cameraY;
  const minY = CAMERA_PAN_BOUNDS.top + halfH;
  const maxY = CAMERA_PAN_BOUNDS.bottom - halfH;
  y = minY <= maxY ? Math.max(minY, Math.min(maxY, y)) : (CAMERA_PAN_BOUNDS.top + CAMERA_PAN_BOUNDS.bottom) / 2;

  return { scale, x, y };
}

function triggerShake(amount) {
  shakeMagnitude = Math.max(shakeMagnitude, amount);
}

function triggerZoomPulse(amount, focusX, focusY) {
  zoom = Math.max(zoom, amount);
  zoomFocusX = focusX;
  zoomFocusY = focusY;
}

function spawnFlash(x, y) {
  effects.push({ type: "flash", x, y, ttl: 14, maxTtl: 14 });
}

function spawnPopup(x, y, text, color) {
  effects.push({ type: "popup", x, y, text, color, ttl: 40, maxTtl: 40 });
}

// Closest-player-wins, not first-in-array-wins: state.players is always
// ordered [A1, A2, B1, B2], so iterating in place and taking the first
// match in range silently favored team A in every loose-ball contest
// regardless of who was actually closest. Confirmed via instrumented
// playthrough: a rebound where B1 stood at distance 0 on the ball still
// lost possession to A2 at distance 19.5, purely from array order.
function tryGainPossession() {
  if (state.ball.owner) return;
  // A ball in flight can't be "gained" by proximity: shoot() clears owner
  // and sets inAir in the same frame that ball.x/y still holds the
  // shooter's own last position (updateBall() hasn't moved it yet this
  // frame), so without this check the shooter was immediately re-awarded
  // the ball at distance 0 before the shot ever visibly left their hands —
  // turning every shot attempt into a same-frame no-op, and leaving owner
  // and inAir both set at once, which let checkScore fire off the stale
  // inAir flag using the re-synced carrier position as a fake "make" with
  // no real shot ever having flown. A flighted ball must land (updateBall
  // clearing inAir) before anyone, including the shooter, can pick it up.
  if (state.ball.inAir) return;
  let closest = null;
  let closestDist = 15;
  for (const player of state.players) {
    const dx = player.x - state.ball.x;
    const dy = player.y - state.ball.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) {
      closest = player;
      closestDist = dist;
    }
  }
  if (closest) {
    state.ball.owner = closest.id;
  }
}

function shoot(player) {
  if (state.ball.owner !== player.id) return;
  state.ball.owner = null;
  state.ball.inAir = true;
  // Target by team, not by which half of the court the shooter is
  // currently standing on: attackHoopFor(player.team) is exactly what
  // runDefenderAI already uses to decide *whether* a player is close enough
  // to shoot, so using anything else here to decide *where* to aim can
  // disagree with it — and does, every time a player has crossed midcourt
  // on the way to their own hoop (i.e. every real scoring position).
  const hoop = attackHoopFor(player.team);
  const dx = hoop.x - player.x;
  const dy = hoop.y - player.y;
  const power = 0.08;
  state.ball.vx = dx * power;
  state.ball.vy = dy * power - 2;
  triggerZoomPulse(1.12, hoop.x, hoop.y);
}

function updateBall() {
  const ball = state.ball;
  if (ball.owner) {
    const p = state.players.find(p => p.id === ball.owner);
    ball.x = p.x;
    ball.y = p.y;
    return;
  }
  if (ball.inAir) {
    ball.x += ball.vx;
    ball.y += ball.vy;
    ball.vy += 0.05;
    if (ball.y > 550) {
      ball.inAir = false;
      ball.vx = 0;
      ball.vy = 0;
    }
    return;
  }
  ball.x += ball.vx;
  ball.y += ball.vy;
  ball.vx *= 0.95;
  ball.vy *= 0.95;
  ball.x = Math.max(50, Math.min(850, ball.x));
  ball.y = Math.max(50, Math.min(550, ball.y));
}

// Same closest-wins fix as tryGainPossession, same reason.
function checkRebound() {
  if (state.ball.inAir) return;
  let closest = null;
  let closestDist = 20;
  for (const p of state.players) {
    const dx = p.x - state.ball.x;
    const dy = p.y - state.ball.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < closestDist) {
      closest = p;
      closestDist = dist;
    }
  }
  if (closest) {
    state.ball.owner = closest.id;
  }
}

function attackingTeamForHoop(hoop) {
  return hoop === HOOP_RIGHT ? "A" : "B";
}

function resetAfterScore() {
  const ball = state.ball;
  ball.owner = null;
  ball.inAir = false;
  ball.vx = 0;
  ball.vy = 0;
  ball.x = 450;
  ball.y = 300;
  ballTrail.length = 0;
}

function checkScore() {
  if (state.gameOver) return;
  const ball = state.ball;
  if (!ball.inAir) return;
  for (const hoop of [HOOP_LEFT, HOOP_RIGHT]) {
    const dx = ball.x - hoop.x;
    const dy = ball.y - hoop.y;
    if (Math.sqrt(dx * dx + dy * dy) < 14) {
      const team = attackingTeamForHoop(hoop);
      state.score[team] += POINTS_PER_BASKET;
      spawnPopup(hoop.x, hoop.y - 20, `+${POINTS_PER_BASKET}`, team === "A" ? "#60a5fa" : "#f87171");
      triggerShake(6);
      const isWinningBasket = state.score[team] >= WIN_SCORE;
      triggerZoomPulse(isWinningBasket ? 1.7 : 1.25, hoop.x, hoop.y);
      if (isWinningBasket) {
        state.gameOver = true;
        state.winner = team;
      }
      resetAfterScore();
      return;
    }
  }
}

function clampToCourt(p) {
  p.x = Math.max(60, Math.min(840, p.x));
  p.y = Math.max(60, Math.min(540, p.y));
}

// Deterministic finite-state machine for every non-player-controlled athlete.
// State is derived fresh each frame from ball possession — no stored transition
// history — so behavior stays reproducible given the same state snapshot.
const AI_STATE = {
  CHASE_BALL: "CHASE_BALL", // ball is loose: race to it
  GUARD_CARRIER: "GUARD_CARRIER", // your marked opponent has the ball: close the gap and pressure for a steal
  MARK_OPPONENT: "MARK_OPPONENT", // another opponent has the ball: deny your mark, goal-side
  BOX_REBOUND: "BOX_REBOUND", // shot incoming at the hoop you defend: hold rim position goal-side of your mark
  ADVANCE_TO_HOOP: "ADVANCE_TO_HOOP" // own team has the ball: push toward the scoring hoop
};

// Static man-to-man assignments. Every player defends one specific opponent
// instead of every defender converging on whoever holds the ball — the
// convergence pattern is what produced both the two-player steal volley in
// symmetric AI-vs-AI play and the permanently undefended off-ball attacker.
// A1 is the human slot and the game loop never AI-drives it, but it still
// gets an entry (its implicit man, B2) so the map is total: any mode that
// does run AI for that slot — demos, tests, a future spectator sim — gets
// a complete defense instead of a crash on an undefined mark.
const DEFENSIVE_MARK = { A1: "B2", A2: "B1", B1: "A1", B2: "A2" };
const MARK_STANDOFF = 30; // deny distance goal-side of the mark
const BOX_DISTANCE = 50; // rim-position distance goal-side toward the mark

function defendedHoopFor(team) {
  // The hoop this team protects = the hoop the other team attacks.
  return team === "A" ? HOOP_LEFT : HOOP_RIGHT;
}

// Closed-form landing point for a ball in flight, mirroring updateBall()'s
// integration exactly (x += vx; y += vy; vy += 0.05; lands when y > 550).
// Chasing a rebound means racing to where the ball WILL come down — tracking
// its current mid-air position always arrives late, which is why AI crashers
// lost every deep-rebound race to a player who aims at the landing spot.
function predictBallLanding() {
  const ball = state.ball;
  if (!ball.inAir) return { x: ball.x, y: ball.y };
  // Solve y + t*vy + 0.05*t*(t-1)/2 >= 550 for the smallest t >= 0.
  const a = 0.025;
  const b = ball.vy - 0.025;
  const c = ball.y - 550;
  const disc = b * b - 4 * a * c;
  const t = disc <= 0 ? 0 : Math.max(0, (-b + Math.sqrt(disc)) / (2 * a));
  return {
    x: Math.max(50, Math.min(850, ball.x + ball.vx * t)),
    y: 550
  };
}

// Human-parity pursuit speed. At 1.6 vs the human's 2.0, a defender could
// never hold the 60-unit pressure radius against a moving carrier and lost
// every loose-ball race: across three instrumented human-driven matches,
// team B recorded 0 possession frames, 0 shots, and 0 steals. Defense must
// be able to reach the play before any assignment logic can matter.
const AI_SPEED = 2.0;
const GUARD_STANDOFF = 20; // stop just outside steal range, close enough for pressure to build
const AUTO_SHOOT_RANGE = 120;

// Deterministic steal model: pressure accumulates while guarding instead of
// rolling a random chance each frame, so identical input replays always
// produce identical steal timing.
const PRESSURE_RADIUS = 60; // beyond this, a defender builds no pressure at all
const BASE_PRESSURE = 1;
const STEAL_THRESHOLD = 45; // accumulated pressure required to force a turnover
const DEBUG_STEALS = false; // flip on to audit pressure/threshold at each turnover

// Shot clock: a hard cap on any single, uninterrupted possession. Backstops
// every other possession mechanic (ties, near-ties, a stationary carrier, or
// any future edge case that lets a possession go stagnant) by guaranteeing
// forward progress — the carrier is forced to shoot rather than the game
// stalling indefinitely. 400 frames is roughly double the time a full drive
// from mid-court to shooting range takes at AI_SPEED, so it never cuts off
// a genuine possession, only a stuck one.
const SHOT_CLOCK_LIMIT = 400;

// Tracks whether the same player has held the ball continuously since the
// last time it was loose, incrementing state.ball.shotClock accordingly and
// forcing a shot once the limit is hit. Runs after steal/rebound resolution
// each frame so it sees the settled owner, not a mid-frame flicker.
function updateShotClock() {
  const ball = state.ball;
  if (!ball.owner) {
    ball.shotClock = 0;
    ball.shotClockOwner = null;
    return;
  }
  if (ball.owner !== ball.shotClockOwner) {
    ball.shotClockOwner = ball.owner;
    ball.shotClock = 0;
  }
  ball.shotClock++;
  if (ball.shotClock >= SHOT_CLOCK_LIMIT) {
    const carrier = state.players.find(pl => pl.id === ball.owner);
    ball.shotClock = 0;
    ball.shotClockOwner = null;
    shoot(carrier);
  }
}

function calculateDefenderPressure(defender, carrier) {
  const dx = carrier.x - defender.x;
  const dy = carrier.y - defender.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > PRESSURE_RADIUS) return 0;

  const proximity = (PRESSURE_RADIUS - dist) / PRESSURE_RADIUS; // 0..1, closer is higher

  // Lane-denial bonus: is the defender sitting between the carrier and the
  // hoop the carrier is attacking? Pure function of current positions, so it
  // stays frame-reproducible without needing a stored velocity history.
  const hoop = attackHoopFor(carrier.team);
  const hx = hoop.x - carrier.x;
  const hy = hoop.y - carrier.y;
  const hoopDist = Math.sqrt(hx * hx + hy * hy) || 1;
  const laneAlignment = (hx * dx + hy * dy) / (hoopDist * (dist || 1)); // -1..1
  const laneBonus = Math.max(0, laneAlignment); // 0..1, only reward blocking the lane

  return BASE_PRESSURE * proximity * (0.5 + 0.5 * laneBonus);
}

function updateAccumulatedPressure(defender, carrier) {
  defender.pressure += calculateDefenderPressure(defender, carrier);
}

function evaluateStealState(defender, carrier) {
  if (defender.pressure < STEAL_THRESHOLD) return;
  if (DEBUG_STEALS) {
    console.debug(
      `[steal] ${defender.id} (${defender.aiState}) took the ball from ${carrier.id}: ` +
      `pressure=${defender.pressure.toFixed(2)} threshold=${STEAL_THRESHOLD}`
    );
  }
  const dx = carrier.x - defender.x;
  const dy = carrier.y - defender.y;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  state.ball.owner = null;
  // Placed 55% of the way toward the defender rather than at the exact
  // midpoint: tryGainPossession() (which runs later this same frame) picks
  // the closest player, and an exact midpoint is an exact tie in distance
  // whenever the carrier is stationary (e.g. an idle human) and the
  // defender sits at GUARD_STANDOFF — ties fall back to array order, which
  // always favors the earlier-indexed player, silently handing the ball
  // right back to the carrier every single time regardless of distance.
  // Biasing the split guarantees the defender is strictly closest no matter
  // the carrier/defender separation, while still routing through the normal
  // loose-ball pickup scan (rather than assigning possession outright),
  // which is what leaves room for a trailing teammate to occasionally
  // intercept the loose ball — that leak is what keeps drives contestable
  // instead of turning every threshold-crossing into a guaranteed turnover.
  state.ball.x = carrier.x + (defender.x - carrier.x) * 0.55;
  state.ball.y = carrier.y + (defender.y - carrier.y) * 0.55;
  state.ball.vx = (dx / dist) * 3;
  state.ball.vy = (dy / dist) * 3;
  defender.pressure = 0;
  defender.visual.flash = 1;
  defender.visual.lunge = 1;
  spawnFlash(defender.x, defender.y);
  triggerBallPop();
  triggerShake(2.5);
  triggerZoomPulse(1.06, defender.x, defender.y);
}

function decideAiState(player) {
  const ball = state.ball;
  if (ball.inAir) {
    // A shot is in flight. If it targets the hoop this player defends, take
    // rim position instead of ball-chasing; otherwise crash for the board.
    const attackedHoop = ball.vx > 0 ? HOOP_RIGHT : HOOP_LEFT;
    return attackedHoop === defendedHoopFor(player.team)
      ? AI_STATE.BOX_REBOUND
      : AI_STATE.CHASE_BALL;
  }
  const owner = ball.owner;
  if (!owner) return AI_STATE.CHASE_BALL;
  const carrier = state.players.find(pl => pl.id === owner);
  if (carrier.team === player.team) return AI_STATE.ADVANCE_TO_HOOP;
  // Single coverage: only the defender assigned to the carrier pressures;
  // everyone else denies their own mark instead of double-teaming the ball.
  return DEFENSIVE_MARK[player.id] === carrier.id
    ? AI_STATE.GUARD_CARRIER
    : AI_STATE.MARK_OPPONENT;
}

function moveToward(player, tx, ty, standoff = 0) {
  const dx = tx - player.x;
  const dy = ty - player.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist <= standoff) return;
  player.x += (dx / dist) * AI_SPEED;
  player.y += (dy / dist) * AI_SPEED;
}

function attackHoopFor(team) {
  return team === "A" ? HOOP_RIGHT : HOOP_LEFT;
}

function runDefenderAI(player) {
  player.aiState = decideAiState(player);

  // Pressure is scoped to an active guard: leaving GUARD_CARRIER for any
  // reason (ball turned over, teammate got it, ball went loose) clears it.
  if (player.aiState !== AI_STATE.GUARD_CARRIER) {
    player.pressure = 0;
  }

  switch (player.aiState) {
    case AI_STATE.CHASE_BALL: {
      // For a grounded loose ball, go to it; for one in flight, race to
      // where it will land instead of trailing its current position.
      const target = predictBallLanding();
      moveToward(player, target.x, target.y);
      break;
    }
    case AI_STATE.GUARD_CARRIER: {
      const carrier = state.players.find(pl => pl.id === state.ball.owner);
      moveToward(player, carrier.x, carrier.y, GUARD_STANDOFF);
      updateAccumulatedPressure(player, carrier);
      evaluateStealState(player, carrier);
      break;
    }
    case AI_STATE.MARK_OPPONENT: {
      // Deny position: hold a spot goal-side of your mark, so a turnover
      // finds the mark already covered and the driving lane stays occupied.
      const mark = state.players.find(pl => pl.id === DEFENSIVE_MARK[player.id]);
      const hoop = defendedHoopFor(player.team);
      const dx = hoop.x - mark.x;
      const dy = hoop.y - mark.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      moveToward(player, mark.x + (dx / d) * MARK_STANDOFF, mark.y + (dy / d) * MARK_STANDOFF);
      break;
    }
    case AI_STATE.BOX_REBOUND: {
      // Rim position goal-side: stand between your hoop and your mark so a
      // miss drops with the defender already inside the crashing attacker.
      const mark = state.players.find(pl => pl.id === DEFENSIVE_MARK[player.id]);
      const hoop = defendedHoopFor(player.team);
      const dx = mark.x - hoop.x;
      const dy = mark.y - hoop.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      moveToward(player, hoop.x + (dx / d) * BOX_DISTANCE, hoop.y + (dy / d) * BOX_DISTANCE);
      break;
    }
    case AI_STATE.ADVANCE_TO_HOOP: {
      const hoop = attackHoopFor(player.team);
      moveToward(player, hoop.x, hoop.y);
      if (state.ball.owner === player.id) {
        const dx = hoop.x - player.x;
        const dy = hoop.y - player.y;
        if (Math.sqrt(dx * dx + dy * dy) < AUTO_SHOOT_RANGE) {
          shoot(player);
        }
      }
      break;
    }
  }
  clampToCourt(player);
}

function updateEffects() {
  for (let i = effects.length - 1; i >= 0; i--) {
    effects[i].ttl--;
    if (effects[i].ttl <= 0) effects.splice(i, 1);
  }

  shakeMagnitude *= 0.85;
  if (shakeMagnitude < 0.05) shakeMagnitude = 0;

  zoom = 1 + (zoom - 1) * 0.9;
  if (Math.abs(zoom - 1) < 0.001) zoom = 1;

  ballPop *= 0.8;
  if (ballPop < 0.02) ballPop = 0;

  ballTrail.push({ x: state.ball.x, y: state.ball.y });
  if (ballTrail.length > 10) ballTrail.shift();
}

// Derives every player's animation state from the position change that
// already happened this frame (state.players[i].x/y, set by the gameplay
// code above). Reads simulation state; writes only to player.visual.
// Nothing in gameplay logic ever reads player.visual back.
function updateVisuals() {
  for (const p of state.players) {
    const v = p.visual;
    const dx = p.x - v.prevX;
    const dy = p.y - v.prevY;
    const moveSpeed = Math.sqrt(dx * dx + dy * dy);

    if (moveSpeed > 0.05) {
      v.angle = Math.atan2(dy, dx);
      v.facing = dx >= 0 ? 1 : -1;
    }
    v.squash = 1 / (1 + Math.min(moveSpeed / 3, 1) * 0.25);

    v.bobPhase += moveSpeed > 0.1 ? 0.35 : 0.12;
    v.bob = Math.sin(v.bobPhase) * (moveSpeed > 0.1 ? 2.2 : 1);

    v.flash *= 0.85;
    if (v.flash < 0.02) v.flash = 0;

    // Steal signature: v.lunge starts at 1 the instant a steal fires (see
    // evaluateStealState), reads as a forward lunge/contact pose while
    // high, and its own decay curve doubles as the recovery back to a
    // normal stance — one scalar, no separate animation states needed.
    v.lunge *= 0.82;
    if (v.lunge < 0.02) v.lunge = 0;

    v.prevX = p.x;
    v.prevY = p.y;
  }
}

function update() {
  const p = state.players[0];
  const speed = 2;
  if (keys["ArrowUp"]) p.y -= speed;
  if (keys["ArrowDown"]) p.y += speed;
  if (keys["ArrowLeft"]) p.x -= speed;
  if (keys["ArrowRight"]) p.x += speed;
  clampToCourt(p);

  if (keys[" "]) shoot(p);

  for (let i = 1; i < state.players.length; i++) {
    runDefenderAI(state.players[i]);
  }

  tryGainPossession();

  updateBall();
  checkScore();
  checkRebound();
  updateShotClock();
  updateEffects();
  updateVisuals();
  updateCamera();
  updateBallVisual();
}

// Screen-space only: always full-bleed regardless of camera pan/zoom. This
// is the single environment layer for this pass (crowd) — fence and
// stadium-light glow were dropped rather than stacked, per direction.
function drawBackground() {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#1b1f24");
  grad.addColorStop(1, "#0d0f12");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#05060a";
  for (let x = 0; x < canvas.width; x += 14) {
    const h1 = 14 + Math.sin(x * 0.7) * 5;
    ctx.fillRect(x, 0, 10, h1);
    const h2 = 14 + Math.cos(x * 0.5) * 5;
    ctx.fillRect(x, canvas.height - h2, 10, h2);
  }
}

function drawHoop(hoopX, facing) {
  // facing: +1 rim opens toward +x (left hoop), -1 opens toward -x (right hoop)
  const backboardX = hoopX - facing * 18;
  ctx.fillStyle = "rgba(230, 230, 235, 0.85)";
  ctx.strokeStyle = "#9ca3af";
  ctx.lineWidth = 2;
  ctx.fillRect(backboardX - 4, 258, 8, 84);
  ctx.strokeRect(backboardX - 4, 258, 8, 84);
  ctx.strokeStyle = "#d1d5db";
  ctx.lineWidth = 1;
  ctx.strokeRect(backboardX - 2, 280, 4, 30);

  ctx.beginPath();
  ctx.ellipse(hoopX, 300, 16, 6, 0, 0, Math.PI * 2);
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.strokeStyle = "rgba(230, 230, 235, 0.55)";
  ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(hoopX + i * 6, 303);
    ctx.lineTo(hoopX + i * 3 + facing * 10, 322);
    ctx.stroke();
  }
}

// Deterministic pseudo-noise (no Math.random) so the speckle pattern is
// stable frame-to-frame instead of flickering under the 60fps redraw.
function hashSpeck(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function drawAsphaltTexture() {
  ctx.save();
  ctx.beginPath();
  ctx.rect(50, 50, 800, 500);
  ctx.clip();
  for (let x = 50; x < 850; x += 18) {
    for (let y = 50; y < 550; y += 18) {
      const speck = hashSpeck(x, y);
      if (speck > 0.86) {
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.03 + speck * 0.03).toFixed(3)})`;
        ctx.fillRect(x, y, 3, 3);
      } else if (speck < 0.07) {
        ctx.fillStyle = `rgba(0, 0, 0, ${(0.08 + speck).toFixed(3)})`;
        ctx.fillRect(x, y, 4, 4);
      }
    }
  }
  ctx.restore();
}

// Night-game stadium lights: two glow pools hanging above the court,
// pooling down over each hoop. World-space so they pan/zoom with the
// camera like a real light rig would, instead of staying screen-fixed.
function drawCourtLighting() {
  // The camera's vertical band is fixed at a ~254-unit window centered on
  // y=300 (updateCamera never follows the ball vertically) — even the
  // court's own y=50/550 edges sit outside that band. So this reads as a
  // warm pool centered right on the hoop (y=300), not a rig hanging above
  // the court, since "above" is never actually reachable by this camera.
  for (const lx of [HOOP_LEFT.x - 30, HOOP_RIGHT.x + 30]) {
    const glow = ctx.createRadialGradient(lx, 300, 20, lx, 300, 200);
    glow.addColorStop(0, "rgba(255, 244, 200, 0.22)");
    glow.addColorStop(1, "rgba(255, 244, 200, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(lx - 200, 100, 400, 400);
  }
}

function drawChainLinkFence() {
  const outer = { x: 20, y: 20, w: 860, h: 560 };
  ctx.save();
  ctx.beginPath();
  ctx.rect(outer.x, outer.y, outer.w, outer.h);
  ctx.rect(50, 50, 800, 500);
  ctx.clip("evenodd");

  ctx.strokeStyle = "rgba(200, 210, 220, 0.35)";
  ctx.lineWidth = 1;
  const step = 14;
  const span = outer.w + outer.h;
  for (let x = outer.x - outer.h; x < outer.x + span; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, outer.y);
    ctx.lineTo(x + outer.h, outer.y + outer.h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, outer.y + outer.h);
    ctx.lineTo(x + outer.h, outer.y);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(150, 160, 170, 0.5)";
  ctx.lineWidth = 3;
  ctx.strokeRect(outer.x, outer.y, outer.w, outer.h);
}

// Neighborhood branding, painted vertically along the fence. Placed here
// rather than below the court: the camera only ever follows the ball
// horizontally (updateCamera holds y at a fixed 300), so anything placed
// far below/above the court's y-band would never actually scroll into
// view during real play. This position sits within the horizontal pan's
// reach on either side.
function drawGraffiti() {
  ctx.save();
  ctx.translate(34, 300);
  ctx.rotate(-Math.PI / 2);
  ctx.font = "italic bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(250, 204, 21, 0.25)";
  ctx.fillText("ARCH RIVALS STREET", 0, 0);
  ctx.restore();
}

function drawCourt() {
  drawAsphaltTexture();
  drawCourtLighting();

  ctx.fillStyle = "rgba(59, 130, 246, 0.12)";
  ctx.fillRect(50, 220, 130, 160);
  ctx.fillStyle = "rgba(239, 68, 68, 0.12)";
  ctx.fillRect(720, 220, 130, 160);

  ctx.strokeStyle = "#e8e8e8";
  ctx.lineWidth = 2;
  ctx.strokeRect(50, 50, 800, 500);
  ctx.strokeRect(50, 220, 130, 160);
  ctx.strokeRect(720, 220, 130, 160);

  ctx.beginPath();
  ctx.moveTo(450, 50);
  ctx.lineTo(450, 550);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(450, 300, 55, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(80, 300, 210, -1.0, 1.0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(820, 300, 210, Math.PI - 1.0, Math.PI + 1.0);
  ctx.stroke();

  drawHoop(HOOP_LEFT.x, 1);
  drawHoop(HOOP_RIGHT.x, -1);

  drawChainLinkFence();
  drawGraffiti();
}

function drawShadow(x, y, r = 20) {
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.9, r, r * 0.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fill();
}

function drawBallTrail() {
  const n = ballTrail.length;
  for (let i = 0; i < n; i++) {
    const t = ballTrail[i];
    const age = n - i;
    const alpha = 0.22 * (1 - age / n);
    if (alpha <= 0) continue;
    ctx.beginPath();
    ctx.arc(t.x, t.y, Math.max(1, 5 - age * 0.3), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(249, 115, 22, ${alpha.toFixed(2)})`;
    ctx.fill();
  }
}

function playerFillColor(p) {
  const isA = p.team === "A";
  const base = isA ? [59, 130, 246] : [239, 68, 68];
  const t = p.visual.flash;
  if (t <= 0) return isA ? "#3b82f6" : "#ef4444";
  const r = Math.round(base[0] + (255 - base[0]) * t);
  const g = Math.round(base[1] + (255 - base[1]) * t);
  const b = Math.round(base[2] + (255 - base[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function drawPlayer(p) {
  const v = p.visual;
  // Steal lunge/contact/recovery is one decaying scalar (v.lunge) layered
  // on top of the normal movement squash-stretch: an extra forward stretch
  // and downward squash while high, easing back to the normal pose as it
  // decays — that easing back IS the recovery, no separate state needed.
  const stretch = (1 / v.squash) * (1 + v.lunge * 0.4);
  const squash = v.squash * (1 - v.lunge * 0.3);
  const isA = p.team === "A";
  const fill = playerFillColor(p);
  const outline = isA ? "#1e3a8a" : "#7f1d1d";
  const drawY = p.y - v.bob;
  const BODY_RX = 22;
  const BODY_RY = 18;
  const HEAD_R = 10;

  ctx.save();
  ctx.translate(p.x, drawY);
  ctx.rotate(v.angle);
  ctx.scale(stretch, squash);
  ctx.beginPath();
  ctx.ellipse(0, 0, BODY_RX, BODY_RY, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = outline;
  ctx.stroke();

  // facing nose: a small chevron pointing the way this player last moved,
  // for at-a-glance orientation readability
  ctx.beginPath();
  ctx.moveTo(BODY_RX - 2, -6);
  ctx.lineTo(BODY_RX + 8, 0);
  ctx.lineTo(BODY_RX - 2, 6);
  ctx.closePath();
  ctx.fillStyle = outline;
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(p.x, drawY - BODY_RY - 4, HEAD_R, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = outline;
  ctx.stroke();
}

function drawBall() {
  const ball = state.ball;
  // Dribble bounce compresses the drawn radius and dips the drawn position
  // slightly at each bounce peak; drawn-only, ball.x/y/vx/vy are untouched.
  const dribbleSquash = ballVisual.bounce * 0.3;
  const r = (6 + ballPop * 4) * (1 - dribbleSquash);
  const drawY = ball.y + ballVisual.bounce * 4;
  ctx.beginPath();
  ctx.arc(ball.x, drawY, r, 0, Math.PI * 2);
  ctx.fillStyle = "#f97316";
  ctx.fill();
  ctx.strokeStyle = "#7c2d12";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ball.x - r, drawY);
  ctx.lineTo(ball.x + r, drawY);
  ctx.moveTo(ball.x, drawY - r);
  ctx.lineTo(ball.x, drawY + r);
  ctx.stroke();
}

function drawEffects() {
  for (const fx of effects) {
    const t = fx.ttl / fx.maxTtl;
    if (fx.type === "flash") {
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, (1 - t) * 24, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 255, 255, ${t.toFixed(2)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    } else if (fx.type === "popup") {
      ctx.save();
      ctx.globalAlpha = Math.max(0, t);
      ctx.fillStyle = fx.color;
      ctx.font = "bold 20px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(fx.text, fx.x, fx.y - (1 - t) * 30);
      ctx.restore();
    }
  }
}

function drawScoreboard() {
  const panelW = 260;
  const panelH = 64;
  const x = canvas.width / 2 - panelW / 2;
  const y = 16;

  ctx.save();
  ctx.fillStyle = "rgba(10, 12, 16, 0.82)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 2;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(x, y, panelW, panelH, 10);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(x, y, panelW, panelH);
    ctx.strokeRect(x, y, panelW, panelH);
  }

  ctx.textAlign = "center";
  ctx.font = "bold 30px sans-serif";
  ctx.fillStyle = "#60a5fa";
  ctx.fillText(String(state.score.A), x + panelW * 0.28, y + panelH * 0.68);
  ctx.fillStyle = "rgba(255, 255, 255, 0.5)";
  ctx.font = "20px sans-serif";
  ctx.fillText("-", x + panelW * 0.5, y + panelH * 0.64);
  ctx.fillStyle = "#f87171";
  ctx.font = "bold 30px sans-serif";
  ctx.fillText(String(state.score.B), x + panelW * 0.72, y + panelH * 0.68);

  ctx.font = "11px sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.fillText("HOME", x + panelW * 0.28, y + panelH * 0.28);
  ctx.fillText("AWAY", x + panelW * 0.72, y + panelH * 0.28);
  ctx.restore();
}

function drawWinBanner() {
  const teamColor = state.winner === "A" ? "#60a5fa" : "#f87171";

  ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const bannerW = Math.min(560, canvas.width * 0.8);
  const bannerH = 170;
  const bx = canvas.width / 2 - bannerW / 2;
  const by = canvas.height / 2 - bannerH / 2;

  ctx.save();
  ctx.fillStyle = "rgba(20, 22, 28, 0.92)";
  ctx.strokeStyle = teamColor;
  ctx.lineWidth = 4;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(bx, by, bannerW, bannerH, 16);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(bx, by, bannerW, bannerH);
    ctx.strokeRect(bx, by, bannerW, bannerH);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = teamColor;
  ctx.font = "bold 52px sans-serif";
  ctx.fillText(`TEAM ${state.winner} WINS`, canvas.width / 2, canvas.height / 2 - 10);

  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = "24px sans-serif";
  ctx.fillText(`${state.score.A} - ${state.score.B}`, canvas.width / 2, canvas.height / 2 + 40);
  ctx.restore();
}

// Section boundaries for render(), so future branches (environment/court
// dressing vs. gameplay-actor "juice") have separate landing zones instead
// of every visual change piling into one function. Each is a thin wrapper
// around the existing draw* functions — no behavior change, just grouping.
function drawEnvironment() {
  drawBackground();
}

function drawGameplayActors() {
  drawBallTrail();
  for (const pl of state.players) {
    drawShadow(pl.x, pl.y);
    drawPlayer(pl);
  }
  drawShadow(state.ball.x, state.ball.y, 6);
  drawBall();
}

function drawGameplayEffects() {
  drawEffects();
}

function drawHud() {
  drawScoreboard();
  if (state.gameOver) {
    drawWinBanner();
  }
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawEnvironment();

  const cam = getCameraTransform();
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.scale(cam.scale, cam.scale);
  ctx.translate(-cam.x, -cam.y);

  ctx.translate(zoomFocusX, zoomFocusY);
  ctx.scale(zoom, zoom);
  ctx.translate(-zoomFocusX, -zoomFocusY);
  ctx.translate((Math.random() - 0.5) * shakeMagnitude, (Math.random() - 0.5) * shakeMagnitude);

  drawCourt();
  drawGameplayActors();
  drawGameplayEffects();

  ctx.restore();

  drawHud();
}

function loop() {
  if (!state.gameOver) {
    update();
  }
  render();
  requestAnimationFrame(loop);
}

loop();
