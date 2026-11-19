// Logic tests for src/board.js against puzzles made by ../galaxy.py (test/puzzles.json).
// Run: npm test
import { readFileSync } from 'node:fs'
import * as B from '../src/board.js'

const puzzles = JSON.parse(readFileSync(new URL('./puzzles.json', import.meta.url), 'utf8'))
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg) } }
for (const [n, pz] of puzzles.entries()) {
  const { R, C, owner, dots } = pz, N = R * C
  const none = Array(N).fill(-1)
  // 1. empty board: nothing colored, no errors (except none), not filled
  let a = B.analyze(pz, B.emptyWalls(R, C), none)
  check(!a.filled && !a.solved && a.errCells.size === 0 && a.badDots.size === 0, `#${n} empty board`)
  // 2. solution walls only -> every area has exactly one dot -> auto colors -> solved, no errors
  const w = B.emptyWalls(R, C)
  for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) w.v[r * (C - 1) + c] = +(owner[r * C + c] !== owner[r * C + c + 1])
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) w.h[r * C + c] = +(owner[r * C + c] !== owner[(r + 1) * C + c])
  a = B.analyze(pz, w, none)
  check(a.solved && a.errCells.size === 0 && a.badDots.size === 0, `#${n} solution walls -> solved (errs ${a.errCells.size})`)
  // 3. solution paint only -> solved
  a = B.analyze(pz, B.emptyWalls(R, C), owner)
  check(a.solved && a.errCells.size === 0, `#${n} solution paint -> solved`)
  // 4. enclose only region 0 -> exactly its cells auto-colored
  const w0 = B.emptyWalls(R, C)
  for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) w0.v[r * (C - 1) + c] = +((owner[r * C + c] === 0) !== (owner[r * C + c + 1] === 0))
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) w0.h[r * C + c] = +((owner[r * C + c] === 0) !== (owner[(r + 1) * C + c] === 0))
  a = B.analyze(pz, w0, none)
  check(a.auto.every((k, j) => (owner[j] === 0) === (k === 0)) && a.errCells.size === 0,
        `#${n} enclose region 0 -> exactly its cells get color 0`)
  a.auto.forEach((k, j) => { if (k >= 0 && k !== owner[j]) check(false, `#${n} auto color differs from solution at ${j}`) })
  // 5. one wrong cell in an otherwise correct paint -> wrong + error flagged somewhere
  const bad = [...owner]
  const i = owner.findIndex((k, j) => j % C + 1 < C && owner[j + 1] !== k)
  bad[i] = owner[i + 1]
  a = B.analyze(pz, B.emptyWalls(R, C), bad)
  check(a.filled && !a.solved && a.errCells.size === 0, `#${n} one wrong cell in open area -> not solved, but no hint shown`)
  // 6. walls inside a dot's core are blocked
  const blocked = B.blockedWalls(R, C, dots)
  const k2 = dots.findIndex(([d0, d1]) => d1 % 2 === 1)
  if (k2 >= 0) {
    const [d0, d1] = dots[k2], r = Math.floor(d0 / 2), cl = (d1 - 1) / 2
    check(blocked.v.has(r * (C - 1) + cl), `#${n} edge dot blocks its edge`)
    check(B.wallAt(R, C, cl + 1, r + 0.5, blocked) === null && B.wallAt(R, C, cl + 1, r + 0.5) !== null, `#${n} wallAt respects blocked`)
  }
  // 7. asymmetric enclosed piece: region 0 plus one extra neighbouring non-core cell
  const coreCells = new Set(dots.flatMap(d => B.core(R, C, d)))
  let x = -1
  for (let j = 0; j < N && x < 0; j++) {
    if (owner[j] !== 0) continue
    for (const y of [j + 1, j - 1, j + C, j - C]) {
      if (y < 0 || y >= N || owner[y] === 0 || coreCells.has(y)) continue
      if ((y === j + 1 && y % C === 0) || (y === j - 1 && j % C === 0)) continue
      x = y; break
    }
  }
  if (x >= 0) {
    const inP = j => owner[j] === 0 || j === x
    const w7 = B.emptyWalls(R, C)
    for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) w7.v[r * (C - 1) + c] = +(inP(r * C + c) !== inP(r * C + c + 1))
    for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) w7.h[r * C + c] = +(inP(r * C + c) !== inP((r + 1) * C + c))
    a = B.analyze(pz, w7, none)
    check(a.auto[x] === 0 && a.errCells.has(x), `#${n} asymmetric piece flagged`)
  }
}
// 8. stray wall inside a region is flagged; solution walls are not
for (const [n, pz] of puzzles.entries()) {
  const { R, C, owner } = pz
  const w = B.emptyWalls(R, C)
  for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) w.v[r * (C - 1) + c] = +(owner[r * C + c] !== owner[r * C + c + 1])
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) w.h[r * C + c] = +(owner[r * C + c] !== owner[(r + 1) * C + c])
  let a = B.analyze(pz, w, Array(R * C).fill(-1))
  check(a.errWalls.v.size + a.errWalls.h.size === 0, `#${n} solution walls not flagged`)
  const idx = w.v.findIndex(x => x === 0)
  if (idx >= 0) {
    w.v[idx] = 1
    a = B.analyze(pz, w, Array(R * C).fill(-1))
    const blockedV = B.blockedWalls(R, C, pz.dots).v
    if (!blockedV.has(idx)) check(a.errWalls.v.has(idx) || a.errCells.size > 0, `#${n} stray wall inside a finished piece flagged (as a stray wall or as a dotless split)`)
  }
}

// 9. hue assignment quality: old greedy vs new swap search
const oldHues = (dots) => {
  const n = dots.length, palette = Array.from({ length: n }, (_, i) => (i * 360) / n)
  const near = dots.map((a, i) => dots.map((b, j) => [j, Math.hypot(a[0] - b[0], a[1] - b[1]) / 2]).filter(([j, d]) => j !== i && d < 4).map(([j]) => j))
  const order = dots.map((_, i) => i).sort((a, b) => near[b].length - near[a].length || a - b)
  const hue = Array(n).fill(null), used = new Set()
  const cd = (x, y) => { const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d) }
  for (const i of order) { let best = null, bs = -1
    for (let p = 0; p < n; p++) { if (used.has(p)) continue
      const hs = near[i].filter(j => hue[j] !== null).map(j => hue[j])
      const sc = hs.length ? Math.min(...hs.map(h => cd(h, palette[p]))) : 360
      if (sc > bs) { bs = sc; best = p } }
    used.add(best); hue[i] = palette[best] }
  return hue
}
// "confusable": dots within 3 cells whose colors share a lightness tier and are < 30 deg apart
const confusable = (dots, col) => {
  let n = 0
  for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
    if (Math.hypot(dots[i][0] - dots[j][0], dots[i][1] - dots[j][1]) / 2 > 3) continue
    const d = Math.abs(col[i].h - col[j].h) % 360
    if (Math.min(d, 360 - d) < 30 && col[i].tier === col[j].tier) n++
  }
  return n
}
let co = 0, cn = 0, xo = 0, xn = 0, t0 = performance.now()
for (const pz of puzzles) {
  const ho = oldHues(pz.dots).map(h => ({ h, tier: 0 })), hn = B.assignHues(pz.dots)
  check(new Set(hn.map(c => c.h)).size === pz.dots.length, 'hues distinct')
  co += B.hueCost(pz.dots, ho); cn += B.hueCost(pz.dots, hn)
  xo += confusable(pz.dots, ho); xn += confusable(pz.dots, hn)
}
const ms = (performance.now() - t0) / puzzles.length
console.log(`colors over ${puzzles.length} puzzles: penalty old ${(co / puzzles.length).toFixed(2)} -> new ${(cn / puzzles.length).toFixed(2)}; ` +
  `confusable close pairs old ${xo} -> new ${xn} (${ms.toFixed(1)} ms/puzzle)`)

// wallAt / dotAt spot checks on a 3x3
check(JSON.stringify(B.wallAt(3, 3, 1.02, 0.5)) === JSON.stringify({ t: 'v', idx: 0 }), 'wallAt vertical')
check(B.wallAt(3, 3, 1.02, 0.1) === null && B.wallAt(3, 3, 1.02, 0.9) === null, 'wallAt ignores edge ends near vertices')
check(JSON.stringify(B.wallAt(3, 3, 2.5, 1.97)) === JSON.stringify({ t: 'h', idx: 3 + 2 }), 'wallAt horizontal')
check(B.wallAt(3, 3, 1.5, 1.5) === null, 'wallAt cell center -> null')
check(B.wallAt(3, 3, 0.02, 1.5) === null, 'wallAt outer border -> null')
check(B.dotAt([[2, 3]], 2.0, 1.5) === 0 && B.dotAt([[2, 3]], 2.5, 1.5) === -1, 'dotAt')
console.log(fails ? `${fails} failures` : `all checks passed on ${puzzles.length} puzzles`)
if (fails) process.exit(1)
