const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const HOOP_LEFT = { x: 80, y: 300 };
const HOOP_RIGHT = { x: 820, y: 300 };

const state = {
  players: [
    { id: "A1", x: 200, y: 300, vx: 0, vy: 0, team: "A", pressure: 0 },
    { id: "A2", x: 250, y: 350, vx: 0, vy: 0, team: "A", pressure: 0 },
    { id: "B1", x: 700, y: 300, vx: 0, vy: 0, team: "B", pressure: 0 },
    { id: "B2", x: 650, y: 350, vx: 0, vy: 0, team: "B", pressure: 0 }
  ],
  ball: { x: 300, y: 300, vx: 0, vy: 0, owner: null, shotClock: 0, inAir: false }
};

const keys = {};
window.addEventListener("keydown", e => keys[e.key] = true);
window.addEventListener("keyup", e => keys[e.key] = false);

function tryGainPossession(player) {
  if (state.ball.owner) return;
  const dx = player.x - state.ball.x;
  const dy = player.y - state.ball.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 15) {
    state.ball.owner = player.id;
  }
}

function shoot(player) {
  if (state.ball.owner !== player.id) return;
  state.ball.owner = null;
  state.ball.inAir = true;
  const hoop = player.x < 450 ? HOOP_RIGHT : HOOP_LEFT;
  const dx = hoop.x - player.x;
  const dy = hoop.y - player.y;
  const power = 0.08;
  state.ball.vx = dx * power;
  state.ball.vy = dy * power - 2;
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

function checkRebound() {
  if (state.ball.inAir) return;
  for (const p of state.players) {
    const dx = p.x - state.ball.x;
    const dy = p.y - state.ball.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 20) {
      state.ball.owner = p.id;
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
  GUARD_CARRIER: "GUARD_CARRIER", // opposing team has the ball: close the gap and pressure for a steal
  ADVANCE_TO_HOOP: "ADVANCE_TO_HOOP" // own team has the ball: push toward the scoring hoop
};

const AI_SPEED = 1.6;
const GUARD_STANDOFF = 20; // stop just outside steal range, close enough for pressure to build
const AUTO_SHOOT_RANGE = 120;

// Deterministic steal model: pressure accumulates while guarding instead of
// rolling a random chance each frame, so identical input replays always
// produce identical steal timing.
const PRESSURE_RADIUS = 60; // beyond this, a defender builds no pressure at all
const BASE_PRESSURE = 1;
const STEAL_THRESHOLD = 45; // accumulated pressure required to force a turnover
const DEBUG_STEALS = false; // flip on to audit pressure/threshold at each turnover

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
  state.ball.vx = (dx / dist) * 3;
  state.ball.vy = (dy / dist) * 3;
  defender.pressure = 0;
}

function decideAiState(player) {
  const owner = state.ball.owner;
  if (!owner) return AI_STATE.CHASE_BALL;
  const carrier = state.players.find(pl => pl.id === owner);
  return carrier.team === player.team ? AI_STATE.ADVANCE_TO_HOOP : AI_STATE.GUARD_CARRIER;
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
    case AI_STATE.CHASE_BALL:
      moveToward(player, state.ball.x, state.ball.y);
      break;
    case AI_STATE.GUARD_CARRIER: {
      const carrier = state.players.find(pl => pl.id === state.ball.owner);
      moveToward(player, carrier.x, carrier.y, GUARD_STANDOFF);
      updateAccumulatedPressure(player, carrier);
      evaluateStealState(player, carrier);
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

  for (const pl of state.players) {
    tryGainPossession(pl);
  }

  updateBall();
  checkRebound();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "white";
  ctx.strokeRect(50, 50, 800, 500);
  ctx.beginPath();
  ctx.moveTo(450, 50);
  ctx.lineTo(450, 550);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(HOOP_LEFT.x, HOOP_LEFT.y, 6, 0, Math.PI * 2);
  ctx.arc(HOOP_RIGHT.x, HOOP_RIGHT.y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = "yellow";
  ctx.stroke();

  for (const pl of state.players) {
    ctx.beginPath();
    ctx.arc(pl.x, pl.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = pl.team === "A" ? "blue" : "red";
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "orange";
  ctx.fill();
}

function loop() {
  update();
  render();
  requestAnimationFrame(loop);
}

loop();
