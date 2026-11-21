// Tests for strokeEdges and the progress codec. Run: npm test
import { strokeEdges, wallAt } from '../src/board.js'
import { encodeProgress, decodeProgress } from '../src/progress.js'
import { parseCode, shareLink } from '../src/share.js'

let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg) } }
const R = 5, C = 5
const key = (w) => `${w.t}${w.idx}`

function drag(points, blocked = null) {
  const s = {}, got = []
  let [lx, ly] = points[0]
  got.push(...strokeEdges(R, C, s, lx, ly, blocked))
  for (const [x, y] of points.slice(1)) {
    const n = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 0.08))
    for (let i = 1; i <= n; i++) got.push(...strokeEdges(R, C, s, lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n, blocked))
    ;[lx, ly] = [x, y]
  }
  return [...new Set(got.map(key))].sort()
}
const hRow = (vy, x0, x1) => Array.from({ length: x1 - x0 }, (_, i) => `h${(vy - 1) * C + x0 + i}`).sort()

// a straight horizontal stroke along y=2 from x=0.5 to x=4.5
check(JSON.stringify(drag([[0.5, 2], [4.6, 2]])) === JSON.stringify(hRow(2, 0, 5)), 'straight line')
// the same stroke with a wobble across the vertex at (2,2): no vertical edge appears
const wob = drag([[0.5, 2], [1.9, 2], [2.05, 2.4], [2.2, 1.95], [4.6, 2]])
check(JSON.stringify(wob) === JSON.stringify(hRow(2, 0, 5)), `wobble ignored: ${wob}`)
// a deliberate turn: right along y=2 to x=2, then down to y=4
const turn = drag([[0.5, 2], [2, 2], [2, 4]])
check(JSON.stringify(turn) === JSON.stringify(['h5', 'h6', 'v9', 'v13'].sort()), `turn: ${turn}`)
// a tap is just the edge under the pointer
check(JSON.stringify(drag([[1.5, 2]])) === JSON.stringify([key(wallAt(R, C, 1.5, 2))]), 'tap')
// the frame is never a wall, but the stroke can run along it
check(drag([[0, 0.2], [0, 4.8]]).length === 0, 'frame')

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
