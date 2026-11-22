// Tests for src/assist.js on puzzles made by ../galaxy.py (test/puzzles.json). Run: npm test
import { readFileSync } from 'node:fs'
import * as B from '../src/board.js'
import * as A from '../src/assist.js'

const puzzles = JSON.parse(readFileSync(new URL('./puzzles.json', import.meta.url), 'utf8'))
let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg) } }

function solutionWalls(R, C, owner) {
  const w = B.emptyWalls(R, C)
  for (let r = 0; r < R; r++) for (let c = 0; c + 1 < C; c++) w.v[r * (C - 1) + c] = +(owner[r * C + c] !== owner[r * C + c + 1])
  for (let r = 0; r + 1 < R; r++) for (let c = 0; c < C; c++) w.h[r * C + c] = +(owner[r * C + c] !== owner[(r + 1) * C + c])
  return w
}
const allWalls = (w) => [...w.v.map((on, idx) => ({ t: 'v', idx, on })), ...w.h.map((on, idx) => ({ t: 'h', idx, on }))]
const count = (w) => w.v.reduce((a, b) => a + b, 0) + w.h.reduce((a, b) => a + b, 0)

let cascades = 0
for (const [n, pz] of puzzles.entries()) {
  const { R, C, owner, dots } = pz, N = R * C
  const blocked = B.blockedWalls(R, C, dots)
  const sol = solutionWalls(R, C, owner)
  const truth = (i) => owner[i]

  // helpers
  check(allWalls(sol).every(({ t, idx }) => {
    const [a, b] = A.wallCells(R, C, t, idx)
    const w = A.wallBetween(R, C, a, b)
    return w.t === t && w.idx === idx
  }), `#${n} wallCells / wallBetween round trip`)
  const co = A.coreOwner(R, C, dots)
  check(co.every((k, i) => k < 0 || owner[i] === k), `#${n} core cells belong to their dot`)

  // 1. drawing any solution wall, with the board fully painted right, only ever adds solution walls
  let sound = true
  for (const s of allWalls(sol).filter(x => x.on)) {
    const w = B.emptyWalls(R, C)
    A.spreadWalls(R, C, dots, w, truth, [s], 1, blocked)
    if (allWalls(w).some(x => x.on && !sol[x.t][x.idx])) sound = false
    if (count(w) > 2) cascades++
  }
  check(sound, `#${n} mirrored walls are all solution walls`)

  // 2. erasing spreads too, and only erases
  const full = { v: [...sol.v], h: [...sol.h] }
  const first = allWalls(sol).find(x => x.on)
  A.spreadWalls(R, C, dots, full, truth, [first], 0, blocked)
  check(count(full) < count(sol) && allWalls(full).every(x => !x.on || sol[x.t][x.idx]), `#${n} erase spreads and only erases`)

  // 3. nothing colored: a wall has no twin
  const w3 = B.emptyWalls(R, C)
  check(!A.spreadWalls(R, C, dots, w3, () => -1, [], 1, blocked) && count(w3) === 0, `#${n} no seeds, no change`)
  A.spreadWalls(R, C, dots, w3, () => -1, [first], 1, blocked)
  check(count(w3) === 1, `#${n} uncolored wall stays single`)

  // 4. auto candidates always keep the answer: empty board, half painted right, region 0 enclosed
  const none = Array(N).fill(-1)
  const keeps = (walls, paint) => {
    const disp = B.analyze(pz, walls, paint).display
    const cands = A.autoCandidates(R, C, dots, walls, disp)
    return cands.every((l, i) => disp[i] >= 0 ? l.length === 0 : l.includes(owner[i]))
  }
  check(keeps(B.emptyWalls(R, C), none), `#${n} candidates on an empty board keep the answer`)
  const half = owner.map((k, i) => (i % 2 ? k : -1))
  check(keeps(B.emptyWalls(R, C), half), `#${n} candidates with half the paint keep the answer`)
  const w0 = B.emptyWalls(R, C)
  for (const x of allWalls(sol)) {
    const [a, b] = A.wallCells(R, C, x.t, x.idx)
    w0[x.t][x.idx] = +((owner[a] === 0) !== (owner[b] === 0))
  }
  check(keeps(w0, none), `#${n} candidates with region 0 enclosed keep the answer`)
  // with every wall drawn, each open cell (none: all auto-colored) has no candidates left
  const solved = A.autoCandidates(R, C, dots, sol, B.analyze(pz, sol, none).display)
  check(solved.every(l => l.length === 0), `#${n} solved board has no candidates`)
}
check(cascades > 0, 'some walls cascade past their first twin')
console.log(fails ? `assist: ${fails} failures` : `assist: all checks passed (${cascades} cascading walls)`)
if (fails) process.exit(1)
