// The board drawing, shared by the game (App.jsx) and the local replay page (replay/).

export const MARGIN = 0.45 // room around the board for the chart's tick frame, in cell units
const WALL_WIDTH = 3.5 // px, player walls and the outer frame

// ---------------------------------------------------------------- colors
// OKLCH so equal hue steps look equally different (HSL crowds the greens together).
// dark: opaque, low-chroma tones; a translucent wash over Prussian blue turns warm hues muddy
// Each dot color is { h, tier }: the tier shifts lightness so neighbouring hues stay apart.
export const washColor = ({ h, tier }, dark) =>
  dark ? `oklch(${tier ? 0.41 : 0.49} 0.062 ${h})` : `oklch(${tier ? 0.84 : 0.91} 0.075 ${h})`
export const starColor = ({ h, tier }, dark) =>
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

export function Board({ puzzle, walls, memo, info, hues, dark, tool, selected, busy, celebrating, covered, svgRef, handlers }) {
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
