// Tests for src/share.js. Run: npm test
import { formatCode, parseCode, shareLink, MAX_SEED } from '../src/share.js'

let fails = 0
const check = (cond, msg) => { if (!cond) { fails++; console.log('FAIL', msg) } }
const opts = { version: 1, sizes: [7, 10, 15] }

const code = formatCode(1, 10, 0x3f2a91c0)
check(code === '1-10-3f2a91c0', 'format')
for (const seed of [0, 1, 255, 123456789, MAX_SEED - 1]) {
  const p = parseCode(formatCode(1, 7, seed), opts)
  check(p.ok && p.seed === seed && p.size === 7 && p.version === 1, `round trip seed ${seed}`)
}
check(parseCode('  1-10-3F2A91C0 ', opts).ok, 'trims and ignores case')
const link = shareLink(code, { origin: 'https://loocookie.github.io', pathname: '/galaxy/' })
check(link === 'https://loocookie.github.io/galaxy/?p=1-10-3f2a91c0', 'share link')
check(parseCode(link, opts).seed === 0x3f2a91c0, 'parses a pasted link')
check(parseCode('https://x/galaxy/?a=1&p=1-15-ff#top', opts).size === 15, 'link with other params')
check(parseCode('2-10-abc', opts).reason === 'version', 'version mismatch')
check(parseCode('1-12-abc', opts).reason === 'size', 'unknown size')
check(parseCode('1-10-80000000', opts).reason === 'format', 'seed out of range')
for (const bad of ['', 'hello', '1-10', '1-10-xyz', '1-10-123456789', '1 10 abc']) {
  check(parseCode(bad, opts).reason === 'format', `rejects ${JSON.stringify(bad)}`)
}

// difficulty levels
const lv = { version: 2, sizes: [7, 10, 15], levels: { 7: { n: 1, h: 1 }, 10: { n: 1, h: 1, e: 1 }, 15: { n: 1, h: 1, e: 1 } } }
check(formatCode(2, 15, 0xabc, 'h') === '2-15h-abc', 'format with a level')
check(formatCode(2, 15, 0xabc) === '2-15-abc', 'format without a level')
{
  const p = parseCode('2-15h-abc', lv)
  check(p.ok && p.size === 15 && p.level === 'h' && p.seed === 0xabc, 'parses a level')
  const q = parseCode('2-15-abc', lv)
  check(q.ok && q.level === null, 'a code without a level still opens')
  check(parseCode('2-7e-abc', lv).reason === 'level', 'a level the size lacks')
  check(parseCode('2-10E-ABC', lv).level === 'e', 'level letter ignores case')
  check(parseCode('https://x/galaxy/?p=2-10n-ff&s=abc', lv).level === 'n', 'level in a link')
}

// typed on a phone: Korean layout, odd dashes, spaces, no version
{
  const want = (text, size, level, seed) => {
    const p = parseCode(text, lv)
    check(p.ok && p.size === size && p.level === level && p.seed === seed, `typed ${JSON.stringify(text)} -> ${JSON.stringify(p)}`)
  }
  want('2-15ㅗ-3ㄹ2ㅁ91ㅊ0', 15, 'h', 0x3f2a91c0)       // h f a c in the Korean layout
  want('2-10ㅜ-듇ㅇ', 10, 'n', 0xebed)                  // e b e d typed: ㄷ+ㅠ+ㄷ make one syllable
  want('2－15ｈ－ＡＢＣ', 15, 'h', 0xabc)                 // full-width
  want('2‐15h–abc', 15, 'h', 0xabc)           // hyphen and en dash
  want(' 2 - 7h - ff ', 7, 'h', 0xff)                   // spaces
  want('15e-abc', 15, 'e', 0xabc)                       // no version
  check(parseCode('15e-abc', lv).version === 2, 'no version means this page’s')
  check(parseCode('2-10-abc', lv).ok, 'plain codes still parse')
}

console.log(fails ? `${fails} failures` : 'share: all checks passed')
if (fails) process.exit(1)
