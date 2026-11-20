// Share codes: "version-size-seed", e.g. "1-10-3f2a91c0" (seed in lowercase hex).
// The same code always yields the same puzzle, as long as the generator version matches.

export const MAX_SEED = 2 ** 31 // seeds are drawn from [0, 2^31)

export function formatCode(version, size, seed) {
  return `${version}-${size}-${seed.toString(16)}`
}

/**
 * Parse a code, or a link containing ?p=<code>. Returns
 *   { ok: true, version, size, seed }  or  { ok: false, reason }
 * where reason is 'format' | 'size' | 'version'.
 */
export function parseCode(input, { version, sizes }) {
  let text = String(input ?? '').trim()
  const fromLink = text.match(/[?&]p=([^&#\s]+)/)
  if (fromLink) text = decodeURIComponent(fromLink[1])
  const m = text.toLowerCase().match(/^(\d{1,3})-(\d{1,2})-([0-9a-f]{1,8})$/)
  if (!m) return { ok: false, reason: 'format' }
  const v = Number(m[1]), size = Number(m[2]), seed = parseInt(m[3], 16)
  if (seed >= MAX_SEED) return { ok: false, reason: 'format' }
  if (!sizes.includes(size)) return { ok: false, reason: 'size' }
  if (v !== version) return { ok: false, reason: 'version', version: v }
  return { ok: true, version: v, size, seed }
}

export function shareLink(code, location = window.location) {
  return `${location.origin}${location.pathname}?p=${code}`
}

export const codeError = {
  format: 'That isn’t a puzzle code. Codes look like 2-10-3f2a91c0.',
  size: 'That code is for a board size this page doesn’t offer.',
  version: 'That code comes from a different version of the generator, so it would make a different puzzle.',
}
