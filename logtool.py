"""Solve logs from the web game ("Copy solve log"), for difficulty research.

    python logtool.py add LOGFILE [--who NAME]   decode, store under data/logs/, print a summary
    python logtool.py show data/logs/X.json      summary of a stored log
    python logtool.py moves data/logs/X.json     strokes the solver would have needed trials for
    python logtool.py seen data/logs/X.json      wait before strokes vs. how open the cell looked
    python logtool.py replay data/logs/*.json    data for the local replay page (web/replay.html)

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
REPLAY_DIR = Path(__file__).parent / 'web' / 'replays'  # not in git; see web/replay.html


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


def settled(R, C, owner, walls, paint, cores) -> set[int]:
    """Cells the player has right: painted with the answer, a dot's own cells, or inside a
    region the drawn walls close off that is exactly one answer region."""
    nv, N = R * (C - 1), R * C
    out = {i for i in range(N) if paint[i] == owner[i]} | set(cores)
    seen = [False] * N
    for s in range(N):
        if seen[s]:
            continue
        seen[s], comp, st = True, [s], [s]
        while st:
            a = st.pop()
            r, c = divmod(a, C)
            for b, wid in ((a + 1, r * (C - 1) + c) if c + 1 < C else (-1, 0),
                           (a - 1, r * (C - 1) + c - 1) if c > 0 else (-1, 0),
                           (a + C, nv + a) if r + 1 < R else (-1, 0),
                           (a - C, nv + a - C) if r > 0 else (-1, 0)):
                if b >= 0 and not walls[wid] and not seen[b]:
                    seen[b] = True
                    comp.append(b)
                    st.append(b)
        k = owner[s]
        if all(owner[i] == k for i in comp) and len(comp) == owner.count(k):
            out.update(comp)
    return out


def color_moves(log: dict, pz):
    """The player's paint strokes, replayed: (event index, t, wait since the previous board change,
    cells the pointer painted, cells settled just before the stroke, paint just before it,
    paint after it). The log may start from a board already under way (its 'open' event)."""
    R, C = log['R'], log['C']
    cores = {i for d in pz.dots for i in Board(R, C).core(d)}
    paint, walls, prev = [-1] * (R * C), [0] * len(solution_walls(R, C, pz.owner)), 0
    for ei, (t, kind, data) in enumerate(log['ev']):
        if not isinstance(data, dict) or not ('w' in data or 'p' in data):
            continue
        before = paint[:]
        known = settled(R, C, pz.owner, walls, before, cores) if kind == 'color' else None
        for cell, k in data.get('p', []):
            paint[cell] = k
        for wid in data.get('w', []):
            walls[wid] ^= 1
        gap, prev = t - prev, t
        if kind == 'color':
            yield ei, t, gap, [c for c in data.get('up', []) if paint[c] >= 0], frozenset(known), before, paint[:]


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
    of them, or used logic the solver doesn't have. Settled cells: see `settled`."""
    R, C = log['R'], log['C']
    pz = puzzle_for(log['code'])
    O = pz.owner
    sv = Solver(R, C, pz.dots)
    cores = {j for c in sv.cores for j in c}
    out, cache, n_basic = [f"{log['code']}  per stroke: (row, col) from 1, color = dot index"], {}, 0
    for _, t, gap, cells, known, before, after in color_moves(log, pz):
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
    for _, t, gap, cells, known, before, after in color_moves(log, pz):
        own = [O[i] if i in known else -1 for i in range(R * C)]
        cells = [c for c in cells if own[c] < 0 and after[c] == O[c]]
        if not cells:
            continue
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


def _eliminate_at(sv: Solver, cand, queue, dirty) -> int:
    """Solver._eliminate that names the cell left without a candidate: -1 if none."""
    N, nbrs, mir, cores = sv.b.N, sv.b.nbrs, sv.mir, sv.cores
    while queue or dirty:
        while queue:
            i, k = queue.pop()
            dirty.add(k)
            m = mir[k][i]
            if m >= 0 and cand[m] >> k & 1:
                cand[m] &= ~(1 << k)
                if not cand[m]:
                    return m
                queue.append((m, k))
        if dirty:
            k = dirty.pop()
            seen, st = set(cores[k]), list(cores[k])
            while st:
                x = st.pop()
                for y in nbrs[x]:
                    if y not in seen and cand[y] >> k & 1:
                        seen.add(y)
                        st.append(y)
            for i in range(N):
                if cand[i] >> k & 1 and i not in seen:
                    cand[i] &= ~(1 << k)
                    if not cand[i]:
                        return i
                    queue.append((i, k))
    return -1


def trial_chain(sv: Solver, own, cand, c: int, k: int) -> dict:
    """Put color k on cell c (and its mirror) and follow basic deductions the way the solver
    does (chain by chain, nearest first). Returns the placements [cell, mirror, color] in order, and how it
    ends: 'contra' with the cell left without a color ('at'), or 'stuck' / 'solved'."""
    own, cand, nbrs, mir = own[:], cand[:], sv.b.nbrs, sv.mir
    m = mir[k][c]
    if m < 0 or not cand[m] >> k & 1:
        return {'end': 'contra', 'at': c if m < 0 else m, 'steps': [[c, c if m < 0 else m, k]]}
    steps, queue = [], []

    def place(i, kk):
        j = mir[kk][i]
        own[i] = own[j] = kk
        sv._keep_only(cand, i, kk, queue)
        sv._keep_only(cand, j, kk, queue)
        steps.append([i, j, kk])
        return {i, j} | set(nbrs[i]) | set(nbrs[j])

    near, dmaps, old = place(c, k), {}, set()
    while True:
        bad = _eliminate_at(sv, cand, queue, set())
        if bad >= 0:
            return {'end': 'contra', 'at': bad, 'steps': steps}
        if all(o >= 0 for o in own):
            return {'end': 'solved', 'at': -1, 'steps': steps}
        pairs = sv._singles(own, cand)
        if not pairs:
            return {'end': 'stuck', 'at': -1, 'steps': steps}
        # continue next to the last placement when something there is forced, as _walk does
        pool = {p: i for p, i in pairs.items()
                if p not in old and (i in near or mir[p[1]][i] in near)} or pairs
        best = None
        for (_, kk), i in pool.items():
            if kk not in dmaps:
                dmaps[kk] = sv._dist_map(own, kk)
            d = min(dmaps[kk][i], dmaps[kk][mir[kk][i]])
            if best is None or d < best[0]:
                best = (d, i, kk)
        _, i, kk = best
        if not cand[mir[kk][i]] >> kk & 1:
            return {'end': 'contra', 'at': mir[kk][i], 'steps': steps}
        old = set(pairs)
        near = place(i, kk)
        dmaps.pop(kk, None)


def replay_data(log: dict) -> dict:
    """Everything the local replay page (web/replay.html) shows: the puzzle, the events, and
    for each paint stroke the solver's view of the board just before it: per painted cell a
    verdict (basic / trial / wrong / stuck); for the others, the colors basic deduction
    leaves open there and, for each wrong one, the solver's way to a contradiction."""
    R, C = log['R'], log['C']
    pz = puzzle_for(log['code'])
    O = pz.owner
    sv = Solver(R, C, pz.dots)
    strokes, cache = {}, {}
    for ei, t, gap, cells, known, before, after in color_moves(log, pz):
        cells = [c for c in cells if c not in known]
        if not cells:
            continue
        if known not in cache:
            when, _ = _verdicts(sv, O, known)
            own, cand, queue, dirty = sv._initial()
            for i in known:
                own[i] = O[i]
                sv._keep_only(cand, i, O[i], queue)
            sv._settle(own, cand, queue, dirty, 0)
            cache[known] = (when, own, cand)
        when, own, cand = cache[known]
        out = []
        for c in cells:
            k = after[c]
            item = {'cell': c, 'color': k, 'answer': O[c]}
            if k != O[c]:
                item['verdict'] = 'wrong'
            elif c not in when:
                item['verdict'] = 'stuck'
            elif not when[c]:
                item['verdict'] = 'basic'
            else:
                item['verdict'] = 'trial'
                item['depths'] = when[c]
            if item['verdict'] != 'basic':
                item['open'] = [j for j in range(sv.D) if cand[c] >> j & 1]
                item['chains'] = {j: trial_chain(sv, own, cand, c, j) for j in item['open'] if j != O[c]}
            out.append(item)
        strokes[ei] = {'gap': gap, 'cells': out,
                       'basic': [i for i in range(R * C) if own[i] >= 0 and i not in known]}
    return {'code': log['code'], 'who': log.get('who', ''), 'R': R, 'C': C,
            'dots': [list(d) for d in pz.dots], 'owner': list(O), 'assist': log['assist'],
            'ev': log['ev'], 'strokes': strokes}


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
    r = sub.add_parser('replay', help='data for the local replay page, into web/replays/')
    r.add_argument('files', nargs='+')
    args = ap.parse_args()
    if args.cmd == 'replay':
        REPLAY_DIR.mkdir(exist_ok=True)
        for f in args.files:
            log = json.loads(Path(f).read_text(encoding='utf-8'))
            path = REPLAY_DIR / Path(f).name
            path.write_text(json.dumps(replay_data(log)), encoding='utf-8')
            print(f'wrote {path}')
        return
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
