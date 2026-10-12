// =====================================================================
// Bomber Deno CrockoDelo – MMO client
// =====================================================================
// The server is authoritative: this script only sends inputs ("join", "in", "b")
// and draws whatever the snapshots ("s") say. Everything else here is juice:
// tweening, particles, screen shake, sounds and the HUD.
// It is ONE self-contained script on purpose (no import/export), compiled with `tsc -p .`.

// ---------- cell values (same numbers as on the server) ----------
const EMPTY = 0;
const WALL = 1;
const CRATE = 2;
const PU_BOMB = 3;
const PU_FIRE = 4;
const PU_SPEED = 5;
const PU_HEART = 6;
const PU_PIERCE = 7;
const PU_NUKE = 8;

// directions: 0 up, 1 right, 2 down, 3 left
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

// fuse lengths are not sent in "init", we only need them for the pulse animation
const FUSE_TICKS = 40;
const NUKE_FUSE_TICKS = 60;

const MAX_PARTICLES = 1500;
const MAX_FLOAT_TEXTS = 40;
const MAX_RINGS = 60;
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const VOID_COLOR = "#0b0d1a";

// index = cell value
const POWERUP_EMOJI = ["", "", "", "💣", "🔥", "⚡", "❤️", "☄️", "☢️"];
const POWERUP_TEXT = ["", "", "", "+1 💣", "+1 🔥", "+1 ⚡", "+1 ♥", "☄️ Durchschlag!", "+1 ☢️"];

// particle colours, particles only store an index into this list
const PALETTE = ["#fff6c2", "#ffb22e", "#ff5a1f", "#c48a4a", "#7a4d26", "#7c8190", "#8dff9a", "#ffffff", "#ff4d6d", "#7aa2ff", "#d08cff", "#ffd84d"];
const C_HOT = 0;
const C_ORANGE = 1;
const C_RED = 2;
const C_WOOD = 3;
const C_WOOD_DARK = 4;
const C_SMOKE = 5;
const C_NUKE = 6;
const C_WHITE = 7;
const C_PINK = 8;
const C_BLUE = 9;
const C_PURPLE = 10;
const C_GOLD = 11;
const FIRE_COLORS = [C_HOT, C_ORANGE, C_ORANGE, C_RED];
const NUKE_COLORS = [C_WHITE, C_NUKE, C_NUKE, C_HOT];
const WOOD_COLORS = [C_WOOD, C_WOOD_DARK, C_WOOD];
const SPARKLE_COLORS = [C_GOLD, C_WHITE, C_HOT];
const POWERUP_COLOR = [C_WHITE, C_WHITE, C_WHITE, C_BLUE, C_ORANGE, C_GOLD, C_PINK, C_PURPLE, C_NUKE];

const STREAK_NAMES = ["", "", "DOUBLE KILL!", "TRIPLE KILL!", "MEGA KILL!", "RAMPAGE!"];

// ---------- types ----------
interface MeState {
  id: number;
  x: number;
  y: number;
  alive: boolean;
  lives: number;
  respawnIn: number;
  bombs: number;
  active: number;
  radius: number;
  speed: number;
  pierce: boolean;
  nukes: number;
  kills: number;
  deaths: number;
  streak: number;
  inv: boolean;
}

interface PlayerView {
  id: number;
  name: string;
  x: number; // target cell from the server
  y: number;
  rx: number; // rendered (tweened) position
  ry: number;
  lives: number;
  inv: boolean;
  dir: number;
  stepStart: number; // for squash and stretch
  stepDir: number;
  stepMs: number; // how long one step of this player takes (measured)
  lastStepAt: number;
  seen: number; // snapshot counter when we last saw this player
  body: string;
  dark: string;
  light: string;
  nameWidth: number;
  nameFont: number;
  visible: boolean;
  screenX: number;
  headY: number;
}

interface BombView {
  x: number;
  y: number;
  ticksLeft: number;
  total: number;
  nuke: boolean;
  pierce: boolean;
  born: number;
  at: number; // time of the snapshot that told us ticksLeft
  phase: number; // pulse phase
  seen: number;
}

interface FlameView {
  index: number;
  x: number;
  y: number;
  nuke: boolean;
  born: number;
  seen: number;
}

interface Ring {
  x: number;
  y: number;
  born: number;
  life: number;
  maxR: number; // in cells
  color: string;
  width: number;
  glow: number; // 0 = ring, otherwise palette index + 1 of an additive glow
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  color: string;
  born: number;
  life: number;
  size: number; // in cells
}

// ---------- DOM ----------
function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const canvas = byId<HTMLCanvasElement>("game");
const ctx = canvas.getContext("2d")!;
const minimap = byId<HTMLCanvasElement>("minimap");
const mctx = minimap.getContext("2d")!;
const statsEl = byId<HTMLDivElement>("stats");
const statEls: Record<string, HTMLElement> = {
  lives: byId("statLives"),
  bombs: byId("statBombs"),
  radius: byId("statRadius"),
  speed: byId("statSpeed"),
  pierce: byId("statPierce"),
  nukes: byId("statNukes"),
  kills: byId("statKills"),
  streak: byId("statStreak"),
};
const pierceBox = byId<HTMLDivElement>("statPierceBox");
const lbEl = byId<HTMLOListElement>("lb");
const feedEl = byId<HTMLDivElement>("feed");
const onlineEl = byId<HTMLDivElement>("online");
const muteButton = byId<HTMLButtonElement>("mute");
const calloutEl = byId<HTMLDivElement>("callout");
const deathEl = byId<HTMLDivElement>("death");
const deathByEl = byId<HTMLDivElement>("deathBy");
const deathTimerEl = byId<HTMLDivElement>("deathTimer");
const reconnectEl = byId<HTMLDivElement>("reconnect");
const startEl = byId<HTMLDivElement>("start");
const titleEl = byId<HTMLHeadingElement>("title");
const nameInput = byId<HTMLInputElement>("nameInput");
const playButton = byId<HTMLButtonElement>("playButton");
const dpad = byId<HTMLDivElement>("dpad");
const dpadKnob = byId<HTMLDivElement>("dpadKnob");
const bombButton = byId<HTMLButtonElement>("bombButton");

// ---------- world state (filled by "init" and the snapshots) ----------
let mapW = 201;
let mapH = 201;
let chunkSize = 16;
let tickMs = 50;
let viewX = 24;
let viewY = 16;
let chunksX = Math.ceil(mapW / chunkSize);
let chunksY = Math.ceil(mapH / chunkSize);
let map = new Uint8Array(mapW * mapH);
let chunkKnown = new Uint8Array(chunksX * chunksY); // 1 = we have the data of this chunk
let chunkInView = new Int32Array(chunksX * chunksY); // snapshot number when the chunk was last in view
let snapshotCount = 0;
let effectsOk = false; // false on the first snapshot and after a camera jump: everything looks "new" then
const cellAnim = new Map<number, number>(); // cell index → start time of a pop-in animation

let me: MeState | null = null;
let myId = -1;
let myServerName = ""; // our name as the server spells it (from the players list)
let joined = false;
let wantToPlay = false; // the user pressed SPIELEN (also used to re-join after a reconnect)
let myName = "";
let killerName = "";
let pendingSpawnFx = false;

const players = new Map<number, PlayerView>();
const playerList: PlayerView[] = []; // reused every frame for sorting by y
const bombs = new Map<number, BombView>();
const flames = new Map<number, FlameView>();
let crownId = -1;
let heat: number[] = [];

// camera, in cells (the centre of the screen)
let camX = 0;
let camY = 0;
let camReady = false;
let serverCamX = 0; // the "cam" cell of the last snapshot
let serverCamY = 0;

// screen effects
let shake = 0;
let flashAlpha = 0;
let flashColor = "#fff";
let fadeAlpha = 0;

// rendering sizes (device pixels)
let dpr = 1;
let S = 32; // one cell in device pixels
let originX = 0; // screen position of cell (0,0)
let originY = 0;

// ---------- small helpers ----------
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function pick(list: number[]): number {
  return list[(Math.random() * list.length) | 0];
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function storageGet(key: string): string {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or blocked storage: just don't remember it
  }
}

// position of my own player (tweened if we can see it), used for floating texts
function myPosition(): { x: number; y: number } {
  const p = players.get(myId);
  if (p) return { x: p.rx, y: p.ry };
  if (me) return { x: me.x, y: me.y };
  return { x: camX - 0.5, y: camY - 0.5 };
}

// is the cell well inside the area the server sends us? (margin in cells)
function isInsideView(x: number, y: number, margin: number): boolean {
  return Math.abs(x - serverCamX) <= viewX - margin && Math.abs(y - serverCamY) <= viewY - margin;
}

// 1 right next to the camera, 0 at the edge of the view
function closeness(x: number, y: number): number {
  const d = Math.hypot(x + 0.5 - camX, y + 0.5 - camY);
  return clamp(1 - d / (viewX * 1.15), 0, 1);
}

// =====================================================================
// Sprites: tiles are drawn once into small canvases, then only copied
// =====================================================================
let sprFloorA!: HTMLCanvasElement;
let sprFloorB!: HTMLCanvasElement;
let sprPillar!: HTMLCanvasElement;
let sprBorder!: HTMLCanvasElement;
let sprCrate!: HTMLCanvasElement;
let sprShadowTop!: HTMLCanvasElement;
let sprShadowLeft!: HTMLCanvasElement;
let sprBomb!: HTMLCanvasElement;
let sprBombNuke!: HTMLCanvasElement;
let sprBombRed!: HTMLCanvasElement;
let sprFlame!: HTMLCanvasElement;
let sprFlameNuke!: HTMLCanvasElement;
let sprHeart!: HTMLCanvasElement;
let sprCrown!: HTMLCanvasElement;
let sprPowerups: HTMLCanvasElement[] = [];
const sprGlow: HTMLCanvasElement[] = []; // one soft glow per palette colour (size independent)
let nameFontPx = 12;
let nameFont = "";

// tiny deterministic random, so the floor speckles look the same every time
let seed = 1;
function seededRandom(): number {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}

function buildFloor(base: string, speck: string): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  g.fillStyle = speck;
  seed = base.length * 977 + 3;
  for (let i = 0; i < 7; i++) {
    const r = S * (0.03 + seededRandom() * 0.04);
    g.globalAlpha = 0.25 + seededRandom() * 0.3;
    g.fillRect(seededRandom() * (S - r), seededRandom() * (S - r), r, r * 0.6);
  }
  g.globalAlpha = 0.12;
  g.fillStyle = "#000";
  g.fillRect(0, S - Math.max(1, S * 0.03), S, Math.max(1, S * 0.03));
  return c;
}

function buildBlock(light: string, side: string, dark: string, darker: string, faceTop: string, faceBottom: string): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const b = S * 0.15;
  const poly = (pts: number[], color: string) => {
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
    g.fill();
  };
  poly([0, 0, S, 0, S - b, b, b, b], light); // top bevel
  poly([0, 0, b, b, b, S - b, 0, S], side); // left bevel
  poly([S, 0, S, S, S - b, S - b, S - b, b], dark); // right bevel
  poly([0, S, S, S, S - b, S - b, b, S - b], darker); // bottom bevel
  const grad = g.createLinearGradient(0, b, 0, S - b);
  grad.addColorStop(0, faceTop);
  grad.addColorStop(1, faceBottom);
  g.fillStyle = grad;
  g.fillRect(b, b, S - 2 * b, S - 2 * b);
  // a small crack so the stones are not too perfect
  g.strokeStyle = "rgba(0,0,0,0.18)";
  g.lineWidth = Math.max(1, S * 0.03);
  g.beginPath();
  g.moveTo(S * 0.3, S * 0.35);
  g.lineTo(S * 0.45, S * 0.5);
  g.lineTo(S * 0.42, S * 0.66);
  g.stroke();
  return c;
}

function buildCrate(): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const m = S * 0.06;
  const w = S - 2 * m;
  // body
  roundRectPath(g, m, m, w, w, S * 0.08);
  g.fillStyle = "#c08043";
  g.fill();
  // planks
  g.strokeStyle = "rgba(90,50,20,0.45)";
  g.lineWidth = Math.max(1, S * 0.025);
  for (let i = 1; i < 4; i++) {
    const y = m + (w * i) / 4;
    g.beginPath();
    g.moveTo(m, y);
    g.lineTo(m + w, y);
    g.stroke();
  }
  // cross
  g.strokeStyle = "#7a4a22";
  g.lineWidth = S * 0.09;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(m + S * 0.14, m + S * 0.14);
  g.lineTo(m + w - S * 0.14, m + w - S * 0.14);
  g.moveTo(m + w - S * 0.14, m + S * 0.14);
  g.lineTo(m + S * 0.14, m + w - S * 0.14);
  g.stroke();
  // frame
  g.lineWidth = S * 0.08;
  g.strokeStyle = "#6e4320";
  roundRectPath(g, m + S * 0.04, m + S * 0.04, w - S * 0.08, w - S * 0.08, S * 0.06);
  g.stroke();
  // light top edge + shadow bottom edge
  g.fillStyle = "rgba(255,230,180,0.35)";
  g.fillRect(m + S * 0.08, m + S * 0.02, w - S * 0.16, S * 0.05);
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.fillRect(m + S * 0.06, m + w - S * 0.06, w - S * 0.12, S * 0.05);
  // nails
  g.fillStyle = "#3b2410";
  const n = S * 0.035;
  const a = m + S * 0.1;
  const z = m + w - S * 0.1;
  g.fillRect(a - n / 2, a - n / 2, n, n);
  g.fillRect(z - n / 2, a - n / 2, n, n);
  g.fillRect(a - n / 2, z - n / 2, n, n);
  g.fillRect(z - n / 2, z - n / 2, n, n);
  return c;
}

function buildShadow(vertical: boolean): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const len = S * 0.3;
  const grad = vertical ? g.createLinearGradient(0, 0, 0, len) : g.createLinearGradient(0, 0, len, 0);
  grad.addColorStop(0, "rgba(0,0,0,0.32)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  if (vertical) g.fillRect(0, 0, S, len);
  else g.fillRect(0, 0, len, S);
  return c;
}

function buildBomb(c1: string, c2: string, c3: string, symbol: string): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const cx = S / 2;
  const cy = S * 0.54;
  const r = S * 0.4;
  // fuse holder
  g.fillStyle = "#555b66";
  g.fillRect(cx - S * 0.08, cy - r - S * 0.06, S * 0.16, S * 0.12);
  const grad = g.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  grad.addColorStop(0, c1);
  grad.addColorStop(0.55, c2);
  grad.addColorStop(1, c3);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  // shiny spot
  g.fillStyle = "rgba(255,255,255,0.55)";
  g.beginPath();
  g.ellipse(cx - r * 0.38, cy - r * 0.42, r * 0.2, r * 0.12, -0.6, 0, Math.PI * 2);
  g.fill();
  if (symbol) {
    g.font = `bold ${Math.round(r * 1.1)}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(10,40,10,0.85)";
    g.fillText(symbol, cx, cy + r * 0.05);
  }
  return c;
}

function buildFlame(stops: string[]): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (let i = 0; i < stops.length; i++) grad.addColorStop(i / (stops.length - 1), stops[i]);
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  return c;
}

function buildPowerup(type: number): HTMLCanvasElement {
  const c = makeCanvas(S, S);
  const g = c.getContext("2d")!;
  const color = PALETTE[POWERUP_COLOR[type]];
  // soft glow
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S / 2);
  grad.addColorStop(0, color);
  grad.addColorStop(0.5, color + "88");
  grad.addColorStop(1, color + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // disc
  g.fillStyle = "rgba(20,20,40,0.55)";
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.8)";
  g.lineWidth = Math.max(1, S * 0.04);
  g.stroke();
  g.font = `${Math.round(S * 0.42)}px ${EMOJI_FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#fff";
  g.fillText(POWERUP_EMOJI[type], S / 2, S * 0.53);
  return c;
}

function buildHeart(size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d")!;
  const s = size;
  g.beginPath();
  g.moveTo(s * 0.5, s * 0.9);
  g.bezierCurveTo(s * 0.05, s * 0.6, s * 0.0, s * 0.25, s * 0.27, s * 0.15);
  g.bezierCurveTo(s * 0.4, s * 0.1, s * 0.5, s * 0.25, s * 0.5, s * 0.3);
  g.bezierCurveTo(s * 0.5, s * 0.25, s * 0.6, s * 0.1, s * 0.73, s * 0.15);
  g.bezierCurveTo(s * 1.0, s * 0.25, s * 0.95, s * 0.6, s * 0.5, s * 0.9);
  g.closePath();
  g.fillStyle = "#ff3355";
  g.fill();
  g.lineWidth = Math.max(1, s * 0.08);
  g.strokeStyle = "#5a0012";
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.6)";
  g.beginPath();
  g.arc(s * 0.32, s * 0.32, s * 0.08, 0, Math.PI * 2);
  g.fill();
  return c;
}

function buildEmoji(emoji: string, size: number): HTMLCanvasElement {
  const c = makeCanvas(size, size);
  const g = c.getContext("2d")!;
  g.font = `${Math.round(size * 0.82)}px ${EMOJI_FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(emoji, size / 2, size * 0.55);
  return c;
}

function buildGlowSprites() {
  for (let i = 0; i < PALETTE.length; i++) {
    const c = makeCanvas(48, 48);
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, PALETTE[i]);
    grad.addColorStop(0.35, PALETTE[i] + "aa");
    grad.addColorStop(1, PALETTE[i] + "00");
    g.fillStyle = grad;
    g.fillRect(0, 0, 48, 48);
    sprGlow[i] = c;
  }
}

function buildSprites() {
  sprFloorA = buildFloor("#3d8a48", "#2f6e39");
  sprFloorB = buildFloor("#45974f", "#56ab60");
  sprPillar = buildBlock("#a3a9b8", "#868c9b", "#4c515c", "#3a3e47", "#7a8091", "#646a7a");
  sprBorder = buildBlock("#6d7282", "#5a5f6e", "#30333b", "#24262d", "#4f5464", "#3f4351");
  sprCrate = buildCrate();
  sprShadowTop = buildShadow(true);
  sprShadowLeft = buildShadow(false);
  sprBomb = buildBomb("#6a7690", "#232838", "#0b0d12", "");
  sprBombNuke = buildBomb("#d4ff9a", "#3caa30", "#0f4010", "☢");
  sprBombRed = buildBomb("#ffb0b0", "#e01818", "#600000", "");
  sprFlame = buildFlame(["rgba(255,255,230,1)", "rgba(255,235,110,0.95)", "rgba(255,140,30,0.8)", "rgba(230,50,0,0.35)", "rgba(200,20,0,0)"]);
  sprFlameNuke = buildFlame(["rgba(255,255,255,1)", "rgba(220,255,220,0.95)", "rgba(90,255,120,0.8)", "rgba(20,200,60,0.35)", "rgba(0,150,40,0)"]);
  sprHeart = buildHeart(Math.max(6, Math.round(S * 0.24)));
  sprCrown = buildEmoji("👑", Math.round(S * 0.6));
  sprPowerups = [];
  for (let t = 0; t <= PU_NUKE; t++) sprPowerups.push(t >= PU_BOMB ? buildPowerup(t) : sprFloorA);
  nameFontPx = Math.max(Math.round(10 * dpr), Math.round(S * 0.33));
  nameFont = `bold ${nameFontPx}px "Trebuchet MS", system-ui, sans-serif`;
}

// =====================================================================
// Resize: fullscreen canvas, DPR aware, cell size from the spec
// =====================================================================
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = window.innerWidth;
  const h = window.innerHeight;
  // never show more than the server sends us
  const cssCell = Math.max(w / (2 * viewX - 2), h / (2 * viewY - 2), 22);
  S = Math.max(8, Math.ceil(cssCell * dpr)); // whole device pixels → no seams between tiles
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const mmSize = minimap.clientWidth || 150;
  minimap.width = Math.round(mmSize * dpr);
  minimap.height = Math.round(mmSize * dpr);
  buildSprites();
}

// =====================================================================
// Particles: struct of arrays, no objects are created per particle
// =====================================================================
const KIND_GLOW = 0; // additive glowing dot (fire, sparks)
const KIND_DEBRIS = 1; // solid square with gravity (wood)
const KIND_SMOKE = 2; // soft grey puff that grows
const KIND_SPARKLE = 3; // twinkling additive star

const pX = new Float32Array(MAX_PARTICLES);
const pY = new Float32Array(MAX_PARTICLES);
const pVX = new Float32Array(MAX_PARTICLES);
const pVY = new Float32Array(MAX_PARTICLES);
const pLife = new Float32Array(MAX_PARTICLES);
const pMaxLife = new Float32Array(MAX_PARTICLES);
const pSize = new Float32Array(MAX_PARTICLES);
const pGravity = new Float32Array(MAX_PARTICLES);
const pKind = new Uint8Array(MAX_PARTICLES);
const pColor = new Uint8Array(MAX_PARTICLES);
let particleCount = 0;

// positions in cells, velocities in cells per second, size in cells
function spawnParticle(x: number, y: number, vx: number, vy: number, life: number, size: number, kind: number, color: number, gravity: number) {
  if (particleCount >= MAX_PARTICLES) return;
  const i = particleCount++;
  pX[i] = x;
  pY[i] = y;
  pVX[i] = vx;
  pVY[i] = vy;
  pLife[i] = life;
  pMaxLife[i] = life;
  pSize[i] = size;
  pKind[i] = kind;
  pColor[i] = color;
  pGravity[i] = gravity;
}

function burst(x: number, y: number, count: number, speedMin: number, speedMax: number, lifeMin: number, lifeMax: number, sizeMin: number, sizeMax: number, kind: number, colors: number[], gravity: number) {
  for (let n = 0; n < count; n++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = rand(speedMin, speedMax);
    spawnParticle(x, y, Math.cos(angle) * speed, Math.sin(angle) * speed, rand(lifeMin, lifeMax), rand(sizeMin, sizeMax), kind, pick(colors), gravity);
  }
}

function updateParticles(dt: number) {
  const drag = Math.exp(-dt * 2.2);
  for (let i = 0; i < particleCount; i++) {
    pLife[i] -= dt;
    if (pLife[i] <= 0) {
      // swap the last particle into this slot
      const last = --particleCount;
      pX[i] = pX[last];
      pY[i] = pY[last];
      pVX[i] = pVX[last];
      pVY[i] = pVY[last];
      pLife[i] = pLife[last];
      pMaxLife[i] = pMaxLife[last];
      pSize[i] = pSize[last];
      pKind[i] = pKind[last];
      pColor[i] = pColor[last];
      pGravity[i] = pGravity[last];
      i--;
      continue;
    }
    pVY[i] += pGravity[i] * dt;
    pVX[i] *= drag;
    pVY[i] *= drag;
    pX[i] += pVX[i] * dt;
    pY[i] += pVY[i] * dt;
  }
}

function drawParticles() {
  const W = canvas.width;
  const H = canvas.height;
  // pass 1: normal blending (debris, smoke)
  for (let i = 0; i < particleCount; i++) {
    const kind = pKind[i];
    if (kind !== KIND_DEBRIS && kind !== KIND_SMOKE) continue;
    const sx = originX + pX[i] * S;
    const sy = originY + pY[i] * S;
    if (sx < -S || sy < -S || sx > W + S || sy > H + S) continue;
    const k = pLife[i] / pMaxLife[i];
    if (kind === KIND_DEBRIS) {
      const s = pSize[i] * S;
      ctx.globalAlpha = Math.min(1, k * 3);
      ctx.fillStyle = PALETTE[pColor[i]];
      ctx.fillRect(sx - s / 2, sy - s / 2, s, s);
    } else {
      const s = pSize[i] * S * (2 - k); // smoke grows while fading
      ctx.globalAlpha = 0.45 * k;
      ctx.drawImage(sprGlow[pColor[i]], sx - s / 2, sy - s / 2, s, s);
    }
  }
  // pass 2: additive (fire, sparks)
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < particleCount; i++) {
    const kind = pKind[i];
    if (kind !== KIND_GLOW && kind !== KIND_SPARKLE) continue;
    const sx = originX + pX[i] * S;
    const sy = originY + pY[i] * S;
    if (sx < -S || sy < -S || sx > W + S || sy > H + S) continue;
    const k = pLife[i] / pMaxLife[i];
    let s = pSize[i] * S * (0.4 + 0.6 * k);
    if (kind === KIND_SPARKLE) {
      s *= 0.7 + 0.5 * Math.sin(pLife[i] * 30 + i);
      ctx.globalAlpha = k;
      ctx.fillStyle = PALETTE[pColor[i]];
      const t = Math.max(1, s * 0.12);
      ctx.fillRect(sx - s / 2, sy - t / 2, s, t);
      ctx.fillRect(sx - t / 2, sy - s / 2, t, s);
    } else {
      ctx.globalAlpha = k;
    }
    ctx.drawImage(sprGlow[pColor[i]], sx - s / 2, sy - s / 2, s, s);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

// ---------- rings, glows and floating texts ----------
const rings: Ring[] = [];
const floatTexts: FloatText[] = [];

function addRing(x: number, y: number, maxR: number, life: number, color: string, width: number, glow: number) {
  if (rings.length >= MAX_RINGS) rings.shift();
  rings.push({ x, y, born: performance.now(), life, maxR, color, width, glow });
}

function addFloatText(x: number, y: number, text: string, color: string, size: number) {
  if (floatTexts.length >= MAX_FLOAT_TEXTS) floatTexts.shift();
  floatTexts.push({ x, y, text, color, born: performance.now(), life: 1300, size });
}

function drawRings(now: number) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    const k = Math.max(0, (now - r.born) / r.life);
    if (k >= 1) {
      rings.splice(i, 1);
      continue;
    }
    const sx = originX + r.x * S;
    const sy = originY + r.y * S;
    const radius = r.maxR * S * easeOutCubic(k);
    if (r.glow > 0) {
      // big soft flash of light
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = (1 - k) * 0.9;
      const s = radius * 2 + S;
      ctx.drawImage(sprGlow[r.glow - 1], sx - s / 2, sy - s / 2, s, s);
      ctx.globalCompositeOperation = "source-over";
    } else {
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.width * S * (1 - k));
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawFloatTexts(now: number) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (let i = floatTexts.length - 1; i >= 0; i--) {
    const t = floatTexts[i];
    const k = Math.max(0, (now - t.born) / t.life);
    if (k >= 1) {
      floatTexts.splice(i, 1);
      continue;
    }
    const pop = k < 0.15 ? easeOutBack(k / 0.15) : 1;
    const size = Math.max(4, t.size * S * pop);
    const sx = originX + t.x * S;
    const sy = originY + (t.y - k * 1.3) * S;
    ctx.globalAlpha = k > 0.7 ? (1 - k) / 0.3 : 1;
    ctx.font = `900 ${Math.round(size)}px Impact, "Arial Black", sans-serif`;
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.strokeStyle = "rgba(20,8,0,0.9)";
    ctx.strokeText(t.text, sx, sy);
    ctx.fillStyle = t.color;
    ctx.fillText(t.text, sx, sy);
  }
  ctx.globalAlpha = 1;
}

// ---------- screen effects ----------
function addShake(amount: number) {
  shake = Math.min(Math.max(shake, amount), 48 * dpr);
}

function flash(color: string, alpha: number) {
  if (alpha < flashAlpha) return;
  flashColor = color;
  flashAlpha = Math.min(1, alpha);
}

let calloutTimer = 0;
function showCallout(text: string, small: boolean) {
  calloutEl.textContent = text;
  calloutEl.className = small ? "small" : "";
  void calloutEl.offsetWidth; // restart the CSS animation
  calloutEl.className = small ? "small show" : "show";
  clearTimeout(calloutTimer);
  calloutTimer = setTimeout(() => (calloutEl.className = ""), 1900);
}

// ---------- effect bundles ----------
function sparkles(x: number, y: number, count: number) {
  burst(x, y, count, 1, 4, 0.4, 0.9, 0.15, 0.35, KIND_SPARKLE, SPARKLE_COLORS, -1.5);
}

function spawnEffect(x: number, y: number, color: string) {
  addRing(x + 0.5, y + 0.5, 1.6, 600, color, 0.18, 0);
  addRing(x + 0.5, y + 0.5, 1.2, 400, "", 0, C_WHITE + 1);
  sparkles(x + 0.5, y + 0.5, 18);
}

function deathEffect(x: number, y: number, color: string, big: boolean) {
  addRing(x + 0.5, y + 0.5, big ? 3 : 2, 700, color, 0.25, 0);
  burst(x + 0.5, y + 0.4, big ? 50 : 26, 2, big ? 9 : 6, 0.4, 1.0, 0.15, 0.4, KIND_GLOW, [C_WHITE, C_GOLD, C_PINK], 3);
  burst(x + 0.5, y + 0.5, 8, 0.3, 1.2, 0.8, 1.4, 0.4, 0.7, KIND_SMOKE, [C_SMOKE], -0.8);
  addFloatText(x + 0.5, y, "💀", "#ffffff", 0.7);
}

// =====================================================================
// Sound: everything is synthesised with WebAudio, no files needed
// =====================================================================
let audio: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = storageGet("bdc-muted") === "1";
const explosionSoundTimes: number[] = [];

function initAudio() {
  if (audio) {
    if (audio.state === "suspended") audio.resume();
    return;
  }
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio = new AC();
    master = audio.createGain();
    master.gain.value = muted ? 0 : 0.6;
    // the compressor keeps 20 explosions at once from clipping
    const comp = audio.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(audio.destination);
    // 2 seconds of white noise, reused for every explosion
    noiseBuffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } catch {
    audio = null;
  }
}

function tone(type: OscillatorType, f0: number, f1: number, start: number, dur: number, vol: number) {
  if (!audio || !master) return;
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), start + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function noise(start: number, dur: number, vol: number, f0: number, f1: number) {
  if (!audio || !master || !noiseBuffer) return;
  const src = audio.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = audio.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(f0, start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, f1), start + dur);
  const g = audio.createGain();
  g.gain.setValueAtTime(Math.max(0.0002, vol), start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(start, Math.random() * Math.max(0, 1.9 - dur), dur + 0.05);
}

function canPlay(): boolean {
  return audio !== null && !muted && audio.state === "running";
}

function playExplosion(vol: number, nuke: boolean) {
  if (!canPlay() || vol < 0.02) return;
  // at most 6 explosion sounds per 100 ms, chain reactions would be deafening otherwise
  const now = performance.now();
  while (explosionSoundTimes.length > 0 && now - explosionSoundTimes[0] > 100) explosionSoundTimes.shift();
  if (explosionSoundTimes.length >= 6) return;
  explosionSoundTimes.push(now);
  const t = audio!.currentTime;
  if (nuke) {
    noise(t, 1.8, 1.0 * vol, 2500, 60);
    tone("sine", 90, 18, t, 1.4, 0.9 * vol);
    tone("sawtooth", 60, 25, t, 1.0, 0.25 * vol);
  } else {
    noise(t, 0.55, 0.75 * vol, 3200 + Math.random() * 800, 140);
    tone("sine", 150 + Math.random() * 30, 38, t, 0.38, 0.8 * vol);
  }
}

function playPlace(vol: number) {
  if (!canPlay() || vol < 0.03) return;
  const t = audio!.currentTime;
  tone("sine", 520, 170, t, 0.1, 0.35 * vol);
  tone("triangle", 95, 60, t, 0.08, 0.3 * vol);
}

function playPickup(special: boolean) {
  if (!canPlay()) return;
  const t = audio!.currentTime;
  const notes = special ? [392, 523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
  for (let i = 0; i < notes.length; i++) tone("square", notes[i], notes[i], t + i * 0.055, 0.11, 0.09);
}

function playHit() {
  if (!canPlay()) return;
  const t = audio!.currentTime;
  tone("sawtooth", 440, 90, t, 0.28, 0.3);
  tone("square", 220, 60, t + 0.02, 0.25, 0.12);
  noise(t, 0.15, 0.3, 2000, 300);
}

function playDeath() {
  if (!canPlay()) return;
  const t = audio!.currentTime;
  tone("sawtooth", 330, 40, t, 0.9, 0.3);
  tone("triangle", 160, 30, t + 0.1, 0.9, 0.3);
}

function playKill(streak: number) {
  if (!canPlay()) return;
  const t = audio!.currentTime;
  const up = Math.pow(2, Math.min(streak - 1, 6) / 12); // every streak level a bit higher
  const notes = [392, 523, 659, 784];
  for (let i = 0; i < notes.length; i++) {
    const last = i === notes.length - 1;
    tone("triangle", notes[i] * up, notes[i] * up, t + i * 0.08, last ? 0.45 : 0.12, 0.22);
    tone("square", notes[i] * up * 2, notes[i] * up * 2, t + i * 0.08, last ? 0.3 : 0.08, 0.05);
  }
}

function playRespawn() {
  if (!canPlay()) return;
  const t = audio!.currentTime;
  tone("sine", 220, 880, t, 0.45, 0.25);
  tone("triangle", 440, 1760, t + 0.08, 0.4, 0.1);
}

function setMuted(value: boolean) {
  muted = value;
  storageSet("bdc-muted", muted ? "1" : "0");
  muteButton.textContent = muted ? "🔇" : "🔊";
  if (audio && master) master.gain.setValueAtTime(muted ? 0 : 0.6, audio.currentTime);
}

// =====================================================================
// Network
// =====================================================================
let socket: WebSocket | null = null;
let reconnectDelay = 1000;

function send(message: object) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${location.host}/ws`);
  socket = ws;
  ws.addEventListener("open", () => {
    reconnectEl.classList.add("hidden");
    reconnectDelay = 1000;
    if (wantToPlay) send({ t: "join", name: myName }); // rejoin automatically after a reconnect
  });
  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      handleMessage(event.data);
    } catch (err) {
      console.error("Fehler bei Nachricht", err);
    }
  });
  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    joined = false;
    me = null;
    myId = -1;
    sentDir = -1;
    reconnectEl.textContent = "⚠️ Verbindung verloren – verbinde neu…";
    reconnectEl.classList.remove("hidden");
    deathEl.classList.add("hidden");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
  });
}

function handleMessage(raw: unknown) {
  if (typeof raw !== "string") return;
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  switch (msg.t) {
    case "init":
      onInit(msg);
      break;
    case "you":
      myId = +msg.id;
      joined = true;
      sentDir = -1;
      updateInput(); // keys that are already held start moving right away
      hideStart();
      break;
    case "s":
      onSnapshot(msg);
      break;
    case "ev":
      onEvent(msg);
      break;
    case "lb":
      onLeaderboard(msg);
      break;
  }
}

function onInit(msg: any) {
  mapW = +msg.w || 201;
  mapH = +msg.h || 201;
  chunkSize = +msg.chunk || 16;
  tickMs = +msg.tick || 50;
  viewX = +msg.vx || 24;
  viewY = +msg.vy || 16;
  chunksX = Math.ceil(mapW / chunkSize);
  chunksY = Math.ceil(mapH / chunkSize);
  // fresh world (also after a reconnect)
  map = new Uint8Array(mapW * mapH);
  chunkKnown = new Uint8Array(chunksX * chunksY);
  chunkInView = new Int32Array(chunksX * chunksY);
  snapshotCount = 0;
  cellAnim.clear();
  players.clear();
  bombs.clear();
  flames.clear();
  camReady = false;
  resize();
}

// ---------- snapshots ----------
function onSnapshot(msg: any) {
  const now = performance.now();
  snapshotCount++;

  // me + camera
  me = msg.me && typeof msg.me === "object" ? (msg.me as MeState) : null;
  if (me) myId = +me.id;
  if (Array.isArray(msg.cam)) {
    const newX = +msg.cam[0] || 0;
    const newY = +msg.cam[1] || 0;
    effectsOk = snapshotCount > 1 && Math.abs(newX - serverCamX) + Math.abs(newY - serverCamY) <= 6;
    serverCamX = newX;
    serverCamY = newY;
    if (!camReady) {
      camX = serverCamX + 0.5;
      camY = serverCamY + 0.5;
      camReady = true;
    }
  }

  // flames first, so map changes know whether a power-up burned or was picked up
  applyFlames(Array.isArray(msg.f) ? msg.f : [], now);
  if (Array.isArray(msg.c)) {
    for (const c of msg.c) {
      if (Array.isArray(c)) applyChunk(+c[0], +c[1], c[2], now);
    }
  }
  markChunksInView();
  applyPlayers(Array.isArray(msg.p) ? msg.p : [], now);
  applyBombs(Array.isArray(msg.b) ? msg.b : [], now);
  if (Array.isArray(msg.e) && snapshotCount > 1) {
    for (const e of msg.e) {
      if (Array.isArray(e)) onExplosion(+e[0], +e[1], +e[2], !!e[3]);
    }
  }

  if (pendingSpawnFx && me && me.alive) {
    pendingSpawnFx = false;
    spawnEffect(me.x, me.y, "#ffffff");
  }

  // old pop-in animations that were never drawn (off screen)
  if (cellAnim.size > 0) {
    for (const [i, t0] of cellAnim) if (now - t0 > 1000) cellAnim.delete(i);
  }

  updateHud();
}

function applyChunk(cx: number, cy: number, data: unknown, now: number) {
  if (typeof data !== "string" || !(cx >= 0 && cx < chunksX && cy >= 0 && cy < chunksY)) return;
  const c = cx + cy * chunksX;
  // only animate changes we could actually see happen (chunk was already in view last snapshot)
  const animate = chunkKnown[c] === 1 && chunkInView[c] === snapshotCount - 1;
  const x0 = cx * chunkSize;
  const y0 = cy * chunkSize;
  const x1 = Math.min(mapW, x0 + chunkSize);
  const y1 = Math.min(mapH, y0 + chunkSize);
  let k = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const v = data.charCodeAt(k++) - 48;
      if (!(v >= 0 && v <= PU_NUKE)) continue;
      const i = y * mapW + x;
      const old = map[i];
      if (old === v) continue;
      map[i] = v;
      if (animate) cellChanged(x, y, i, old, v, now);
    }
  }
  chunkKnown[c] = 1;
}

// juice for a single map cell that changed while we were watching
function cellChanged(x: number, y: number, i: number, old: number, v: number, now: number) {
  const cx = x + 0.5;
  const cy = y + 0.5;
  if (old === CRATE) {
    // crate blown up: wood debris + dust
    burst(cx, cy, 12, 2, 6, 0.5, 1.0, 0.08, 0.18, KIND_DEBRIS, WOOD_COLORS, 9);
    burst(cx, cy, 3, 0.2, 1, 0.6, 1.1, 0.5, 0.8, KIND_SMOKE, [C_SMOKE], -0.6);
    if (v >= PU_BOMB) {
      cellAnim.set(i, now + 120); // the item pops out of the crate a moment later
      sparkles(cx, cy, 6);
    }
  } else if (v === CRATE) {
    cellAnim.set(i, now); // a crate grew back
    burst(cx, cy + 0.3, 4, 0.3, 1.2, 0.4, 0.7, 0.3, 0.5, KIND_SMOKE, [C_SMOKE], -0.4);
  } else if (old >= PU_BOMB && v === EMPTY) {
    if (flames.has(i)) {
      burst(cx, cy, 3, 0.2, 1, 0.5, 0.9, 0.4, 0.6, KIND_SMOKE, [C_SMOKE], -0.8); // burned
    } else {
      sparkles(cx, cy, 14); // picked up
      addRing(cx, cy, 0.9, 350, PALETTE[POWERUP_COLOR[old]], 0.12, 0);
    }
  } else if (v >= PU_BOMB) {
    cellAnim.set(i, now); // e.g. power-ups dropped by a dying player
  }
}

// remember which chunks are in view this snapshot (same range rule as the server)
function markChunksInView() {
  const cx0 = Math.max(0, Math.floor((serverCamX - viewX) / chunkSize));
  const cx1 = Math.min(chunksX - 1, Math.floor((serverCamX + viewX) / chunkSize));
  const cy0 = Math.max(0, Math.floor((serverCamY - viewY) / chunkSize));
  const cy1 = Math.min(chunksY - 1, Math.floor((serverCamY + viewY) / chunkSize));
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) chunkInView[cx + cy * chunksX] = snapshotCount;
  }
}

function createPlayer(id: number, name: string, x: number, y: number): PlayerView {
  const hue = ((id * 137.508) % 360).toFixed(1);
  return {
    id, name, x, y, rx: x, ry: y,
    lives: 3, inv: false, dir: 2,
    stepStart: -1e9, stepDir: 2, stepMs: 200, lastStepAt: -1e9,
    seen: 0,
    body: `hsl(${hue},75%,58%)`,
    dark: `hsl(${hue},60%,28%)`,
    light: `hsla(${hue},100%,90%,0.85)`,
    nameWidth: 0, nameFont: 0,
    visible: false, screenX: 0, headY: 0,
  };
}

// p: [id, x, y, lives, inv(0/1), dir, "name"]
function applyPlayers(list: any[], now: number) {
  for (let n = 0; n < list.length; n++) {
    const a = list[n];
    if (!Array.isArray(a)) continue;
    const id = +a[0];
    const x = +a[1];
    const y = +a[2];
    if (!isFinite(id) || !isFinite(x) || !isFinite(y)) continue;
    const name = String(a[6] === undefined ? "?" : a[6]);
    let p = players.get(id);
    if (!p) {
      p = createPlayer(id, name, x, y);
      players.set(id, p);
      // a freshly spawned player (invulnerable and not just walking into view)
      if (effectsOk && a[4] && isInsideView(x, y, 3) && id !== myId) spawnEffect(x, y, p.body);
    } else if (x !== p.x || y !== p.y) {
      const dist = Math.abs(x - p.rx) + Math.abs(y - p.ry);
      if (dist > 3) {
        // too far for a tween (respawn, lag): teleport
        p.rx = x;
        p.ry = y;
      } else {
        const interval = now - p.lastStepAt;
        p.stepMs = interval < 400 ? clamp(p.stepMs * 0.5 + interval * 0.5, 80, 230) : 160;
        p.lastStepAt = now;
        p.stepStart = now;
        p.stepDir = x > p.x ? 1 : x < p.x ? 3 : y > p.y ? 2 : 0;
        // small dust puff at the feet
        spawnParticle(p.x + 0.5 + rand(-0.15, 0.15), p.y + 0.85, rand(-0.3, 0.3), rand(-0.5, -0.1), 0.4, 0.3, KIND_SMOKE, C_SMOKE, 0);
      }
      p.x = x;
      p.y = y;
    }
    p.lives = +a[3] || 0;
    p.inv = !!a[4];
    const dir = +a[5];
    if (dir >= 0 && dir <= 3) p.dir = dir;
    if (name !== p.name) {
      p.name = name;
      p.nameFont = 0; // measure again
    }
    if (id === myId) myServerName = name;
    p.seen = snapshotCount;
  }
  // players that are gone: died (if they had 1 life left) or left the view
  for (const p of players.values()) {
    if (p.seen === snapshotCount) continue;
    if (effectsOk && p.lives <= 1 && p.id !== myId && isInsideView(p.x, p.y, 2)) deathEffect(p.rx, p.ry, p.body, false);
    players.delete(p.id);
  }
}

// b: [x, y, ticksLeft, nuke(0/1), pierce(0/1)]
function applyBombs(list: any[], now: number) {
  for (let n = 0; n < list.length; n++) {
    const a = list[n];
    if (!Array.isArray(a)) continue;
    const x = +a[0];
    const y = +a[1];
    if (!(x >= 0 && x < mapW && y >= 0 && y < mapH)) continue;
    const ticksLeft = +a[2] || 0;
    const nuke = !!a[3];
    const index = y * mapW + x;
    let b = bombs.get(index);
    if (!b) {
      const total = Math.max(nuke ? NUKE_FUSE_TICKS : FUSE_TICKS, ticksLeft);
      const fresh = ticksLeft >= total - 4;
      b = { x, y, ticksLeft, total, nuke, pierce: !!a[4], born: fresh ? now : now - 1000, at: now, phase: 0, seen: 0 };
      bombs.set(index, b);
      if (fresh && effectsOk) {
        playPlace(closeness(x, y));
        burst(x + 0.5, y + 0.8, 5, 0.5, 1.5, 0.3, 0.6, 0.3, 0.5, KIND_SMOKE, [C_SMOKE], -0.3);
      }
    }
    b.ticksLeft = ticksLeft;
    b.at = now;
    b.nuke = nuke;
    b.pierce = !!a[4];
    b.seen = snapshotCount;
  }
  for (const [index, b] of bombs) if (b.seen !== snapshotCount) bombs.delete(index);
}

// f: [x, y, nuke(0/1)]
function applyFlames(list: any[], now: number) {
  for (let n = 0; n < list.length; n++) {
    const a = list[n];
    if (!Array.isArray(a)) continue;
    const x = +a[0];
    const y = +a[1];
    if (!(x >= 0 && x < mapW && y >= 0 && y < mapH)) continue;
    const index = y * mapW + x;
    let f = flames.get(index);
    if (!f) {
      f = { index, x, y, nuke: !!a[2], born: now, seen: 0 };
      flames.set(index, f);
      if (effectsOk) {
        const colors = f.nuke ? NUKE_COLORS : FIRE_COLORS;
        burst(x + 0.5, y + 0.5, 3, 1, 3.5, 0.25, 0.6, 0.3, 0.6, KIND_GLOW, colors, -2);
      }
    }
    f.nuke = !!a[2];
    f.seen = snapshotCount;
  }
  for (const f of flames.values()) {
    if (f.seen === snapshotCount) continue;
    if (Math.random() < 0.5) spawnParticle(f.x + 0.5, f.y + 0.5, rand(-0.3, 0.3), rand(-1, -0.3), rand(0.6, 1.1), 0.6, KIND_SMOKE, C_SMOKE, -0.3);
    flames.delete(f.index);
  }
}

// e: [x, y, radius, nuke(0/1)], one per bomb that just exploded
function onExplosion(x: number, y: number, radius: number, nuke: boolean) {
  if (!isFinite(x) || !isFinite(y)) return;
  const near = closeness(x, y);
  const cx = x + 0.5;
  const cy = y + 0.5;
  if (nuke) {
    burst(cx, cy, 160, 2, 16, 0.4, 1.3, 0.3, 0.8, KIND_GLOW, NUKE_COLORS, -1);
    burst(cx, cy, 30, 0.5, 3, 1.0, 2.0, 0.8, 1.5, KIND_SMOKE, [C_SMOKE], -1.2);
    addRing(cx, cy, Math.max(4, radius * 0.8), 900, "#c8ffd0", 0.4, 0);
    addRing(cx, cy, Math.max(3, radius * 0.5), 700, "", 0, C_NUKE + 1);
    addRing(cx, cy, 2.5, 400, "", 0, C_WHITE + 1);
    addShake(46 * dpr * Math.max(0.35, near));
    flash("#ffffff", 0.9 * Math.max(0.35, near));
  } else {
    burst(cx, cy, 45, 1.5, 8, 0.3, 0.8, 0.2, 0.55, KIND_GLOW, FIRE_COLORS, -1.5);
    burst(cx, cy, 6, 0.3, 1.5, 0.7, 1.3, 0.6, 1.0, KIND_SMOKE, [C_SMOKE], -0.9);
    addRing(cx, cy, 2.3, 420, "#fff2c0", 0.22, 0);
    addRing(cx, cy, 1.6, 260, "", 0, C_HOT + 1);
    addShake(15 * dpr * near * near);
    if (near > 0.85) flash("#ffdca0", 0.15);
  }
  playExplosion(Math.max(0.06, near * near), nuke);
}

// ---------- personal events ----------
function onEvent(msg: any) {
  const pos = myPosition();
  switch (msg.k) {
    case "pu": {
      const v = +msg.pu;
      const color = PALETTE[POWERUP_COLOR[v] === undefined ? C_WHITE : POWERUP_COLOR[v]];
      addFloatText(pos.x + 0.5, pos.y, POWERUP_TEXT[v] || "+1", color, 0.55);
      sparkles(pos.x + 0.5, pos.y + 0.5, 24);
      addRing(pos.x + 0.5, pos.y + 0.5, 1.3, 400, color, 0.15, 0);
      playPickup(v === PU_NUKE || v === PU_PIERCE);
      if (v === PU_NUKE) showCallout("☢️ ATOMBOMBE BEREIT!", true);
      break;
    }
    case "hit":
      addFloatText(pos.x + 0.5, pos.y, "-1 ♥", "#ff4d6d", 0.6);
      flash("#ff1e3c", 0.45);
      addShake(22 * dpr);
      playHit();
      vibrate(80);
      break;
    case "die":
      killerName = String(msg.by === undefined ? "" : msg.by);
      flash("#ff1e3c", 0.7);
      addShake(36 * dpr);
      deathEffect(pos.x, pos.y, "#ffffff", true);
      playDeath();
      vibrate(250);
      break;
    case "kill": {
      const victim = String(msg.name === undefined ? "?" : msg.name);
      const streak = +msg.streak || 1;
      // show the KILL text where the victim was, if we still know it
      let kx = pos.x;
      let ky = pos.y;
      for (const p of players.values()) {
        if (p.name === victim && p.id !== myId) {
          kx = p.rx;
          ky = p.ry;
          break;
        }
      }
      addFloatText(kx + 0.5, ky, "KILL!", "#ffd84d", 0.8);
      sparkles(kx + 0.5, ky + 0.5, 30);
      playKill(streak);
      if (streak >= 2) {
        showCallout(STREAK_NAMES[streak] || "GODLIKE!", false);
        addShake(10 * dpr);
      } else {
        showCallout(`💀 ${victim} erledigt!`, true);
      }
      break;
    }
    case "spawn":
      pendingSpawnFx = true;
      killerName = "";
      deathEl.classList.add("hidden");
      playRespawn();
      break;
  }
}

function vibrate(ms: number) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    // not supported
  }
}

// =====================================================================
// HUD (DOM). Only touched when something actually changed.
// =====================================================================
const hudCache: Record<string, string> = {};

function setStat(key: string, text: string) {
  if (hudCache[key] === text) return;
  const first = hudCache[key] === undefined;
  hudCache[key] = text;
  const el = statEls[key];
  el.textContent = text;
  if (!first) {
    const box = el.parentElement!;
    box.classList.remove("bump");
    void box.offsetWidth; // restart the animation
    box.classList.add("bump");
  }
}

function updateHud() {
  if (!me) {
    if (!statsEl.classList.contains("hidden")) statsEl.classList.add("hidden");
    if (!deathEl.classList.contains("hidden")) deathEl.classList.add("hidden");
    return;
  }
  statsEl.classList.remove("hidden");
  const lives = Math.max(0, me.lives | 0);
  setStat("lives", lives > 0 ? "❤️".repeat(lives) + "🖤".repeat(Math.max(0, 3 - lives)) : "💀");
  setStat("bombs", `${Math.max(0, me.bombs - me.active)}/${me.bombs}`);
  setStat("radius", String(me.radius));
  setStat("speed", String((me.speed | 0) + 1));
  setStat("pierce", me.pierce ? "an" : "–");
  pierceBox.classList.toggle("off", !me.pierce);
  setStat("nukes", String(me.nukes));
  setStat("kills", String(me.kills));
  setStat("streak", String(me.streak));

  // death overlay with countdown
  if (!me.alive) {
    deathEl.classList.remove("hidden");
    const self = killerName !== "" && (killerName === myServerName || killerName === myName);
    const byText = killerName === "" ? "Du wurdest gesprengt!" : self ? "Du hast dich selbst erwischt 🤦" : `${killerName} hat dich erwischt`;
    if (hudCache.deathBy !== byText) {
      hudCache.deathBy = byText;
      deathByEl.textContent = byText;
    }
    const secs = Math.ceil((me.respawnIn * tickMs) / 1000);
    const timerText = secs > 0 ? `Zurück in ${secs}…` : "Gleich geht's weiter…";
    if (hudCache.deathTimer !== timerText) {
      hudCache.deathTimer = timerText;
      deathTimerEl.textContent = timerText;
    }
  } else if (!deathEl.classList.contains("hidden")) {
    deathEl.classList.add("hidden");
  }
}

// ---------- leaderboard, kill feed, online count ----------
let lbKey = "";
let feedKey = "";
let onlineKey = "";
let previousFeedRows: string[] = [];

function onLeaderboard(msg: any) {
  const top: any[] = Array.isArray(msg.top) ? msg.top : [];
  crownId = top.length > 0 && Array.isArray(top[0]) && +top[0][2] > 0 ? +top[0][0] : -1;

  const key = JSON.stringify(top) + "|" + myId + "|" + (me ? me.kills + ":" + me.streak : "");
  if (key !== lbKey) {
    lbKey = key;
    rebuildLeaderboard(top);
  }

  const feed: any[] = Array.isArray(msg.feed) ? msg.feed : [];
  const fKey = JSON.stringify(feed);
  if (fKey !== feedKey) {
    feedKey = fKey;
    rebuildFeed(feed);
  }

  const onlineText = `🟢 ${+msg.humans || 0} online · 🤖 ${+msg.bots || 0} Bots`;
  if (onlineText !== onlineKey) {
    onlineKey = onlineText;
    onlineEl.textContent = onlineText;
  }

  heat = Array.isArray(msg.heat) ? msg.heat : [];
}

function makeSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text; // textContent, never innerHTML: names come from other players
  return span;
}

function rebuildLeaderboard(top: any[]) {
  lbEl.textContent = "";
  let meListed = false;
  for (let i = 0; i < top.length; i++) {
    const row = top[i];
    if (!Array.isArray(row)) continue;
    const li = document.createElement("li");
    const isMe = +row[0] === myId;
    if (isMe) {
      li.className = "me";
      meListed = true;
    }
    li.appendChild(makeSpan("rank", i === 0 ? "👑" : `${i + 1}.`));
    li.appendChild(makeSpan("name", String(row[1])));
    if (+row[3] >= 2) li.appendChild(makeSpan("streak", `🔥${+row[3]}`));
    li.appendChild(makeSpan("kills", String(+row[2] || 0)));
    lbEl.appendChild(li);
  }
  if (top.length === 0) {
    const li = document.createElement("li");
    li.className = "gap";
    li.textContent = "Noch keine Kills";
    lbEl.appendChild(li);
  }
  // not in the top 10: show my own line below
  if (!meListed && me) {
    const gap = document.createElement("li");
    gap.className = "gap";
    gap.textContent = "···";
    lbEl.appendChild(gap);
    const li = document.createElement("li");
    li.className = "me";
    li.appendChild(makeSpan("rank", "–"));
    li.appendChild(makeSpan("name", myServerName || myName || "Du"));
    if (me.streak >= 2) li.appendChild(makeSpan("streak", `🔥${me.streak}`));
    li.appendChild(makeSpan("kills", String(me.kills)));
    lbEl.appendChild(li);
  }
}

// feed: [["killer","victim",killerStreak], ...] oldest first, newest is shown on top
function rebuildFeed(feed: any[]) {
  feedEl.textContent = "";
  const rowKeys: string[] = [];
  for (let i = feed.length - 1; i >= 0; i--) {
    const row = feed[i];
    if (!Array.isArray(row)) continue;
    const killer = String(row[0]);
    const victim = String(row[1]);
    const streak = +row[2] || 0;
    const rowKey = JSON.stringify(row);
    rowKeys.push(rowKey);
    const div = document.createElement("div");
    div.className = "feedRow";
    if (previousFeedRows.indexOf(rowKey) === -1) div.classList.add("new"); // slide in only new rows
    const myNames = [myServerName, myName];
    if (myNames.indexOf(killer) !== -1 || myNames.indexOf(victim) !== -1) div.classList.add("mine");
    if (killer === victim) {
      div.appendChild(makeSpan("victim", victim));
      div.appendChild(document.createTextNode(" 💀 hat sich selbst gesprengt"));
    } else {
      div.appendChild(makeSpan("killer", killer));
      div.appendChild(document.createTextNode(" 💥 "));
      div.appendChild(makeSpan("victim", victim));
      if (streak >= 2) div.appendChild(makeSpan("streak", ` x${streak}`));
    }
    feedEl.appendChild(div);
  }
  previousFeedRows = rowKeys;
}

// ---------- minimap ----------
let minimapTimer = 0;

function drawMinimap(now: number) {
  const w = minimap.width;
  const h = minimap.height;
  mctx.clearRect(0, 0, w, h);
  mctx.fillStyle = "rgba(8,10,24,0.9)";
  mctx.fillRect(0, 0, w, h);
  const cw = w / chunksX;
  const ch = h / chunksY;
  // chunks we have seen
  mctx.fillStyle = "rgba(70,150,85,0.35)";
  for (let c = 0; c < chunkKnown.length; c++) {
    if (chunkKnown[c]) mctx.fillRect((c % chunksX) * cw, Math.floor(c / chunksX) * ch, cw - 0.5, ch - 0.5);
  }
  // heat: alive players per chunk
  let maxHeat = 1;
  for (let c = 0; c < heat.length; c++) if (heat[c] > maxHeat) maxHeat = heat[c];
  mctx.fillStyle = "#ff7a2e";
  for (let c = 0; c < heat.length && c < chunksX * chunksY; c++) {
    const n = +heat[c];
    if (!(n > 0)) continue;
    mctx.globalAlpha = Math.min(1, 0.25 + 0.75 * Math.sqrt(n / maxHeat));
    mctx.fillRect((c % chunksX) * cw + 1, Math.floor(c / chunksX) * ch + 1, cw - 2, ch - 2);
  }
  mctx.globalAlpha = 1;
  // view rectangle and my position
  const sx = w / mapW;
  const sy = h / mapH;
  mctx.strokeStyle = "rgba(255,255,255,0.6)";
  mctx.lineWidth = Math.max(1, dpr);
  mctx.strokeRect((camX - viewX) * sx, (camY - viewY) * sy, viewX * 2 * sx, viewY * 2 * sy);
  const pos = myPosition();
  const blink = Math.floor(now / 300) % 2 === 0;
  mctx.fillStyle = me ? (blink ? "#ffffff" : "#ffd84d") : "#7aa2ff";
  mctx.beginPath();
  mctx.arc((pos.x + 0.5) * sx, (pos.y + 0.5) * sy, Math.max(2.5, 3.5 * dpr), 0, Math.PI * 2);
  mctx.fill();
}

// =====================================================================
// Rendering
// =====================================================================
function drawTiles(now: number) {
  const W = canvas.width;
  const H = canvas.height;
  const x0 = Math.max(0, Math.floor(-originX / S));
  const x1 = Math.min(mapW - 1, Math.floor((W - originX) / S));
  const y0 = Math.max(0, Math.floor(-originY / S));
  const y1 = Math.min(mapH - 1, Math.floor((H - originY) / S));
  const animating = cellAnim.size > 0;
  for (let y = y0; y <= y1; y++) {
    const chunkRow = ((y / chunkSize) | 0) * chunksX;
    const row = y * mapW;
    const sy = originY + y * S;
    for (let x = x0; x <= x1; x++) {
      if (chunkKnown[chunkRow + ((x / chunkSize) | 0)] === 0) continue; // unknown → dark void
      const i = row + x;
      const v = map[i];
      const sx = originX + x * S;
      if (v === WALL) {
        const border = x === 0 || y === 0 || x === mapW - 1 || y === mapH - 1;
        ctx.drawImage(border ? sprBorder : sprPillar, sx, sy);
        continue;
      }
      ctx.drawImage((x + y) & 1 ? sprFloorA : sprFloorB, sx, sy);
      // soft shadows from blocks above and to the left
      if (y > 0) {
        const up = map[i - mapW];
        if (up === WALL || up === CRATE) ctx.drawImage(sprShadowTop, sx, sy);
      }
      if (x > 0) {
        const left = map[i - 1];
        if (left === WALL || left === CRATE) ctx.drawImage(sprShadowLeft, sx, sy);
      }
      if (v === EMPTY) continue;

      // pop-in animation (new crate / new power-up)
      let scale = 1;
      if (animating) {
        const t0 = cellAnim.get(i);
        if (t0 !== undefined) {
          const k = (now - t0) / 300;
          if (k < 0) scale = 0;
          else if (k < 1) scale = easeOutBack(k);
          else cellAnim.delete(i);
        }
      }
      if (scale <= 0.01) continue;

      if (v === CRATE) {
        if (scale === 1) ctx.drawImage(sprCrate, sx, sy);
        else {
          const s = S * scale;
          ctx.drawImage(sprCrate, sx + (S - s) / 2, sy + (S - s) / 2, s, s);
        }
      } else if (v >= PU_BOMB && v <= PU_NUKE) {
        const bob = Math.sin(now * 0.004 + x * 0.9 + y * 1.3) * S * 0.07;
        const s = S * scale * (1 + 0.06 * Math.sin(now * 0.006 + x + y));
        ctx.drawImage(sprPowerups[v], sx + (S - s) / 2, sy + (S - s) / 2 + bob, s, s);
      }
    }
  }
}

function drawFlames(now: number) {
  if (flames.size === 0) return;
  const W = canvas.width;
  const H = canvas.height;
  // pass 1: tint the floor under the flames
  for (const f of flames.values()) {
    const sx = originX + f.x * S;
    const sy = originY + f.y * S;
    if (sx < -S || sy < -S || sx > W || sy > H) continue;
    ctx.fillStyle = f.nuke ? "rgba(120,255,150,0.35)" : "rgba(255,90,0,0.38)";
    ctx.fillRect(sx, sy, S, S);
  }
  // pass 2: flickering additive fire blobs that melt into each other
  ctx.globalCompositeOperation = "lighter";
  for (const f of flames.values()) {
    const cx = originX + (f.x + 0.5) * S;
    const cy = originY + (f.y + 0.5) * S;
    if (cx < -S || cy < -S || cx > W + S || cy > H + S) continue;
    const age = Math.max(0, now - f.born);
    let s = 1.25 + 0.15 * Math.sin(now * 0.035 + f.x * 1.7 + f.y * 2.3);
    if (age < 120) s *= 0.5 + 0.7 * (age / 120); // pop in
    const size = s * S;
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(now * 0.05 + f.x * 3.1 + f.y);
    ctx.drawImage(f.nuke ? sprFlameNuke : sprFlame, cx - size / 2, cy - size / 2, size, size);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawBombs(now: number) {
  const W = canvas.width;
  const H = canvas.height;
  for (const b of bombs.values()) {
    const cx = originX + (b.x + 0.5) * S;
    const cy = originY + (b.y + 0.5) * S;
    if (cx < -S || cy < -S || cx > W + S || cy > H + S) continue;
    const fuseLeft = Math.max(0, b.ticksLeft * tickMs - (now - b.at)); // ms
    const frac = clamp(fuseLeft / (b.total * tickMs), 0, 1); // 1 = just placed, 0 = boom
    const pulse = 1 + 0.1 * Math.sin(b.phase);
    const age = (now - b.born) / 220;
    const pop = age < 1 ? easeOutBack(Math.max(0, age)) : 1;
    const size = S * (b.nuke ? 1.1 : 0.85) * pulse * pop;
    if (size <= 0) continue;

    // shadow
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.ellipse(cx, cy + S * 0.36, size * 0.36, S * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // pierce bombs get a purple aura
    if (b.pierce) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.5 + 0.2 * Math.sin(now * 0.01);
      const g = size * 1.5;
      ctx.drawImage(sprGlow[C_PURPLE], cx - g / 2, cy - g / 2, g, g);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    const top = cy - size / 2;
    ctx.drawImage(b.nuke ? sprBombNuke : sprBomb, cx - size / 2, top, size, size);
    // red flash in the last half second
    if (fuseLeft < 500) {
      ctx.globalAlpha = Math.sin(now * 0.05) > 0 ? 0.85 : 0.25;
      ctx.drawImage(sprBombRed, cx - size / 2, top, size, size);
      ctx.globalAlpha = 1;
    }

    // fuse: gets shorter as time runs out
    const baseX = cx + size * 0.02;
    const baseY = top + size * 0.1;
    const len = size * (0.12 + 0.28 * frac);
    const tipX = baseX + len * 0.8;
    const tipY = baseY - len * 0.6;
    ctx.strokeStyle = "#d9c49a";
    ctx.lineWidth = Math.max(1, S * 0.05);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(baseX + len * 0.1, baseY - len * 0.7, tipX, tipY);
    ctx.stroke();
    // glowing spark at the tip
    ctx.globalCompositeOperation = "lighter";
    const sparkSize = S * (0.35 + 0.15 * Math.random());
    ctx.drawImage(sprGlow[C_HOT], tipX - sparkSize / 2, tipY - sparkSize / 2, sparkSize, sparkSize);
    ctx.globalCompositeOperation = "source-over";
  }
}

// emit fuse sparks and update the pulse (in update, not in drawing)
function updateBombs(dt: number, now: number) {
  for (const b of bombs.values()) {
    const fuseLeft = Math.max(0, b.ticksLeft * tickMs - (now - b.at));
    const frac = clamp(fuseLeft / (b.total * tickMs), 0, 1);
    const freq = 1.5 + (1 - frac) * 9; // pulses faster and faster
    b.phase += dt * freq * Math.PI * 2;
    if (Math.random() < dt * 30 && isInsideView(b.x, b.y, 0)) {
      const size = b.nuke ? 1.1 : 0.85;
      const len = size * (0.12 + 0.28 * frac);
      const tipX = b.x + 0.5 + size * 0.02 + len * 0.8;
      const tipY = b.y + 0.5 - size * 0.4 - len * 0.6;
      spawnParticle(tipX, tipY, rand(-1.5, 1.5), rand(-2.5, -0.5), rand(0.15, 0.35), rand(0.1, 0.2), KIND_GLOW, pick(FIRE_COLORS), 6);
    }
  }
}

function updateFlames(dt: number) {
  for (const f of flames.values()) {
    if (Math.random() < dt * 5) {
      spawnParticle(f.x + rand(0.2, 0.8), f.y + rand(0.3, 0.8), rand(-0.3, 0.3), rand(-2, -0.8), rand(0.3, 0.6), rand(0.15, 0.3), KIND_GLOW, pick(f.nuke ? NUKE_COLORS : FIRE_COLORS), -1);
    }
  }
}

function byRenderY(a: PlayerView, b: PlayerView): number {
  return a.ry - b.ry;
}

function drawPlayers(now: number) {
  playerList.length = 0;
  for (const p of players.values()) playerList.push(p);
  playerList.sort(byRenderY);
  for (let i = 0; i < playerList.length; i++) drawPlayerBody(playerList[i], now);
  // tags in a second pass so names are never hidden behind other players
  ctx.font = nameFont;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < playerList.length; i++) drawPlayerTags(playerList[i], now);
}

function drawPlayerBody(p: PlayerView, now: number) {
  const cx = originX + (p.rx + 0.5) * S;
  const footY = originY + (p.ry + 0.5) * S + S * 0.34;
  if (cx < -S || cx > canvas.width + S || footY < -S || footY > canvas.height + 2 * S) {
    p.visible = false;
    return;
  }
  p.visible = true;
  const isMe = p.id === myId;

  // squash and stretch: stretch in the walking direction, then squash on landing
  const k = (now - p.stepStart) / (p.stepMs * 1.2);
  let along = 1;
  let across = 1;
  let hop = 0;
  if (k >= 0 && k < 1) {
    const wobble = Math.sin(k * Math.PI * 2) * (1 - k);
    along = 1 + 0.22 * wobble;
    across = 1 - 0.15 * wobble;
    hop = Math.sin(k * Math.PI) * S * 0.1;
  }
  const horizontal = p.stepDir === 1 || p.stepDir === 3;
  const scaleX = horizontal ? along : across;
  const scaleY = (horizontal ? across : along) * (1 + 0.035 * Math.sin(now * 0.006 + p.id)); // idle breathing

  // shadow (smaller while hopping)
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.ellipse(cx, footY, S * 0.3 * scaleX * (1 - hop / S), S * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();

  // blink while invulnerable
  ctx.globalAlpha = p.inv && Math.floor(now / 90) % 2 === 0 ? 0.35 : 1;

  const w = S * 0.74;
  const h = S * 0.72;
  ctx.save();
  ctx.translate(cx, footY - hop);
  ctx.scale(scaleX, scaleY);

  // feet
  ctx.fillStyle = p.dark;
  const footLift = k >= 0 && k < 1 ? Math.sin(k * Math.PI * 2) * S * 0.05 : 0;
  ctx.beginPath();
  ctx.ellipse(-w * 0.22, -S * 0.03 - footLift, w * 0.16, S * 0.07, 0, 0, Math.PI * 2);
  ctx.ellipse(w * 0.22, -S * 0.03 + footLift, w * 0.16, S * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();

  // body
  roundRectPath(ctx, -w / 2, -h, w, h * 0.95, S * 0.3);
  ctx.fillStyle = p.body;
  ctx.fill();
  ctx.lineWidth = isMe ? S * 0.09 : S * 0.05;
  ctx.strokeStyle = isMe ? "#ffffff" : p.dark;
  ctx.stroke();

  // shiny highlight
  ctx.fillStyle = p.light;
  ctx.beginPath();
  ctx.ellipse(-w * 0.2, -h * 0.78, w * 0.12, h * 0.08, -0.5, 0, Math.PI * 2);
  ctx.fill();

  // eyes look in the facing direction
  const d = p.dir;
  const lookX = DX[d] * S * 0.09;
  const lookY = DY[d] * S * 0.06;
  const eyeY = -h * 0.58 + lookY;
  const blinking = (now + p.id * 977) % 3700 < 110;
  for (let side = -1; side <= 1; side += 2) {
    const ex = side * S * 0.14 + lookX;
    if (blinking) {
      ctx.strokeStyle = "#1a1a1a";
      ctx.lineWidth = Math.max(1, S * 0.04);
      ctx.beginPath();
      ctx.moveTo(ex - S * 0.07, eyeY);
      ctx.lineTo(ex + S * 0.07, eyeY);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, S * 0.09, S * 0.115, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#151515";
      ctx.beginPath();
      ctx.ellipse(ex + DX[d] * S * 0.035, eyeY + DY[d] * S * 0.045, S * 0.045, S * 0.06, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  p.screenX = cx;
  p.headY = footY - hop - h * scaleY;
}

function drawPlayerTags(p: PlayerView, now: number) {
  if (!p.visible) return;
  const isMe = p.id === myId;
  let y = p.headY;

  // crown for the leaderboard #1, sitting on the head
  if (p.id === crownId) {
    const cs = S * 0.55;
    const bob = Math.sin(now * 0.005) * S * 0.03;
    ctx.drawImage(sprCrown, p.screenX - cs / 2, y - cs * 0.78 + bob, cs, cs);
    y -= cs * 0.6;
  }

  // hearts
  const hs = S * 0.24;
  const lives = Math.min(5, Math.max(0, p.lives | 0));
  if (lives > 0) {
    const total = lives * hs * 0.9;
    for (let i = 0; i < lives; i++) ctx.drawImage(sprHeart, p.screenX - total / 2 + i * hs * 0.9, y - hs - S * 0.04, hs, hs);
    y -= hs + S * 0.06;
  }

  // name tag
  if (p.nameFont !== nameFontPx) {
    p.nameWidth = ctx.measureText(p.name).width;
    p.nameFont = nameFontPx;
  }
  const pad = nameFontPx * 0.3;
  const tw = p.nameWidth + pad * 2;
  const th = nameFontPx + pad;
  const ty = y - th - S * 0.02;
  roundRectPath(ctx, p.screenX - tw / 2, ty, tw, th, th / 2);
  ctx.fillStyle = isMe ? "rgba(90,60,0,0.75)" : "rgba(10,12,28,0.6)";
  ctx.fill();
  ctx.fillStyle = isMe ? "#ffd84d" : "#ffffff";
  ctx.fillText(p.name, p.screenX, ty + th / 2 + 1);
  y = ty;

  // bobbing arrow over myself
  if (isMe) {
    const bob = Math.sin(now * 0.008) * S * 0.08;
    const ay = y - S * 0.12 + bob;
    const aw = S * 0.22;
    ctx.fillStyle = "#ffd84d";
    ctx.strokeStyle = "#3a1500";
    ctx.lineWidth = Math.max(1, S * 0.04);
    ctx.beginPath();
    ctx.moveTo(p.screenX - aw, ay - aw);
    ctx.lineTo(p.screenX + aw, ay - aw);
    ctx.lineTo(p.screenX, ay);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

// ---------- main loop ----------
let lastFrame = performance.now();

function update(dt: number, now: number) {
  // tween players toward their server cell at their own walking speed
  for (const p of players.values()) {
    const dx = p.x - p.rx;
    const dy = p.y - p.ry;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist === 0) continue;
    const maxStep = ((dt * 1000) / p.stepMs) * (dist > 1.2 ? 2.2 : 1.15); // catch up if we lag behind
    if (dist <= maxStep) {
      p.rx = p.x;
      p.ry = p.y;
    } else {
      p.rx += (dx / dist) * maxStep;
      p.ry += (dy / dist) * maxStep;
    }
  }

  // camera follows my (tweened) player, or the server's camera while spectating / dead
  let targetX = serverCamX + 0.5;
  let targetY = serverCamY + 0.5;
  const mine = players.get(myId);
  if (mine) {
    targetX = mine.rx + 0.5;
    targetY = mine.ry + 0.5;
  }
  if (camReady) {
    const far = Math.abs(targetX - camX) + Math.abs(targetY - camY);
    if (far > 14) {
      // big jump (spectator switches player, respawn far away): cut with a quick fade
      camX = targetX;
      camY = targetY;
      fadeAlpha = 0.85;
    } else {
      const a = 1 - Math.exp(-dt * 9);
      camX += (targetX - camX) * a;
      camY += (targetY - camY) * a;
    }
  }

  shake *= Math.exp(-dt * 9);
  if (shake < 0.3) shake = 0;
  flashAlpha = Math.max(0, flashAlpha - dt * 2.2);
  fadeAlpha = Math.max(0, fadeAlpha - dt * 3);

  updateBombs(dt, now);
  updateFlames(dt);
  updateParticles(dt);

  minimapTimer -= dt;
  if (minimapTimer <= 0) {
    minimapTimer = 0.1;
    drawMinimap(now);
  }
}

function render(now: number) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = VOID_COLOR;
  ctx.fillRect(0, 0, W, H);
  if (!camReady) return;

  const shakeX = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
  const shakeY = shake > 0 ? (Math.random() * 2 - 1) * shake : 0;
  originX = Math.round(W / 2 - camX * S + shakeX);
  originY = Math.round(H / 2 - camY * S + shakeY);

  drawTiles(now);
  drawFlames(now);
  drawBombs(now);
  drawPlayers(now);
  drawParticles();
  drawRings(now);
  drawFloatTexts(now);

  if (flashAlpha > 0) {
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = flashColor;
    ctx.fillRect(0, 0, W, H);
  }
  if (fadeAlpha > 0) {
    ctx.globalAlpha = fadeAlpha;
    ctx.fillStyle = VOID_COLOR;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalAlpha = 1;
}

function frame() {
  // performance.now() instead of the rAF timestamp: the message handlers use it too,
  // and the rAF time can be slightly older, which would give negative animation ages
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  try {
    update(dt, now);
    render(now);
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(frame);
}

// =====================================================================
// Input: keyboard (key stack), touch D-pad and bomb button
// =====================================================================
const keyStack: number[] = []; // held direction keys, the last pressed one wins
let touchDir = -1;
let sentDir = -1;

function codeToDir(code: string, key: string): number {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return 0;
    case "KeyD":
    case "ArrowRight":
      return 1;
    case "KeyS":
    case "ArrowDown":
      return 2;
    case "KeyA":
    case "ArrowLeft":
      return 3;
  }
  // fallback for browsers without e.code
  switch (key) {
    case "w":
    case "W":
      return 0;
    case "d":
    case "D":
      return 1;
    case "s":
    case "S":
      return 2;
    case "a":
    case "A":
      return 3;
  }
  return -1;
}

function currentDir(): number {
  if (touchDir !== -1) return touchDir;
  return keyStack.length > 0 ? keyStack[keyStack.length - 1] : -1;
}

// send "in" only when the resulting direction changes
function updateInput() {
  if (!joined) return;
  const dir = currentDir();
  if (dir === sentDir) return;
  sentDir = dir;
  send({ t: "in", d: dir });
}

function removeFromStack(dir: number) {
  const i = keyStack.indexOf(dir);
  if (i !== -1) keyStack.splice(i, 1);
}

function placeBomb() {
  if (joined) send({ t: "b" });
}

function isStartVisible(): boolean {
  return !startEl.classList.contains("hidden") && !startEl.classList.contains("leaving");
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  // typing a name: leave the keys alone, Enter starts the game
  if (e.target instanceof HTMLInputElement) {
    if (e.key === "Enter") {
      e.preventDefault();
      startPlaying();
    }
    return;
  }
  initAudio();
  const dir = codeToDir(e.code, e.key);
  if (dir !== -1) {
    e.preventDefault();
    if (!e.repeat) {
      removeFromStack(dir);
      keyStack.push(dir);
      updateInput();
    }
    return;
  }
  if (e.code === "Space" || e.key === " ") {
    e.preventDefault(); // no page scroll, no clicking a focused button
    if (!e.repeat) placeBomb();
    return;
  }
  if (e.code === "KeyM" || e.key === "m" || e.key === "M") {
    if (!e.repeat) setMuted(!muted);
    return;
  }
  if (e.key === "Enter" && isStartVisible()) startPlaying();
});

window.addEventListener("keyup", (e: KeyboardEvent) => {
  const dir = codeToDir(e.code, e.key);
  if (dir === -1) return;
  removeFromStack(dir);
  updateInput();
});

// alt-tab etc.: forget every held key, otherwise the player keeps running
window.addEventListener("blur", () => {
  keyStack.length = 0;
  touchDir = -1;
  resetKnob();
  updateInput();
});

// --- touch D-pad: drag inside the circle, the dominant axis wins ---
let dpadPointer = -1;

function resetKnob() {
  dpadKnob.style.transform = "";
}

function dpadMove(e: PointerEvent) {
  const r = dpad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  const dead = r.width * 0.12;
  let dir = -1;
  if (Math.abs(dx) > dead || Math.abs(dy) > dead) {
    dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0;
  }
  const maxR = r.width * 0.3;
  const len = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, maxR / len);
  dpadKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  if (dir !== touchDir) {
    touchDir = dir;
    if (dir !== -1) vibrate(8);
    updateInput();
  }
}

dpad.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  initAudio();
  dpadPointer = e.pointerId;
  try {
    dpad.setPointerCapture(e.pointerId);
  } catch {
    // ignore
  }
  dpadMove(e);
});
dpad.addEventListener("pointermove", (e: PointerEvent) => {
  if (e.pointerId === dpadPointer) dpadMove(e);
});
const dpadEnd = (e: PointerEvent) => {
  if (e.pointerId !== dpadPointer) return;
  dpadPointer = -1;
  touchDir = -1;
  resetKnob();
  updateInput();
};
dpad.addEventListener("pointerup", dpadEnd);
dpad.addEventListener("pointercancel", dpadEnd);

bombButton.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  initAudio();
  vibrate(15);
  placeBomb();
});

muteButton.addEventListener("click", () => {
  initAudio();
  setMuted(!muted);
  muteButton.blur(); // so space doesn't click it again
});

// ---------- start screen ----------
function buildTitle() {
  const colors = ["#ffd84d", "#ffb22e", "#ff7a2e", "#ff4d6d", "#7aa2ff", "#8dff9a"];
  const words = (titleEl.textContent || "").trim().split(/\s+/);
  titleEl.textContent = "";
  let n = 0;
  for (const word of words) {
    const wordSpan = document.createElement("span");
    wordSpan.className = "word";
    for (const ch of word) {
      const letter = document.createElement("span");
      letter.className = "letter";
      letter.textContent = ch;
      letter.style.color = colors[n % colors.length];
      letter.style.animationDelay = `${n * 0.07}s`;
      wordSpan.appendChild(letter);
      n++;
    }
    titleEl.appendChild(wordSpan);
  }
}

function startPlaying() {
  if (wantToPlay && joined) return;
  initAudio();
  myName = nameInput.value.trim().slice(0, 16);
  storageSet("bdc-name", myName);
  wantToPlay = true;
  send({ t: "join", name: myName }); // if the socket is not open yet, "open" sends it
  hideStart();
}

function hideStart() {
  if (startEl.classList.contains("hidden")) return;
  startEl.classList.add("leaving");
  document.body.classList.remove("onStart");
  nameInput.blur();
  setTimeout(() => startEl.classList.add("hidden"), 420);
}

playButton.addEventListener("click", () => startPlaying());

// ---------- go! ----------
buildTitle();
nameInput.value = storageGet("bdc-name");
setMuted(muted);
buildGlowSprites();
resize();
window.addEventListener("resize", resize);
// the first click/touch anywhere unlocks the audio
window.addEventListener("pointerdown", () => initAudio());
connect();
requestAnimationFrame(frame);
setTimeout(() => nameInput.focus(), 50);
