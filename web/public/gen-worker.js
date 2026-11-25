// Classic Web Worker: runs the Python generator (galaxy.py) inside Pyodide.
// Message in : { id, R, C, seed, level }   (level: a code letter of LEVELS in galaxy.py, or null)
// Message out: { id, ok: true, puzzle: { R, C, dots, owner, seed, level, tier, tries } } | { id, ok: false, error }
// Or         : { id, tierOf: { R, C, dots } } -> { id, ok: true, puzzle: { tier } }  (galaxy.tier)
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js')

const ready = (async () => {
  const py = await loadPyodide()
  const src = await (await fetch('py/galaxy.py', { cache: 'no-cache' })).text()
  py.FS.writeFile('/home/pyodide/galaxy.py', src)
  py.runPython(`
import sys, json
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
from galaxy import make_puzzle, tier

def make(R, C, seed, level):
    pz, tries = make_puzzle(R, seed, level or None)
    return json.dumps({'R': R, 'C': C, 'dots': pz.dots, 'owner': pz.owner, 'seed': seed,
                       'level': level or None, 'tier': tier(R, C, pz.dots), 'tries': tries})

def tier_of(R, C, dots_json):
    return tier(R, C, [tuple(d) for d in json.loads(dots_json)])
`)
  return { make: py.globals.get('make'), tierOf: py.globals.get('tier_of') }
})()

self.onmessage = async (e) => {
  const { id, R, C, seed, level = null, tierOf = null } = e.data
  try {
    const py = await ready
    if (tierOf) {
      self.postMessage({ id, ok: true, puzzle: { tier: py.tierOf(tierOf.R, tierOf.C, JSON.stringify(tierOf.dots)) } })
      return
    }
    const puzzle = JSON.parse(py.make(R, C, seed, level))
    self.postMessage({ id, ok: true, puzzle })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
