import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { analyze, assignHues, blockedWalls, emptyWalls, wallAt, STROKE_TOL, STROKE_ENDS, dotAt, mirror } from './board.js'
import { coreOwner, withCores, spreadWalls, wallsAround, autoCandidates, frameTwins, mirrorFrame, colorBorders } from './assist.js'
import { formatCode, parseCode, shareLink, codeError, MAX_SEED } from './share.js'
import { encodeProgress, decodeProgress } from './progress.js'
import './App.css'

const SIZES = [7, 10, 15]
const MARGIN = 0.45 // room around the board for the chart's tick frame, in cell units
const WALL_WIDTH = 3.5 // px, player walls and the outer frame
const saveKey = (n) => `galaxy_${n}x${n}`
const LAST_SIZE_KEY = 'galaxy_last_size'
const ASSIST_KEY = 'galaxy_assist'
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

// A shared link (?p=<code>, maybe &s=<progress>) is read once at startup, then removed from the
// address bar so a later refresh resumes the saved game instead of re-opening the link.
const LINK = (() => {
  const params = new URLSearchParams(window.location.search)
  const p = params.get('p')
  if (p === null) return null
  const url = new URL(window.location.href)
  url.searchParams.delete('p')
  url.searchParams.delete('s')
  window.history.replaceState(null, '', url)
  const parsed = parseCode(p, codeOptions)
  return parsed.ok ? { ...parsed, state: params.get('s') } : parsed
})()

const hasProgress = (s) => !!s && (s.walls.v.some(Boolean) || s.walls.h.some(Boolean) ||
  s.paint.some(k => k >= 0) || !!s.memo?.some(l => l.length) || !!s.candOff?.some(l => l.length))
const emptyMemo = (n) => Array.from({ length: n }, () => [])
const cellList = (a, n) => (Array.isArray(a) && a.length === n ? a : emptyMemo(n)) // per-cell lists, older saves lack them
// solved, whatever the assist settings: a dot's core cells are always its color
const isSolved = (pz, walls, paint) => analyze(pz, walls, withCores(paint, coreOwner(pz.R, pz.C, pz.dots))).solved

function loadAssist() {
  try {
    const a = JSON.parse(storage.get(ASSIST_KEY))
    return { mirror: !!a?.mirror, cands: !!a?.cands }
  } catch { return { mirror: false, cands: false } }
}

function loadSave(n) {
  try {
    const s = JSON.parse(storage.get(saveKey(n)))
    if (s?.puzzle?.R === n && s.puzzle.C === n && s.walls && s.paint) {
      return { ...s, memo: cellList(s.memo, n * n), candOff: cellList(s.candOff, n * n), elapsed: Number.isFinite(s.elapsed) && s.elapsed > 0 ? s.elapsed : 0 }
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

// Pencil marks in one cell, in the order they were added: m marks sit in rows of k = ceil(sqrt(m)),
// so 1 is a single mark, 2 a pair, 3-4 a square, 5-6 rows of 3, and so on. Cell-relative coordinates.
// A single mark keeps the 2x2 size, so it never reads as a star.
function memoLayout(m) {
  const k = Math.ceil(Math.sqrt(m)), rows = Math.ceil(m / k)
  const pitch = 0.78 / k, r = (0.78 / Math.max(k, 2)) * 0.36
  const out = []
  for (let j = 0; j < rows; j++) {
    const n = Math.min(k, m - j * k)
    const y = 0.5 + (j - (rows - 1) / 2) * pitch
    for (let t = 0; t < n; t++) out.push({ x: 0.5 + (t - (n - 1) / 2) * pitch, y, r })
  }
  return out
}

function Board({ puzzle, walls, memo, info, hues, dark, tool, selected, busy, celebrating, covered, svgRef, handlers }) {
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

      {!covered && memo.map((list, i) => {
        if (!list.length || info.display[i] >= 0) return null // a painted cell hides its marks
        const r = Math.floor(i / C), c = i % C
        // squares, so pencil marks never read as stars (which are circles)
        return memoLayout(list.length).map((p, t) => {
          const s = p.r * 1.8
          return (
            <rect key={`m${i}-${list[t]}`} className="memo" x={c + p.x - s / 2} y={r + p.y - s / 2}
              width={s} height={s} rx={s * 0.12} fill={starColor(hues[list[t]], dark)} />
          )
        })
      })}

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
        const isSel = tool !== 'line' && k === selected
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
  // which game to show: a size, plus a seed when opening a shared code (null = saved or random),
  // plus shared progress to start from. `confirmed`: the player already agreed to lose progress.
  const [request, setRequest] = useState(() => {
    if (LINK?.ok) return { size: LINK.size, seed: LINK.seed, state: LINK.state }
    const n = Number(storage.get(LAST_SIZE_KEY))
    return { size: SIZES.includes(n) ? n : 10, seed: null }
  })
  const size = request.size
  const genToken = useRef(0) // only the latest generation request may apply its result
  const [shareOpen, setShareOpen] = useState(false)
  const [shareError, setShareError] = useState('')
  const [withProgress, setWithProgress] = useState(false)
  const [snap, setSnap] = useState(null) // the progress a share link carries, taken when asked for
  const [progressLink, setProgressLink] = useState('')
  const [copied, setCopied] = useState(false)
  const shareRef = useRef(null)
  const [newOpen, setNewOpen] = useState(() => !!LINK && !LINK.ok)
  const [newError, setNewError] = useState(() => (LINK && !LINK.ok ? codeError[LINK.reason] : ''))
  const [codeInput, setCodeInput] = useState('')
  const newRef = useRef(null)
  const [notice, setNotice] = useState('')
  const [resetArmed, setResetArmed] = useState(false) // Reset asks once: the first press arms it
  const [dragging, setDragging] = useState(false)
  const [puzzle, setPuzzle] = useState(null)
  const [walls, setWalls] = useState(null)
  const [paint, setPaint] = useState(null)
  const [memo, setMemo] = useState(null) // per cell, the star indices pencilled in, oldest first
  const [candOff, setCandOff] = useState(null) // per cell, auto candidates the player crossed out
  const [assist, setAssist] = useState(loadAssist) // { mirror, cands }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef(null)
  const [mode, setMode] = useState('line') // 'line' | 'color'
  const [memoOn, setMemoOn] = useState(false) // within color mode: pencil marks instead of paint
  const tool = mode === 'color' && memoOn ? 'memo' : mode
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
  const pointers = useRef(new Set()) // fingers on the board; a second one means a pinch, not a stroke
  const dark = theme === 'dark'

  useEffect(() => { storage.set(ASSIST_KEY, JSON.stringify(assist)) }, [assist])

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  // saved once per second of play at most (elapsedSec), and on every move
  const elapsedSec = Math.floor(elapsed / 1000)
  useEffect(() => {
    if (puzzle && walls && paint && memo && candOff) {
      storage.set(saveKey(puzzle.R), JSON.stringify({ puzzle, walls, paint, memo, candOff, elapsed: elapsedSec * 1000 }))
    }
  }, [puzzle, walls, paint, memo, candOff, elapsedSec])

  const hues = useMemo(() => (puzzle ? assignHues(puzzle.dots) : []), [puzzle])
  const blocked = useMemo(() => (puzzle ? blockedWalls(puzzle.R, puzzle.C, puzzle.dots) : null), [puzzle])
  const coreOwn = useMemo(() => (puzzle ? coreOwner(puzzle.R, puzzle.C, puzzle.dots) : null), [puzzle])
  // with auto-mirror on, every dot's core cells show its color (derived, never stored)
  const shownPaint = useMemo(
    () => (paint && coreOwn ? (assist.mirror ? withCores(paint, coreOwn) : paint) : null),
    [paint, coreOwn, assist.mirror])
  const info = useMemo(
    () => (puzzle && walls && shownPaint ? analyze(puzzle, walls, shownPaint) : null),
    [puzzle, walls, shownPaint])
  // With auto-mirror on, a fresh board already has walls: borders between star cells and the
  // frame mirrored about them. Those alone are not progress.
  const baseWalls = useMemo(() => {
    if (!assist.mirror || !puzzle) return null
    const w = emptyWalls(puzzle.R, puzzle.C)
    mirrorFrame(puzzle.R, puzzle.C, puzzle.dots, w, j => coreOwn[j], blocked)
    return w
  }, [assist.mirror, puzzle, coreOwn, blocked])
  const cands = useMemo(
    () => (assist.cands && info ? autoCandidates(puzzle.R, puzzle.C, puzzle.dots, walls, info.display) : null),
    [assist.cands, info, puzzle, walls])
  // pencil marks on screen: the player's own, or with auto candidates on, the candidates left
  const shownMemo = useMemo(
    () => (cands && candOff ? cands.map((l, i) => l.filter(k => !candOff[i].includes(k))) : memo),
    [cands, candOff, memo])

  // A stroke is judged when the finger lifts: passing through a solved board mid-drag doesn't
  // count, and the rest of that stroke can't be cut off.
  const solved = !!info?.solved && !dragging

  // Play the clear animation once, when an unsolved board becomes solved. Loading a solved
  // save, switching themes or re-rendering must not replay it.
  useEffect(() => {
    const prev = solvedRef.current
    solvedRef.current = { puzzle, solved }
    if (!solved || prev.puzzle !== puzzle || prev.solved) return
    setCelebrating(true)
    const t = setTimeout(() => setCelebrating(false), 1600)
    return () => clearTimeout(t)
  }, [solved, puzzle])

  const applyPuzzle = (pz, w, p, mm, el = 0, off = null) => {
    setStarted(false)
    setElapsed(el)
    setPuzzle(pz)
    setWalls(w)
    setPaint(p)
    setMemo(mm)
    setCandOff(off ?? emptyMemo(pz.R * pz.C))
    setHistory([])
    setSelected(-1)
  }

  // Start `pz` from shared progress, falling back to `base` (a save, or null for a fresh board).
  const openShared = useCallback(async (pz, base, state, confirmed, token) => {
    const st = await decodeProgress(state, { R: pz.R, C: pz.C, D: pz.dots.length })
    if (token !== genToken.current) return
    const n = pz.R * pz.C
    const fallback = () => (base
      ? applyPuzzle(pz, base.walls, base.paint, base.memo, base.elapsed, base.candOff)
      : applyPuzzle(pz, emptyWalls(pz.R, pz.C), Array(n).fill(-1), emptyMemo(n)))
    if (!st) { fallback(); setNotice(codeError.state); return }
    const unfinished = base && hasProgress(base) && !isSolved(pz, base.walls, base.paint)
    if (unfinished && !confirmed &&
      !window.confirm('This link carries someone’s progress. Opening it replaces yours on this puzzle.')) {
      fallback()
      return
    }
    applyPuzzle(pz, st.walls, st.paint, st.memo, st.elapsed)
  }, [])

  const generate = useCallback(async (n, seed = null, state = null) => {
    const token = ++genToken.current
    setBusy(true)
    setError('')
    try {
      const pz = await requestPuzzle(n, seed)
      if (token !== genToken.current) return // superseded by a newer request
      const pzv = { ...pz, v: GEN_VERSION }
      if (state) await openShared(pzv, null, state, true, token)
      else applyPuzzle(pzv, emptyWalls(n, n), Array(n * n).fill(-1), emptyMemo(n * n))
      setWarm(true)
    } catch {
      if (token === genToken.current) setError("Couldn't generate a puzzle. Check your connection, then try again.")
    } finally {
      if (token === genToken.current) setBusy(false)
    }
  }, [openShared])

  // open the requested game: the saved one for this size (if it matches), or generate
  useEffect(() => {
    const { size: n, seed, state = null, confirmed = false } = request
    storage.set(LAST_SIZE_KEY, String(n))
    setNotice('')
    const saved = loadSave(n)
    const savedMatches = saved && (seed === null ||
      (saved.puzzle.seed === seed && (saved.puzzle.v ?? 1) === GEN_VERSION))
    if (savedMatches) {
      const token = ++genToken.current // drop any generation still in flight
      setBusy(false)
      if (state && seed !== null) openShared(saved.puzzle, saved, state, confirmed, token)
      else applyPuzzle(saved.puzzle, saved.walls, saved.paint, saved.memo, saved.elapsed, saved.candOff)
    } else {
      setPuzzle(null)
      generate(n, seed, seed !== null ? state : null)
    }
    getWorker() // warm Pyodide up even when a saved game was restored
  }, [request, generate, openShared])

  // Timer: runs while an unsolved puzzle is on screen and the tab is visible.
  useEffect(() => {
    const onVis = () => {
      setVisible(!document.hidden)
      if (document.hidden) setStarted(false)
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const covered = !!info && !solved && !started
  const running = !!info && !solved && !busy && visible && started
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

  // a solved board is final: no more drawing, undo or reset
  const handleUndo = useCallback(() => {
    if (!history.length || covered || solved) return
    const prev = history[history.length - 1]
    setWalls(prev.walls)
    setPaint(prev.paint)
    setMemo(prev.memo)
    setCandOff(prev.candOff)
    setHistory(history.slice(0, -1))
  }, [history, covered, solved])

  // From line mode, M (or the button) goes straight to pencilling; within color mode it toggles.
  const toggleMemo = useCallback(() => {
    if (mode === 'line') { setMode('color'); setMemoOn(true) } else setMemoOn(on => !on)
  }, [mode])

  const progress = walls && paint && memo && candOff ? { walls, paint, memo, candOff } : null
  // progress beyond what auto-mirror draws on a fresh board by itself
  const progressed = !!progress && hasProgress(baseWalls ? {
    ...progress,
    walls: { v: walls.v.map((x, i) => x !== baseWalls.v[i]), h: walls.h.map((x, i) => x !== baseWalls.h[i]) },
  } : progress)
  const unfinished = !!puzzle && progressed && !solved

  // Turning auto-mirror on (or opening a puzzle with it on) draws what the colors already give:
  // borders between two colors, and the frame mirrored inside the board, cascading from there.
  const prevMirror = useRef(assist.mirror)
  useEffect(() => {
    const turnedOn = assist.mirror && !prevMirror.current
    prevMirror.current = assist.mirror
    if (!assist.mirror || !puzzle || !walls || !info || solved) return
    const w = { v: [...walls.v], h: [...walls.h] }
    if (!mirrorFrame(puzzle.R, puzzle.C, puzzle.dots, w, j => info.display[j], blocked)) return
    if (turnedOn) setHistory(h => [...h.slice(-199), { walls, paint, memo, candOff }])
    setWalls(w)
  }, [assist.mirror, puzzle]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!resetArmed) return
    const t = setTimeout(() => setResetArmed(false), 3000)
    return () => clearTimeout(t)
  }, [resetArmed])

  const handleReset = () => {
    if (!puzzle || solved) return
    if (progressed && !resetArmed) { setResetArmed(true); return }
    setResetArmed(false)
    setHistory(h => [...h.slice(-199), { walls, paint, memo, candOff }])
    setWalls(baseWalls ? { v: [...baseWalls.v], h: [...baseWalls.h] } : emptyWalls(puzzle.R, puzzle.C))
    setPaint(Array(puzzle.R * puzzle.C).fill(-1))
    setMemo(emptyMemo(puzzle.R * puzzle.C))
    setCandOff(emptyMemo(puzzle.R * puzzle.C))
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { setShareOpen(false); setNewOpen(false); setSettingsOpen(false); return }
      if (e.target instanceof HTMLInputElement) return // typing a code, not playing
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); handleUndo(); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'l') setMode('line')
      if (key === 'c') setMode('color')
      if (key === 'm') toggleMemo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleUndo, toggleMemo])

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

  // the color a cell shows while a stroke is under way (paint from the stroke's own copy)
  const colorAt = (d, j) => {
    if (assist.mirror && coreOwn[j] >= 0) return coreOwn[j]
    if (info.auto[j] >= 0) return info.auto[j]
    return d.kind === 'color' ? d.work[j] : info.display[j]
  }

  const applyAt = (x, y) => {
    const d = drag.current
    const { R, C, dots } = puzzle
    if (d.kind === 'line') {
      // the first edge uses the tap's hit range; later ones need the pointer nearer the middle
      const w = d.value !== null
        ? wallAt(R, C, x, y, blocked, STROKE_TOL, STROKE_ENDS)
        : wallAt(R, C, x, y, blocked)
      if (!w) return
      const arr = d.work[w.t]
      if (d.value === null) d.value = arr[w.idx] ? 0 : 1 // the first edge decides: draw or erase
      if (assist.mirror) {
        // drawing or erasing a wall does the same to its mirror images about the colors it borders
        if (spreadWalls(R, C, dots, d.work, j => colorAt(d, j), [w], d.value, blocked)) d.changed = true
      } else if (arr[w.idx] !== d.value) { arr[w.idx] = d.value; d.changed = true }
    } else if (d.kind === 'memo') {
      const i = cellAt(x, y)
      if (i < 0 || info.display[i] >= 0) return
      const list = d.work[i], has = list.includes(selected)
      if (d.action === 'add' && !has) { d.work[i] = [...list, selected]; d.changed = true }
      if (d.action === 'remove' && has) { d.work[i] = list.filter(k => k !== selected); d.changed = true }
    } else if (d.kind === 'cand') {
      // crossing out an auto candidate, or bringing a crossed-out one back
      const i = cellAt(x, y)
      if (i < 0 || info.display[i] >= 0 || !cands[i].includes(selected)) return
      const list = d.work[i], off = list.includes(selected)
      if (d.action === 'remove' && !off) { d.work[i] = [...list, selected]; d.changed = true }
      if (d.action === 'add' && off) { d.work[i] = list.filter(k => k !== selected); d.changed = true }
    } else {
      const i = cellAt(x, y)
      if (i < 0) return
      if (d.action === 'erase' && d.work[i] >= 0) {
        const k = d.work[i]
        d.work[i] = -1
        d.changed = true
        if (assist.mirror) {
          const m = mirror(R, C, i, dots[k])
          if (m >= 0 && d.work[m] === k) d.work[m] = -1
        }
      }
      if (d.action === 'paint' && d.work[i] < 0) {
        d.work[i] = selected
        d.changed = true
        if (assist.mirror) {
          // paint the mirror cell too, then mirror the walls already drawn around both
          const m = mirror(R, C, i, dots[selected])
          if (m >= 0 && colorAt(d, m) < 0) d.work[m] = selected
          // ...and draw the borders with other colors (then mirror those as well)
          const seeds = [i, m].filter(j => j >= 0).flatMap(j => [
            ...wallsAround(R, C, d.walls, j), ...frameTwins(R, C, dots, j, selected, blocked),
            ...colorBorders(R, C, x => colorAt(d, x), j).filter(w => !blocked[w.t].has(w.idx))])
          if (spreadWalls(R, C, dots, d.walls, j => colorAt(d, j), seeds, 1, blocked)) d.wallsChanged = true
        }
      }
    }
  }

  const flush = () => {
    const d = drag.current
    if (d.wallsChanged) setWalls({ v: [...d.walls.v], h: [...d.walls.h] })
    if (!d.changed) return
    if (d.kind === 'line') setWalls({ v: [...d.work.v], h: [...d.work.h] })
    else if (d.kind === 'memo') setMemo([...d.work])
    else if (d.kind === 'cand') setCandOff([...d.work])
    else setPaint([...d.work])
  }

  // A second finger turns the stroke into a pinch: whatever the first finger drew is taken back.
  const cancelStroke = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (!d || !(d.changed || d.wallsChanged)) return
    setWalls(d.snap.walls)
    setPaint(d.snap.paint)
    setMemo(d.snap.memo)
    setCandOff(d.snap.candOff)
  }

  const onPointerDown = (e) => {
    pointers.current.add(e.pointerId)
    if (pointers.current.size > 1) { cancelStroke(); return }
    if (!info || solved || busy || covered) return
    const [x, y] = toCell(e)
    const snap = { walls, paint, memo, candOff }
    const base = { snap, changed: false, last: [x, y], pointerId: e.pointerId }
    if (tool !== 'line') {
      const k = dotAt(puzzle.dots, x, y)
      if (k >= 0) { setSelected(s => (s === k ? -1 : k)); return } // tap the picked star again to drop it
      const i = cellAt(x, y)
      if (i < 0) return
      if (tool === 'memo') {
        // the first cell decides whether this stroke adds or removes the picked color's mark
        if (selected < 0 || info.display[i] >= 0) return
        if (cands) {
          if (!cands[i].includes(selected)) return
          const action = candOff[i].includes(selected) ? 'add' : 'remove'
          drag.current = { ...base, kind: 'cand', action, work: [...candOff] }
        } else {
          const action = memo[i].includes(selected) ? 'remove' : 'add'
          drag.current = { ...base, kind: 'memo', action, work: [...memo] }
        }
      } else {
        const action = paint[i] >= 0 ? 'erase' : selected >= 0 ? 'paint' : null
        if (!action) return
        drag.current = {
          ...base, kind: 'color', action, work: [...paint],
          walls: { v: [...walls.v], h: [...walls.h] }, wallsChanged: false,
        }
      }
    } else {
      drag.current = { ...base, kind: 'line', value: null, work: { v: [...walls.v], h: [...walls.h] } }
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    applyAt(x, y)
    flush()
  }

  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    const [x, y] = toCell(e)
    const [lx, ly] = d.last
    const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / 0.08))
    for (let s = 1; s <= steps; s++) applyAt(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps)
    d.last = [x, y]
    flush()
  }

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId)
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    drag.current = null
    setDragging(false)
    if (d.changed || d.wallsChanged) setHistory(h => [...h.slice(-199), d.snap])
  }

  // the browser took the touch over (a pinch zoom): drop the stroke
  const onPointerCancel = (e) => {
    pointers.current.delete(e.pointerId)
    cancelStroke()
  }

  // ---------------------------------------------------------------- sharing
  const code = puzzle && Number.isInteger(puzzle.seed) ? formatCode(puzzle.v ?? 1, puzzle.R, puzzle.seed) : ''
  const link = code ? shareLink(code) : ''

  // panels close on a press anywhere outside them
  useEffect(() => {
    if (!shareOpen && !newOpen && !settingsOpen) return
    const onDown = (e) => {
      if (shareRef.current && !shareRef.current.contains(e.target)) setShareOpen(false)
      if (newRef.current && !newRef.current.contains(e.target)) setNewOpen(false)
      if (settingsRef.current && !settingsRef.current.contains(e.target)) setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [shareOpen, newOpen, settingsOpen])

  // "Include my progress": the link carries the board and time as they were when asked for
  const takeSnap = () => setSnap(progress ? { ...progress, elapsed } : null)
  const snapHasProgress = !!snap && (hasProgress(snap) || snap.elapsed >= 1000)
  useEffect(() => {
    setProgressLink('')
    if (!withProgress || !snapHasProgress || !puzzle || !code) return
    let live = true
    encodeProgress({ R: puzzle.R, C: puzzle.C, D: puzzle.dots.length, ...snap })
      .then(s => { if (live) setProgressLink(shareLink(code, window.location, s)) })
    return () => { live = false }
  }, [withProgress, snap, snapHasProgress, puzzle, code])
  const shownLink = withProgress && snapHasProgress ? progressLink : link

  const toggleShare = () => {
    if (!shareOpen) takeSnap()
    setShareOpen(!shareOpen)
    setShareError('')
    setCopied(false)
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shownLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setShareError('Copying isn\u2019t allowed here. Select the link above and copy it.')
    }
  }

  const startRandom = () => {
    setNewOpen(false)
    generate(size)
  }

  const openCode = (e) => {
    e.preventDefault()
    const p = parseCode(codeInput, codeOptions)
    if (!p.ok) { setNewError(codeError[p.reason]); return }
    const same = puzzle && puzzle.R === p.size && puzzle.seed === p.seed && (puzzle.v ?? 1) === p.version
    if (!same || p.state) {
      // the same size replaces the board on screen, which the menu already warns about
      if (p.size !== size) {
        const saved = loadSave(p.size)
        const savedUnfinished = saved && hasProgress(saved) && !isSolved(saved.puzzle, saved.walls, saved.paint)
        const differs = saved && !(saved.puzzle.seed === p.seed && (saved.puzzle.v ?? 1) === p.version)
        if (savedUnfinished && (differs || p.state) &&
          !window.confirm(`Opening this code replaces your unfinished ${p.size} \u00d7 ${p.size} puzzle.`)) return
      }
      setRequest({ size: p.size, seed: p.seed, state: p.state, confirmed: true })
    }
    setNewError('')
    setCodeInput('')
    setNewOpen(false)
  }

  // ---------------------------------------------------------------- render
  let status = ''
  if (error) status = error
  else if (busy) status = warm ? `Generating a ${size} × ${size} puzzle…` : 'Preparing the puzzle generator. The first one takes a few seconds.'
  else if (solved) status = 'Solved.'
  else if (notice) status = notice

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
          <div className="settings-wrap" ref={settingsRef}>
            <button className="icon-button" onClick={() => setSettingsOpen(o => !o)} aria-expanded={settingsOpen}
              aria-label="Assists">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round">
                <path d="M4 7 h9 M17 7 h3 M4 17 h3 M11 17 h9" />
                <circle cx="15" cy="7" r="2" />
                <circle cx="9" cy="17" r="2" />
              </svg>
            </button>
            {settingsOpen && (
              <div className="share-panel settings-panel" role="dialog" aria-label="Assists">
                <label className="share-check assist-option">
                  <input type="checkbox" checked={assist.mirror}
                    onChange={e => setAssist(a => ({ ...a, mirror: e.target.checked }))} />
                  <span>
                    <strong>Auto mirror</strong>
                    <span className="share-label">Star cells take their color. Painting or erasing a cell does
                      the same to its mirror, and walls around a color are mirrored too.</span>
                  </span>
                </label>
                <label className="share-check assist-option">
                  <input type="checkbox" checked={assist.cands}
                    onChange={e => setAssist(a => ({ ...a, cands: e.target.checked }))} />
                  <span>
                    <strong>Auto candidates</strong>
                    <span className="share-label">Memos show every color a cell can still take, kept up to date.
                      With Memo on, tap one to cross it out.</span>
                  </span>
                </label>
              </div>
            )}
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
        {puzzle && info && shownMemo ? (
          <Board puzzle={puzzle} walls={walls} memo={shownMemo} info={info} hues={hues} dark={dark} tool={tool}
            selected={selected} busy={busy} celebrating={celebrating} covered={covered} svgRef={svgRef}
            handlers={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel }} />
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

      <div className={`status-row${solved && !busy ? ' is-solved' : ''}`} ref={shareRef}>
        <p className="status" role="status">{puzzle ? status : ''}</p>
        <div className="status-meta">
          {code && (
            <button className="code-button" onClick={toggleShare}
              aria-expanded={shareOpen} aria-label={`Puzzle code ${code}. Share this puzzle`}>
              {code}
            </button>
          )}
          {puzzle && (
            <span className="timer" aria-label={`Time ${formatTime(elapsed)}`}>{formatTime(elapsed)}</span>
          )}
        </div>

        {shareOpen && link && (
          <div className="share-panel" role="dialog" aria-label="Share this puzzle">
            <div className="share-block">
              <p className="share-label">
                {withProgress && snapHasProgress
                  ? 'Anyone with this link picks up where you are, clock included.'
                  : 'Anyone with this link gets the same puzzle.'}
              </p>
              <div className="share-row">
                <input className="share-input" readOnly value={shownLink} aria-label="Share link"
                  onFocus={e => e.target.select()} />
                <button className="text-button is-primary" onClick={copyLink} disabled={!shownLink}>
                  {copied ? 'Copied' : 'Copy link'}
                </button>
              </div>
              <label className={`share-check${snapHasProgress ? '' : ' is-disabled'}`}>
                <input type="checkbox" checked={withProgress && snapHasProgress} disabled={!snapHasProgress}
                  onChange={e => { setWithProgress(e.target.checked); takeSnap(); setCopied(false) }} />
                Include my progress{snapHasProgress ? ` at ${formatTime(snap.elapsed)}` : ''}
              </label>
            </div>
            {shareError && <p className="share-error" role="alert">{shareError}</p>}
          </div>
        )}
      </div>

      <div className="toolbar">
        <div className="tool-group">
          <div className="segmented" role="group" aria-label="Tool">
            <button aria-pressed={mode === 'line'} onClick={() => setMode('line')}>Line</button>
            <button aria-pressed={mode === 'color'} onClick={() => setMode('color')}>
              Color
              <span className="swatch" style={{ background: selected >= 0 && hues[selected] !== undefined ? starColor(hues[selected], dark) : 'transparent' }} />
            </button>
          </div>
          {/* only meaningful in color mode; hidden, not removed, so the row never shifts under a thumb */}
          <button className={`memo-toggle${mode === 'color' ? '' : ' is-hidden'}`} aria-pressed={memoOn}
            onClick={toggleMemo} tabIndex={mode === 'color' ? 0 : -1} aria-hidden={mode !== 'color'}
            title="Pencil marks (M)">
            <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 20 l1.2-4.6 L15.6 5 a2.1 2.1 0 0 1 3 0 l0.4 0.4 a2.1 2.1 0 0 1 0 3 L8.6 18.8 Z"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            Memo
          </button>
        </div>
        <div className="actions">
          <button className="text-button" onClick={handleUndo} disabled={!history.length || covered || solved}>Undo</button>
          <button className={`text-button${resetArmed ? ' is-armed' : ''}`} onClick={handleReset}
            disabled={!puzzle || busy || covered || solved}
            aria-label={resetArmed ? 'Press again to clear the board' : 'Reset'}>
            {/* both labels share one grid cell, so the button keeps the wider one's width */}
            <span className="label-stack">
              <span aria-hidden={resetArmed}>Reset</span>
              <span aria-hidden={!resetArmed}>Reset?</span>
            </span>
          </button>
          <div className="new-wrap" ref={newRef}>
            <button className={`text-button${solved ? ' is-primary' : ''}`} aria-expanded={newOpen}
              onClick={() => { setNewOpen(o => !o); setNewError('') }}>
              New puzzle
            </button>
            {newOpen && (
              <div className="share-panel new-panel" role="dialog" aria-label="Start a new puzzle">
                <div className="share-block">
                  <button className="text-button is-primary" onClick={startRandom} disabled={busy}>
                    Random {size} × {size} puzzle
                  </button>
                  {unfinished && <p className="share-label">This puzzle isn’t solved yet. Starting another one replaces it.</p>}
                </div>
                <form className="share-block" onSubmit={openCode}>
                  <label className="share-label" htmlFor="code-input">Or play a shared code</label>
                  <div className="share-row">
                    <input id="code-input" className="share-input" value={codeInput} autoComplete="off" spellCheck={false}
                      placeholder="2-10-3f2a91c0 or a link" onChange={e => { setCodeInput(e.target.value); setNewError('') }} />
                    <button className="text-button" type="submit" disabled={!codeInput.trim()}>Open</button>
                  </div>
                </form>
                {newError && <p className="share-error" role="alert">{newError}</p>}
              </div>
            )}
          </div>
        </div>
      </div>

      <p className="hint">
        Draw walls with <kbd>L</kbd>, paint with <kbd>C</kbd>, pencil in candidates with <kbd>M</kbd>.
        In color mode, tap a star to pick its color and tap it again to put it down.
        Undo with <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
      </p>
    </main>
  )
}
