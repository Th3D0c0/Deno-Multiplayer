// Game world, rules, bots and snapshot building for the Bomber MMO.
// server.ts only does HTTP + websockets and calls the exported functions at the bottom of this file.

// ---------- constants ----------

export const MAP_W = 201;
export const MAP_H = 201;
export const CHUNK = 16;
export const CHUNKS_X = Math.ceil(MAP_W / CHUNK); // 13
export const CHUNKS_Y = Math.ceil(MAP_H / CHUNK); // 13
const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y; // 169

export const TICK_MS = 50; // 20 ticks per second
export const VIEW_X = 24; // the server sends everything within ±VIEW_X / ±VIEW_Y cells
export const VIEW_Y = 16;

const FUSE_TICKS = 40; // 2 s
const NUKE_FUSE_TICKS = 60; // 3 s
const FLAME_TICKS = 10; // 0.5 s, flames hurt the whole time

const BASE_RADIUS = 5;
const MAX_RADIUS = 12;
const NUKE_RADIUS = 15;
const BASE_BOMBS = 1;
const MAX_BOMBS = 8;
const START_LIVES = 3;
const MAX_LIVES = 5;
const SPEED_DELAYS_MS = [200, 170, 145, 125, 110, 95]; // ms per cell step for speed level 0..5

const SPAWN_INV_TICKS = 60;
const HIT_INV_TICKS = 40;
const RESPAWN_TICKS = 60;

const CRATE_DENSITY = 0.45; // target fraction of non-wall cells that are crates
const DROP_CHANCE = 0.3; // chance that a destroyed crate drops a power-up
const REGROW_TRIES_PER_TICK = 10;

const MAX_BUFFERED_BYTES = 1_000_000; // skip snapshots for connections that can't keep up
const SPECTATE_SWITCH_TICKS = 200; // spectators switch to another player every ~10 s
const LEADERBOARD_EVERY_TICKS = 20; // once per second
const STATS_EVERY_MS = 5000;

// map values
const EMPTY = 0;
const WALL = 1; // never destroyed
const CRATE = 2; // destroyed by explosions
const PU_BOMB = 3; // +1 max bombs
const PU_FIRE = 4; // +1 radius
const PU_SPEED = 5; // +1 speed level
const PU_HEART = 6; // +1 life
const PU_PIERCE = 7; // flames pass through crates
const PU_NUKE = 8; // next bomb is a nuke

// power-up drop weights (same order as the list)
const DROP_TYPES = [PU_BOMB, PU_FIRE, PU_SPEED, PU_HEART, PU_PIERCE, PU_NUKE];
const DROP_WEIGHTS = [26, 26, 20, 12, 10, 6];
const DROP_WEIGHT_SUM = DROP_WEIGHTS.reduce((a, b) => a + b, 0);

// directions: 0 up, 1 right, 2 down, 3 left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// ---------- types ----------

export interface Connection {
  socket: WebSocket;
  player: Player | null; // null while spectating
  sentVersions: Int32Array; // chunk version last sent to this connection (-1 = never)
  spectating: Player | null; // whom a spectator is watching
  spectateUntil: number; // tick when the spectator switches to someone else
}

interface Player {
  id: number;
  name: string;
  nameJson: string; // JSON.stringify(name), cached for snapshots
  isBot: boolean;
  conn: Connection | null; // null for bots
  x: number;
  y: number;
  dir: number; // facing direction
  input: number; // held direction, -1 = none
  nextMoveAt: number; // ms, earliest time for the next step
  alive: boolean;
  lives: number;
  respawnAt: number; // tick
  invUntil: number; // tick, invulnerable while tick < invUntil
  maxBombs: number;
  activeBombs: number;
  radius: number;
  speed: number;
  pierce: boolean;
  nukes: number;
  // power-ups collected since the last spawn (dropped again on death)
  gotBomb: number;
  gotFire: number;
  gotSpeed: number;
  kills: number;
  deaths: number;
  streak: number;
  // bot only
  path: number[]; // directions still to walk
  wanderDir: number;
}

interface Bomb {
  i: number; // cell index
  x: number;
  y: number;
  owner: Player;
  explodeAt: number; // tick
  radius: number;
  pierce: boolean;
  nuke: boolean;
  exploding: boolean; // already queued for explosion this tick
}

interface Flame {
  until: number; // tick
  owner: Player;
  nuke: boolean;
}

// ---------- world state ----------

const map = new Uint8Array(MAP_W * MAP_H);
const chunkVersion = new Int32Array(CHUNK_COUNT);
const chunkCache: (string | null)[] = new Array(CHUNK_COUNT).fill(null); // '[cx,cy,"data"]' or null
const cellChunk = new Uint16Array(MAP_W * MAP_H); // chunk index of every cell
const occupancy = new Uint16Array(MAP_W * MAP_H); // alive players per cell

const players = new Map<number, Player>();
const bombs = new Map<number, Bomb>(); // key = cell index
const flames = new Map<number, Flame>(); // key = cell index
const connections = new Set<Connection>();

let tick = 0;
let nextPlayerId = 1;
let crateCount = 0;
let crateTarget = 0;
let botCount = 0;
let humanPlayerCount = 0;
let wasPaused = true;

// spatial hash: alive players per chunk, rebuilt every tick
const chunkPlayers: Player[][] = [];
for (let c = 0; c < CHUNK_COUNT; c++) chunkPlayers.push([]);
let alivePlayers: Player[] = [];

// things that happened this tick
const explosionsThisTick: Bomb[] = [];
const destroyedCrates: number[] = [];

// kill feed: [killer, victim, killerStreak]
const killFeed: [string, string, number][] = [];

// per chunk JSON fragments, rebuilt every tick
const fragPlayers: string[] = new Array(CHUNK_COUNT).fill("");
const fragBombs: string[] = new Array(CHUNK_COUNT).fill("");
const fragFlames: string[] = new Array(CHUNK_COUNT).fill("");
const fragEvents: string[] = new Array(CHUNK_COUNT).fill("");

// stats for the log line
const stats = { ticks: 0, tickMsSum: 0, tickMsMax: 0, sendMsSum: 0, msgsOut: 0, bytesOut: 0, msgsIn: 0, since: Date.now() };

// ---------- small helpers ----------

function randomInt(n: number): number {
  return Math.floor(Math.random() * n);
}

function chunkOf(x: number, y: number): number {
  return Math.floor(x / CHUNK) + Math.floor(y / CHUNK) * CHUNKS_X;
}

function isPowerUp(v: number): boolean {
  return v >= PU_BOMB;
}

// every map write goes through here, so chunk versions and the crate count stay correct
function setCell(i: number, v: number) {
  const old = map[i];
  if (old === v) return;
  if (old === CRATE) crateCount--;
  if (v === CRATE) crateCount++;
  map[i] = v;
  const c = cellChunk[i];
  chunkVersion[c]++;
  chunkCache[c] = null;
}

const CELL_CHARS: string[] = [];
for (let v = 0; v < 16; v++) CELL_CHARS.push(String.fromCharCode(48 + v));

// chunk entry for the "c" array: [cx,cy,"data"], one char per cell
function getChunkEntry(c: number): string {
  const cached = chunkCache[c];
  if (cached !== null) return cached;
  const cx = c % CHUNKS_X;
  const cy = Math.floor(c / CHUNKS_X);
  const x0 = cx * CHUNK;
  const y0 = cy * CHUNK;
  const x1 = Math.min(MAP_W, x0 + CHUNK);
  const y1 = Math.min(MAP_H, y0 + CHUNK);
  let data = "";
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) data += CELL_CHARS[map[x + y * MAP_W]];
  }
  const entry = `[${cx},${cy},"${data}"]`;
  chunkCache[c] = entry;
  return entry;
}

function send(conn: Connection, text: string) {
  if (conn.socket.readyState !== WebSocket.OPEN) return;
  try {
    conn.socket.send(text);
    stats.msgsOut++;
    stats.bytesOut += text.length;
  } catch {
    // socket closed in between, ignore
  }
}

// personal event for a human player (bots have no socket)
function sendEvent(p: Player, event: Record<string, unknown>) {
  if (p.conn) send(p.conn, JSON.stringify({ t: "ev", ...event }));
}

// ---------- map generation ----------

function generateMap() {
  let nonWall = 0;
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const i = x + y * MAP_W;
      cellChunk[i] = chunkOf(x, y);
      if (x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1) {
        map[i] = WALL; // outer border
      } else if (x % 2 === 0 && y % 2 === 0) {
        map[i] = WALL; // pillar
      } else {
        nonWall++;
        if (Math.random() < CRATE_DENSITY) {
          map[i] = CRATE;
          crateCount++;
        }
      }
    }
  }
  crateTarget = Math.floor(nonWall * CRATE_DENSITY);
}

// ---------- names ----------

const NAME_FIRST = [
  "Turbo", "Mega", "Wilder", "Flinke", "Knusper", "Super", "Kleiner", "Dicker", "Blitz", "Feuer",
  "Hyper", "Crazy", "Bombo", "Zacki", "Wusel", "Kaboom",
];
const NAME_SECOND = [
  "Toast", "Brezel", "Wurst", "Dackel", "Gurke", "Igel", "Keks", "Otter", "Waffel", "Knödel",
  "Krokodil", "Schnitzel", "Hamster", "Pudel", "Strudel", "Rakete",
];

function randomName(): string {
  for (;;) {
    const name = NAME_FIRST[randomInt(NAME_FIRST.length)] + " " + NAME_SECOND[randomInt(NAME_SECOND.length)];
    if (name.length <= 16) return name;
  }
}

function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return randomName();
  // remove control characters, trim, max 16 characters (Array.from keeps emoji in one piece)
  // deno-lint-ignore no-control-regex
  const name = Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()).slice(0, 16).join("").trim();
  return name === "" ? randomName() : name;
}

// ---------- players ----------

function createPlayer(name: string, conn: Connection | null): Player {
  const p: Player = {
    id: nextPlayerId++,
    name,
    nameJson: JSON.stringify(name),
    isBot: conn === null,
    conn,
    x: 1,
    y: 1,
    dir: 2,
    input: -1,
    nextMoveAt: 0,
    alive: false,
    lives: 0,
    respawnAt: 0,
    invUntil: 0,
    maxBombs: BASE_BOMBS,
    activeBombs: 0,
    radius: BASE_RADIUS,
    speed: 0,
    pierce: false,
    nukes: 0,
    gotBomb: 0,
    gotFire: 0,
    gotSpeed: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    path: [],
    wanderDir: randomInt(4),
  };
  players.set(p.id, p);
  if (p.isBot) botCount++;
  else humanPlayerCount++;
  return p;
}

function removePlayer(p: Player) {
  if (p.alive) occupancy[p.x + p.y * MAP_W]--;
  p.alive = false; // so spectators stop watching this player
  players.delete(p.id);
  if (p.isBot) botCount--;
  else humanPlayerCount--;
}

// is any alive player within `range` cells (square) of x,y?
function playerNear(x: number, y: number, range: number): boolean {
  for (let yy = Math.max(0, y - range); yy <= Math.min(MAP_H - 1, y + range); yy++) {
    for (let xx = Math.max(0, x - range); xx <= Math.min(MAP_W - 1, x + range); xx++) {
      if (occupancy[xx + yy * MAP_W] > 0) return true;
    }
  }
  return false;
}

function bombNear(x: number, y: number, range: number): boolean {
  if (bombs.size === 0) return false;
  for (let yy = Math.max(0, y - range); yy <= Math.min(MAP_H - 1, y + range); yy++) {
    for (let xx = Math.max(0, x - range); xx <= Math.min(MAP_W - 1, x + range); xx++) {
      if (bombs.has(xx + yy * MAP_W)) return true;
    }
  }
  return false;
}

// smart spawning: near the action (8..18 cells from a random alive player), but not on top of anyone
function findSpawnCell(): { x: number; y: number } {
  for (let attempt = 0; attempt < 80; attempt++) {
    let x: number;
    let y: number;
    if (attempt < 40 && alivePlayers.length > 0) {
      const anchor = alivePlayers[randomInt(alivePlayers.length)];
      const dist = 8 + Math.random() * 10;
      const angle = Math.random() * Math.PI * 2;
      x = Math.round(anchor.x + Math.cos(angle) * dist);
      y = Math.round(anchor.y + Math.sin(angle) * dist);
    } else {
      x = randomInt(MAP_W);
      y = randomInt(MAP_H);
    }
    // odd/odd cells are never pillars
    x |= 1;
    y |= 1;
    if (x < 1 || y < 1 || x > MAP_W - 2 || y > MAP_H - 2) continue;
    if (playerNear(x, y, 4) || bombNear(x, y, 6)) continue;
    return { x, y };
  }
  // the map is very full: take any odd/odd cell
  return { x: randomInt((MAP_W - 1) / 2) * 2 + 1, y: randomInt((MAP_H - 1) / 2) * 2 + 1 };
}

function spawnPlayer(p: Player) {
  const spawn = findSpawnCell();
  // clear the crates around the spawn so nobody starts trapped (pillars stay)
  for (let y = spawn.y - 2; y <= spawn.y + 2; y++) {
    for (let x = spawn.x - 2; x <= spawn.x + 2; x++) {
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      const i = x + y * MAP_W;
      if (map[i] === CRATE) setCell(i, EMPTY);
    }
  }
  p.x = spawn.x;
  p.y = spawn.y;
  p.alive = true;
  p.lives = START_LIVES;
  p.invUntil = tick + SPAWN_INV_TICKS;
  p.maxBombs = BASE_BOMBS;
  p.radius = BASE_RADIUS;
  p.speed = 0;
  p.pierce = false;
  p.nukes = 0;
  p.gotBomb = 0;
  p.gotFire = 0;
  p.gotSpeed = 0;
  p.input = p.isBot ? -1 : p.input;
  p.path = [];
  occupancy[p.x + p.y * MAP_W]++;
  pickUp(p); // in case a power-up lies on the spawn cell
  sendEvent(p, { k: "spawn" });
}

// ---------- movement and power-ups ----------

function pickUp(p: Player) {
  const i = p.x + p.y * MAP_W;
  const v = map[i];
  if (!isPowerUp(v)) return;
  setCell(i, EMPTY);
  if (v === PU_BOMB) {
    p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
    p.gotBomb++;
  } else if (v === PU_FIRE) {
    p.radius = Math.min(MAX_RADIUS, p.radius + 1);
    p.gotFire++;
  } else if (v === PU_SPEED) {
    p.speed = Math.min(SPEED_DELAYS_MS.length - 1, p.speed + 1);
    p.gotSpeed++;
  } else if (v === PU_HEART) {
    p.lives = Math.min(MAX_LIVES, p.lives + 1);
  } else if (v === PU_PIERCE) {
    p.pierce = true;
  } else if (v === PU_NUKE) {
    p.nukes++;
  }
  sendEvent(p, { k: "pu", pu: v });
}

// can a player walk onto this cell?
function isWalkable(i: number): boolean {
  const v = map[i];
  return v !== WALL && v !== CRATE && !bombs.has(i);
}

// one step in direction dir; returns true if the player moved
function tryStep(p: Player, dir: number): boolean {
  p.dir = dir; // facing changes even when blocked
  const nx = p.x + DX[dir];
  const ny = p.y + DY[dir];
  if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) return false;
  const ni = nx + ny * MAP_W;
  if (!isWalkable(ni)) return false;
  occupancy[p.x + p.y * MAP_W]--;
  p.x = nx;
  p.y = ny;
  occupancy[ni]++;
  pickUp(p);
  return true;
}

// step if the held direction allows it and the player is ready
function movePlayer(p: Player, now: number) {
  if (!p.alive || p.input < 0 || now < p.nextMoveAt) return;
  if (tryStep(p, p.input)) {
    p.nextMoveAt = Math.max(p.nextMoveAt, now - TICK_MS) + SPEED_DELAYS_MS[p.speed];
    // bots walk along their planned path, then stop until the next decision
    if (p.isBot) p.input = p.path.length > 0 ? p.path.shift()! : -1;
  }
}

// ---------- bombs and explosions ----------

function placeBomb(p: Player): boolean {
  if (!p.alive || p.activeBombs >= p.maxBombs) return false;
  const i = p.x + p.y * MAP_W;
  if (bombs.has(i)) return false; // one bomb per cell
  const nuke = p.nukes > 0;
  if (nuke) p.nukes--;
  bombs.set(i, {
    i,
    x: p.x,
    y: p.y,
    owner: p,
    explodeAt: tick + (nuke ? NUKE_FUSE_TICKS : FUSE_TICKS),
    radius: nuke ? NUKE_RADIUS : p.radius,
    pierce: nuke || p.pierce,
    nuke,
    exploding: false,
  });
  p.activeBombs++;
  return true;
}

function addFlame(i: number, bomb: Bomb) {
  flames.set(i, { until: tick + FLAME_TICKS, owner: bomb.owner, nuke: bomb.nuke });
}

function explode(bomb: Bomb, queue: Bomb[]) {
  bombs.delete(bomb.i);
  bomb.owner.activeBombs = Math.max(0, bomb.owner.activeBombs - 1);
  explosionsThisTick.push(bomb);
  addFlame(bomb.i, bomb);

  for (let d = 0; d < 4; d++) {
    for (let step = 1; step <= bomb.radius; step++) {
      const x = bomb.x + DX[d] * step;
      const y = bomb.y + DY[d] * step;
      const i = x + y * MAP_W;
      const v = map[i]; // the border is wall, so we never leave the map
      if (v === WALL) break; // walls stop the flame
      addFlame(i, bomb);

      // chain reaction: another bomb in the way explodes in this same tick
      const other = bombs.get(i);
      if (other && !other.exploding) {
        other.exploding = true;
        queue.push(other);
      }

      if (v === CRATE) {
        destroyedCrates.push(i); // resolved after all explosions of this tick
        if (!bomb.pierce) break;
      } else if (isPowerUp(v)) {
        setCell(i, EMPTY); // explosions destroy items
        if (!bomb.pierce) break;
      }
    }
  }
}

function randomDrop(): number {
  let r = Math.random() * DROP_WEIGHT_SUM;
  for (let k = 0; k < DROP_TYPES.length; k++) {
    r -= DROP_WEIGHTS[k];
    if (r < 0) return DROP_TYPES[k];
  }
  return PU_BOMB;
}

function updateBombs() {
  const queue: Bomb[] = [];
  for (const bomb of bombs.values()) {
    // fuse is over, or a flame is lying on the bomb
    if (bomb.explodeAt <= tick || flames.has(bomb.i)) {
      bomb.exploding = true;
      queue.push(bomb);
    }
  }
  // the queue grows while we go through it (chain reactions)
  for (let q = 0; q < queue.length; q++) explode(queue[q], queue);

  // destroyed crates become a power-up or empty floor
  for (const i of destroyedCrates) {
    if (map[i] !== CRATE) continue; // hit by two explosions
    setCell(i, Math.random() < DROP_CHANCE ? randomDrop() : EMPTY);
  }
  destroyedCrates.length = 0;
}

function expireFlames() {
  for (const [i, flame] of flames) {
    if (flame.until <= tick) flames.delete(i);
  }
}

// ---------- hits, deaths, kill feed ----------

function updateHits() {
  for (const p of players.values()) {
    if (!p.alive || p.invUntil > tick) continue;
    const flame = flames.get(p.x + p.y * MAP_W);
    if (!flame) continue;
    p.lives--;
    p.invUntil = tick + HIT_INV_TICKS;
    if (p.lives > 0) {
      sendEvent(p, { k: "hit", by: flame.owner.name });
    } else {
      killPlayer(p, flame.owner);
    }
  }
}

function killPlayer(victim: Player, killer: Player) {
  victim.alive = false;
  victim.deaths++;
  victim.streak = 0;
  victim.respawnAt = tick + RESPAWN_TICKS;
  victim.input = victim.isBot ? -1 : victim.input;
  occupancy[victim.x + victim.y * MAP_W]--;
  dropPowerUps(victim);

  if (killer !== victim) {
    killer.kills++;
    killer.streak++;
    sendEvent(killer, { k: "kill", name: victim.name, streak: killer.streak });
  }
  sendEvent(victim, { k: "die", by: killer.name });
  killFeed.push([killer.name, victim.name, killer.streak]);
  if (killFeed.length > 6) killFeed.shift();
}

// drop up to 3 of the collected bomb/fire/speed power-ups on empty cells nearby
function dropPowerUps(p: Player) {
  const items: number[] = [];
  for (let k = 0; k < p.gotBomb; k++) items.push(PU_BOMB);
  for (let k = 0; k < p.gotFire; k++) items.push(PU_FIRE);
  for (let k = 0; k < p.gotSpeed; k++) items.push(PU_SPEED);
  if (items.length === 0) return;
  shuffle(items);

  const cells: number[] = [];
  for (let y = p.y - 2; y <= p.y + 2; y++) {
    for (let x = p.x - 2; x <= p.x + 2; x++) {
      if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
      const i = x + y * MAP_W;
      if (map[i] === EMPTY && !bombs.has(i)) cells.push(i);
    }
  }
  shuffle(cells);
  const count = Math.min(3, items.length, cells.length);
  for (let k = 0; k < count; k++) setCell(cells[k], items[k]);
}

function shuffle<T>(list: T[]) {
  for (let k = list.length - 1; k > 0; k--) {
    const j = randomInt(k + 1);
    const tmp = list[k];
    list[k] = list[j];
    list[j] = tmp;
  }
}

// ---------- crate regrowth ----------

function regrowCrates() {
  for (let attempt = 0; attempt < REGROW_TRIES_PER_TICK && crateCount < crateTarget; attempt++) {
    const x = 1 + randomInt(MAP_W - 2);
    const y = 1 + randomInt(MAP_H - 2);
    const i = x + y * MAP_W;
    if (map[i] !== EMPTY || bombs.has(i) || flames.has(i)) continue;
    if (playerNear(x, y, 3)) continue;
    setCell(i, CRATE);
  }
}

// ---------- bots ----------

// is this cell on a flame or in line of a bomb that will reach it?
// extraBomb* describe a bomb the bot is only thinking about placing (extraBombIndex -1 = none)
function isDangerous(x: number, y: number, extraBombIndex = -1, extraRadius = 0, extraPierce = false): boolean {
  const i = x + y * MAP_W;
  if (flames.has(i) || bombs.has(i) || i === extraBombIndex) return true;
  for (let d = 0; d < 4; d++) {
    let behindCrate = false;
    for (let step = 1; step <= NUKE_RADIUS; step++) {
      const ni = (x + DX[d] * step) + (y + DY[d] * step) * MAP_W;
      const v = map[ni];
      if (v === WALL) break;
      const bomb = bombs.get(ni);
      if (bomb && bomb.radius >= step && (!behindCrate || bomb.pierce)) return true;
      if (ni === extraBombIndex && extraRadius >= step && (!behindCrate || extraPierce)) return true;
      if (v === CRATE) behindCrate = true;
    }
  }
  return false;
}

// BFS buffers, reused for every search (stamp trick avoids clearing)
const bfsStamp = new Int32Array(MAP_W * MAP_H);
const bfsFrom = new Int32Array(MAP_W * MAP_H); // previous cell
const bfsDepth = new Int8Array(MAP_W * MAP_H);
const bfsQueue = new Int32Array(1024);
let bfsGeneration = 0;
const BFS_MAX_DEPTH = 7;

// path (list of directions) to the nearest safe cell, or null if there is none within 7 steps
function findEscape(p: Player, extraBombIndex = -1, extraRadius = 0, extraPierce = false): number[] | null {
  bfsGeneration++;
  const start = p.x + p.y * MAP_W;
  let head = 0;
  let tail = 0;
  bfsQueue[tail++] = start;
  bfsStamp[start] = bfsGeneration;
  bfsDepth[start] = 0;
  bfsFrom[start] = -1;
  while (head < tail) {
    const i = bfsQueue[head++];
    const x = i % MAP_W;
    const y = (i - x) / MAP_W;
    if (i !== start && !isDangerous(x, y, extraBombIndex, extraRadius, extraPierce)) {
      // walk back to the start to build the path
      const path: number[] = [];
      let cur = i;
      while (bfsFrom[cur] !== -1) {
        const prev = bfsFrom[cur];
        const diff = cur - prev;
        path.push(diff === -MAP_W ? 0 : diff === 1 ? 1 : diff === MAP_W ? 2 : 3);
        cur = prev;
      }
      return path.reverse();
    }
    if (bfsDepth[i] >= BFS_MAX_DEPTH) continue;
    for (let d = 0; d < 4; d++) {
      const ni = i + DX[d] + DY[d] * MAP_W;
      if (bfsStamp[ni] === bfsGeneration) continue;
      if (!isWalkable(ni) || ni === extraBombIndex || flames.has(ni)) continue;
      bfsStamp[ni] = bfsGeneration;
      bfsFrom[ni] = i;
      bfsDepth[ni] = bfsDepth[i] + 1;
      if (tail < bfsQueue.length) bfsQueue[tail++] = ni;
    }
  }
  return null;
}

// enemy within 3 cells in a straight line (not behind a wall or crate)?
function enemyInLine(p: Player): boolean {
  for (let d = 0; d < 4; d++) {
    for (let step = 1; step <= 3; step++) {
      const i = (p.x + DX[d] * step) + (p.y + DY[d] * step) * MAP_W;
      const v = map[i];
      if (v === WALL || v === CRATE) break;
      if (occupancy[i] > 0) return true;
    }
  }
  return false;
}

function nextToCrate(p: Player): boolean {
  for (let d = 0; d < 4; d++) {
    if (map[(p.x + DX[d]) + (p.y + DY[d]) * MAP_W] === CRATE) return true;
  }
  return false;
}

// neighbour cell is walkable and not dangerous
function isSafeStep(p: Player, d: number): boolean {
  const nx = p.x + DX[d];
  const ny = p.y + DY[d];
  return isWalkable(nx + ny * MAP_W) && !flames.has(nx + ny * MAP_W) && !isDangerous(nx, ny);
}

function setBotPath(p: Player, path: number[]) {
  p.path = path;
  p.input = path.length > 0 ? path.shift()! : -1;
}

function botThink(p: Player) {
  // 1. danger: run to the nearest safe cell
  if (isDangerous(p.x, p.y)) {
    const escape = findEscape(p);
    setBotPath(p, escape ?? []);
    return;
  }

  // 2. maybe place a bomb next to a crate or an enemy, but only if we can escape from it
  const here = p.x + p.y * MAP_W;
  if (p.activeBombs < p.maxBombs && !bombs.has(here)) {
    const wantsBomb = (enemyInLine(p) && Math.random() < 0.6) || (nextToCrate(p) && Math.random() < 0.3);
    if (wantsBomb) {
      const radius = p.nukes > 0 ? NUKE_RADIUS : p.radius;
      const pierce = p.nukes > 0 || p.pierce;
      const escape = findEscape(p, here, radius, pierce);
      if (escape && placeBomb(p)) {
        setBotPath(p, escape);
        return;
      }
    }
  }

  // 3. grab a power-up right next to us
  for (let d = 0; d < 4; d++) {
    const ni = (p.x + DX[d]) + (p.y + DY[d]) * MAP_W;
    if (isPowerUp(map[ni]) && isSafeStep(p, d)) {
      setBotPath(p, [d]);
      return;
    }
  }

  // 4. wander: keep going unless blocked or dangerous, sometimes turn
  if (isSafeStep(p, p.wanderDir) && Math.random() >= 0.15) {
    setBotPath(p, [p.wanderDir]);
    return;
  }
  const options: number[] = [];
  for (let d = 0; d < 4; d++) if (isSafeStep(p, d)) options.push(d);
  if (options.length === 0) {
    setBotPath(p, []);
    return;
  }
  p.wanderDir = options[randomInt(options.length)];
  setBotPath(p, [p.wanderDir]);
}

function updateBots() {
  for (const p of players.values()) {
    // every 3rd tick, staggered by id so not all bots think in the same tick
    if (p.isBot && p.alive && (tick + p.id) % 3 === 0) botThink(p);
  }
}

// ---------- spatial hash and snapshots ----------

function rebuildSpatialHash() {
  for (let c = 0; c < CHUNK_COUNT; c++) chunkPlayers[c].length = 0;
  alivePlayers = [];
  for (const p of players.values()) {
    if (!p.alive) continue;
    alivePlayers.push(p);
    chunkPlayers[cellChunk[p.x + p.y * MAP_W]].push(p);
  }
}

// one JSON fragment per chunk for players, bombs, flames and explosion events
function buildFragments() {
  for (let c = 0; c < CHUNK_COUNT; c++) {
    let text = "";
    for (const p of chunkPlayers[c]) {
      const entry = `[${p.id},${p.x},${p.y},${p.lives},${p.invUntil > tick ? 1 : 0},${p.dir},${p.nameJson}]`;
      text = text === "" ? entry : text + "," + entry;
    }
    fragPlayers[c] = text;
    fragBombs[c] = "";
    fragFlames[c] = "";
    fragEvents[c] = "";
  }
  for (const bomb of bombs.values()) {
    const c = cellChunk[bomb.i];
    const entry = `[${bomb.x},${bomb.y},${bomb.explodeAt - tick},${bomb.nuke ? 1 : 0},${bomb.pierce ? 1 : 0}]`;
    fragBombs[c] = fragBombs[c] === "" ? entry : fragBombs[c] + "," + entry;
  }
  for (const [i, flame] of flames) {
    const c = cellChunk[i];
    const x = i % MAP_W;
    const entry = `[${x},${(i - x) / MAP_W},${flame.nuke ? 1 : 0}]`;
    fragFlames[c] = fragFlames[c] === "" ? entry : fragFlames[c] + "," + entry;
  }
  for (const bomb of explosionsThisTick) {
    const c = cellChunk[bomb.i];
    const entry = `[${bomb.x},${bomb.y},${bomb.radius},${bomb.nuke ? 1 : 0}]`;
    fragEvents[c] = fragEvents[c] === "" ? entry : fragEvents[c] + "," + entry;
  }
  explosionsThisTick.length = 0;
}

function meJson(p: Player): string {
  return `{"id":${p.id},"x":${p.x},"y":${p.y},"alive":${p.alive},"lives":${p.lives},` +
    `"respawnIn":${p.alive ? 0 : Math.max(0, p.respawnAt - tick)},"bombs":${p.maxBombs},"active":${p.activeBombs},` +
    `"radius":${p.radius},"speed":${p.speed},"pierce":${p.pierce},"nukes":${p.nukes},"kills":${p.kills},` +
    `"deaths":${p.deaths},"streak":${p.streak},"inv":${p.invUntil > tick}}`;
}

// where is this connection looking? own player, or the spectated player
function cameraOf(conn: Connection): { x: number; y: number } {
  if (conn.player) return { x: conn.player.x, y: conn.player.y };
  const target = conn.spectating;
  if (!target || !target.alive || tick >= conn.spectateUntil) {
    conn.spectating = alivePlayers.length > 0 ? alivePlayers[randomInt(alivePlayers.length)] : null;
    conn.spectateUntil = tick + SPECTATE_SWITCH_TICKS;
  }
  if (conn.spectating) return { x: conn.spectating.x, y: conn.spectating.y };
  return { x: (MAP_W - 1) / 2, y: (MAP_H - 1) / 2 };
}

function sendSnapshot(conn: Connection) {
  if (conn.socket.readyState !== WebSocket.OPEN) return;
  if (conn.socket.bufferedAmount > MAX_BUFFERED_BYTES) return; // slow client, skip this tick

  const cam = cameraOf(conn);
  const cx0 = Math.max(0, Math.floor((cam.x - VIEW_X) / CHUNK));
  const cx1 = Math.min(CHUNKS_X - 1, Math.floor((cam.x + VIEW_X) / CHUNK));
  const cy0 = Math.max(0, Math.floor((cam.y - VIEW_Y) / CHUNK));
  const cy1 = Math.min(CHUNKS_Y - 1, Math.floor((cam.y + VIEW_Y) / CHUNK));

  // just glue the prepared fragments of the visible chunks together
  let ps = "";
  let bs = "";
  let fs = "";
  let es = "";
  let cs = "";
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cx + cy * CHUNKS_X;
      if (fragPlayers[c] !== "") ps = ps === "" ? fragPlayers[c] : ps + "," + fragPlayers[c];
      if (fragBombs[c] !== "") bs = bs === "" ? fragBombs[c] : bs + "," + fragBombs[c];
      if (fragFlames[c] !== "") fs = fs === "" ? fragFlames[c] : fs + "," + fragFlames[c];
      if (fragEvents[c] !== "") es = es === "" ? fragEvents[c] : es + "," + fragEvents[c];
      if (conn.sentVersions[c] !== chunkVersion[c]) {
        conn.sentVersions[c] = chunkVersion[c];
        const entry = getChunkEntry(c);
        cs = cs === "" ? entry : cs + "," + entry;
      }
    }
  }
  const me = conn.player ? meJson(conn.player) : "null";
  send(
    conn,
    `{"t":"s","k":${tick},"me":${me},"cam":[${cam.x},${cam.y}],"p":[${ps}],"b":[${bs}],"f":[${fs}],"e":[${es}],"c":[${cs}]}`,
  );
}

// ---------- leaderboard ----------

function sendLeaderboard() {
  const sorted = Array.from(players.values()).sort((a, b) => b.kills - a.kills || b.streak - a.streak);
  const top = sorted.slice(0, 10).map((p) => [p.id, p.name, p.kills, p.streak]);
  const heat: number[] = [];
  for (let c = 0; c < CHUNK_COUNT; c++) heat.push(chunkPlayers[c].length);
  const text = JSON.stringify({
    t: "lb",
    top,
    feed: killFeed,
    humans: connections.size,
    bots: botCount,
    heat,
  });
  for (const conn of connections) send(conn, text); // same string for everybody
}

// ---------- stats ----------

function logStats() {
  const now = Date.now();
  const seconds = (now - stats.since) / 1000;
  if (seconds * 1000 < STATS_EVERY_MS) return;
  const avg = stats.ticks > 0 ? stats.tickMsSum / stats.ticks : 0;
  const memMb = Deno.memoryUsage().rss / 1024 / 1024;
  console.log(
    `[stats] humans=${connections.size} bots=${botCount} players=${players.size} ` +
      `avgTick=${avg.toFixed(2)}ms maxTick=${stats.tickMsMax.toFixed(2)}ms ticks/s=${(stats.ticks / seconds).toFixed(1)} ` +
      `(snapshots ${(stats.ticks > 0 ? stats.sendMsSum / stats.ticks : 0).toFixed(2)}ms) ` +
      `msgs/s=${Math.round(stats.msgsOut / seconds)} KB/s=${Math.round(stats.bytesOut / 1024 / seconds)} ` +
      `in/s=${Math.round(stats.msgsIn / seconds)} bombs=${bombs.size} flames=${flames.size} ` +
      `crates=${crateCount}/${crateTarget} rss=${memMb.toFixed(0)}MB`,
  );
  stats.ticks = 0;
  stats.tickMsSum = 0;
  stats.tickMsMax = 0;
  stats.sendMsSum = 0;
  stats.msgsOut = 0;
  stats.bytesOut = 0;
  stats.msgsIn = 0;
  stats.since = now;
}

// ---------- the tick ----------

function gameTick() {
  // nobody is watching: don't simulate at all (saves Deno Deploy quota)
  if (connections.size === 0) {
    if (!wasPaused) console.log("[game] no players online, pausing the simulation");
    wasPaused = true;
    return;
  }
  if (wasPaused) {
    console.log("[game] simulation running");
    wasPaused = false;
    stats.since = Date.now();
  }

  const started = performance.now();
  tick++;
  rebuildSpatialHash();

  // respawns
  for (const p of players.values()) {
    if (!p.alive && p.lives === 0 && p.respawnAt <= tick) spawnPlayer(p);
  }

  updateBots();

  const now = performance.now();
  for (const p of players.values()) movePlayer(p, now);

  updateBombs();
  expireFlames();
  updateHits();
  regrowCrates();

  rebuildSpatialHash();
  const sendStarted = performance.now();
  buildFragments();
  for (const conn of connections) sendSnapshot(conn);
  stats.sendMsSum += performance.now() - sendStarted;

  if (tick % LEADERBOARD_EVERY_TICKS === 0) sendLeaderboard();

  const took = performance.now() - started;
  stats.ticks++;
  stats.tickMsSum += took;
  stats.tickMsMax = Math.max(stats.tickMsMax, took);
  logStats();
}

// ---------- API for server.ts ----------

export function startGame() {
  generateMap();
  let wantedBots = 50;
  try {
    const env = Deno.env.get("BOTS");
    if (env !== undefined && env.trim() !== "" && !isNaN(Number(env))) wantedBots = Math.max(0, Math.floor(Number(env)));
  } catch {
    // no env permission: keep the default
  }
  for (let k = 0; k < wantedBots; k++) {
    const bot = createPlayer("🤖 " + randomName(), null);
    spawnPlayer(bot);
    alivePlayers.push(bot);
  }
  console.log(`[game] map ${MAP_W}x${MAP_H}, ${crateCount} crates, ${wantedBots} bots`);

  // Like setInterval(gameTick, TICK_MS), but it keeps exactly 20 ticks/s:
  // setInterval(50) only gives ~16 ticks/s on Windows (timer steps of ~15.6 ms),
  // so each tick is planned on a fixed timeline and a late tick makes the next wait shorter.
  let nextTickAt = performance.now() + TICK_MS;
  const loop = () => {
    gameTick();
    nextTickAt += TICK_MS;
    const now = performance.now();
    if (now - nextTickAt > 250) nextTickAt = now; // far behind (e.g. laptop was asleep): don't catch up
    setTimeout(loop, Math.max(0, nextTickAt - now));
  };
  setTimeout(loop, TICK_MS);
}

export function openConnection(socket: WebSocket): Connection {
  const conn: Connection = {
    socket,
    player: null,
    sentVersions: new Int32Array(CHUNK_COUNT).fill(-1),
    spectating: null,
    spectateUntil: 0,
  };
  connections.add(conn);
  send(conn, JSON.stringify({ t: "init", w: MAP_W, h: MAP_H, chunk: CHUNK, tick: TICK_MS, vx: VIEW_X, vy: VIEW_Y }));
  return conn;
}

export function closeConnection(conn: Connection) {
  connections.delete(conn);
  if (conn.player) removePlayer(conn.player);
  conn.player = null;
}

export function handleMessage(conn: Connection, data: unknown) {
  stats.msgsIn++;
  if (typeof data !== "string" || data.length > 500) return;
  // deno-lint-ignore no-explicit-any
  let msg: any;
  try {
    msg = JSON.parse(data);
  } catch {
    return; // malformed, ignore
  }
  if (!msg || typeof msg !== "object") return;

  if (msg.t === "join") {
    if (conn.player) return; // already playing
    const p = createPlayer(cleanName(msg.name), conn);
    conn.player = p;
    send(conn, JSON.stringify({ t: "you", id: p.id }));
    spawnPlayer(p);
  } else if (msg.t === "in") {
    const p = conn.player;
    const d = msg.d;
    if (!p || (d !== -1 && d !== 0 && d !== 1 && d !== 2 && d !== 3)) return;
    if (d === p.input) return;
    p.input = d;
    // new direction and ready: step right away instead of waiting for the next tick
    if (d >= 0 && p.alive) movePlayer(p, performance.now());
  } else if (msg.t === "b") {
    if (conn.player) placeBomb(conn.player);
  }
}
