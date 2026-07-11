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
  ball: { x: 300, y: 300, vx: 0, vy: 0, owner: null, shotClock: 0, inAir: false },
  score: { A: 0, B: 0 },
  gameOver: false,
  winner: null
};

const POINTS_PER_BASKET = 2;
const WIN_SCORE = 11;

const keys = {};
window.addEventListener("keydown", e => keys[e.key] = true);
window.addEventListener("keyup", e => keys[e.key] = false);

// Cosmetic-only presentation state: ball trail, transient effects (impact
// flash, score popups), screen shake, and camera zoom. None of this feeds
// back into game logic, so it can use randomness freely without touching
// the deterministic simulation above.
const ballTrail = [];
const effects = [];
let shakeMagnitude = 0;
let zoom = 1;
let zoomFocusX = 450;
let zoomFocusY = 300;

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
      triggerZoomPulse(1.25, hoop.x, hoop.y);
      if (state.score[team] >= WIN_SCORE) {
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
  spawnFlash(defender.x, defender.y);
  triggerShake(2.5);
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
  if (dist <= standoff) {
    player.vx = 0;
    player.vy = 0;
    return;
  }
  const stepX = (dx / dist) * AI_SPEED;
  const stepY = (dy / dist) * AI_SPEED;
  player.x += stepX;
  player.y += stepY;
  player.vx = stepX;
  player.vy = stepY;
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

function updateEffects() {
  for (let i = effects.length - 1; i >= 0; i--) {
    effects[i].ttl--;
    if (effects[i].ttl <= 0) effects.splice(i, 1);
  }

  shakeMagnitude *= 0.85;
  if (shakeMagnitude < 0.05) shakeMagnitude = 0;

  zoom = 1 + (zoom - 1) * 0.9;
  if (Math.abs(zoom - 1) < 0.001) zoom = 1;

  ballTrail.push({ x: state.ball.x, y: state.ball.y });
  if (ballTrail.length > 10) ballTrail.shift();
}

function update() {
  const p = state.players[0];
  const speed = 2;
  let dx = 0;
  let dy = 0;
  if (keys["ArrowUp"]) dy -= speed;
  if (keys["ArrowDown"]) dy += speed;
  if (keys["ArrowLeft"]) dx -= speed;
  if (keys["ArrowRight"]) dx += speed;
  p.x += dx;
  p.y += dy;
  p.vx = dx;
  p.vy = dy;
  clampToCourt(p);

  if (keys[" "]) shoot(p);

  for (let i = 1; i < state.players.length; i++) {
    runDefenderAI(state.players[i]);
  }

  for (const pl of state.players) {
    tryGainPossession(pl);
  }

  updateBall();
  checkScore();
  checkRebound();
  updateEffects();
}

function drawBackground() {
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  grad.addColorStop(0, "#1b1f24");
  grad.addColorStop(1, "#0d0f12");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const lx of [80, canvas.width - 80]) {
    const glow = ctx.createRadialGradient(lx, 20, 5, lx, 20, 160);
    glow.addColorStop(0, "rgba(255, 244, 200, 0.22)");
    glow.addColorStop(1, "rgba(255, 244, 200, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.fillStyle = "#05060a";
  for (let x = 0; x < canvas.width; x += 14) {
    const h1 = 12 + Math.sin(x * 0.7) * 4;
    ctx.fillRect(x, 0, 10, h1);
    const h2 = 12 + Math.cos(x * 0.5) * 4;
    ctx.fillRect(x, canvas.height - h2, 10, h2);
  }

  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = "rgba(200, 200, 200, 0.35)";
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 30, canvas.width - 60, canvas.height - 60);
  ctx.restore();
}

function drawCourt() {
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

  ctx.beginPath();
  ctx.arc(HOOP_LEFT.x, HOOP_LEFT.y, 6, 0, Math.PI * 2);
  ctx.arc(HOOP_RIGHT.x, HOOP_RIGHT.y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawShadow(x, y, r = 11) {
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

function drawPlayer(p) {
  const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  const stretch = 1 + Math.min(speed / 3, 1) * 0.25;
  const squash = 1 / stretch;
  const angle = speed > 0.05 ? Math.atan2(p.vy, p.vx) : 0;
  const isA = p.team === "A";
  const fill = isA ? "#3b82f6" : "#ef4444";
  const outline = isA ? "#1e3a8a" : "#7f1d1d";

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.scale(stretch, squash);
  ctx.beginPath();
  ctx.ellipse(0, 0, 11, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(p.x, p.y - 11, 5, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = outline;
  ctx.stroke();
}

function drawBall() {
  const ball = state.ball;
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#f97316";
  ctx.fill();
  ctx.strokeStyle = "#7c2d12";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ball.x - 6, ball.y);
  ctx.lineTo(ball.x + 6, ball.y);
  ctx.moveTo(ball.x, ball.y - 6);
  ctx.lineTo(ball.x, ball.y + 6);
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
  ctx.fillStyle = "white";
  ctx.font = "24px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${state.score.A} - ${state.score.B}`, canvas.width / 2, 35);
}

function drawWinBanner() {
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "gold";
  ctx.font = "48px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`TEAM ${state.winner} WINS`, canvas.width / 2, canvas.height / 2);
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(zoomFocusX, zoomFocusY);
  ctx.scale(zoom, zoom);
  ctx.translate(-zoomFocusX, -zoomFocusY);
  ctx.translate((Math.random() - 0.5) * shakeMagnitude, (Math.random() - 0.5) * shakeMagnitude);

  drawBackground();
  drawCourt();
  drawBallTrail();

  for (const pl of state.players) {
    drawShadow(pl.x, pl.y);
    drawPlayer(pl);
  }
  drawShadow(state.ball.x, state.ball.y, 6);
  drawBall();

  drawEffects();

  ctx.restore();

  drawScoreboard();

  if (state.gameOver) {
    drawWinBanner();
  }
}

function loop() {
  if (!state.gameOver) {
    update();
  }
  render();
  requestAnimationFrame(loop);
}

loop();
