// Classic Web Worker: runs the Python generator (galaxy.py) inside Pyodide.
// Message in : { id, R, C, seed }
// Message out: { id, ok: true, puzzle: { R, C, dots, owner, seed, tries } } | { id, ok: false, error }
importScripts('https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js')

const ready = (async () => {
  const py = await loadPyodide()
  const src = await (await fetch('py/galaxy.py', { cache: 'no-cache' })).text()
  py.FS.writeFile('/home/pyodide/galaxy.py', src)
  py.runPython(`
import sys, json, random
if '/home/pyodide' not in sys.path:
    sys.path.insert(0, '/home/pyodide')
from galaxy import generate_sim, Solver

def make(R, C, seed):
    rng = random.Random(seed)
    tries = 0
    while True:
        tries += 1
        pz = generate_sim(R, C, rng)
        if Solver(R, C, pz.dots).count_solutions(2) == 1:
            return json.dumps({'R': R, 'C': C, 'dots': pz.dots, 'owner': pz.owner,
                               'seed': seed, 'tries': tries})
`)
  return py.globals.get('make')
})()

self.onmessage = async (e) => {
  const { id, R, C, seed } = e.data
  try {
    const make = await ready
    const puzzle = JSON.parse(make(R, C, seed))
    self.postMessage({ id, ok: true, puzzle })
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) })
  }
}
