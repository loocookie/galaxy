"""Cross-check the solver against exhaustive enumeration on small grids.

  python verify.py 4 4

Enumerates every partition of an R x C grid into connected point-symmetric
regions (each containing its dot's core), groups them by dot set, then checks:
  * solver 'solved'  => dot set has exactly one partition, and it matches
  * non-unique dot set => solver never reports 'solved'
and reports how many unique puzzles each max_level setting solves.
"""
import sys
import time
from collections import Counter, defaultdict

from galaxy import Board, Solver


def placements(b: Board):
    out = []
    for d0 in range(2 * b.R - 1):
        for d1 in range(2 * b.C - 1):
            d = (d0, d1)
            core = set(b.core(d))
            pairs, seen = [], set(core)
            for p in range(b.N):
                m = b.mirror(p, d)
                if p in seen or m < 0:
                    continue
                seen.update((p, m))
                pairs.append((p, m))
            for mask in range(1 << len(pairs)):
                S = set(core)
                for t, (p, m) in enumerate(pairs):
                    if mask >> t & 1:
                        S.update((p, m))
                st, vis = [next(iter(S))], set()
                vis.add(st[0])
                while st:
                    x = st.pop()
                    for y in b.nbrs[x]:
                        if y in S and y not in vis:
                            vis.add(y)
                            st.append(y)
                if len(vis) == len(S):
                    out.append((d, frozenset(S)))
    return out


def enumerate_partitions(b: Board):
    pl = placements(b)
    by_first = defaultdict(list)
    for d, S in pl:
        by_first[min(S)].append((d, S))
    covered = [False] * b.N
    sols = defaultdict(list)
    cur = []

    def rec():
        try:
            i = covered.index(False)
        except ValueError:
            sols[frozenset(d for d, _ in cur)].append(list(cur))
            return
        for d, S in by_first[i]:
            if any(covered[j] for j in S):
                continue
            for j in S:
                covered[j] = True
            cur.append((d, S))
            rec()
            cur.pop()
            for j in S:
                covered[j] = False

    rec()
    return sols


def main():
    R, C = int(sys.argv[1]), int(sys.argv[2])
    levels = range(int(sys.argv[3]) + 1) if len(sys.argv) > 3 else range(3)
    b = Board(R, C)
    t = time.perf_counter()
    sols = enumerate_partitions(b)
    print(f"{R}x{C}: {sum(map(len, sols.values()))} partitions, {len(sols)} dot sets "
          f"({time.perf_counter() - t:.1f}s)")
    unique = {k: v[0] for k, v in sols.items() if len(v) == 1}
    multi = [k for k, v in sols.items() if len(v) > 1]
    print(f"  unique: {len(unique)}   non-unique: {len(multi)}")

    # Solve each unique dot set at increasing levels; only stuck ones move up.
    todo = list(unique)
    for lv in levels:
        t = time.perf_counter()
        stuck, used = [], Counter()
        for key in todo:
            dots = sorted(key)
            res = Solver(R, C, dots, max_level=lv).solve()
            if res.status == 'solved':
                expect = [-1] * b.N
                for d, S in unique[key]:
                    for j in S:
                        expect[j] = dots.index(d)
                assert res.owner == expect, f"wrong solution for {dots}"
                used[res.max_level] += 1
            else:
                assert res.status == 'stuck', f"contradiction on solvable puzzle {dots}"
                stuck.append(key)
        print(f"  max_level={lv}: stuck {len(stuck)} / {len(todo)} tried "
              f"({time.perf_counter() - t:.1f}s)")
        todo = stuck
        if not todo:
            break
    if todo:
        print("  example still stuck:", sorted(todo[0]))

    # Soundness: non-unique dot sets must never be 'solved'.
    t = time.perf_counter()
    for key in multi:
        res = Solver(R, C, sorted(key), max_level=levels[-1]).solve()
        assert res.status != 'solved', f"solver claims unique solution for non-unique {sorted(key)}"
    print(f"  non-unique sets never solved: OK ({time.perf_counter() - t:.1f}s)")

    # count_solutions must agree with enumeration (capped at 2).
    t = time.perf_counter()
    for key, v in sols.items():
        got = Solver(R, C, sorted(key)).count_solutions(2)
        assert got == min(len(v), 2), f"count_solutions {got} != {len(v)} for {sorted(key)}"
    print(f"  count_solutions matches enumeration: OK ({time.perf_counter() - t:.1f}s)")


if __name__ == '__main__':
    main()
