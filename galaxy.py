"""Galaxy (Tentai Show) generator and human-style solver.

Coordinates: cell (r, c) is index r*C + c. Dots use doubled coordinates:
cell (r, c) has center (2r, 2c), so a dot d lies in [0, 2R-2] x [0, 2C-2].
The mirror of cell (r, c) about d is cell (d0 - r, d1 - c).
See PLAN.md for the design.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from typing import Callable

Dot = tuple[int, int]

# Share codes (web UI) are "version-size-seed". A seed only reproduces the same puzzle with
# the same generator, so bump this whenever generate_sim (or anything it calls, or the web
# worker's accept loop) changes the puzzle a given seed produces. The web build reads it.
GENERATOR_VERSION = 2


class Board:
    def __init__(self, R: int, C: int):
        self.R, self.C, self.N = R, C, R * C
        self.nbrs: list[list[int]] = []
        for i in range(self.N):
            r, c = divmod(i, C)
            self.nbrs.append([rr * C + cc for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1))
                              if 0 <= rr < R and 0 <= cc < C])

    def in_range(self, d: Dot) -> bool:
        return 0 <= d[0] <= 2 * self.R - 2 and 0 <= d[1] <= 2 * self.C - 2

    def mirror(self, i: int, d: Dot) -> int:
        r, c = divmod(i, self.C)
        mr, mc = d[0] - r, d[1] - c
        return mr * self.C + mc if 0 <= mr < self.R and 0 <= mc < self.C else -1

    def core(self, d: Dot) -> list[int]:
        rs = (d[0] // 2,) if d[0] % 2 == 0 else (d[0] // 2, d[0] // 2 + 1)
        cs = (d[1] // 2,) if d[1] % 2 == 0 else (d[1] // 2, d[1] // 2 + 1)
        return [r * self.C + c for r in rs for c in cs]

    def dots_touching(self, i: int) -> list[Dot]:
        """All in-range dots whose core contains cell i."""
        r, c = divmod(i, self.C)
        return [(2 * r + a, 2 * c + b) for a in (-1, 0, 1) for b in (-1, 0, 1)
                if self.in_range((2 * r + a, 2 * c + b))]


# --------------------------------------------------------------------------- generator

@dataclass
class Puzzle:
    R: int
    C: int
    dots: list[Dot]
    owner: list[int]  # generator's partition: cell -> dot index


def _max_region(b: Board, owner: list[int], d: Dot) -> set[int]:
    """Largest symmetric connected region d could still grow to (closure of valid pairs)."""
    region = set(b.core(d))
    st = list(region)
    while st:
        x = st.pop()
        for j in b.nbrs[x]:
            if j not in region and owner[j] < 0 and (mj := b.mirror(j, d)) >= 0 and owner[mj] < 0:
                region.update((j, mj))
                st += [j, mj]
    return region


def _makes_pocket(b: Board, owner: list[int], cells) -> bool:
    """Would claiming `cells` leave a free cell with no free neighbor?"""
    cl = set(cells)
    return any(owner[s] < 0 and s not in cl and all(owner[z] >= 0 or z in cl for z in b.nbrs[s])
               for x in cl for s in b.nbrs[x])


def generate(R: int, C: int, rng: random.Random | None = None, target: float = 8.0,
             p0: float = 0.3, weight: str = 'sat', avoid_pockets: bool = False,
             stop_fn: Callable[[int], float] | None = None) -> Puzzle:
    """Grow point-symmetric regions until the grid is covered (never fails, no retries).

    Center choice: to cover the most constrained free cell u, pick among dots whose
    region can reach u, weighted by w(|M|) where M is the largest region the dot could
    still grow to. weight: 'sat' = min(|M|, target), 'linear' = |M|, 'uniform' = 1.
    Growth: after core + path to u, stop with probability stop_fn(n) at each step,
    default min(1, p0 * (n / target)^2) so larger regions stop more readily.
    avoid_pockets: prefer moves that do not leave an isolated 1-cell free pocket
    (singleton regions are still allowed; this only reduces forced ones).
    """
    rng = rng or random.Random()
    if stop_fn is None:
        stop_fn = lambda n: min(1.0, p0 * (n / target) ** 2)
    wfn = {'sat': lambda m: min(m, target), 'linear': lambda m: m, 'uniform': lambda m: 1}[weight]
    b = Board(R, C)

    def makes_pocket(owner, cells) -> bool:
        return avoid_pockets and _makes_pocket(b, owner, cells)

    def max_region(owner, d) -> set[int]:
        return _max_region(b, owner, d)

    def path_region(d, M, u) -> set[int]:
        """core(d) + shortest path inside M to u + its mirror image."""
        core = b.core(d)
        prev = {x: -1 for x in core}
        queue = list(core)
        for x in queue:
            if x == u:
                break
            for y in b.nbrs[x]:
                if y in M and y not in prev:
                    prev[y] = x
                    queue.append(y)
        region = set(core)
        x = u
        while x != -1:
            region.update((x, b.mirror(x, d)))
            x = prev[x]
        return region

    all_dots = [(a, c) for a in range(2 * R - 1) for c in range(2 * C - 1)]
    owner = [-1] * b.N
    dots: list[Dot] = []
    while True:
        free = [i for i in range(b.N) if owner[i] < 0]
        if not free:
            return Puzzle(R, C, dots, owner)
        # cover the most constrained free cell u, by any dot whose region can reach u
        deg = {i: sum(owner[j] < 0 for j in b.nbrs[i]) for i in free}
        m = min(deg.values())
        u = rng.choice([i for i in free if deg[i] == m])
        options, weights = [], []
        for d in all_dots:
            mu = b.mirror(u, d)
            if mu < 0 or owner[mu] >= 0 or any(owner[j] >= 0 for j in b.core(d)):
                continue
            M = max_region(owner, d)
            if u in M:
                P = path_region(d, M, u)
                options.append((d, P, makes_pocket(owner, P)))
                weights.append(wfn(len(M)))
        # never empty: u's own cell center always qualifies
        if avoid_pockets and any(not p for _, _, p in options):
            weights = [w for w, o in zip(weights, options) if not o[2]]
            options = [o for o in options if not o[2]]
        d, region, _ = rng.choices(options, weights)[0]
        k = len(dots)
        dots.append(d)
        for j in region:
            owner[j] = k
        while rng.random() >= stop_fn(len(region)):
            front = sorted({j for x in region for j in b.nbrs[x]
                            if owner[j] < 0 and (mj := b.mirror(j, d)) >= 0 and owner[mj] < 0
                            and not makes_pocket(owner, (j, mj))})
            if not front:
                break
            j = rng.choice(front)
            mj = b.mirror(j, d)
            owner[j] = owner[mj] = k
            region.update((j, mj))


def generate_sim(R: int, C: int, rng: random.Random | None = None, target: float = 8.0,
                 p0: float = 0.0, spacing: float | None = None, batch: int | None = None,
                 avoid_pockets: bool = True, seed_weight: str = 'max', corner_w: float = 0.7,
                 corner_to_stop: bool = True,
                 stop_fn: Callable[[int], float] | None = None) -> Puzzle:
    """Simultaneous growth (never fails, no retries).

    Phase loop until the grid is covered:
      1. Seed about |free| / target new dots (at most `batch` per phase; None = no cap)
         on free cores, at random, keeping seeds of this phase at least `spacing` cells
         apart (default sqrt(target)).
      2. Grow all seeded regions round-robin (shuffled each round), one mirror pair per
         turn. A region stops when it has no valid pair, or with probability stop_fn(n)
         (default min(1, p0 * (n / target)^2); p0=0 means grow until blocked).
    Leftover free cells are covered by the next phase's seeds.
    seed_weight: 'uniform'; 'sat' = prefer dots with room, weight min(|M|, target)
    (weighted sampling without replacement); 'max' = strict priority on
    min(|M|, target), random within ties (never seeds a dead-end dot while a dot
    with more room exists).
    avoid_pockets: growth prefers pairs that do not leave an isolated 1-cell free
    pocket, but still takes a pocket-making pair when it is the only option.
    corner_w: weight of a candidate touching the region on 2+ sides (filling a concave
    corner) relative to 1 for a cell touching on one side. < 1 = thinner, more branches.
    corner_to_stop: unified draw of "stop" and "which cell". With p = stop_fn(n) and N
    frontier cells, the stop option first gets y0 = p*N/(1-p) (so P(stop) = p before the
    corner penalty); then the weight each corner cell loses, (1 - corner_w), is moved to
    the stop option. Total weight stays N + y0, and
    P(stop) = p + (1 - p) * (1 - corner_w) * (#corner cells / N):
    a region whose frontier is mostly concave corners (already compact) stops readily.
    """
    rng = rng or random.Random()
    if stop_fn is None:
        stop_fn = lambda n: min(1.0, p0 * (n / target) ** 2)
    if spacing is None:
        spacing = target ** 0.5
    b = Board(R, C)
    all_dots = [(a, c) for a in range(2 * R - 1) for c in range(2 * C - 1)]
    owner = [-1] * b.N
    dots: list[Dot] = []
    regions: list[set[int]] = []
    lim2 = (2 * spacing) ** 2  # doubled coordinates
    while True:
        nfree = sum(o < 0 for o in owner)
        if not nfree:
            return Puzzle(R, C, dots, owner)
        want = max(1, round(nfree / target))
        if batch is not None:
            want = min(want, batch)
        cands = [d for d in all_dots if all(owner[j] < 0 for j in b.core(d))]
        if seed_weight == 'sat':
            key = {d: rng.random() ** (1.0 / min(len(_max_region(b, owner, d)), target)) for d in cands}
            cands.sort(key=key.__getitem__, reverse=True)
        elif seed_weight == 'max':
            key = {d: (min(len(_max_region(b, owner, d)), target), rng.random()) for d in cands}
            cands.sort(key=key.__getitem__, reverse=True)
        else:
            rng.shuffle(cands)
        seeds: list[Dot] = []
        claimed: set[int] = set()
        for d in cands:  # first candidate is always accepted, so each phase makes progress
            if len(seeds) >= want:
                break
            core = b.core(d)
            if claimed.intersection(core) or any((d[0] - e[0]) ** 2 + (d[1] - e[1]) ** 2 < lim2 for e in seeds):
                continue
            seeds.append(d)
            claimed.update(core)
        active = []
        for d in seeds:
            k = len(dots)
            dots.append(d)
            regions.append(set(b.core(d)))
            for j in regions[k]:
                owner[j] = k
            active.append(k)
        while active:
            rng.shuffle(active)
            still = []
            for k in active:
                region, d = regions[k], dots[k]
                p = stop_fn(len(region))
                if not corner_to_stop and rng.random() < p:
                    continue
                front = sorted({j for x in region for j in b.nbrs[x]
                                if owner[j] < 0 and (mj := b.mirror(j, d)) >= 0 and owner[mj] < 0})
                if not front:
                    continue
                if avoid_pockets:
                    safe = [j for j in front if not _makes_pocket(b, owner, (j, b.mirror(j, d)))]
                    front = safe or front
                if corner_to_stop:
                    if p >= 1.0:
                        continue
                    ws = [corner_w if sum(y in region for y in b.nbrs[j]) >= 2 else 1.0 for j in front]
                    y = p * len(front) / (1.0 - p) + (len(front) - sum(ws))
                    if rng.random() * (y + sum(ws)) < y:
                        continue
                    j = rng.choices(front, ws)[0]
                elif corner_w == 1.0:
                    j = rng.choice(front)
                else:
                    ws = [corner_w if sum(y in region for y in b.nbrs[j]) >= 2 else 1.0 for j in front]
                    j = rng.choices(front, ws)[0]
                mj = b.mirror(j, d)
                owner[j] = owner[mj] = k
                region.update((j, mj))
                still.append(k)
            active = still


def shape_stats(pz: Puzzle) -> dict[str, float]:
    """Shape metrics over regions of size >= 4.

    block: fraction of their cells lying in some full 2x2 block of the same region
           (1 = chunky/rectangular, 0 = thin lines).
    perim: mean perimeter / area (lower = more compact).
    """
    R, C, own = pz.R, pz.C, pz.owner
    in_block = [False] * (R * C)
    for r in range(R - 1):
        for c in range(C - 1):
            q = (r * C + c, r * C + c + 1, (r + 1) * C + c, (r + 1) * C + c + 1)
            if own[q[0]] == own[q[1]] == own[q[2]] == own[q[3]]:
                for x in q:
                    in_block[x] = True
    size: dict[int, int] = {}
    perim: dict[int, int] = {}
    for i in range(R * C):
        k = own[i]
        size[k] = size.get(k, 0) + 1
        r, c = divmod(i, C)
        perim[k] = perim.get(k, 0) + sum(
            not (0 <= rr < R and 0 <= cc < C) or own[rr * C + cc] != k
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)))
    big = {k for k, s in size.items() if s >= 4}
    cells = [i for i in range(R * C) if own[i] in big]
    return {
        'block': sum(in_block[i] for i in cells) / len(cells) if cells else 0.0,
        'perim': sum(perim[k] / size[k] for k in big) / len(big) if big else 0.0,
    }


# --------------------------------------------------------------------------- solver

@dataclass
class SolveResult:
    status: str           # 'solved' | 'stuck' | 'contra'
    owner: list[int]      # -1 where undetermined
    max_level: int        # highest trial level needed (0 = basic rules only)
    score: float
    rounds: int           # number of deduction rounds (basic rounds + trial eliminations)
    steps: list[tuple[int, float]] = field(default_factory=list)  # (level, cost) per round
    depths: list[int] = field(default_factory=list)  # per trial: chains followed to the
                                                      # contradiction (-1 = nested trial)

    @property
    def difficulty(self) -> tuple[int, float]:
        return (self.max_level, self.score)


class _Contradiction(Exception):
    pass


class Solver:
    """Human-style solver.

    State per cell: own[i] (dot index or -1) and cand[i], a bitmask of the dots cell i may
    still belong to. Elimination is incremental: every removed candidate (i, k) is queued,
    its mirror about k loses k too (rules 1 and 3), and dot k is marked dirty so only its
    reachability (rule 2) is recomputed. Trials are bounded by the cheapest contradiction
    found so far. Results are identical to the original set-based solver.
    """

    def __init__(self, R: int, C: int, dots: list[Dot], max_level: int = 2, trial_mult: float = 4.0,
                 paths: bool = True):
        self.b = b = Board(R, C)
        self.dots = list(dots)
        self.D = len(dots)
        self.max_level, self.trial_mult = max_level, trial_mult
        self.paths = paths  # the path rule (_path_forced) in solve(); count_solutions never uses it
        seen: set[int] = set()
        self.cores = []
        for d in self.dots:
            if not b.in_range(d):
                raise ValueError(f"dot out of range: {d}")
            core = b.core(d)
            if seen & set(core):
                raise ValueError(f"dot cores overlap at {d}")
            seen.update(core)
            self.cores.append(core)
        self.mir = [[b.mirror(i, d) for i in range(b.N)] for d in self.dots]

    # --- state helpers
    def _initial(self):
        """Returns (own, cand, queue, dirty) before any elimination."""
        N, D, mir = self.b.N, self.D, self.mir
        own = [-1] * N
        cand = [(1 << D) - 1] * N
        queue: list[tuple[int, int]] = []
        for i in range(N):
            for k in range(D):
                if mir[k][i] < 0:
                    cand[i] &= ~(1 << k)
                    queue.append((i, k))
        for k, core in enumerate(self.cores):
            for i in core:
                own[i] = k
                self._keep_only(cand, i, k, queue)
        return own, cand, queue, set(range(D))

    @staticmethod
    def _keep_only(cand, i, k, queue):
        """Restrict cell i to dot k, queueing every removed candidate."""
        rest = cand[i] & ~(1 << k)
        cand[i] = 1 << k
        while rest:
            low = rest & -rest
            queue.append((i, low.bit_length() - 1))
            rest ^= low

    def _eliminate(self, cand, queue, dirty) -> bool:
        """Apply rules 1-3 to a fixpoint, starting from the queued removals and dirty dots.
        Returns False on contradiction (a cell with no candidate left)."""
        N, nbrs, mir, cores = self.b.N, self.b.nbrs, self.mir, self.cores
        while queue or dirty:
            while queue:
                i, k = queue.pop()
                dirty.add(k)  # losing cell i may cut dot k's region apart (rule 2)
                m = mir[k][i]
                bit = 1 << k
                if m >= 0 and cand[m] & bit:
                    c = cand[m] & ~bit
                    if not c:
                        return False
                    cand[m] = c
                    queue.append((m, k))
            if dirty:
                k = dirty.pop()
                bit = 1 << k
                core = cores[k]
                seen = set(core)
                st = list(core)
                while st:
                    x = st.pop()
                    for y in nbrs[x]:
                        if y not in seen and cand[y] & bit:
                            seen.add(y)
                            st.append(y)
                for i in range(N):
                    if cand[i] & bit and i not in seen:
                        c = cand[i] & ~bit
                        if not c:
                            return False
                        cand[i] = c
                        queue.append((i, k))
        return True

    def _block(self, own: list[int], k: int) -> list[tuple[int, int]]:
        """Cells owned by k connected to its core via owned-by-k cells, as (r, c)."""
        nbrs, C = self.b.nbrs, self.b.C
        seen = set(self.cores[k])
        st = list(seen)
        while st:
            x = st.pop()
            for y in nbrs[x]:
                if y not in seen and own[y] == k:
                    seen.add(y)
                    st.append(y)
        return [divmod(x, C) for x in seen]

    def _assign_round(self, own, cand, queue) -> float | None:
        singles = [i for i in range(self.b.N) if own[i] < 0 and cand[i] & (cand[i] - 1) == 0]
        if not singles:
            return None
        C = self.b.C
        blocks: dict[int, list[tuple[int, int]]] = {}
        cost = 0.0
        for i in singles:
            if own[i] >= 0:
                continue  # assigned as a mirror earlier this round
            k = cand[i].bit_length() - 1
            m = self.mir[k][i]
            if not cand[m] >> k & 1:
                # an earlier assignment this round gave the mirror to another dot: the
                # current assumptions contradict each other (the old set-based solver
                # silently overwrote the mirror here and missed this)
                raise _Contradiction
            if k not in blocks:
                blocks[k] = self._block(own, k)
            best = min((r - br) ** 2 + (c - bc) ** 2
                       for x in (i, m) for r, c in (divmod(x, C),) for br, bc in blocks[k])
            own[i] = own[m] = k
            self._keep_only(cand, i, k, queue)
            self._keep_only(cand, m, k, queue)
            cost += best
        return cost

    def _propagate(self, own, cand, queue, dirty, level: int, steps: list | None,
                   budget: float = float('inf')):
        """Returns (status, cost, rounds, max_level_used); status is 'contra', 'solved',
        'stuck', or 'over' (cost reached `budget`, so this branch cannot beat the caller's
        best). Mutates own/cand/queue/dirty."""
        N, mir = self.b.N, self.mir
        cost, rounds, used = 0.0, 0, 0
        while True:
            if not self._eliminate(cand, queue, dirty):
                return 'contra', cost, rounds, used
            if all(o >= 0 for o in own):
                return 'solved', cost, rounds, used
            try:
                c = self._assign_round(own, cand, queue)
            except _Contradiction:
                return 'contra', cost, rounds, used
            if c is not None:
                cost += c
                rounds += 1
                if steps is not None:
                    steps.append((0, c))
                if cost >= budget:
                    return 'over', cost, rounds, used
                continue
            found = None
            for lv in range(1, level + 1):
                best = None
                tried: set[tuple[int, int]] = set()
                for i in range(N):
                    if own[i] >= 0:
                        continue
                    x = cand[i]
                    while x:
                        low = x & -x
                        x ^= low
                        k = low.bit_length() - 1
                        m = mir[k][i]
                        key = (min(i, m), k)
                        if key in tried:
                            continue
                        tried.add(key)
                        o2, c2, q2 = own[:], cand[:], []
                        o2[i] = o2[m] = k
                        self._keep_only(c2, i, k, q2)
                        self._keep_only(c2, m, k, q2)
                        bound = best[0] if best is not None else float('inf')
                        st, cc, _, _ = self._propagate(o2, c2, q2, set(), lv - 1, None, bound)
                        if st == 'contra' and cc < bound:
                            best = (cc, i, k)
                if best is not None:
                    found = (lv, best)
                    break
            if found is None:
                return 'stuck', cost, rounds, used
            lv, (cc, i, k) = found
            step_cost = self.trial_mult ** lv * (1 + cc)
            bit = 1 << k
            cand[i] &= ~bit
            queue.append((i, k))  # the mirror loses k through the queue
            dirty.add(k)
            cost += step_cost
            rounds += 1
            used = max(used, lv)
            if steps is not None:
                steps.append((lv, step_cost))
            if cost >= budget:
                return 'over', cost, rounds, used

    def count_solutions(self, limit: int = 2) -> int:
        """Exact search (basic propagation + branching); counts solutions up to `limit`."""
        def rec(own, cand, queue, dirty) -> int:
            st, _, _, _ = self._propagate(own, cand, queue, dirty, 0, None)
            if st == 'contra':
                return 0
            if st == 'solved':
                return 1
            i = min((i for i in range(self.b.N) if own[i] < 0), key=lambda i: cand[i].bit_count())
            total = 0
            x = cand[i]
            while x:
                low = x & -x
                x ^= low
                k = low.bit_length() - 1
                o2, c2, q2 = own[:], cand[:], []
                m = self.mir[k][i]
                o2[i] = o2[m] = k
                self._keep_only(c2, i, k, q2)
                self._keep_only(c2, m, k, q2)
                total += rec(o2, c2, q2, set())
                if total >= limit:
                    break
            return total
        return rec(*self._initial())

    def solve_legacy(self) -> SolveResult:
        """The first rating: whole rounds of singles, cost = squared distance to the block
        as it was at the start of the round; trials pick the cheapest contradiction."""
        own, cand, queue, dirty = self._initial()
        steps: list[tuple[int, float]] = []
        st, cost, rounds, used = self._propagate(own, cand, queue, dirty, self.max_level, steps)
        return SolveResult(st, own, used, cost, rounds, steps)

    # --- human-order rating (2026-11-21)
    def _dist_map(self, own: list[int], k: int) -> list[int]:
        """Grid distance from every cell to the nearest cell owned by dot k."""
        nbrs = self.b.nbrs
        dist = [-1] * self.b.N
        frontier = [i for i, o in enumerate(own) if o == k]
        for i in frontier:
            dist[i] = 0
        d = 0
        while frontier:
            d += 1
            nxt = []
            for x in frontier:
                for y in nbrs[x]:
                    if dist[y] < 0:
                        dist[y] = d
                        nxt.append(y)
            frontier = nxt
        return dist

    def _trial_order(self, own, cand) -> list[tuple[int, int]]:
        """Candidates (cell, dot) in the order a person would try them: cells with the fewest
        candidates first, then the ones nearest that dot's block."""
        mir, dmaps, out, seen = self.mir, {}, [], set()
        for i in range(self.b.N):
            if own[i] >= 0:
                continue
            x = cand[i]
            n = x.bit_count()
            while x:
                low = x & -x
                x ^= low
                k = low.bit_length() - 1
                m = mir[k][i]
                key = (min(i, m), k)
                if key in seen:
                    continue
                seen.add(key)
                if k not in dmaps:
                    dmaps[k] = self._dist_map(own, k)
                out.append((n, min(dmaps[k][i], dmaps[k][m]), i, k))
        out.sort()
        return [(i, k) for _, _, i, k in out]

    def _find_trial(self, own, cand, level: int):
        """The first trial, in human order, that leads to a contradiction using at most
        `level` nested trials: (level used, tries, cell, dot), or None."""
        order = self._trial_order(own, cand)
        for lv in range(1, level + 1):
            for tries, (i, k) in enumerate(order, 1):
                m = self.mir[k][i]
                o2, c2, q2 = own[:], cand[:], []
                o2[i] = o2[m] = k
                self._keep_only(c2, i, k, q2)
                self._keep_only(c2, m, k, q2)
                if self._settle(o2, c2, q2, set(), lv - 1)[0] == 'contra':
                    return lv, tries, i, k
        return None

    def _assign_all(self, own, cand, queue) -> bool:
        """Assign every single (and its mirror) at once. Raises _Contradiction."""
        did = False
        for i in range(self.b.N):
            if own[i] >= 0 or cand[i] & (cand[i] - 1):
                continue
            k = cand[i].bit_length() - 1
            m = self.mir[k][i]
            if not cand[m] >> k & 1:
                raise _Contradiction
            own[i] = own[m] = k
            self._keep_only(cand, i, k, queue)
            self._keep_only(cand, m, k, queue)
            did = True
        return did

    def _path_forced(self, own, cand) -> list[tuple[int, int]]:
        """The path rule (2026-11-23, from a player's explanation): a cell of dot k must reach
        k's core through cells that can still be k, so a cell lying on every such path must
        be k too. Returns those (cell, k), from the cells owned by k but not yet joined to its
        core by owned cells. One BFS per candidate cell: fine for 15x15."""
        nbrs, N, out = self.b.nbrs, self.b.N, []
        for k in range(self.D):
            bit, core = 1 << k, self.cores[k]

            def grow(seen, ok):
                st = list(seen)
                while st:
                    a = st.pop()
                    for b in nbrs[a]:
                        if b not in seen and ok(b):
                            seen.add(b)
                            st.append(b)
                return seen

            block = grow(set(core), lambda b: own[b] == k)
            loose = [x for x in range(N) if own[x] == k and x not in block]
            if not loose:
                continue
            for y in grow(set(block), lambda b: cand[b] & bit):
                if own[y] >= 0:
                    continue
                r = grow(set(block), lambda b: b != y and cand[b] & bit)
                if any(x not in r for x in loose):
                    out.append((y, k))
        return out

    def _settle(self, own, cand, queue, dirty, level: int) -> tuple[str, int]:
        """Propagate in whole rounds, with human-order trials up to `level`.
        Returns (status, rounds): 'contra' | 'solved' | 'stuck'."""
        rounds = 0
        while True:
            if not self._eliminate(cand, queue, dirty):
                return 'contra', rounds
            if all(o >= 0 for o in own):
                return 'solved', rounds
            try:
                if self._assign_all(own, cand, queue):
                    rounds += 1
                    continue
            except _Contradiction:
                return 'contra', rounds
            if self.paths:
                forced = self._path_forced(own, cand)
                for y, k in forced:
                    if not cand[y] >> k & 1:
                        return 'contra', rounds
                    self._keep_only(cand, y, k, queue)
                if forced:
                    rounds += 1
                    continue
            hit = self._find_trial(own, cand, level) if level > 0 else None
            if hit is None:
                return 'stuck', rounds
            _, _, i, k = hit
            cand[i] &= ~(1 << k)
            queue.append((i, k))
            dirty.add(k)
            rounds += 1

    def _singles(self, own, cand) -> dict[tuple[int, int], int]:
        """Forced pairs: (min(cell, mirror), dot) -> cell, for cells with one candidate left."""
        mir, out = self.mir, {}
        for i in range(self.b.N):
            if own[i] < 0 and not cand[i] & (cand[i] - 1):
                k = cand[i].bit_length() - 1
                out.setdefault((min(i, mir[k][i]), k), i)
        return out

    def _forced(self, own, cand) -> dict[tuple[int, int], int]:
        """_singles plus the cells the path rule forces (when on): a player draws the path
        right after placing a cell away from its dot's block, so they count like any other."""
        out = self._singles(own, cand)
        if self.paths:
            for y, k in self._path_forced(own, cand):
                out.setdefault((min(y, self.mir[k][y]), k), y)
        return out

    def _walk(self, own, cand, queue, dirty, steps=None, after=()) -> tuple[str, int, float]:
        """Basic deductions, chain by chain. Placing a cell (and its mirror) often forces a
        cell right next to one of them: following that is free. When nothing next to the last
        placement is forced, the next forced cell has to be found somewhere on the board: a new
        chain, costing (distance to its dot's block) / (forced pairs available). `after`: cells
        just placed (a trial), whose neighbours continue that placement. Returns
        (status, chains, cost), status 'contra' | 'solved' | 'stuck'."""
        nbrs, mir = self.b.nbrs, self.mir
        chains, cost, fresh, dmaps = 0, 0.0, None, {}
        while True:
            if not self._eliminate(cand, queue, dirty):
                return 'contra', chains, cost
            if all(o >= 0 for o in own):
                return 'solved', chains, cost
            pairs = self._forced(own, cand)
            if not pairs:
                return 'stuck', chains, cost
            if fresh is None:
                near = {j for x in after for j in nbrs[x]} | set(after)
                fresh = {p for p, j in pairs.items() if j in near or mir[p[1]][j] in near}
            pool = {p: i for p, i in pairs.items() if p in fresh}
            if not pool:
                pool = pairs
            best = None
            for (_, k), i in pool.items():
                if k not in dmaps:
                    dmaps[k] = self._dist_map(own, k)
                d = min(dmaps[k][i], dmaps[k][mir[k][i]])
                if best is None or d < best[0]:
                    best = (d, i, k)
            d, i, k = best
            if pool is pairs:
                chains += 1
                c = d / len(pairs)
                cost += c
                if steps is not None:
                    steps.append((0, c))
            m = mir[k][i]
            if not cand[m] >> k & 1:
                return 'contra', chains, cost
            own[i] = own[m] = k
            self._keep_only(cand, i, k, queue)
            self._keep_only(cand, m, k, queue)
            dmaps.pop(k, None)
            if not self._eliminate(cand, queue, dirty):
                return 'contra', chains, cost
            near = set(nbrs[i]) | set(nbrs[m]) | {i, m}
            fresh = {p for p, j in self._forced(own, cand).items()
                     if p not in pairs and (j in near or mir[p[1]][j] in near)}

    def solve(self) -> SolveResult:
        """Rate like a person (2026-11-22). Basic deductions cost only where a chain has to be
        started (see _walk). When nothing is forced, take the first candidate, in human order,
        whose trial ends in a contradiction; its depth is the number of chains followed to get
        there, and it costs 1 + depth. A trial that itself needs a trial has depth -1 and costs
        trial_mult**level. `rounds` counts deduction waves (whole rounds of singles)."""
        own, cand, queue, dirty = self._initial()
        rounds = self._settle(own[:], cand[:], queue[:], set(dirty), self.max_level)[1]
        steps: list[tuple[int, float]] = []
        depths: list[int] = []
        cost, used = 0.0, 0
        while True:
            st, _, c = self._walk(own, cand, queue, dirty, steps)
            cost += c
            if st != 'stuck':
                return SolveResult(st, own, used, cost, rounds, steps, depths)
            hit = self._find_trial(own, cand, self.max_level)
            if hit is None:
                return SolveResult('stuck', own, used, cost, rounds, steps, depths)
            lv, _, i, k = hit
            m = self.mir[k][i]
            if lv == 1:
                o2, c2, q2 = own[:], cand[:], []
                o2[i] = o2[m] = k
                self._keep_only(c2, i, k, q2)
                self._keep_only(c2, m, k, q2)
                depth = self._walk(o2, c2, q2, set(), after=(i, m))[1]
                c = 1 + depth
            else:
                depth, c = -1, self.trial_mult ** lv
            depths.append(depth)
            cand[i] &= ~(1 << k)
            queue.append((i, k))
            dirty.add(k)
            cost += c
            used = max(used, lv)
            steps.append((lv, c))


TIERS = ('normal', 'hard', 'expert')

# Levels offered per board size: code letter -> [label, tiers it accepts]. A tier too rare at
# a size is folded into its neighbour (7x7: hard 2.5%, expert 1.5% -> one Hard). Shares of
# first unique puzzles per seed (2026-11-25): 7x7 96/2.5/1.5%, 10x10 81/12/7%, 15x15 20/16/64%.
# web/vite.config.js reads this JSON; changing it changes what level codes mean (bump the version).
LEVELS_JSON = '''{
  "7": {"n": ["Normal", ["normal"]], "h": ["Hard", ["hard", "expert"]]},
  "10": {"n": ["Normal", ["normal"]], "h": ["Hard", ["hard"]], "e": ["Expert", ["expert"]]},
  "15": {"n": ["Normal", ["normal"]], "h": ["Hard", ["hard"]], "e": ["Expert", ["expert"]]}
}'''
LEVELS = {int(n): v for n, v in json.loads(LEVELS_JSON).items()}


def tier(R: int, C: int, dots: list[Dot]) -> str:
    """Difficulty tier of a unique puzzle (2026-11-25): 'normal' if basic deductions without
    the path rule finish it (= Simon Tatham's Normal, puzzle-galaxies.com Normal), 'hard' if
    they do with the path rule, 'expert' if it needs trials even then. No trials are run."""
    s = Solver(R, C, dots, paths=False)
    own, cand, queue, dirty = s._initial()
    if s._settle(own, cand, queue, dirty, 0)[0] == 'solved':
        return 'normal'
    s.paths = True
    return 'hard' if s._settle(own, cand, [], set(range(s.D)), 0)[0] == 'solved' else 'expert'


def make_puzzle(n: int, seed: int, level: str | None = None) -> tuple[Puzzle, int]:
    """The puzzle a share code stands for (the web worker and logtool both use this).
    Draw from random.Random(seed) until a puzzle has exactly one solution and, when `level`
    (a letter of LEVELS[n]) is given, its tier is one that level accepts. Returns (puzzle,
    tries). Codes without a level (version 2 before 2026-11-25) keep their puzzles."""
    rng = random.Random(seed)
    accept = LEVELS[n][level][1] if level else None
    tries = 0
    while True:
        tries += 1
        pz = generate_sim(n, n, rng)
        if accept is None:
            if Solver(n, n, pz.dots).count_solutions(2) == 1:
                return pz, tries
            continue
        # The tier first: it is cheap, and a puzzle basic deductions finish has one solution
        # (they are sound), so only 'expert' needs the exact count. A puzzle with several
        # solutions always comes out 'expert'. Same puzzles as checking uniqueness first.
        t = tier(n, n, pz.dots)
        if t in accept and (t != 'expert' or Solver(n, n, pz.dots).count_solutions(2) == 1):
            return pz, tries


def solve(R: int, C: int, dots: list[Dot], **kw) -> SolveResult:
    return Solver(R, C, dots, **kw).solve()


# --------------------------------------------------------------------------- rendering

def render(R: int, C: int, dots: list[Dot], owner: list[int] | None = None) -> str:
    """ASCII view. Without owner: puzzle (outer frame + dots). With owner: region borders."""
    H, W = 2 * R + 1, 2 * C + 1

    def own(r, c):
        return owner[r * C + c] if owner is not None and 0 <= r < R and 0 <= c < C else -2

    def hwall(y, x):  # horizontal segment above cell row y//2, column x//2
        r, c = y // 2, x // 2
        return r == 0 or r == R or (owner is not None and own(r - 1, c) != own(r, c))

    def vwall(y, x):
        r, c = y // 2, x // 2
        return c == 0 or c == C or (owner is not None and own(r, c - 1) != own(r, c))

    dotset = {(d[0] + 1, d[1] + 1) for d in dots}
    lines = []
    for y in range(H):
        row = []
        for x in range(W):
            width = 1 if x % 2 == 0 else 3
            if y % 2 == 0 and x % 2 == 0:
                walls = [y > 0 and vwall(y - 1, x), y < H - 1 and vwall(y + 1, x),
                         x > 0 and hwall(y, x - 1), x < W - 1 and hwall(y, x + 1)]
                s = '+' if any(walls) else '.'
            elif y % 2 == 0:
                s = '---' if hwall(y, x) else '   '
            elif x % 2 == 0:
                s = '|' if vwall(y, x) else ' '
            else:
                s = '   '
            if (y, x) in dotset:
                s = 'o' if width == 1 else s[0] + 'o' + s[2]
            row.append(s)
        lines.append(''.join(row))
    return '\n'.join(lines)
