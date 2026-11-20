import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { analyze, assignHues, blockedWalls, emptyWalls, wallAt, dotAt } from './board.js'
import { formatCode, parseCode, shareLink, codeError, MAX_SEED } from './share.js'
import './App.css'

const SIZES = [7, 10, 15]
const MARGIN = 0.45 // room around the board for the chart's tick frame, in cell units
const WALL_WIDTH = 3.5 // px, player walls and the outer frame
const saveKey = (n) => `galaxy_${n}x${n}`
const LAST_SIZE_KEY = 'galaxy_last_size'
/* global __GEN_VERSION__ */
const GEN_VERSION = __GEN_VERSION__ // GENERATOR_VERSION from galaxy.py, injected by vite.config.js
const codeOptions = { version: GEN_VERSION, sizes: SIZES }

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

function requestPuzzle(n, seed = null) {
  return new Promise((resolve, reject) => {
    const id = ++reqId
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, R: n, C: n, seed: seed ?? Math.floor(Math.random() * MAX_SEED) })
  })
}

// A shared link (?p=<code>) is read once at startup, then removed from the address bar so a
// later refresh resumes the saved game instead of re-opening the link.
const LINK = (() => {
  const p = new URLSearchParams(window.location.search).get('p')
  if (p === null) return null
  const url = new URL(window.location.href)
  url.searchParams.delete('p')
  window.history.replaceState(null, '', url)
  return parseCode(p, codeOptions)
})()

const hasProgress = (s) => !!s && (s.walls.v.some(Boolean) || s.walls.h.some(Boolean) || s.paint.some(k => k >= 0))

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

function Board({ puzzle, walls, info, hues, dark, tool, selected, busy, celebrating, covered, svgRef, handlers }) {
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
  const cls = ['board', `tool-${tool}`, busy && 'is-busy', celebrating && 'is-celebrating', covered && 'is-covered']
    .filter(Boolean).join(' ')

  return (
    <svg ref={svgRef} className={cls} viewBox={`${-m} ${-m} ${C + 2 * m} ${R + 2 * m}`}
      role="img" aria-label={covered ? `${R} by ${C} puzzle, hidden until you start`
        : `${R} by ${C} Galaxy puzzle with ${dots.length} centers`}
      {...handlers}>
      <defs>
        <filter id="glow" x="-1" y="-1" width="3" height="3">
          <feGaussianBlur stdDeviation="0.09" />
        </filter>
      </defs>

      <rect x={0} y={0} width={C} height={R} style={{ fill: 'var(--board)' }} />

      {!covered && info.display.map((k, i) => {
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

      {!covered && <g strokeWidth={WALL_WIDTH} strokeLinecap="round">
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
      </g>}

      {/* the outer frame is the outermost wall, so it shares the player's wall weight */}
      <rect x={0} y={0} width={C} height={R} fill="none" style={{ stroke: 'var(--ink)' }}
        strokeWidth={WALL_WIDTH} vectorEffect="non-scaling-stroke" />

      {!covered && [...info.errCells].map(i => (
        <circle key={`e${i}`} cx={(i % C) + 0.82} cy={Math.floor(i / C) + 0.18} r={0.075}
          style={{ fill: 'var(--error)' }} />
      ))}

      {!covered && dots.map(([d0, d1], k) => {
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
  // which game to show: a size, plus a seed when opening a shared code (null = saved or random)
  const [request, setRequest] = useState(() => {
    if (LINK?.ok) return { size: LINK.size, seed: LINK.seed }
    const n = Number(storage.get(LAST_SIZE_KEY))
    return { size: SIZES.includes(n) ? n : 10, seed: null }
  })
  const size = request.size
  const genToken = useRef(0) // only the latest generation request may apply its result
  const [shareOpen, setShareOpen] = useState(() => !!LINK && !LINK.ok)
  const [shareError, setShareError] = useState(() => (LINK && !LINK.ok ? codeError[LINK.reason] : ''))
  const [codeInput, setCodeInput] = useState('')
  const [copied, setCopied] = useState(false)
  const shareRef = useRef(null)
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
  // The board stays covered until Start, and covers again whenever the page is hidden,
  // so nobody studies the puzzle off the clock.
  const [started, setStarted] = useState(false)
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
    setStarted(false)
    setElapsed(el)
    setPuzzle(pz)
    setWalls(w)
    setPaint(p)
    setHistory([])
    setSelected(-1)
  }

  const generate = useCallback(async (n, seed = null) => {
    const token = ++genToken.current
    setBusy(true)
    setError('')
    try {
      const pz = await requestPuzzle(n, seed)
      if (token !== genToken.current) return // superseded by a newer request
      applyPuzzle({ ...pz, v: GEN_VERSION }, emptyWalls(n, n), Array(n * n).fill(-1))
      setWarm(true)
    } catch {
      if (token === genToken.current) setError("Couldn't generate a puzzle. Check your connection, then try again.")
    } finally {
      if (token === genToken.current) setBusy(false)
    }
  }, [])

  // open the requested game: the saved one for this size (if it matches), or generate
  useEffect(() => {
    const { size: n, seed } = request
    storage.set(LAST_SIZE_KEY, String(n))
    const saved = loadSave(n)
    const savedMatches = saved && (seed === null ||
      (saved.puzzle.seed === seed && (saved.puzzle.v ?? 1) === GEN_VERSION))
    if (savedMatches) {
      genToken.current++ // drop any generation still in flight
      setBusy(false)
      applyPuzzle(saved.puzzle, saved.walls, saved.paint, saved.elapsed)
    } else {
      setPuzzle(null)
      generate(n, seed)
    }
    getWorker() // warm Pyodide up even when a saved game was restored
  }, [request, generate])

  // Timer: runs while an unsolved puzzle is on screen and the tab is visible.
  useEffect(() => {
    const onVis = () => {
      setVisible(!document.hidden)
      if (document.hidden) setStarted(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const covered = !!info && !info.solved && !started
  const running = !!info && !info.solved && !busy && visible && started
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
    if (!history.length || covered) return
    const prev = history[history.length - 1]
    setWalls(prev.walls)
    setPaint(prev.paint)
    setHistory(history.slice(0, -1))
  }, [history, covered])

  const handleReset = () => {
    if (!puzzle) return
    setHistory(h => [...h.slice(-199), { walls, paint }])
    setWalls(emptyWalls(puzzle.R, puzzle.C))
    setPaint(Array(puzzle.R * puzzle.C).fill(-1))
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setShareOpen(false); return }
      if (e.target instanceof HTMLInputElement) return // typing a code, not playing
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
    if (!info || info.solved || busy || covered) return
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

  // ---------------------------------------------------------------- sharing
  const code = puzzle && Number.isInteger(puzzle.seed) ? formatCode(puzzle.v ?? 1, puzzle.R, puzzle.seed) : ''
  const link = code ? shareLink(code) : ''

  useEffect(() => {
    if (!shareOpen) return
    const onDown = (e) => { if (shareRef.current && !shareRef.current.contains(e.target)) setShareOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [shareOpen])

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setShareError('Copying isn\u2019t allowed here. Select the link above and copy it.')
    }
  }

  const openCode = (e) => {
    e.preventDefault()
    const p = parseCode(codeInput, codeOptions)
    if (!p.ok) { setShareError(codeError[p.reason]); return }
    const same = puzzle && puzzle.R === p.size && puzzle.seed === p.seed && (puzzle.v ?? 1) === p.version
    if (!same) {
      const saved = loadSave(p.size)
      const unfinished = saved && hasProgress(saved) && !analyze(saved.puzzle, saved.walls, saved.paint).solved
      const differs = saved && !(saved.puzzle.seed === p.seed && (saved.puzzle.v ?? 1) === p.version)
      if (unfinished && differs &&
        !window.confirm(`Opening this code replaces your unfinished ${p.size} \u00d7 ${p.size} puzzle.`)) return
      setRequest({ size: p.size, seed: p.seed })
    }
    setShareError('')
    setCodeInput('')
    setShareOpen(false)
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
              <button key={n} aria-pressed={size === n} onClick={() => setRequest({ size: n, seed: null })}>{n} × {n}</button>
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
            selected={selected} busy={busy} celebrating={celebrating} covered={covered} svgRef={svgRef}
            handlers={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }} />
        ) : (
          <div className="board-empty">
            {error ? (
              <button className="text-button is-primary" onClick={() => generate(size)}>Try again</button>
            ) : 'Preparing the puzzle generator. The first one takes a few seconds.'}
          </div>
        )}
        {covered && (
          <div className="cover">
            <button className="start-button" onClick={() => setStarted(true)} disabled={busy}>
              {elapsed >= 1000 ? 'Resume' : 'Start'}
            </button>
          </div>
        )}
      </div>

      <div className={`status-row${info?.solved && !busy ? ' is-solved' : ''}`} ref={shareRef}>
        <p className="status" role="status">{puzzle ? status : ''}</p>
        <div className="status-meta">
          <button className="code-button" onClick={() => { setShareOpen(o => !o); setShareError('') }}
            aria-expanded={shareOpen} aria-label={code ? `Puzzle code ${code}. Share or open a code` : 'Open a puzzle code'}>
            {code || 'Enter code'}
          </button>
          {puzzle && (
            <span className="timer" aria-label={`Time ${formatTime(elapsed)}`}>{formatTime(elapsed)}</span>
          )}
        </div>

        {shareOpen && (
          <div className="share-panel" role="dialog" aria-label="Share or open a puzzle">
            {link && (
              <div className="share-block">
                <p className="share-label">Anyone with this link gets the same puzzle.</p>
                <div className="share-row">
                  <input className="share-input" readOnly value={link} aria-label="Share link"
                    onFocus={e => e.target.select()} />
                  <button className="text-button is-primary" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
                </div>
              </div>
            )}
            <form className="share-block" onSubmit={openCode}>
              <label className="share-label" htmlFor="code-input">Play a shared puzzle</label>
              <div className="share-row">
                <input id="code-input" className="share-input" value={codeInput} autoComplete="off" spellCheck={false}
                  placeholder="1-10-3f2a91c0 or a link" onChange={e => { setCodeInput(e.target.value); setShareError('') }} />
                <button className="text-button" type="submit" disabled={!codeInput.trim()}>Open</button>
              </div>
            </form>
            {shareError && <p className="share-error" role="alert">{shareError}</p>}
          </div>
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
          <button className="text-button" onClick={handleUndo} disabled={!history.length || covered}>Undo</button>
          <button className="text-button" onClick={handleReset} disabled={!puzzle || busy || covered}>Reset</button>
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
