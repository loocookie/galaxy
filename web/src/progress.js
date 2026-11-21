// Progress in a share link: walls, paint, memos and elapsed time, packed into bits and
// (when the browser can) deflated, then base64url. Decoding needs the puzzle's shape (R, C and
// the number of stars D), which the code in the same link already pins down.
//
// String: one format letter, then base64url bytes. 'a' = raw bits, 'b' = deflate-raw of them.
// Bits: layout version (4), elapsed seconds (24), vertical walls, horizontal walls,
//       paint per cell (b bits, star + 1, 0 = none), memos per cell (count in b bits, then each
//       star in b bits), where b = bit length of D.

const LAYOUT = 1

const bitLength = (n) => Math.max(1, Math.ceil(Math.log2(n + 1)))

function toB64(bytes) {
  let s = ''
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, ch => ch.charCodeAt(0))
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

const canDeflate = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'

export async function encodeProgress({ R, C, D, walls, paint, memo, elapsed }) {
  const bits = []
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1) }
  const b = bitLength(D)
  put(LAYOUT, 4)
  put(Math.min(2 ** 24 - 1, Math.floor(elapsed / 1000)), 24)
  for (const on of walls.v) bits.push(on ? 1 : 0)
  for (const on of walls.h) bits.push(on ? 1 : 0)
  for (let i = 0; i < R * C; i++) put(paint[i] + 1, b)
  for (let i = 0; i < R * C; i++) {
    put(memo[i].length, b)
    for (const k of memo[i]) put(k, b)
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8))
  bits.forEach((bit, i) => { if (bit) bytes[i >> 3] |= 128 >> (i & 7) })
  if (canDeflate()) {
    try { return 'b' + toB64(await pipe(bytes, new CompressionStream('deflate-raw'))) } catch { /* fall through */ }
  }
  return 'a' + toB64(bytes)
}

/** The progress in `text`, or null if it is damaged or doesn't fit this puzzle. */
export async function decodeProgress(text, { R, C, D }) {
  try {
    const fmt = text[0]
    let bytes = fromB64(text.slice(1))
    if (fmt === 'b') {
      if (!canDeflate()) return null
      bytes = await pipe(bytes, new DecompressionStream('deflate-raw'))
    } else if (fmt !== 'a') return null
    let pos = 0
    const total = bytes.length * 8
    const get = (n) => {
      let v = 0
      for (let i = 0; i < n; i++, pos++) {
        if (pos >= total) throw new Error('short')
        v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1)
      }
      return v
    }
    const b = bitLength(D)
    if (get(4) !== LAYOUT) return null
    const elapsed = get(24) * 1000
    const v = Array.from({ length: R * (C - 1) }, () => get(1))
    const h = Array.from({ length: (R - 1) * C }, () => get(1))
    const paint = Array.from({ length: R * C }, () => get(b) - 1)
    if (paint.some(k => k >= D)) return null
    const memo = []
    for (let i = 0; i < R * C; i++) {
      const n = get(b)
      const list = Array.from({ length: n }, () => get(b))
      if (n > D || list.some(k => k >= D) || new Set(list).size !== n) return null
      memo.push(list)
    }
    if (total - pos >= 8) return null // trailing data: not made for this puzzle
    return { walls: { v, h }, paint, memo, elapsed }
  } catch {
    return null
  }
}
