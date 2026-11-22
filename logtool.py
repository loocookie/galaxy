"""Solve logs from the web game ("Copy solve log"), for difficulty research.

    python logtool.py add LOGFILE [--who NAME]   decode, store under data/logs/, print a summary
    python logtool.py show data/logs/X.json      summary of a stored log

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

from galaxy import GENERATOR_VERSION, Solver, generate_sim

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


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    a = sub.add_parser('add')
    a.add_argument('file', help="text file with the copied log, or '-' for stdin")
    a.add_argument('--who', default='owner')
    s = sub.add_parser('show')
    s.add_argument('file')
    args = ap.parse_args()
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
