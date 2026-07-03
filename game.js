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

function clampToCourt(p) {
  p.x = Math.max(60, Math.min(840, p.x));
  p.y = Math.max(60, Math.min(540, p.y));
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

  for (const pl of state.players) {
    tryGainPossession(pl);
  }
  trySteal(state.players[2], p);

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
