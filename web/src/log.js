// Solve log, for difficulty research: what the player did, and when (game clock).
//
// { v: 1, code, R, C, device: 'touch' | 'mouse', assist: {mirror, cands} at the start, ev: [...] }
// Each event is [t, kind, data], t in tenths of a second of play.
//   open    the board this log starts from (data: a change from an empty board; empty if fresh)
//   line | color | memo | cand    one stroke; data = change, plus what the player touched:
//           uw = wall ids the pointer hit, up = cells the pointer painted (the rest is auto-mirror)
//   undo | reset | auto           data = change (auto: walls auto-mirror drew by itself)
//   assist  data = { mirror, cands } after a switch
//   run | stop    the clock started or stopped (start, resume, tab hidden, solved)
//   solved
// A change: w = wall ids flipped (v walls 0.., then h walls), p = [[cell, color]] painted (-1 =
// erased), m / x = [[cell, list]] new pencil marks / crossed-out candidates.
// Copied as 'glxlog1:' + base64url(deflate-raw(JSON)).

export const LOG_PREFIX = 'glxlog1:'

export const wallId = (R, C, t, idx) => (t === 'v' ? idx : R * (C - 1) + idx)

/** What changed from board a to board b (walls, paint, memo, candOff), or null if nothing. */
export function diffBoards(a, b) {
  const out = {}
  const w = []
  a.walls.v.forEach((x, i) => { if (!x !== !b.walls.v[i]) w.push(i) })
  const nv = a.walls.v.length
  a.walls.h.forEach((x, i) => { if (!x !== !b.walls.h[i]) w.push(nv + i) })
  if (w.length) out.w = w
  const p = []
  a.paint.forEach((k, i) => { if (k !== b.paint[i]) p.push([i, b.paint[i]]) })
  if (p.length) out.p = p
  const lists = (x, y) => {
    const r = []
    x.forEach((l, i) => { if (l.join() !== y[i].join()) r.push([i, y[i]]) })
    return r
  }
  const m = lists(a.memo, b.memo)
  if (m.length) out.m = m
  const xo = lists(a.candOff, b.candOff)
  if (xo.length) out.x = xo
  return Object.keys(out).length ? out : null
}

export function newLog({ code, R, C, assist, board, elapsed }) {
  const empty = {
    walls: { v: Array(R * (C - 1)).fill(0), h: Array((R - 1) * C).fill(0) },
    paint: Array(R * C).fill(-1),
    memo: Array.from({ length: R * C }, () => []),
    candOff: Array.from({ length: R * C }, () => []),
  }
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches
  return {
    v: 1, code, R, C, device: touch ? 'touch' : 'mouse', assist: { ...assist },
    ev: [[Math.round(elapsed / 100), 'open', diffBoards(empty, board) ?? {}]],
  }
}

async function deflate(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw')))
  return new Uint8Array(await out.arrayBuffer())
}

function toB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The log as text to paste: compressed when the browser can, plain JSON otherwise. */
export async function encodeLog(log) {
  const json = JSON.stringify(log)
  if (typeof CompressionStream !== 'function') return json
  return LOG_PREFIX + toB64(await deflate(new TextEncoder().encode(json)))
}
