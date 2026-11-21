// Tests for the line-stroke hit range and the progress codec. Run: npm test
import { wallAt, STROKE_TOL, STROKE_ENDS } from '../src/board.js'
import { encodeProgress, decodeProgress } from '../src/progress.js'
import { parseCode, shareLink } from '../src/share.js'

let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg) } }
const R = 5, C = 5
const key = (w) => `${w.t}${w.idx}`

// the same stroke logic as App.jsx: the first edge with the tap's range, later ones narrower
function drag(points) {
  const walls = { v: Array(R * (C - 1)).fill(0), h: Array((R - 1) * C).fill(0) }
  const seq = []
  const at = (x, y) => {
    const w = seq.length ? wallAt(R, C, x, y, null, STROKE_TOL, STROKE_ENDS) : wallAt(R, C, x, y)
    if (!w) return
    seq.push(w)
    walls[w.t][w.idx] = 1
  }
  let [lx, ly] = points[0]
  at(lx, ly)
  for (const [x, y] of points.slice(1)) {
    const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 0.08))
    for (let i = 1; i <= n; i++) at(lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n)
    ;[lx, ly] = [x, y]
  }
  return [...walls.v.map((on, i) => (on ? 'v' + i : '')), ...walls.h.map((on, i) => (on ? 'h' + i : ''))].filter(Boolean).sort()
}
const hRow = (vy, x0, x1) => Array.from({ length: x1 - x0 }, (_, i) => `h${(vy - 1) * C + x0 + i}`).sort()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check(same(drag([[0.5, 2], [4.5, 2]]), hRow(2, 0, 5)), 'straight line')
// a wobble near a vertex (within STROKE_ENDS of it) catches no perpendicular edge
const wob = drag([[0.5, 2], [1.9, 2], [2.05, 2.28], [2.2, 1.95], [4.5, 2]])
check(same(wob, hRow(2, 0, 5)), `wobble ignored: ${wob}`)
const wobUp = drag([[0.5, 2], [1.95, 2], [2.04, 1.72], [2.3, 2.02], [3.5, 2]])
check(same(wobUp, hRow(2, 0, 4)), `upward wobble ignored: ${wobUp}`)
// a real turn stays: right along y=2 to x=2, then down along x=2
const turn = drag([[0.5, 2], [2, 2], [2, 4.5]])
check(same(turn, ['h5', 'h6', 'v9', 'v13', 'v17'].sort()), `turn kept: ${turn}`)
// a corner that overshoots the vertex a little doesn't catch the next edge along
const over = drag([[0.5, 2], [2.27, 2], [2.1, 2.1], [2, 2.3], [2, 4.5]])
check(same(over, ['h5', 'h6', 'v9', 'v13', 'v17'].sort()), `corner overshoot: ${over}`)
// a straight drag a little off the line still takes every edge
const off = drag([[0.5, 2.15], [4.5, 1.85]])
check(same(off, hRow(2, 0, 5)), `slightly off the line: ${off}`)
// dragging down through the middle of a column crosses stacked horizontal walls
const stack = drag([[1.5, 0.5], [1.5, 4.5]])
check(same(stack, ['h1', 'h6', 'h11', 'h16'].sort()), `stacked: ${stack}`)

// progress codec
const D = 9, N = 15
const rnd = (() => { let s = 7; return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 })()
const walls = { v: Array.from({ length: N * (N - 1) }, () => (rnd() < 0.3 ? 1 : 0)), h: Array.from({ length: (N - 1) * N }, () => (rnd() < 0.3 ? 1 : 0)) }
const paint = Array.from({ length: N * N }, () => (rnd() < 0.5 ? Math.floor(rnd() * D) : -1))
const memo = Array.from({ length: N * N }, () => (rnd() < 0.2 ? [...new Set([Math.floor(rnd() * D), Math.floor(rnd() * D)])] : []))
const enc = await encodeProgress({ R: N, C: N, D, walls, paint, memo, elapsed: 754321 })
const dec = await decodeProgress(enc, { R: N, C: N, D })
check(dec && JSON.stringify(dec.walls) === JSON.stringify(walls) && JSON.stringify(dec.paint) === JSON.stringify(paint) &&
  JSON.stringify(dec.memo) === JSON.stringify(memo) && dec.elapsed === 754000, 'progress round trip')
check(/^[ab][A-Za-z0-9_-]+$/.test(enc), 'url-safe')
const empty = await encodeProgress({ R: N, C: N, D, walls: { v: walls.v.map(() => 0), h: walls.h.map(() => 0) }, paint: paint.map(() => -1), memo: memo.map(() => []), elapsed: 0 })
console.log(`progress: busy 15x15 ${enc.length} chars, empty ${empty.length} chars`)
check(await decodeProgress(enc, { R: 10, C: 10, D }) === null, 'rejects a different shape')
check(await decodeProgress('b' + enc.slice(3), { R: N, C: N, D }) === null, 'rejects damage')
const p = parseCode(shareLink('2-15-ff', { origin: 'https://x', pathname: '/g/' }, enc), { version: 2, sizes: [15] })
check(p.ok && p.state === enc, 'state survives a link')

console.log(fails ? `${fails} failures` : 'stroke+progress: all checks passed')
if (fails) process.exit(1)
