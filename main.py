"""Generate Galaxy puzzles, or print generation statistics.

  python main.py -r 7 -c 7 -n 3            # 3 puzzles with solutions
  python main.py -r 7 -c 7 --stats 200     # acceptance / level / region-size stats
"""
import argparse
import random
import time
from collections import Counter

from galaxy import SolveResult, Solver, generate, generate_sim, render, shape_stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-r', '--rows', type=int, default=7)
    ap.add_argument('-c', '--cols', type=int, default=7)
    ap.add_argument('-n', '--count', type=int, default=1)
    ap.add_argument('-m', '--method', choices=['seq', 'sim'], default='sim',
                    help='seq = one region at a time, sim = simultaneous growth')
    ap.add_argument('-b', '--batch', type=int, help='sim: max seeds per phase (default: no cap)')
    ap.add_argument('--seed-weight', choices=['uniform', 'sat', 'max'], default='max', help='sim: seed choice')
    ap.add_argument('--corner-w', type=float, default=0.7, help='sim: weight for concave-corner cells (<1 = thinner)')
    ap.add_argument('--corner-to-stop', action=argparse.BooleanOptionalAction, default=True,
                    help='sim: weight removed from corner cells goes to the stop option (default on)')
    ap.add_argument('--spacing', type=float, help='sim: min seed distance in cells (default sqrt(target))')
    ap.add_argument('-t', '--target', type=float, help='target region size (default 8)')
    ap.add_argument('--p0', type=float, help='stop prob = p0 * (n/target)^2 (default: seq 0.3, sim 0)')
    ap.add_argument('-w', '--weight', choices=['sat', 'linear', 'uniform'], default='sat')
    ap.add_argument('--avoid-pockets', action=argparse.BooleanOptionalAction,
                    help='avoid leaving isolated 1-cell holes (default: seq off, sim on)')
    ap.add_argument('--max-level', type=int, default=2)
    ap.add_argument('--trial-mult', type=float, default=4.0)
    ap.add_argument('--seed', type=int)
    ap.add_argument('--stats', type=int, metavar='N', help='generate N candidates and report statistics')
    a = ap.parse_args()
    rng = random.Random(a.seed)
    if a.p0 is None:
        a.p0 = 0.3 if a.method == 'seq' else 0.0
    if a.target is None:
        a.target = 8.0
    if a.avoid_pockets is None:
        a.avoid_pockets = a.method == 'sim'
    if a.method == 'seq':
        gen = lambda: generate(a.rows, a.cols, rng, target=a.target, p0=a.p0, weight=a.weight,
                               avoid_pockets=a.avoid_pockets)
    else:
        gen = lambda: generate_sim(a.rows, a.cols, rng, target=a.target, p0=a.p0, spacing=a.spacing, batch=a.batch,
                                   avoid_pockets=a.avoid_pockets, seed_weight=a.seed_weight,
                                   corner_w=a.corner_w, corner_to_stop=a.corner_to_stop)
    def slv(pz) -> SolveResult:
        s = Solver(pz.R, pz.C, pz.dots, max_level=a.max_level, trial_mult=a.trial_mult)
        if s.count_solutions(2) != 1:  # cheap exact check first; the human solver is slow to give up
            return SolveResult('non-unique', [-1] * (pz.R * pz.C), -1, 0.0, 0)
        return s.solve()

    if a.stats:
        status, levels, sizes, ndots, scores = Counter(), Counter(), Counter(), Counter(), []
        blocks, perims = [], []
        t = time.perf_counter()
        for _ in range(a.stats):
            pz = gen()
            sizes.update(Counter(pz.owner).values())
            ndots[len(pz.dots)] += 1
            sh = shape_stats(pz)
            blocks.append(sh['block'])
            perims.append(sh['perim'])
            res = slv(pz)
            status[res.status] += 1
            if res.status == 'solved':
                assert res.owner == pz.owner, "solver solution differs from generator partition"
                levels[res.max_level] += 1
                scores.append(res.score)
        dt = time.perf_counter() - t
        opts = (f"w={a.weight} avoid_pockets={a.avoid_pockets}" if a.method == 'seq'
                else f"spacing={a.spacing or a.target ** 0.5:.2f} batch={a.batch} seed_w={a.seed_weight} avoid_pockets={a.avoid_pockets} corner_w={a.corner_w} corner_to_stop={a.corner_to_stop}")
        print(f"{a.rows}x{a.cols}  {a.method}  target={a.target} p0={a.p0} {opts} max_level={a.max_level}  "
              f"({dt / a.stats * 1000:.0f} ms/puzzle)")
        print("status      :", dict(status))
        print("max level   :", dict(sorted(levels.items())))
        print("#regions    :", dict(sorted(ndots.items())))
        print("region size :", dict(sorted(sizes.items())))
        tot = sum(sizes.values())
        bucket = lambda lo, hi: sum(v for k, v in sizes.items() if lo <= k <= hi) / tot
        print(f"size bucket : 1: {bucket(1, 1):.0%}  2-4: {bucket(2, 4):.0%}  5-10: {bucket(5, 10):.0%}  "
              f"11+: {bucket(11, 10 ** 9):.0%}  (avg {a.rows * a.cols * a.stats / tot:.1f})")
        print(f"shape       : 2x2-block {sum(blocks) / len(blocks):.2f}  perim/area {sum(perims) / len(perims):.2f}")
        if scores:
            scores.sort()
            print(f"score       : min {scores[0]:.0f}  median {scores[len(scores) // 2]:.0f}  max {scores[-1]:.0f}")
        return

    made = 0
    while made < a.count:
        pz = gen()
        res = slv(pz)
        if res.status != 'solved':
            continue
        made += 1
        print(f"#{made}  {a.rows}x{a.cols}  regions={len(pz.dots)}  "
              f"level={res.max_level}  score={res.score:.0f}  rounds={res.rounds}")
        puzzle = render(pz.R, pz.C, pz.dots).splitlines()
        sol = render(pz.R, pz.C, pz.dots, pz.owner).splitlines()
        for l, r in zip(puzzle, sol):
            print(l + '    ' + r)
        print()


if __name__ == '__main__':
    main()
