"""Solve logs from the web game ("Copy solve log"), for difficulty research.

    python logtool.py add LOGFILE [--who NAME]   decode, store under data/logs/, print a summary
    python logtool.py show data/logs/X.json      summary of a stored log
    python logtool.py moves data/logs/X.json     strokes the solver would have needed trials for
    python logtool.py seen data/logs/X.json      wait before strokes vs. how open the cell looked

A log is 'glxlog1:' + base64url(deflate-raw(JSON)); the format is described in web/src/log.js.
The summary replays the log against the puzzle (regenerated from its code) and reports the
clock, the moves, the long pauses before moves, and the mistakes: walls or paint the player
put down that the answer doesn't have, and how long they stayed.
"""
import argparse
import base64
import datetime as dt
import json
import random
import sys
import zlib
from pathlib import Path

from galaxy import GENERATOR_VERSION, Board, Solver, generate_sim

LOG_DIR = Path(__file__).parent / 'data' / 'logs'


def decode(text: str) -> dict:
    text = text.strip()
    if text.startswith('glxlog1:'):
        raw = text[len('glxlog1:'):]
        raw += '=' * (-len(raw) % 4)
        return json.loads(zlib.decompress(base64.urlsafe_b64decode(raw), wbits=-15))
    return json.loads(text)


def puzzle_for(code: str):
    """The puzzle a share code stands for, made exactly as the web worker makes it."""
    version, size, seed = code.split('-')
    if int(version) != GENERATOR_VERSION:
        raise SystemExit(f'log is from generator version {version}, this galaxy.py is {GENERATOR_VERSION}')
    n, rng = int(size), random.Random(int(seed, 16))
    while True:
        pz = generate_sim(n, n, rng)
        if Solver(n, n, pz.dots).count_solutions(2) == 1:
            return pz


def solution_walls(R, C, owner):
    v = [int(owner[r * C + c] != owner[r * C + c + 1]) for r in range(R) for c in range(C - 1)]
    h = [int(owner[r * C + c] != owner[(r + 1) * C + c]) for r in range(R - 1) for c in range(C)]
    return v + h  # wall ids: v walls first, then h walls (log.js wallId)


def fmt(t10: int) -> str:
    s = t10 // 10
    return f'{s // 60}:{s % 60:02d}'


def summary(log: dict) -> str:
    R, C = log['R'], log['C']
    pz = puzzle_for(log['code'])
    sol = solution_walls(R, C, pz.owner)
    # a dot's own cells: with auto-mirror on they show its color whatever paint is under them
    cores = {i for d in pz.dots for i in Board(R, C).core(d)}
    mirror_on = log['assist'].get('mirror')
    walls = [0] * len(sol)
    paint = [-1] * (R * C)
    out = [f"{log['code']}  {R}x{C}  device {log['device']}  assists at start {log['assist']}"]

    wrong_since: dict[tuple, int] = {}  # ('w', id) / ('p', cell) -> time it went wrong
    mistakes = []  # (kind, what, put at, fixed at or None, by player?)
    moves, gaps, last_move = 0, [], None
    running_since, played = None, 0
    solved_at = None
    for t, kind, data in log['ev']:
        if kind == 'run':
            running_since = t
        elif kind == 'stop':
            if running_since is not None:
                played += t - running_since
            running_since = None
        elif kind == 'solved':
            solved_at = t
        elif kind == 'assist':
            mirror_on = data.get('mirror')
            out.append(f'  {fmt(t)}  assists -> {data}')
        if not isinstance(data, dict):
            continue
        user_w, user_p = set(data.get('uw', [])), set(data.get('up', []))
        for wid in data.get('w', []):
            walls[wid] ^= 1
            key = ('w', wid)
            if walls[wid] and not sol[wid]:
                wrong_since[key] = t
                mistakes.append(['wall', wid, t, None, kind == 'line' and wid in user_w])
            elif key in wrong_since:
                for m in mistakes:
                    if m[0] == 'wall' and m[1] == wid and m[3] is None:
                        m[3] = t
                del wrong_since[key]
        for cell, k in data.get('p', []):
            paint[cell] = k
            if mirror_on and cell in cores:
                continue
            key = ('p', cell)
            if k >= 0 and k != pz.owner[cell]:
                wrong_since[key] = t
                mistakes.append(['paint', cell, t, None, kind == 'color' and cell in user_p])
            elif key in wrong_since:
                for m in mistakes:
                    if m[0] == 'paint' and m[1] == cell and m[3] is None:
                        m[3] = t
                del wrong_since[key]
        if kind in ('line', 'color', 'memo', 'cand'):
            moves += 1
            if last_move is not None:
                gaps.append((t - last_move, t))
            last_move = t
        if kind in ('undo', 'reset'):
            out.append(f'  {fmt(t)}  {kind}')

    end = log['ev'][-1][0]
    out.append(f'  clock at the end {fmt(end)}' + (f', solved at {fmt(solved_at)}' if solved_at is not None else ', not solved'))
    out.append(f'  moves {moves}')
    long = sorted(gaps, reverse=True)[:8]
    out.append('  longest pauses before a move: ' + ', '.join(f'{g / 10:.0f}s (at {fmt(t)})' for g, t in long))
    own = [m for m in mistakes if m[4]]
    out.append(f'  mistakes by the player: {len(own)} '
               f'(walls {sum(m[0] == "wall" for m in own)}, paint {sum(m[0] == "paint" for m in own)}), '
               f'by auto-mirror from them: {len(mistakes) - len(own)}')
    for kind, what, put, fixed, _ in own:
        life = f'fixed after {(fixed - put) / 10:.0f}s' if fixed is not None else 'never fixed'
        out.append(f'    {fmt(put)}  {kind} {what}  {life}')
    return '\n'.join(out)


def color_moves(log: dict, pz):
    """The player's paint strokes, replayed: (t, wait since the previous board change,
    cells the pointer painted, paint just before the stroke, paint after it)."""
    N = log['R'] * log['C']
    paint, prev = [-1] * N, 0
    for t, kind, data in log['ev']:
        if not isinstance(data, dict) or not ('w' in data or 'p' in data):
            continue
        before = paint[:]
        for cell, k in data.get('p', []):
            paint[cell] = k
        gap, prev = t - prev, t
        if kind == 'color':
            yield t, gap, [c for c in data.get('up', []) if paint[c] >= 0], before, paint[:]


def _verdicts(sv: Solver, O, known: frozenset):
    """From a board where exactly `known` cells are settled (to the answer): basic deduction,
    then the solver's trials one by one. Returns ({cell: depths of the trials it waited
    for}, candidates after basic deduction alone)."""
    N = sv.b.N
    own, cand, queue, dirty = sv._initial()
    for i in known:
        own[i] = O[i]
        sv._keep_only(cand, i, O[i], queue)
    when, trials, basic = {}, [], None
    while True:
        st = sv._settle(own, cand, queue, dirty, 0)[0]
        if basic is None:
            basic = cand[:]
        for i in range(N):
            if own[i] >= 0 and i not in when:
                when[i] = list(trials)
        if st != 'stuck':
            return when, basic
        hit = sv._find_trial(own, cand, 2)
        if hit is None:
            return when, basic
        lv, _, i, k = hit
        m, depth = sv.mir[k][i], -1
        if lv == 1:
            o2, c2, q2 = own[:], cand[:], []
            o2[i] = o2[m] = k
            sv._keep_only(c2, i, k, q2)
            sv._keep_only(c2, m, k, q2)
            depth = sv._walk(o2, c2, q2, set(), after=(i, m))[1]
        trials.append(depth)
        cand[i] &= ~(1 << k)
        queue, dirty = [(i, k)], {k}


def moves_report(log: dict, all_moves: bool = False) -> str:
    """Each paint stroke judged against the board the player had just before it: was it a
    basic deduction for the solver, or did the solver need trials (how many, how deep)?
    For those, the colors basic deduction could not rule out: either the player missed one
    of them, or used logic the solver doesn't have. Cells count as settled when painted
    right (dots' own cells always); walls are not used."""
    R, C = log['R'], log['C']
    pz = puzzle_for(log['code'])
    O = pz.owner
    sv = Solver(R, C, pz.dots)
    cores = {j for c in sv.cores for j in c}
    out, cache, n_basic = [f"{log['code']}  per stroke: (row, col) from 1, color = dot index"], {}, 0
    for t, gap, cells, before, after in color_moves(log, pz):
        known = frozenset(i for i in range(R * C) if before[i] == O[i] or i in cores)
        cells = [c for c in cells if c not in known]
        if not cells:
            continue
        if known not in cache:
            cache[known] = _verdicts(sv, O, known)
        when, basic = cache[known]
        guess = any(k >= 0 and k != O[i] and i not in cores for i, k in enumerate(before))
        for c in cells:
            k = after[c]
            alive = [j for j in range(sv.D) if basic[c] >> j & 1]
            if k != O[c]:
                v = f'wrong (answer {O[c]})'
            elif c not in when:
                v = 'solver stuck'
            elif not when[c]:
                n_basic += 1
                if not all_moves:
                    continue
                v = 'basic'
            else:
                v = f'{len(when[c])} trials, depths {when[c]}; still open: {[j for j in alive if j != k]}'
            out.append(f'  {fmt(t)} (+{gap / 10:.0f}s)  ({c // C + 1},{c % C + 1}) -> {k}  {v}'
                       f"  [board {len(known)}{', a wrong paint on it' if guess else ''}]")
    out.append(f'  basic strokes: {n_basic}' + ('' if all_moves else ' (not listed; --all lists them)'))
    return '\n'.join(out)


def seen_report(log: dict) -> str:
    """Wait before each correct stroke against how many colors the cell *looks* open to: the
    mirror cell is on the board and not another color's, and both cells reach the dot over
    empty or own-color cells. Where the solver has ruled more out than that, the player has
    to find the hidden reason."""
    R, C = log['R'], log['C']
    pz = puzzle_for(log['code'])
    O = pz.owner
    sv = Solver(R, C, pz.dots)
    nb, cores = sv.b.nbrs, {j for c in sv.cores for j in c}

    def reach(own, k):
        seen = set(sv.cores[k])
        st = list(seen)
        while st:
            x = st.pop()
            for y in nb[x]:
                if y not in seen and own[y] in (-1, k):
                    seen.add(y)
                    st.append(y)
        return seen

    cache, rows = {}, []
    for t, gap, cells, before, after in color_moves(log, pz):
        own = [O[i] if before[i] == O[i] or i in cores else -1 for i in range(R * C)]
        cells = [c for c in cells if own[c] < 0 and after[c] == O[c]]
        if not cells:
            continue
        known = frozenset(i for i in range(R * C) if own[i] >= 0)
        if known not in cache:
            cache[known] = _verdicts(sv, O, known)
        when, _ = cache[known]
        c = cells[0]
        regions = {}
        seen = 0
        for k in range(sv.D):
            m = sv.mir[k][c]
            if m < 0 or own[m] not in (-1, k):
                continue
            if k not in regions:
                regions[k] = reach(own, k)
            seen += c in regions[k] and m in regions[k]
        rows.append(('basic' if not when.get(c, [0]) else 'trial', min(seen, 4), gap))
    out = [f"{log['code']}  wait before correct strokes, by colors the cell looks open to"]
    for key in sorted(set((a, b) for a, b, _ in rows)):
        gs = sorted(g for a, b, g in rows if (a, b) == key)
        out.append(f'  {key[0]:5s} looks open to {key[1]}{"+" if key[1] == 4 else ""}:  {len(gs):3d} strokes,'
                   f' median wait {gs[len(gs) // 2] / 10:5.1f}s, mean {sum(gs) / len(gs) / 10:5.1f}s')
    return '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('add')
    a.add_argument('file', help="text file with the copied log, or '-' for stdin")
    a.add_argument('--who', default='owner')
    s = sub.add_parser('show')
    s.add_argument('file')
    m = sub.add_parser('moves', help='strokes the solver needed trials for, from the board at the time')
    m.add_argument('file')
    m.add_argument('--all', action='store_true', help='list basic strokes too')
    n = sub.add_parser('seen', help='wait before strokes against how open the cell looked')
    n.add_argument('file')
    args = ap.parse_args()
    if args.cmd in ('moves', 'seen'):
        log = json.loads(Path(args.file).read_text(encoding='utf-8'))
        print(moves_report(log, args.all) if args.cmd == 'moves' else seen_report(log))
        return
    if args.cmd == 'add':
        text = sys.stdin.read() if args.file == '-' else Path(args.file).read_text(encoding='utf-8')
        log = decode(text)
        log['who'] = args.who
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
        path = LOG_DIR / f"{log['code']}_{args.who}_{stamp}.json"
        path.write_text(json.dumps(log), encoding='utf-8')
        print(f'saved {path}')
    else:
        log = json.loads(Path(args.file).read_text(encoding='utf-8'))
    print(summary(log))


if __name__ == '__main__':
    main()
