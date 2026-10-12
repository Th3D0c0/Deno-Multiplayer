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

const players: Record<string, Player> = {};
const sockets = new Map<string, WebSocket>();
// one bomb per player, keyed by the owner's id
const bombs: Record<string, Bomb> = {};

const BOMB_FUSE_MS = 2000;
const EXPLOSION_RADIUS = 5;
const START_LIVES = 3;
const BREAKABLE_WALL_CHANCE = 0.6; // chance that a free cell gets a breakable wall

// map values
const EMPTY = 0;
const WALL = 1; // can't be destroyed
const BREAKABLE_WALL = 2; // destroyed by explosions

// odd sizes so the pillars are symmetric (like Bomberman)
const grid_width = 21;
const grid_length = 11;

// the four inner corners, top left / top right / bottom left / bottom right
const spawnPoints = [
  { x: 1, y: 1 },
  { x: grid_width - 2, y: 1 },
  { x: 1, y: grid_length - 2 },
  { x: grid_width - 2, y: grid_length - 2 },
];

const map: number[] = new Array(grid_width * grid_length).fill(EMPTY);

// spawn corner and the cells right next to it stay free, so players don't start trapped
function isNearSpawn(x: number, y: number): boolean {
  return spawnPoints.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) <= 1);
}

function generateMap(map: number[]) {
  for (let i = 0; i < grid_width * grid_length; i++) {
    const x = i % grid_width;
    const y = Math.floor(i / grid_width);
    if (x === 0 || x === grid_width - 1 || y === 0 || y === grid_length - 1) {
      map[i] = WALL;
    } else if (x % 2 === 0 && y % 2 === 0) {
      // pillar on every second cell inside the border
      map[i] = WALL;
    } else if (!isNearSpawn(x, y) && Math.random() < BREAKABLE_WALL_CHANCE) {
      map[i] = BREAKABLE_WALL;
    } else {
      map[i] = EMPTY;
    }
  }
}

generateMap(map);

function xyToIndex(x: number, y: number): number {
  return y * grid_width + x;
}

function getCell(x: number, y: number): number {
  if (x < 0 || x >= grid_width || y < 0 || y >= grid_length) return WALL;
  return map[xyToIndex(x, y)];
}

function isWalkable(x: number, y: number): boolean {
  return getCell(x, y) === EMPTY;
}

function getSpawnPoint(): { x: number; y: number } {
  // first corner nobody is standing on, otherwise the corner with the fewest players
  let best = spawnPoints[0];
  let bestCount = Infinity;
  for (const spawn of spawnPoints) {
    const count = Object.values(players).filter((p) => p.lives > 0 && p.x === spawn.x && p.y === spawn.y).length;
    if (count < bestCount) {
      best = spawn;
      bestCount = count;
    }
  }
  return best;
}

function getExplosionCells(bomb: Bomb): { x: number; y: number }[] {
  const cells = [{ x: bomb.x, y: bomb.y }];
  const directions = [
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
  ];
  for (const { dx, dy } of directions) {
    for (let step = 1; step <= EXPLOSION_RADIUS; step++) {
      const x = bomb.x + dx * step;
      const y = bomb.y + dy * step;
      const cell = getCell(x, y);
      // solid walls stop the explosion in this direction
      if (cell === WALL) break;
      cells.push({ x, y });
      // breakable walls get hit, but also stop the explosion
      if (cell === BREAKABLE_WALL) break;
    }
  }
  return cells;
}

function explode(bomb: Bomb) {
  delete bombs[bomb.owner];
  const cells = getExplosionCells(bomb);

  const destroyed: { x: number; y: number }[] = [];
  for (const cell of cells) {
    const i = xyToIndex(cell.x, cell.y);
    if (map[i] === BREAKABLE_WALL) {
      map[i] = EMPTY;
      destroyed.push(cell);
    }
  }

  broadcast({ type: "explosion", owner: bomb.owner, cells, destroyed });

  // every living player standing in the explosion loses one life
  for (const p of Object.values(players)) {
    if (p.lives <= 0) continue;
    if (cells.some((c) => c.x === p.x && c.y === p.y)) {
      p.lives -= 1;
      broadcast({ type: "update", player: p });
    }
  }
}

function placeBomb(owner: string) {
  const p = players[owner];
  if (!p || p.lives <= 0 || bombs[owner]) return; // next bomb only after the current one exploded

  const bomb: Bomb = { owner, x: p.x, y: p.y };
  bombs[owner] = bomb;
  broadcast({ type: "bomb", bomb });

  setTimeout(() => explode(bomb), BOMB_FUSE_MS);
}

function broadcast(message: unknown, except?: string) {
  for (const [id, socket] of sockets) {
    if (id !== except) {
      socket.send(JSON.stringify(message));
    }
  }
}

Deno.serve((request) => {
  const { pathname } = new URL(request.url);

  // Static file serving
  if (pathname === "/") {
    return new Response(Deno.readTextFileSync("./public/index.html"), {
      headers: { "content-type": "text/html" },
    });
  }

  if (pathname === "/client.js") {
    return new Response(Deno.readTextFileSync("./public/client.js"), {
      headers: { "content-type": "application/javascript" },
    });
  }

  // WebSocket for game
  if (pathname === "/ws") {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response(null, { status: 501 });
    }

    const { socket, response } = Deno.upgradeWebSocket(request);
    guardSocket(socket); // comment this line to disable idle/max timeout for testing (careful on Deno Deploy free plan)
    const id = crypto.randomUUID();

    // x and y are grid cells, not pixels
    const spawn = getSpawnPoint();
    players[id] = { id, x: spawn.x, y: spawn.y, lives: START_LIVES };
    sockets.set(id, socket);

    socket.addEventListener("open", () => {
      console.log(`Player ${id} connected`);
      socket.send(JSON.stringify({ type: "init", id, players, bombs, map, grid_width, grid_length }));
      broadcast({ type: "join", player: players[id] }, id);
    });

    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "move") {
        const p = players[id];
        if (!p || p.lives <= 0) return;
        let nx = p.x;
        let ny = p.y;
        if (msg.dir === "up") ny -= 1;
        if (msg.dir === "down") ny += 1;
        if (msg.dir === "left") nx -= 1;
        if (msg.dir === "right") nx += 1;
        if (!isWalkable(nx, ny)) return;
        p.x = nx;
        p.y = ny;
        broadcast({ type: "update", player: p });
      } else if (msg.type === "bomb") {
        placeBomb(id);
      }
    });

    socket.addEventListener("close", () => {
      console.log(`Player ${id} disconnected`);
      delete players[id];
      sockets.delete(id);
      broadcast({ type: "leave", id });
    });

    return response;
  }

  return new Response("Not found", { status: 404 });
});


// When using Deno Deploy, the free plan's quota can be conserved by closing sockets that are idle or have been connected for too long
const IDLE_MS = 10 * 60 * 1000;     // close connection after 10 minutes of inactivity
const MAX_MS = 4 * 60 * 60 * 1000;  // close the connection after 4 hours

function guardSocket(socket: WebSocket) {
  let idle: number | undefined;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => socket.close(4000, "idle timeout"), IDLE_MS);
  };
  const max = setTimeout(() => socket.close(4001, "max duration"), MAX_MS);

  socket.addEventListener("open", resetIdle);
  socket.addEventListener("message", resetIdle);
  socket.addEventListener("close", () => {
    clearTimeout(idle);
    clearTimeout(max);
  });
}

