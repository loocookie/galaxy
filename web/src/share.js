// Share codes: "version-size[level]-seed", e.g. "2-10h-3f2a91c0" (seed in lowercase hex).
// The level letter (n / h / e, see LEVELS in galaxy.py) picks the difficulty; codes without
// one (made before levels existed) still open the same puzzle as before.
// The same code always yields the same puzzle, as long as the generator version matches.

export const MAX_SEED = 2 ** 31 // seeds are drawn from [0, 2^31)

// Typed codes come through phone keyboards: a Korean layout turns letters into jamo (h -> ㅗ,
// and b = ㅠ can join a syllable: e b -> 듀), some keyboards give full-width or other dashes.
// Map them back to what the same keys type in the Latin layout (두벌식).
const JAMO = {
  ㄱ: 'r', ㄲ: 'R', ㄳ: 'rt', ㄴ: 's', ㄵ: 'sw', ㄶ: 'sg', ㄷ: 'e', ㄸ: 'E', ㄹ: 'f', ㄺ: 'fr', ㄻ: 'fa',
  ㄼ: 'fq', ㄽ: 'ft', ㄾ: 'fx', ㄿ: 'fv', ㅀ: 'fg', ㅁ: 'a', ㅂ: 'q', ㅃ: 'Q', ㅄ: 'qt', ㅅ: 't', ㅆ: 'T',
  ㅇ: 'd', ㅈ: 'w', ㅉ: 'W', ㅊ: 'c', ㅋ: 'z', ㅌ: 'x', ㅍ: 'v', ㅎ: 'g',
  ㅏ: 'k', ㅐ: 'o', ㅑ: 'i', ㅒ: 'O', ㅓ: 'j', ㅔ: 'p', ㅕ: 'u', ㅖ: 'P', ㅗ: 'h', ㅘ: 'hk', ㅙ: 'ho',
  ㅚ: 'hl', ㅛ: 'y', ㅜ: 'n', ㅝ: 'nj', ㅞ: 'np', ㅟ: 'nl', ㅠ: 'b', ㅡ: 'm', ㅢ: 'ml', ㅣ: 'l',
}
const LEAD = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
const VOWEL = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const TAIL = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ']

export function latinKeys(text) {
  // jamo first: NFKC would turn compatibility jamo (ㅗ) into conjoining ones (ᅩ)
  let out = ''
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0) - 0xac00
    if (code >= 0 && code < 11172) { // a composed syllable: lead + vowel (+ tail)
      const t = code % 28, v = Math.floor(code / 28) % 21, l = Math.floor(code / 588)
      out += JAMO[LEAD[l]] + JAMO[VOWEL[v]] + (t ? JAMO[TAIL[t]] : '')
    } else out += JAMO[ch] ?? ch
  }
  return out.normalize('NFKC').replace(/[‐-―−ー]/g, '-') // hyphen-like marks
}

export function formatCode(version, size, seed, level = null) {
  return `${version}-${size}${level ?? ''}-${seed.toString(16)}`
}

/**
 * Parse a code, or a link containing ?p=<code> (and maybe &s=<progress>). Returns
 *   { ok: true, version, size, level, seed, state }  or  { ok: false, reason }
 * where reason is 'format' | 'size' | 'level' | 'version', level is a letter or null, and
 * state is the raw progress text or null. `levels`: { size: { letter: ... } } when known.
 */
export function parseCode(input, { version, sizes, levels = null }) {
  let text = latinKeys(String(input ?? '')).trim()
  const fromState = text.match(/[?&]s=([A-Za-z0-9_-]+)/)
  const state = fromState ? fromState[1] : null
  const fromLink = text.match(/[?&]p=([^&#\s]+)/)
  if (fromLink) text = decodeURIComponent(fromLink[1])
  text = text.toLowerCase().replace(/\s+/g, '')
  // "2-15h-3f2a91c0", or without the version ("15h-3f2a91c0": this page's version)
  const m = text.match(/^(?:(\d{1,3})-)?(\d{1,2})([a-z]?)-([0-9a-f]{1,8})$/)
  if (!m) return { ok: false, reason: 'format' }
  const v = m[1] === undefined ? version : Number(m[1])
  const size = Number(m[2]), level = m[3] || null, seed = parseInt(m[4], 16)
  if (seed >= MAX_SEED) return { ok: false, reason: 'format' }
  if (m[1] === undefined && !sizes.includes(size)) return { ok: false, reason: 'format' } // "1-10" is no code
  if (!sizes.includes(size)) return { ok: false, reason: 'size' }
  if (v !== version) return { ok: false, reason: 'version', version: v }
  if (level && levels && !levels[size]?.[level]) return { ok: false, reason: 'level' }
  return { ok: true, version: v, size, level, seed, state }
}

export function shareLink(code, location = window.location, state = null) {
  return `${location.origin}${location.pathname}?p=${code}${state ? `&s=${state}` : ''}`
}

export const codeError = {
  format: 'That isn’t a puzzle code. Codes look like 2-10h-3f2a91c0.',
  size: 'That code is for a board size this page doesn’t offer.',
  level: 'That code asks for a difficulty this board size doesn’t offer.',
  version: 'That code comes from a different version of the generator, so it would make a different puzzle.',
  state: 'The progress in that link is damaged, so the puzzle starts fresh.',
}
