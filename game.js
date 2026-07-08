const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");

const HOOP_LEFT = { x: 80, y: 300 };
const HOOP_RIGHT = { x: 820, y: 300 };

const state = {
  players: [
    { id: "A1", x: 200, y: 300, vx: 0, vy: 0, team: "A" },
    { id: "A2", x: 250, y: 350, vx: 0, vy: 0, team: "A" },
    { id: "B1", x: 700, y: 300, vx: 0, vy: 0, team: "B" },
    { id: "B2", x: 650, y: 350, vx: 0, vy: 0, team: "B" }
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

function tryGainPossession(player) {
  if (state.ball.owner) return;
  const dx = player.x - state.ball.x;
  const dy = player.y - state.ball.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 15) {
    state.ball.owner = player.id;
  }
}

function trySteal(defender, target) {
  if (state.ball.owner !== target.id) return;
  const dx = defender.x - target.x;
  const dy = defender.y - target.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 18 && Math.random() < 0.08) {
    state.ball.owner = null;
    state.ball.vx = (Math.random() - 0.5) * 4;
    state.ball.vy = (Math.random() - 0.5) * 4;
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
const GUARD_STANDOFF = 12; // must stay below trySteal's proximity check (18) or defenders stall just outside steal range
const AUTO_SHOOT_RANGE = 120;

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

  switch (player.aiState) {
    case AI_STATE.CHASE_BALL:
      moveToward(player, state.ball.x, state.ball.y);
      break;
    case AI_STATE.GUARD_CARRIER: {
      const carrier = state.players.find(pl => pl.id === state.ball.owner);
      moveToward(player, carrier.x, carrier.y, GUARD_STANDOFF);
      trySteal(player, carrier);
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
  checkScore();
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

  ctx.fillStyle = "white";
  ctx.font = "24px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${state.score.A} - ${state.score.B}`, canvas.width / 2, 35);

  if (state.gameOver) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "gold";
    ctx.font = "48px sans-serif";
    ctx.fillText(`TEAM ${state.winner} WINS`, canvas.width / 2, canvas.height / 2);
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
