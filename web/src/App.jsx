import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { analyze, assignHues, blockedWalls, emptyWalls, wallAt, dotAt } from './board.js'
import './App.css'

const SIZES = [7, 10, 15]
const MARGIN = 0.45 // room around the board for the chart's tick frame, in cell units
const WALL_WIDTH = 3.5 // px, player walls and the outer frame
const saveKey = (n) => `galaxy_${n}x${n}`
const LAST_SIZE_KEY = 'galaxy_last_size'

const storage = {
  get(key) { try { return localStorage.getItem(key) } catch { return null } },
  set(key, value) { try { localStorage.setItem(key, value) } catch { /* unavailable */ } },
}

// ---------------------------------------------------------------- generator worker (Pyodide)
let worker = null
let reqId = 0
const pending = new Map()

function getWorker() {
  if (!worker) {
    worker = new Worker(`${import.meta.env.BASE_URL}gen-worker.js`)
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.ok) p.resolve(e.data.puzzle)
      else p.reject(new Error(e.data.error))
    }
    worker.onerror = (e) => {
      pending.forEach(p => p.reject(new Error(e.message || 'worker error')))
      pending.clear()
      worker = null
    }
  }
  return worker
}

function requestPuzzle(n) {
  return new Promise((resolve, reject) => {
    const id = ++reqId
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, R: n, C: n, seed: Math.floor(Math.random() * 2 ** 31) })
  })
}

function loadSave(n) {
  try {
    const s = JSON.parse(storage.get(saveKey(n)))
    if (s?.puzzle?.R === n && s.puzzle.C === n && s.walls && s.paint) {
      return { ...s, elapsed: Number.isFinite(s.elapsed) && s.elapsed > 0 ? s.elapsed : 0 }
    }
  } catch { /* corrupt save */ }
  return null
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  const pad = (v) => String(v).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

// ---------------------------------------------------------------- colors
// OKLCH so equal hue steps look equally different (HSL crowds the greens together).
// dark: opaque, low-chroma tones; a translucent wash over Prussian blue turns warm hues muddy
// Each dot color is { h, tier }: the tier shifts lightness so neighbouring hues stay apart.
const washColor = ({ h, tier }, dark) =>
  dark ? `oklch(${tier ? 0.41 : 0.49} 0.062 ${h})` : `oklch(${tier ? 0.84 : 0.91} 0.075 ${h})`
const starColor = ({ h, tier }, dark) =>
  dark ? `oklch(${tier ? 0.76 : 0.88} 0.13 ${h})` : `oklch(${tier ? 0.48 : 0.6} 0.16 ${h})`

// ---------------------------------------------------------------- board view

function Board({ puzzle, walls, info, hues, dark, tool, selected, busy, celebrating, svgRef, handlers }) {
  const { R, C, dots } = puzzle
  const m = MARGIN
  const ticks = []
  for (let c = 0; c <= C; c++) {
    const len = c % 5 === 0 ? 0.26 : 0.14
    ticks.push([c, -len, c, 0], [c, R, c, R + len])
  }
  for (let r = 0; r <= R; r++) {
    const len = r % 5 === 0 ? 0.26 : 0.14
    ticks.push([-len, r, 0, r], [C, r, C + len, r])
  }
  const cls = ['board', `tool-${tool}`, busy && 'is-busy', celebrating && 'is-celebrating'].filter(Boolean).join(' ')

  return (
    <svg ref={svgRef} className={cls} viewBox={`${-m} ${-m} ${C + 2 * m} ${R + 2 * m}`}
      role="img" aria-label={`${R} by ${C} Galaxy puzzle with ${dots.length} centers`}
      {...handlers}>
      <defs>
        <filter id="glow" x="-1" y="-1" width="3" height="3">
          <feGaussianBlur stdDeviation="0.09" />
        </filter>
      </defs>

      <rect x={0} y={0} width={C} height={R} style={{ fill: 'var(--board)' }} />

      {info.display.map((k, i) => {
        if (k < 0) return null
        const r = Math.floor(i / C), c = i % C
        return (
          <rect key={`w${i}`} className="wash" x={c} y={r} width={1.01} height={1.01}
            style={{ fill: washColor(hues[k], dark), animationDelay: `${(r + c) * 30}ms` }} />
        )
      })}

      <g style={{ stroke: 'var(--graticule)' }} strokeWidth={1} vectorEffect="non-scaling-stroke">
        {Array.from({ length: C - 1 }, (_, c) => (
          <line key={`gv${c}`} x1={c + 1} y1={0} x2={c + 1} y2={R} vectorEffect="non-scaling-stroke" />
        ))}
        {Array.from({ length: R - 1 }, (_, r) => (
          <line key={`gh${r}`} x1={0} y1={r + 1} x2={C} y2={r + 1} vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      <g style={{ stroke: 'var(--ink)' }} strokeWidth={1.25}>
        {ticks.map(([x1, y1, x2, y2], t) => (
          <line key={`t${t}`} x1={x1} y1={y1} x2={x2} y2={y2} vectorEffect="non-scaling-stroke" />
        ))}
      </g>

      <g strokeWidth={WALL_WIDTH} strokeLinecap="round">
        {walls.v.map((on, idx) => {
          if (!on) return null
          const r = Math.floor(idx / (C - 1)), c = idx % (C - 1)
          const bad = info.errWalls.v.has(idx)
          return <line key={`wv${idx}`} x1={c + 1} y1={r} x2={c + 1} y2={r + 1} vectorEffect="non-scaling-stroke"
            style={{ stroke: bad ? 'var(--error)' : 'var(--ink)' }} />
        })}
        {walls.h.map((on, idx) => {
          if (!on) return null
          const r = Math.floor(idx / C), c = idx % C
          const bad = info.errWalls.h.has(idx)
          return <line key={`wh${idx}`} x1={c} y1={r + 1} x2={c + 1} y2={r + 1} vectorEffect="non-scaling-stroke"
            style={{ stroke: bad ? 'var(--error)' : 'var(--ink)' }} />
        })}
      </g>

      {/* the outer frame is the outermost wall, so it shares the player's wall weight */}
      <rect x={0} y={0} width={C} height={R} fill="none" style={{ stroke: 'var(--ink)' }}
        strokeWidth={WALL_WIDTH} vectorEffect="non-scaling-stroke" />

      {[...info.errCells].map(i => (
        <circle key={`e${i}`} cx={(i % C) + 0.82} cy={Math.floor(i / C) + 0.18} r={0.075}
          style={{ fill: 'var(--error)' }} />
      ))}

      {dots.map(([d0, d1], k) => {
        const cx = d1 / 2 + 0.5, cy = d0 / 2 + 0.5
        const isSel = tool === 'color' && k === selected
        const delay = { animationDelay: `${(cx + cy) * 30}ms` }
        return (
          <g key={`s${k}`}>
            {dark && (
              <circle className={`star${isSel ? ' is-selected' : ''}`} cx={cx} cy={cy} r={0.2}
                fill={starColor(hues[k], true)} opacity={0.55} filter="url(#glow)" style={delay} />
            )}
            <circle className={`star${isSel ? ' is-selected' : ''}`} cx={cx} cy={cy} r={0.15}
              fill={starColor(hues[k], dark)} style={{ stroke: 'var(--ink)', ...delay }}
              strokeWidth={isSel ? 2 : 1.25} vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------- app

export default function App() {
  const [theme, setTheme] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const [size, setSize] = useState(() => {
    const n = Number(storage.get(LAST_SIZE_KEY))
    return SIZES.includes(n) ? n : 10
  })
  const [puzzle, setPuzzle] = useState(null)
  const [walls, setWalls] = useState(null)
  const [paint, setPaint] = useState(null)
  const [tool, setTool] = useState('line')
  const [selected, setSelected] = useState(-1)
  const [history, setHistory] = useState([])
  const [busy, setBusy] = useState(false)
  const [warm, setWarm] = useState(false) // generator has answered at least once
  const [celebrating, setCelebrating] = useState(false) // clear animation, only at the moment of solving
  const solvedRef = useRef({ puzzle: null, solved: false })
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0) // ms spent on the current puzzle
  const [visible, setVisible] = useState(() => !document.hidden)
  const svgRef = useRef(null)
  const drag = useRef(null)
  const dark = theme === 'dark'

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  // saved once per second of play at most (elapsedSec), and on every move
  const elapsedSec = Math.floor(elapsed / 1000)
  useEffect(() => {
    if (puzzle && walls && paint) {
      storage.set(saveKey(puzzle.R), JSON.stringify({ puzzle, walls, paint, elapsed: elapsedSec * 1000 }))
    }
  }, [puzzle, walls, paint, elapsedSec])

  const hues = useMemo(() => (puzzle ? assignHues(puzzle.dots) : []), [puzzle])
  const blocked = useMemo(() => (puzzle ? blockedWalls(puzzle.R, puzzle.C, puzzle.dots) : null), [puzzle])
  const info = useMemo(
    () => (puzzle && walls && paint ? analyze(puzzle, walls, paint) : null),
    [puzzle, walls, paint])

  // Play the clear animation once, when an unsolved board becomes solved. Loading a solved
  // save, switching themes or re-rendering must not replay it.
  useEffect(() => {
    const solved = !!info?.solved
    const prev = solvedRef.current
    solvedRef.current = { puzzle, solved }
    if (!solved || prev.puzzle !== puzzle || prev.solved) return
    setCelebrating(true)
    const t = setTimeout(() => setCelebrating(false), 1600)
    return () => clearTimeout(t)
  }, [info, puzzle])

  const applyPuzzle = (pz, w, p, el = 0) => {
    setElapsed(el)
    setPuzzle(pz)
    setWalls(w)
    setPaint(p)
    setHistory([])
    setSelected(-1)
  }

  const generate = useCallback(async (n) => {
    setBusy(true)
    setError('')
    try {
      const pz = await requestPuzzle(n)
      applyPuzzle(pz, emptyWalls(n, n), Array(n * n).fill(-1))
      setWarm(true)
    } catch {
      setError("Couldn't generate a puzzle. Check your connection, then try again.")
    } finally {
      setBusy(false)
    }
  }, [])

  // load (or generate) whenever the size changes
  useEffect(() => {
    storage.set(LAST_SIZE_KEY, String(size))
    const saved = loadSave(size)
    if (saved) applyPuzzle(saved.puzzle, saved.walls, saved.paint, saved.elapsed)
    else { setPuzzle(null); generate(size) }
    getWorker() // warm Pyodide up even when a saved game was restored
  }, [size, generate])

  // Timer: runs while an unsolved puzzle is on screen and the tab is visible.
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const running = !!info && !info.solved && !busy && visible
  useEffect(() => {
    if (!running) return
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const delta = now - last // capture before `last` moves: the updater runs later, at render
      last = now
      setElapsed(e => e + delta)
    }, 250)
    return () => clearInterval(id)
  }, [running])

  const handleUndo = useCallback(() => {
    if (!history.length) return
    const prev = history[history.length - 1]
    setWalls(prev.walls)
    setPaint(prev.paint)
    setHistory(history.slice(0, -1))
  }, [history])

  const handleReset = () => {
    if (!puzzle) return
    setHistory(h => [...h.slice(-199), { walls, paint }])
    setWalls(emptyWalls(puzzle.R, puzzle.C))
    setPaint(Array(puzzle.R * puzzle.C).fill(-1))
  }

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); handleUndo(); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.toLowerCase() === 'l') setTool('line')
      if (e.key.toLowerCase() === 'c') setTool('color')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleUndo])

  // ---------------------------------------------------------------- pointer input
  const toCell = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    const W = puzzle.C + 2 * MARGIN, H = puzzle.R + 2 * MARGIN
    return [((e.clientX - rect.left) / rect.width) * W - MARGIN, ((e.clientY - rect.top) / rect.height) * H - MARGIN]
  }
  const cellAt = (x, y) => {
    const r = Math.floor(y), c = Math.floor(x)
    return r >= 0 && r < puzzle.R && c >= 0 && c < puzzle.C ? r * puzzle.C + c : -1
  }

  const applyAt = (x, y) => {
    const d = drag.current
    if (d.kind === 'line') {
      const w = wallAt(puzzle.R, puzzle.C, x, y, blocked)
      if (!w) return
      const arr = d.work[w.t]
      if (d.value === null) d.value = arr[w.idx] ? 0 : 1
      if (arr[w.idx] !== d.value) { arr[w.idx] = d.value; d.changed = true }
    } else {
      const i = cellAt(x, y)
      if (i < 0) return
      if (d.action === 'erase' && d.work[i] >= 0) { d.work[i] = -1; d.changed = true }
      if (d.action === 'paint' && d.work[i] < 0) { d.work[i] = selected; d.changed = true }
    }
  }

  const flush = () => {
    const d = drag.current
    if (!d.changed) return
    if (d.kind === 'line') setWalls({ v: [...d.work.v], h: [...d.work.h] })
    else setPaint([...d.work])
  }

  const onPointerDown = (e) => {
    if (!info || info.solved || busy) return
    const [x, y] = toCell(e)
    if (tool === 'color') {
      const k = dotAt(puzzle.dots, x, y)
      if (k >= 0) { setSelected(s => (s === k ? -1 : k)); return } // tap the picked star again to drop it
      const i = cellAt(x, y)
      if (i < 0) return
      const action = paint[i] >= 0 ? 'erase' : selected >= 0 ? 'paint' : null
      if (!action) return
      drag.current = { kind: 'color', action, work: [...paint], snap: { walls, paint }, changed: false, last: [x, y] }
    } else {
      drag.current = {
        kind: 'line', value: null, work: { v: [...walls.v], h: [...walls.h] },
        snap: { walls, paint }, changed: false, last: [x, y],
      }
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    applyAt(x, y)
    flush()
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const [x, y] = toCell(e)
    const [lx, ly] = d.last
    const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 0.08))
    for (let s = 1; s <= steps; s++) applyAt(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps)
    d.last = [x, y]
    flush()
  }

  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.changed) setHistory(h => [...h.slice(-199), d.snap])
  }

  // ---------------------------------------------------------------- render
  let status = ''
  if (error) status = error
  else if (busy) status = warm ? `Generating a ${size} × ${size} puzzle…` : 'Preparing the puzzle generator. The first one takes a few seconds.'
  else if (info?.solved) status = 'Solved.'

  return (
    <main className="app">
      <header className="header">
        <h1 className="title">Galaxy</h1>
        <div className="header-controls">
          <div className="segmented" role="group" aria-label="Board size">
            {SIZES.map(n => (
              <button key={n} aria-pressed={size === n} onClick={() => setSize(n)}>{n} × {n}</button>
            ))}
          </div>
          <button className="icon-button" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M12 4 a8 8 0 0 1 0 16 z" fill="currentColor" />
            </svg>
          </button>
        </div>
      </header>

      <div className="board-wrap">
        {puzzle && info ? (
          <Board puzzle={puzzle} walls={walls} info={info} hues={hues} dark={dark} tool={tool}
            selected={selected} busy={busy} celebrating={celebrating} svgRef={svgRef}
            handlers={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }} />
        ) : (
          <div className="board-empty">
            {error ? (
              <button className="text-button is-primary" onClick={() => generate(size)}>Try again</button>
            ) : 'Preparing the puzzle generator. The first one takes a few seconds.'}
          </div>
        )}
      </div>

      <div className={`status-row${info?.solved && !busy ? ' is-solved' : ''}`}>
        <p className="status" role="status">{puzzle ? status : ''}</p>
        {puzzle && (
          <span className="timer" aria-label={`Time ${formatTime(elapsed)}`}>{formatTime(elapsed)}</span>
        )}
      </div>

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Tool">
          <button aria-pressed={tool === 'line'} onClick={() => setTool('line')}>Line</button>
          <button aria-pressed={tool === 'color'} onClick={() => setTool('color')}>
            Color
            <span className="swatch" style={{ background: selected >= 0 && hues[selected] !== undefined ? starColor(hues[selected], dark) : 'transparent' }} />
          </button>
        </div>
        <div className="actions">
          <button className="text-button" onClick={handleUndo} disabled={!history.length}>Undo</button>
          <button className="text-button" onClick={handleReset} disabled={!puzzle || busy}>Reset</button>
          <button className={`text-button${info?.solved ? ' is-primary' : ''}`} onClick={() => generate(size)} disabled={busy}>
            New puzzle
          </button>
        </div>
      </div>

      <p className="hint">
        Draw walls with <kbd>L</kbd>, paint with <kbd>C</kbd>. In paint mode, tap a star to pick its color and tap it again to put it down.
        Undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
      </p>
    </main>
  )
}
