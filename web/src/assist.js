// Optional assists (no React): auto-mirroring of paint and walls, and auto candidates.
// They only ever use the player's own marks and the symmetry rule, never the solution.
import { core, mirror } from './board.js'

/** Per cell, the dot whose core it is, or -1. */
export function coreOwner(R, C, dots) {
  const own = Array(R * C).fill(-1)
  dots.forEach((d, k) => { for (const i of core(R, C, d)) own[i] = k })
  return own
}

/** The paint the board shows when auto-mirror is on: every dot's core cells take its color. */
export const withCores = (paint, coreOwn) => paint.map((k, i) => (coreOwn[i] >= 0 ? coreOwn[i] : k))

/** The two cells a wall separates. */
export function wallCells(R, C, t, idx) {
  if (t === 'v') {
    const r = Math.floor(idx / (C - 1)), c = idx % (C - 1)
    return [r * C + c, r * C + c + 1]
  }
  return [idx, idx + C]
}

/** The wall between two neighbouring cells, or null. */
export function wallBetween(R, C, a, b) {
  if (a > b) [a, b] = [b, a]
  if (b === a + 1 && a % C + 1 < C) return { t: 'v', idx: Math.floor(a / C) * (C - 1) + (a % C) }
  if (b === a + C) return { t: 'h', idx: a }
  return null
}

/** Walls around cell i that are drawn. */
export function wallsAround(R, C, walls, i) {
  const r = Math.floor(i / C), c = i % C, out = []
  const nb = []
  if (c > 0) nb.push(i - 1)
  if (c + 1 < C) nb.push(i + 1)
  if (r > 0) nb.push(i - C)
  if (r + 1 < R) nb.push(i + C)
  for (const j of nb) {
    const w = wallBetween(R, C, i, j)
    if (walls[w.t][w.idx]) out.push(w)
  }
  return out
}

/**
 * Set the walls `seeds` to `value` and spread: a wall on the edge of a colored cell has a twin
 * mirrored about that color's dot, which gets the same value, and so on from each twin (its
 * own colored cells may point to further twins). Twins on the board's frame or through a dot
 * are skipped. `colorAt(i)` is the color the player sees on cell i (-1 = none). Mutates
 * `walls`; returns whether anything changed.
 */
export function spreadWalls(R, C, dots, walls, colorAt, seeds, value, blocked) {
  let changed = false
  const queue = []
  for (const w of seeds) {
    if (walls[w.t][w.idx] !== value) { walls[w.t][w.idx] = value; changed = true }
    queue.push(w)
  }
  const seen = new Set(queue.map(w => w.t + w.idx))
  while (queue.length) {
    const { t, idx } = queue.pop()
    const [a, b] = wallCells(R, C, t, idx)
    for (const k of new Set([colorAt(a), colorAt(b)])) {
      if (k < 0) continue
      const ma = mirror(R, C, a, dots[k]), mb = mirror(R, C, b, dots[k])
      if (ma < 0 || mb < 0) continue
      const m = wallBetween(R, C, ma, mb)
      if (!m || blocked[m.t].has(m.idx) || seen.has(m.t + m.idx)) continue
      seen.add(m.t + m.idx)
      if (walls[m.t][m.idx] !== value) { walls[m.t][m.idx] = value; changed = true }
      queue.push(m)
    }
  }
  return changed
}

/**
 * Auto candidates: for each cell that isn't colored yet, the dots it could still belong to
 * going by the player's marks: its mirror about the dot is on the board, and both it and the
 * mirror can reach the dot's core without crossing a wall or a cell of another color.
 * `display` is the color shown per cell (-1 = none). Returns a list of dot indices per cell.
 */
export function autoCandidates(R, C, dots, walls, display) {
  const N = R * C
  const reach = dots.map((d, k) => {
    const seen = new Uint8Array(N)
    const st = core(R, C, d).filter(i => display[i] < 0 || display[i] === k)
    for (const i of st) seen[i] = 1
    while (st.length) {
      const x = st.pop(), r = Math.floor(x / C), c = x % C
      const step = (y, wall) => {
        if (!wall && !seen[y] && (display[y] < 0 || display[y] === k)) { seen[y] = 1; st.push(y) }
      }
      if (c + 1 < C) step(x + 1, walls.v[r * (C - 1) + c])
      if (c > 0) step(x - 1, walls.v[r * (C - 1) + c - 1])
      if (r + 1 < R) step(x + C, walls.h[x])
      if (r > 0) step(x - C, walls.h[x - C])
    }
    return seen
  })
  const out = []
  for (let i = 0; i < N; i++) {
    if (display[i] >= 0) { out.push([]); continue }
    const list = []
    dots.forEach((d, k) => {
      const m = mirror(R, C, i, d)
      if (m >= 0 && reach[k][i] && reach[k][m]) list.push(k)
    })
    out.push(list)
  }
  return out
}
