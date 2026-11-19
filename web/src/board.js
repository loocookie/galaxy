// Pure game logic for the Galaxy UI (no React). Coordinates follow galaxy.py:
// cell i = r*C + c; a dot [d0, d1] is in doubled coordinates (cell (r,c) center = (2r, 2c)).
//
// Walls drawn by the player:
//   v[r*(C-1) + c] : wall between cell (r,c) and (r,c+1)
//   h[r*C + c]     : wall between cell (r,c) and (r+1,c)
// paint[i]: dot index the player colored cell i with, or -1.

export const emptyWalls = (R, C) => ({ v: Array(R * (C - 1)).fill(0), h: Array((R - 1) * C).fill(0) })

export function core(R, C, [d0, d1]) {
  const rs = d0 % 2 === 0 ? [d0 / 2] : [(d0 - 1) / 2, (d0 + 1) / 2]
  const cs = d1 % 2 === 0 ? [d1 / 2] : [(d1 - 1) / 2, (d1 + 1) / 2]
  return rs.flatMap(r => cs.map(c => r * C + c))
}

export function mirror(R, C, i, [d0, d1]) {
  const r = Math.floor(i / C), c = i % C
  const mr = d0 - r, mc = d1 - c
  return mr >= 0 && mr < R && mc >= 0 && mc < C ? mr * C + mc : -1
}

/** Connected components of cells, walls block movement. Returns comp id per cell. */
export function components(R, C, walls) {
  const N = R * C
  const comp = Array(N).fill(-1)
  let n = 0
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue
    comp[s] = n
    const st = [s]
    while (st.length) {
      const x = st.pop()
      const r = Math.floor(x / C), c = x % C
      const nb = []
      if (c + 1 < C && !walls.v[r * (C - 1) + c]) nb.push(x + 1)
      if (c > 0 && !walls.v[r * (C - 1) + c - 1]) nb.push(x - 1)
      if (r + 1 < R && !walls.h[r * C + c]) nb.push(x + C)
      if (r > 0 && !walls.h[(r - 1) * C + c]) nb.push(x - C)
      for (const y of nb) if (comp[y] < 0) { comp[y] = n; st.push(y) }
    }
    n++
  }
  return comp
}

/**
 * Derive everything the view needs from the player's walls and paint.
 * - auto[i]   : dot index if cell i lies in a wall-enclosed area containing exactly one dot
 * - display[i]: auto color if any, else the manual paint
 * - errCells  : rule violations only (never compares against the solution, and never
 *               checks open areas, which would give hints):
 *     closed one-dot piece that is not point-symmetric (mirror outside the piece);
 *     closed area containing no dot at all.
 * - errWalls  : walls drawn between two cells of the same color (e.g. a stray line inside a
 *               finished piece); { v: Set<idx>, h: Set<idx> }
 * - badDots   : dots with a wall drawn through their core
 * - filled / solved
 */
export function analyze(puzzle, walls, paint) {
  const { R, C, dots, owner } = puzzle
  const N = R * C
  const comp = components(R, C, walls)
  // a dot is "bad" if any wall segment runs between two of its core cells
  const badDots = new Set()
  dots.forEach((d, k) => {
    const cs = core(R, C, d)
    for (const a of cs) for (const b of cs) {
      if (b === a + 1 && a % C + 1 < C && walls.v[Math.floor(a / C) * (C - 1) + a % C]) badDots.add(k)
      if (b === a + C && walls.h[a]) badDots.add(k)
    }
  })
  const dotComp = dots.map((d) => {
    const cs = core(R, C, d).map(i => comp[i])
    return cs.some(x => x !== cs[0]) ? -1 : cs[0]
  })
  const compDots = new Map()
  dotComp.forEach((cp, k) => {
    if (cp < 0) return
    if (!compDots.has(cp)) compDots.set(cp, [])
    compDots.get(cp).push(k)
  })
  // a dot split by a wall still "occupies" every component it touches (no empty-area error there)
  const touched = new Set()
  dots.forEach((d, k) => { if (dotComp[k] < 0) core(R, C, d).forEach(i => touched.add(comp[i])) })

  const auto = comp.map(cp => (compDots.get(cp)?.length === 1 ? compDots.get(cp)[0] : -1))
  const display = auto.map((a, i) => (a >= 0 ? a : paint[i]))

  const errCells = new Set()
  for (let i = 0; i < N; i++) {
    const k = display[i]
    if (k < 0) continue
    // Only closed pieces are checked for symmetry. Checking painted cells in open areas
    // (mirror off-grid / other color, or cut off from their dot) would give away hints.
    const m = mirror(R, C, i, dots[k])
    if (auto[i] >= 0 && (m < 0 || comp[m] !== comp[i])) errCells.add(i)
  }
  for (let i = 0; i < N; i++) {
    if (!compDots.has(comp[i]) && !touched.has(comp[i])) errCells.add(i)
  }

  // a wall between two cells of the same color can never be part of the answer
  const errWalls = { v: new Set(), h: new Set() }
  for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) {
    const idx = r * (C - 1) + c, a = display[r * C + c]
    if (walls.v[idx] && a >= 0 && a === display[r * C + c + 1]) errWalls.v.add(idx)
  }
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) {
    const idx = r * C + c, a = display[idx]
    if (walls.h[idx] && a >= 0 && a === display[idx + C]) errWalls.h.add(idx)
  }

  const filled = display.every(k => k >= 0)
  const solved = filled && display.every((k, i) => k === owner[i])
  return { comp, auto, display, errCells, errWalls, badDots, filled, solved }
}

const hueDist = (x, y) => { const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d) }

/**
 * Pairwise weight: large when two dots are close. Dot distance only (never the solution,
 * which would leak adjacency through the colors).
 */
function pairWeights(dots) {
  return dots.map((a, i) => dots.map((b, j) => {
    if (i === j) return 0
    const dist = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 // in cells
    return dist < 7 ? 1 / Math.max(dist, 0.5) ** 2 : 0
  }))
}
/** Similarity of two colors {h, tier}: hue closeness, much weaker across lightness tiers. */
const colorPenalty = (a, b) => {
  const t = Math.max(0, 1 - hueDist(a.h, b.h) / 120)
  return t * t * (a.tier === b.tier ? 1 : 0.3)
}

/** Total similarity penalty of a color assignment (lower is better). */
export function hueCost(dots, colors, W = pairWeights(dots)) {
  let cost = 0
  for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
    if (W[i][j]) cost += W[i][j] * colorPenalty(colors[i], colors[j])
  }
  return cost
}

/**
 * Distinct colors for the dots, as { h: OKLCH hue, tier: 0 | 1 lightness tier }.
 * Palette: one evenly spaced hue per dot, lightness tiers alternating around the wheel, so
 * hue neighbours also differ in lightness. Assigned greedily, then improved by pairwise
 * swaps until no swap lowers the penalty: dots close to each other get dissimilar colors.
 */
export function assignHues(dots) {
  const n = dots.length
  if (!n) return []
  const W = pairWeights(dots)
  const palette = Array.from({ length: n }, (_, i) => ({ h: (20 + (i * 360) / n) % 360, tier: i % 2 }))
  const crowd = W.map(row => row.reduce((a, b) => a + b, 0))
  const order = dots.map((_, i) => i).sort((a, b) => crowd[b] - crowd[a] || a - b)
  const col = Array(n).fill(null)
  const free = new Set(palette.keys())
  for (const i of order) {
    let best = -1, bestCost = Infinity
    for (const p of free) {
      let c = 0
      for (let j = 0; j < n; j++) if (col[j] && W[i][j]) c += W[i][j] * colorPenalty(palette[p], col[j])
      if (c < bestCost) { bestCost = c; best = p }
    }
    free.delete(best)
    col[i] = palette[best]
  }
  const local = (i) => {
    let c = 0
    for (let j = 0; j < n; j++) if (j !== i && W[i][j]) c += W[i][j] * colorPenalty(col[i], col[j])
    return c
  }
  for (let pass = 0, improved = true; improved && pass < 50; pass++) {
    improved = false
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const before = local(i) + local(j)
      ;[col[i], col[j]] = [col[j], col[i]]
      if (local(i) + local(j) < before - 1e-9) improved = true
      else [col[i], col[j]] = [col[j], col[i]]
    }
  }
  return col
}

/**
 * Walls the player may not draw: the edges between two core cells of a dot
 * (a dot on an edge blocks that edge; a dot on a vertex blocks its four edges).
 * Returns { v: Set<idx>, h: Set<idx> }.
 */
export function blockedWalls(R, C, dots) {
  const v = new Set(), h = new Set()
  for (const d of dots) {
    const cs = core(R, C, d)
    for (const a of cs) for (const b of cs) {
      if (b === a + 1 && a % C + 1 < C) v.add(Math.floor(a / C) * (C - 1) + (a % C))
      if (b === a + C) h.add(a)
    }
  }
  return { v, h }
}

/**
 * Which wall the point (x, y) in cell units is on, or null. Only interior walls, only the
 * middle part of an edge (`ends` of each end, near the vertices, is ignored so a drag along
 * one line does not catch the crossing edges), and never a blocked wall.
 */
export function wallAt(R, C, x, y, blocked = null, tol = 0.25, ends = 0.2) {
  const vx = Math.round(x), hy = Math.round(y)
  const dv = Math.abs(x - vx), dh = Math.abs(y - hy)
  if (Math.min(dv, dh) > tol) return null
  let w = null
  if (dv <= dh) {
    const r = Math.floor(y), along = y - r
    if (vx <= 0 || vx >= C || r < 0 || r >= R || along < ends || along > 1 - ends) return null
    w = { t: 'v', idx: r * (C - 1) + (vx - 1) }
  } else {
    const c = Math.floor(x), along = x - c
    if (hy <= 0 || hy >= R || c < 0 || c >= C || along < ends || along > 1 - ends) return null
    w = { t: 'h', idx: (hy - 1) * C + c }
  }
  if (blocked && blocked[w.t].has(w.idx)) return null
  return w
}

/** Index of the dot near (x, y) in cell units, or -1. */
export function dotAt(dots, x, y, radius = 0.32) {
  let best = -1, bd = radius
  dots.forEach(([d0, d1], k) => {
    const dist = Math.hypot(x - (d1 / 2 + 0.5), y - (d0 / 2 + 0.5))
    if (dist <= bd) { bd = dist; best = k }
  })
  return best
}
