// A push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Idea: the levels this competition draws are a hallway with independent rooms
// off it (one door each, boxes can never leave their room), so the level's
// push-optimal count is the sum of the rooms' optima. This program solves each
// room on its own with a breadth-first search over pushes, then stitches the
// rooms together with the player's walks between them. A breadth-first search
// over pushes finds the fewest pushes by construction: the first solved state
// it meets is optimal, and every room this generator draws is solvable inside
// the state budget below.
//
// Two prunings keep the search small, and neither can remove a solvable state:
//   - dead squares: a box standing on a square from which no sequence of pushes
//     (ignoring the other boxes) can ever reach a goal is dropped at once. The
//     live squares are found by pulling boxes backwards from the goals.
//   - frozen 2x2 blocks: four squares of walls and boxes, one of the boxes off
//     its goal, can never move again, so the push that forms one is refused.
//
// A state is the boxes' squares plus the lowest square of the player's
// reachable region (the exact square the player stands on inside its region
// does not matter). Deterministic throughout: fixed direction order, fixed
// state budget counted in work, no clock, no randomness, so two runs write
// the same bytes.
//
// Runtime: node /bot/main.ts, Node 22, standard library only. It reads
// /input/<id>/level.txt (or $MAKEFUN_INPUT_DIR) and writes
// /output/<id>/solution.txt (or $MAKEFUN_OUTPUT_DIR) for every instance id,
// the player's moves in lowercase u/d/l/r, one letter a step.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in states, never in seconds: a search cut off by the
// clock would answer differently from one run to the next.
const ROOM_BUDGET = 250_000;
const LEVEL_BUDGET = 100_000;

// The four steps: across, down, back, right; kept in this order everywhere so
// every tie breaks the same way on every run.
const DIRS = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  // Nothing leaves the board: the outermost frame counts as wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goal, boxes, player };
}

/**
 * The squares from which a box alone can still reach some goal: start at the
 * goals and pull boxes backwards. A box at y can be pulled to x (one step in
 * direction d) exactly when both y and the square behind it, y - d, are open
 * floor, so the pull walk marks every square a box can ever be pushed from.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Whether the box just pushed onto `t` now sits in a frozen 2x2 block: four
 * squares, each a wall or a box, holding at least one box off its goal. No box
 * in such a block can ever move again (every push out of it needs the player
 * to stand on a square inside it), so the state is dead.
 */
function frozenBlock(level: Level, occupied: Uint8Array, t: number): boolean {
  const { w, wall, goal } = level;
  const tx = t % w;
  const ty = Math.floor(t / w);
  for (let oy = -1; oy <= 0; oy++) {
    for (let ox = -1; ox <= 0; ox++) {
      const ax = tx + ox;
      const ay = ty + oy;
      if (ax < 0 || ay < 0 || ax + 1 >= w || ay + 1 >= level.h) continue;
      const a = ay * w + ax;
      const cells = [a, a + 1, a + w, a + w + 1];
      let full = true;
      let offGoal = false;
      for (const c of cells) {
        if (!wall[c] && !occupied[c]) {
          full = false;
          break;
        }
        if (occupied[c] && !goal[c]) offGoal = true;
      }
      if (full && offGoal) return true;
    }
  }
  return false;
}

/**
 * The squares the player reaches from `from` around walls and `occupied`
 * boxes, marking them in `seen` with `stamp`; returns the lowest square of
 * the region, which names the region in a state's key.
 */
function flood(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** A state's key: its region's lowest square and the boxes' squares. */
function keyFor(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5 && size <= 300) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}:${boxes.join(',')}`;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lowercase LURD letters. */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const { dx, dy, ch } of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = ch;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The player's square after playing `moves` (lowercase LURD) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * The push-optimal solution of `level` within `maxStates` states, or null
 * when the search gives up (or the level has no solution): {pushes, moves},
 * moves in lowercase LURD. States are searched in order of pushes made, so
 * the first solved state met is optimal.
 */
function pushBfs(level: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goal } = level;
  const size = wall.length;
  const live = liveSquares(level);
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // The states in the order found: their boxes, the square the player stands
  // on after the push that made them, their parent, and the push itself.
  const allBoxes: number[][] = [level.boxes.slice()];
  const afterPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyFor(level.boxes, flood(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  let found = -1;
  for (let head = 0; head < allBoxes.length && found < 0; head++) {
    const boxes = allBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    flood(level, occupied, afterPlayer[head], seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di].dy * w + DIRS[di].dx;
        const behind = b - d;
        const ahead = b + d;
        if (behind < 0 || behind >= size || ahead < 0 || ahead >= size) continue;
        if (seen[behind] !== here) continue;
        if (wall[ahead] || occupied[ahead] || !live[ahead]) continue;
        occupied[b] = 0;
        occupied[ahead] = 1;
        const frozen = frozenBlock(level, occupied, ahead);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = ahead;
          next.sort((x, y) => x - y);
          key = keyFor(next, flood(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[ahead] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (allBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, allBoxes.length);
        allBoxes.push(next!);
        afterPlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushDir.push(di);
        if (solved(next!)) {
          found = allBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const next = allBoxes[s];
    const from = pushFrom[s];
    const di = pushDir[s];
    const d = DIRS[di].dy * w + DIRS[di].dx;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di].ch;
    player = from;
    boxes = next;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done?: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds a
 * box is a room. Null when some part holds more or fewer boxes than goals, or
 * a box starts in the hallway: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const { dx, dy } of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The whole level solved as one search, the fallback when it is no set of rooms. */
function solveWhole(level: Level): string {
  const solved = pushBfs(level, LEVEL_BUDGET);
  return solved === null ? '' : solved.moves;
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms === null) return solveWhole(level);
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      goal: goalSet(level, room.goals),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = pushBfs(sub, ROOM_BUDGET);
    if (solved === null) return solveWhole(level);
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

/** A goal mask for one room's goals on the level's board. */
function goalSet(level: Level, goals: number[]): Uint8Array {
  const goal = new Uint8Array(level.wall.length);
  for (const g of goals) goal[g] = 1;
  return goal;
}

for (const id of readdirSync(INPUT).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8'));
  } catch (err) {
    // A failed instance still gets its file (empty: valid format, 0 points),
    // but the failure is reported on stderr instead of vanishing silently.
    console.error(`solve ${id} failed:`, err instanceof Error ? err.message : err);
    moves = '';
  }
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
