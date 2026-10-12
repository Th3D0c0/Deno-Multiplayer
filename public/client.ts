interface Player {
  id: string;
  x: number;
  y: number;
  lives: number;
}

interface Bomb {
  owner: string;
  x: number;
  y: number;
}

interface Explosion {
  cells: { x: number; y: number }[];
  until: number;
}

const EXPLOSION_SHOW_MS = 500;

// map values, same as on the server
const WALL = 1;
const BREAKABLE_WALL = 2;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const livesText = document.getElementById("lives")!;

// overwritten by the server's init message so client and server always use the same grid
let grid_width = 21;
let grid_length = 11;
let map: number[] = [];


const protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(`${protocol}//${location.host}/ws`);
let myId: string | null = null;
let players: Record<string, Player> = {};
let bombs: Record<string, Bomb> = {};
let explosions: Explosion[] = [];

socket.addEventListener("message", (event: MessageEvent) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "init") {
    myId = msg.id;
    players = msg.players;
    bombs = msg.bombs;
    map = msg.map;
    grid_width = msg.grid_width;
    grid_length = msg.grid_length;
  } else if (msg.type === "join") {
    players[msg.player.id] = msg.player;
  } else if (msg.type === "update") {
    players[msg.player.id] = msg.player;
  } else if (msg.type === "leave") {
    delete players[msg.id];
  } else if (msg.type === "bomb") {
    bombs[msg.bomb.owner] = msg.bomb;
  } else if (msg.type === "explosion") {
    delete bombs[msg.owner];
    explosions.push({ cells: msg.cells, until: Date.now() + EXPLOSION_SHOW_MS });
    for (const cell of msg.destroyed) {
      map[cell.y * grid_width + cell.x] = 0;
    }
  }
  updateLivesText();
});

function updateLivesText() {
  const me = myId ? players[myId] : undefined;
  if (!me) return;
  livesText.textContent = me.lives > 0 ? `Leben: ${"♥".repeat(me.lives)}` : "Ausgeschieden!";
}

function drawGrid() {
  const cellWidth = canvas.width / grid_width;
  const cellHeight = canvas.height / grid_length;

  ctx.strokeStyle = 'black';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i: number = 0; i <= grid_width; i++) {
    ctx.moveTo(i * cellWidth, 0);
    ctx.lineTo(i * cellWidth, canvas.height);
  }
  for (let j: number = 0; j <= grid_length; j++) {
    ctx.moveTo(0, j * cellHeight);
    ctx.lineTo(canvas.width, j * cellHeight);
  }
  ctx.stroke();
}

function drawMap() {
  const cellWidth = canvas.width / grid_width;
  const cellHeight = canvas.height / grid_length;

  for (let i: number = 0; i < map.length; i++) {
    if (map[i] === WALL || map[i] === BREAKABLE_WALL) {
      const x = i % grid_width;
      const y = Math.floor(i / grid_width);
      ctx.fillStyle = map[i] === WALL ? "grey" : "sienna";
      ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
    }
  }
}

function drawBombs() {
  const cellWidth = canvas.width / grid_width;
  const cellHeight = canvas.height / grid_length;

  ctx.fillStyle = "black";
  for (const owner in bombs) {
    const b = bombs[owner];
    ctx.beginPath();
    ctx.arc((b.x + 0.5) * cellWidth, (b.y + 0.5) * cellHeight, Math.min(cellWidth, cellHeight) * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawExplosions() {
  const cellWidth = canvas.width / grid_width;
  const cellHeight = canvas.height / grid_length;

  explosions = explosions.filter((ex) => ex.until > Date.now());
  ctx.fillStyle = "orange";
  for (const ex of explosions) {
    for (const cell of ex.cells) {
      ctx.fillRect(cell.x * cellWidth, cell.y * cellHeight, cellWidth, cellHeight);
    }
  }
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].indexOf(e.key) !== -1) {
    socket.send(JSON.stringify({ type: "move", dir: keyToDir(e.key) }));
  } else if (e.key === " ") {
    e.preventDefault(); // stop the page from scrolling / clicking a focused button
    if (!e.repeat) socket.send(JSON.stringify({ type: "bomb" }));
  }
});

document.getElementById("controls")!.addEventListener("click", (e: MouseEvent) => {
  const target = e.target as HTMLButtonElement;
  if (target.tagName === "BUTTON") {
    const dir = target.id;
    socket.send(JSON.stringify({ type: "move", dir }));
  }
});

function keyToDir(key: string): string {
  switch (key) {
    case "w": case "ArrowUp": return "up";
    case "s": case "ArrowDown": return "down";
    case "a": case "ArrowLeft": return "left";
    case "d": case "ArrowRight": return "right";
    default: return "";
  }
}

function gameLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawMap();
  drawExplosions();
  drawGrid();
  drawBombs();
  const cellWidth = canvas.width / grid_width;
  const cellHeight = canvas.height / grid_length;
  for (const id in players) {
    const p = players[id];
    if (p.lives <= 0) continue; // out of lives, removed from the board
    ctx.fillStyle = id === myId ? "blue" : "red";
    ctx.fillRect(p.x * cellWidth, p.y * cellHeight, cellWidth, cellHeight);

    // lives as small hearts inside the player's cell
    ctx.fillStyle = "white";
    ctx.font = `${Math.floor(cellHeight * 0.3)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("♥".repeat(p.lives), (p.x + 0.5) * cellWidth, (p.y + 0.5) * cellHeight);
  }
  requestAnimationFrame(gameLoop);
}
gameLoop();
