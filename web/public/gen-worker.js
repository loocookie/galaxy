// Classic Web Worker: runs the Python generator (galaxy.py) inside Pyodide.
// Message in : { id, R, C, seed, level }   (level: a code letter of LEVELS in galaxy.py, or null)
// Message out: { id, ok: true, puzzle: { R, C, dots, owner, seed, level, tries } } | { id, ok: false, error }
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js')

const ready = (async () => {
  const py = await loadPyodide()
  const src = await (await fetch('py/galaxy.py', { cache: 'no-cache' })).text()
  py.FS.writeFile('/home/pyodide/galaxy.py', src)
  py.runPython(`
import sys, json
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
from galaxy import make_puzzle

def make(R, C, seed, level):
    pz, tries = make_puzzle(R, seed, level or None)
    return json.dumps({'R': R, 'C': C, 'dots': pz.dots, 'owner': pz.owner,
                       'seed': seed, 'level': level or None, 'tries': tries})
`)
  return py.globals.get('make')
})()

self.onmessage = async (e) => {
  const { id, R, C, seed, level = null } = e.data
  try {
    const make = await ready
    const puzzle = JSON.parse(make(R, C, seed, level))
    self.postMessage({ id, ok: true, puzzle })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
