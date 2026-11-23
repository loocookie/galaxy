// Local replay of a solve log, with the solver's view of each paint stroke.
// Data: `python logtool.py replay data/logs/*.json` writes web/replays/*.json (not in git).
// Open with `npm run dev`, then /replay.html. The production build leaves this page out.
import { useState, useEffect, useMemo, useCallback } from 'react'
import { analyze, assignHues } from '../board.js'
import { coreOwner, withCores } from '../assist.js'
import { Board, MARGIN, washColor, starColor } from '../BoardView.jsx'

const FILES = import.meta.glob('../../replays/*.json')
const NAMES = Object.keys(FILES).sort()
const label = (path) => path.split('/').pop().replace(/\.json$/, '')

const clock = (t10) => {
  const s = Math.floor(t10 / 10)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const KIND = {
  open: 'start (the board the log began with)', line: 'line', color: 'paint', memo: 'pencil mark',
  cand: 'candidate crossed out / back', undo: 'undo', reset: 'reset', auto: 'auto-mirror frame',
  assist: 'assists changed', run: 'clock started', stop: 'clock stopped', solved: 'solved', other: 'change',
}
const VERDICT = {
  basic: 'basic deduction',
  trial: 'the solver needed trials here',
  wrong: 'wrong color',
  stuck: 'the solver could not settle this',
}
const flagged = (s) => s && s.cells.some(c => c.verdict !== 'basic')
// a link can open a place: ?log=<part of the file name>&at=<event>&try=<cell>:<color>, or ?note=<question id>
const PARAMS = new URLSearchParams(window.location.search)
const START = {
  name: NAMES.find(n => PARAMS.get('log') && n.includes(PARAMS.get('log'))) ?? NAMES[0] ?? null,
  note: PARAMS.get('note'),
  at: Number(PARAMS.get('at')) || 0,
  focus: PARAMS.get('try')?.split(':').map(Number) ?? null,
}

/** Board, paint and auto-mirror state before each event: states[i] is the board event i starts from. */
function replayStates(data) {
  const { R, C, ev } = data
  const nv = R * (C - 1)
  let v = Array(nv).fill(0), h = Array((R - 1) * C).fill(0), paint = Array(R * C).fill(-1)
  let mirror = !!data.assist?.mirror
  const out = []
  for (const [, kind, d] of ev) {
    out.push({ walls: { v, h }, paint, mirror })
    if (kind === 'assist') mirror = !!d?.mirror
    if (d && (d.w || d.p)) {
      v = [...v]; h = [...h]; paint = [...paint]
      for (const id of d.w ?? []) {
        if (id < nv) v[id] ^= 1
        else h[id - nv] ^= 1
      }
      for (const [cell, k] of d.p ?? []) paint[cell] = k
    }
  }
  out.push({ walls: { v, h }, paint, mirror })
  return out
}

function Overlay({ data, stroke, focus, chainLen, showBasic, hues, dark }) {
  const { R, C, dots } = data
  const m = MARGIN
  const cellRect = (i, props) => (
    <rect x={i % C + 0.06} y={Math.floor(i / C) + 0.06} width={0.88} height={0.88} {...props} />
  )
  const chain = focus && stroke?.cells.find(c => c.cell === focus.cell)?.chains?.[focus.color]
  const steps = chain ? chain.steps.slice(0, chainLen) : []
  const item = focus && stroke?.cells.find(c => c.cell === focus.cell)
  return (
    <svg className="replay-overlay" viewBox={`${-m} ${-m} ${C + 2 * m} ${R + 2 * m}`} aria-hidden="true">
      {showBasic && stroke?.basic.map(i => cellRect(i, {
        key: `b${i}`, fill: washColor(hues[data.owner[i]], dark), opacity: 0.55,
        style: { stroke: 'var(--ink-soft)' }, strokeDasharray: '0.08 0.08', strokeWidth: 0.03,
      }))}
      {steps.flatMap(([a, b, k], n) => (a === b ? [a] : [a, b]).map(i => (
        <g key={`c${n}-${i}`}>
          {cellRect(i, { fill: washColor(hues[k], dark), opacity: 0.92, style: { stroke: starColor(hues[k], dark) }, strokeWidth: 0.05 })}
          <text x={i % C + 0.5} y={Math.floor(i / C) + 0.62} className="replay-step">{n + 1}</text>
        </g>
      )))}
      {chain && chainLen >= chain.steps.length && chain.at >= 0 && (
        <g className="replay-contra">
          <circle cx={chain.at % C + 0.5} cy={Math.floor(chain.at / C) + 0.5} r={0.42} />
          <text x={chain.at % C + 0.5} y={Math.floor(chain.at / C) + 0.64}>✕</text>
        </g>
      )}
      {item?.open?.map(k => {
        const [d0, d1] = dots[k]
        return <circle key={`o${k}`} className={`replay-open${k === focus.color ? ' is-focus' : ''}`}
          cx={d1 / 2 + 0.5} cy={d0 / 2 + 0.5} r={0.32} style={{ stroke: starColor(hues[k], dark) }} />
      })}
      {stroke?.cells.map(c => cellRect(c.cell, {
        key: `s${c.cell}`, fill: 'none', className: `replay-target is-${c.verdict}`,
      }))}
    </svg>
  )
}

export default function Replay() {
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light' }, [dark])
  const [name, setName] = useState(START.name)
  const [data, setData] = useState(null)
  const [pos, setPos] = useState(0)
  const [focus, setFocus] = useState(null) // { cell, color }: the trial shown on the board
  const [chainLen, setChainLen] = useState(0)
  const [showBasic, setShowBasic] = useState(false)

  // go to event `at`, showing the trial of color `tr[1]` on cell `tr[0]` when there is one
  const place = (d, at, tr) => {
    setPos(at)
    const [cell, color] = tr ?? []
    const ch = d.strokes[at]?.cells.find(c => c.cell === cell)?.chains?.[color]
    setFocus(ch ? { cell, color } : null)
    setChainLen(ch ? ch.steps.length : 0)
  }

  useEffect(() => {
    if (!name) return
    let live = true
    FILES[name]().then(mod => {
      if (!live) return
      const d = mod.default
      setData(d)
      const first = name === START.name
      const note = first && (d.notes ?? []).find(n => n.id === START.note)
      if (note) { place(d, note.at, note.try); return }
      place(d, first ? Math.min(START.at, d.ev.length) : 0, first ? START.focus : null)
    })
    return () => { live = false }
  }, [name])

  const states = useMemo(() => (data ? replayStates(data) : []), [data])
  const puzzle = useMemo(() => data && { R: data.R, C: data.C, dots: data.dots, owner: data.owner }, [data])
  const hues = useMemo(() => (data ? assignHues(data.dots) : []), [data])
  const cores = useMemo(() => (data ? coreOwner(data.R, data.C, data.dots) : null), [data])
  const flaggedAt = useMemo(() => (data ? data.ev.map((_, i) => i).filter(i => flagged(data.strokes[i])) : []), [data])

  const last = data ? data.ev.length : 0
  const go = useCallback((p) => { setPos(Math.max(0, Math.min(last, p))); setFocus(null) }, [last])
  const nextFlag = (dir) => {
    const list = dir > 0 ? flaggedAt.filter(i => i > pos) : flaggedAt.filter(i => i < pos).reverse()
    if (list.length) go(list[0])
  }
  const notes = data?.notes ?? []
  const nextNote = (dir) => {
    const list = dir > 0 ? notes.filter(n => n.at > pos) : notes.filter(n => n.at < pos).reverse()
    if (list.length) place(data, list[0].at, list[0].try)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return
      if (e.key === 'ArrowRight') go(pos + 1)
      if (e.key === 'ArrowLeft') go(pos - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pos, go])

  if (!NAMES.length) {
    return <main className="replay"><p>No replay data. Run <code>python logtool.py replay data/logs/*.json</code> in the project folder, then reload.</p></main>
  }
  if (!data || !states.length) return <main className="replay"><p>Loading…</p></main>

  const st = states[pos]
  const shown = st.mirror ? withCores(st.paint, cores) : st.paint
  const info = analyze(puzzle, st.walls, shown)
  const event = data.ev[pos]
  const stroke = data.strokes[pos]
  const memo = Array.from({ length: data.R * data.C }, () => [])
  const rc = (i) => `(${Math.floor(i / data.C) + 1},${i % data.C + 1})`
  const swatch = (k) => <span className="swatch" style={{ background: starColor(hues[k], dark) }} />
  const pick = (cell, color) => {
    const ch = stroke.cells.find(c => c.cell === cell).chains[color]
    setFocus({ cell, color })
    setChainLen(ch.steps.length)
  }
  const fchain = focus && stroke?.cells.find(c => c.cell === focus.cell)?.chains?.[focus.color]

  return (
    <main className="replay">
      <header className="replay-head">
        <select value={name} onChange={e => setName(e.target.value)}>
          {NAMES.map(n => <option key={n} value={n}>{label(n)}</option>)}
        </select>
        <span className="replay-meta">{data.R}×{data.C} · assists at start: mirror {data.assist?.mirror ? 'on' : 'off'}, candidates {data.assist?.cands ? 'on' : 'off'}</span>
        <button className="text-button" onClick={() => setDark(d => !d)}>{dark ? 'Light' : 'Dark'}</button>
      </header>

      <div className="replay-body">
        <div className="board-wrap replay-board">
          <Board puzzle={puzzle} walls={st.walls} memo={memo} info={info} hues={hues} dark={dark}
            tool="line" selected={-1} busy={false} celebrating={false} covered={false} handlers={{}} />
          <Overlay data={data} stroke={stroke} focus={focus} chainLen={chainLen} showBasic={showBasic} hues={hues} dark={dark} />
        </div>

        <section className="replay-side">
          <div className="replay-nav">
            <button className="text-button" onClick={() => go(0)} aria-label="First">⏮</button>
            <button className="text-button" onClick={() => go(pos - 1)} aria-label="Previous">◀</button>
            <button className="text-button" onClick={() => go(pos + 1)} aria-label="Next">▶</button>
            <button className="text-button" onClick={() => go(last)} aria-label="Last">⏭</button>
            <span className="replay-sep" />
            <button className="text-button" onClick={() => nextFlag(-1)}>◀ flagged</button>
            <button className="text-button" onClick={() => nextFlag(1)}>flagged ▶</button>
            {notes.length > 0 && <>
              <button className="text-button" onClick={() => nextNote(-1)}>◀ question</button>
              <button className="text-button" onClick={() => nextNote(1)}>question ▶</button>
            </>}
          </div>
          <input type="range" min={0} max={last} value={pos} onChange={e => go(Number(e.target.value))} className="replay-slider" />
          <p className="replay-where">
            event {pos} / {last}
            {event ? <> · <b>{clock(event[0])}</b> · next: {KIND[event[1]] ?? event[1]}</> : ' · end'}
            {stroke && <> · waited {Math.round(stroke.gap / 10)}s</>}
          </p>
          <p className="replay-hint">The board is shown just before the event; outlined cells are the ones it paints. ← → step.</p>

          {notes.filter(n => n.at === pos).map(n => (
            <div key={n.id} className="replay-note">
              <div className="replay-note-id">{n.id}</div>
              <p>{n.text}</p>
              {n.answer && <p className="replay-note-answer">{n.answer}</p>}
            </div>
          ))}

          {stroke && (
            <ul className="replay-cells">
              {stroke.cells.map(c => (
                <li key={c.cell} className={`is-${c.verdict}`}>
                  <div>
                    {rc(c.cell)} → {swatch(c.color)} <b>{VERDICT[c.verdict]}</b>
                    {c.verdict === 'wrong' && <> (answer {swatch(c.answer)}){!c.open.includes(c.color) && ' — basic deduction had already ruled this color out'}</>}
                    {c.depths && <> — {c.depths.length} trial{c.depths.length > 1 ? 's' : ''}, depths {c.depths.join(', ')}</>}
                  </div>
                  {c.open && (
                    <div className="replay-open-list">
                      Colors basic deduction leaves open here:
                      {c.open.map(k => k === c.answer
                        ? <span key={k} className="replay-chip is-answer">{swatch(k)} answer</span>
                        : <button key={k} className={`replay-chip${focus?.cell === c.cell && focus.color === k ? ' is-on' : ''}`}
                          onClick={() => pick(c.cell, k)}>{swatch(k)} try it</button>)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {fchain && (
            <div className="replay-chain">
              <p>
                Trying {swatch(focus.color)} on {rc(focus.cell)}: the solver makes {fchain.steps.length} placements
                {fchain.end === 'contra' && <>, then {rc(fchain.at)} has no color left (✕).</>}
                {fchain.end === 'stuck' && <> and stops without a contradiction: from this board, this color is only ruled out after trials elsewhere.</>}
                {fchain.end === 'solved' && <> and fills the board (should not happen for a wrong color).</>}
              </p>
              <input type="range" min={0} max={fchain.steps.length} value={chainLen}
                onChange={e => setChainLen(Number(e.target.value))} className="replay-slider" />
              <p className="replay-hint">Numbers: order of placement (a cell and its mirror share one). Drag to follow it step by step.</p>
            </div>
          )}

          <label className="replay-check">
            <input type="checkbox" checked={showBasic} onChange={e => setShowBasic(e.target.checked)} />
            Show cells basic deduction settles on this board (not yet on the player's)
          </label>
          {notes.length > 0 && (
            <div className="replay-note-list">
              <h3>Questions</h3>
              {notes.map(n => (
                <button key={n.id} className={`replay-chip${n.at === pos ? ' is-on' : ''}${n.answer ? ' is-answered' : ''}`}
                  onClick={() => place(data, n.at, n.try)}>
                  {n.id} · {clock(data.ev[n.at][0])}{n.answer ? ' ✓' : ''}
                </button>
              ))}
            </div>
          )}
          <p className="replay-hint">Flagged strokes: {flaggedAt.length}. Settled for the player = painted right, a dot's own cells, or a region closed off by walls.</p>
        </section>
      </div>
    </main>
  )
}
