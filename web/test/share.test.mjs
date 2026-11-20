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

console.log(fails ? `${fails} failures` : 'share: all checks passed')
if (fails) process.exit(1)
