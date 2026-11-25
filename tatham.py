"""Other sites' difficulty rules, for comparison with ours (research only; the game doesn't use it).

tatham_normal: Simon Tatham's Galaxies 'Normal' solver, ported from galaxies.c in Simon
Tatham's Portable Puzzle Collection (MIT licence, (c) Simon Tatham and contributors).

It runs galaxies.c solver_state with maxdiff = NORMAL: solver_obvious, then repeat lines_opposite / spaces_oneposs / expand_dots
until nothing changes. A puzzle is Normal if this finishes it; otherwise Tatham's generator
calls it Unreasonable (it needs solver_recurse, i.e. guessing).

Coordinates are Tatham's 'space' grid: (2R+1) x (2C+1), tiles at odd/odd, edges odd/even,
vertices even/even. Our dots (d0, d1) (doubled cell coordinates) sit at (d0+1, d1+1)."""


def tatham_normal(R, C, dots):
    SY, SX = 2 * R + 1, 2 * C + 1
    D = [(d0 + 1, d1 + 1) for d0, d1 in dots]
    tiles = [(y, x) for y in range(1, SY, 2) for x in range(1, SX, 2)]
    edge = set()
    for y in range(SY):
        for x in range(SX):
            if (y + x) % 2 == 1 and (y in (0, SY - 1) or x in (0, SX - 1)):
                edge.add((y, x))  # the outer frame
    own = {}

    def ingrid(p):
        return 0 < p[0] < SY - 1 and 0 < p[1] < SX - 1

    def opp(p, k):
        q = (2 * D[k][0] - p[0], 2 * D[k][1] - p[1])
        return q if ingrid(q) else None

    def assoc(t, k):
        """solver_add_assoc: -1 impossible, 0 no-op, 1 done."""
        if t in own:
            return 0 if own[t] == k else -1
        o = opp(t, k)
        if o is None or (o in own and own[o] != k):
            return -1
        own[t] = own[o] = k
        return 1

    def adj(t):
        """(edge, tile across it or None) for the four sides of tile t."""
        y, x = t
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            e, n = (y + dy, x + dx), (y + 2 * dy, x + 2 * dx)
            yield e, (n if ingrid(n) else None)

    # solver_obvious: tiles touching each dot
    for k, (dy, dx) in enumerate(D):
        for a in (-1, 0, 1):
            for b in (-1, 0, 1):
                t = (dy + a, dx + b)
                if t[0] % 2 == 1 and t[1] % 2 == 1 and ingrid(t):
                    if assoc(t, k) < 0:
                        return 'impossible'

    def lines_opposite():
        did = False
        for y in range(1, SY - 1):
            for x in range(1, SX - 1):
                if (y + x) % 2 == 0:
                    continue
                e = (y, x)
                ts = [(y - 1, x), (y + 1, x)] if y % 2 == 0 else [(y, x - 1), (y, x + 1)]
                if e not in edge and all(t in own for t in ts) and own[ts[0]] != own[ts[1]]:
                    edge.add(e)
                    did = True
                if e not in edge:
                    continue
                for t in ts:
                    if t not in own:
                        continue
                    k = own[t]
                    if opp(t, k) is None:
                        return -1
                    eo = (2 * D[k][0] - y, 2 * D[k][1] - x)
                    if eo not in edge:
                        edge.add(eo)
                        did = True
        # frame edges with an associated tile next to them mirror too
        for e in list(edge):
            if ingrid(e):
                continue
            y, x = e
            for t in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if t in own and t[0] % 2 == 1 and t[1] % 2 == 1:
                    k = own[t]
                    eo = (2 * D[k][0] - y, 2 * D[k][1] - x)
                    if eo not in edge:
                        edge.add(eo)
                        did = True
        return 1 if did else 0

    def spaces_oneposs():
        did = False
        for t in tiles:
            if t in own:
                continue
            eset, dot = 0, None
            ok = True
            for e, n in adj(t):
                if e in edge:
                    eset += 1
                    continue
                if n not in own or (dot is not None and own[n] != dot):
                    ok = False
                    break
                dot = own[n]
            if not ok:
                continue
            if eset == 4:
                return -1
            if assoc(t, dot) < 0:
                return -1
            did = True
        return 1 if did else 0

    def expand_dots():
        reach = {}
        for k, (dy, dx) in enumerate(D):
            if dy % 2 == 1 and dx % 2 == 1:
                seed = [(dy, dx), (dy, dx)]
            elif dy % 2 == 1:
                seed = [(dy, dx - 1), (dy, dx + 1)]
            elif dx % 2 == 1:
                seed = [(dy - 1, dx), (dy + 1, dx)]
            else:
                seed = [(dy - 1, dx - 1), (dy + 1, dx + 1)]
            mark = set(seed)
            lst = list(seed)
            start, end = 0, len(lst)
            while True:
                for i in range(start, end, 2):
                    t1 = lst[i]
                    for e, n in adj(t1):
                        if e in edge or n is None or n in mark:
                            continue
                        n2 = opp(n, k)
                        if n2 is None:
                            mark.add(n)
                            continue
                        if all(z not in own or own[z] == k for z in (n, n2)):
                            lst += [n, n2]
                        mark.add(n)
                        mark.add(n2)
                if len(lst) > end:
                    start, end = end, len(lst)
                else:
                    break
            for t in set(lst):
                if t not in own:
                    reach.setdefault(t, set()).add(k)
        did = False
        for t in tiles:
            if t in own:
                continue
            ks = reach.get(t)
            if not ks:
                return -1
            if len(ks) == 1:
                r = assoc(t, next(iter(ks)))
                if r < 0:
                    return -1
                did = did or r > 0
        return 1 if did else 0

    while True:
        for step in (lines_opposite, spaces_oneposs, expand_dots):
            r = step()
            if r < 0:
                return 'impossible'
            if r > 0:
                break
        else:
            break
    return 'normal' if len(own) == len(tiles) else 'unreasonable'


def puzzle_galaxies_dots(task: str, w: int):
    """Dots of a puzzle-galaxies.com puzzle from its page's `task` string: positions on the
    (2w-1) x (2w-1) grid of centres/edges/corners, row by row; a letter skips that many
    positions (a = 0) and puts a dot, 'z' skips 25 without one. Gives our (d0, d1)."""
    W, pos, dots = 2 * w - 1, 0, []
    for ch in task:
        if ch == 'z':
            pos += 25
            continue
        pos += ord(ch) - 97
        dots.append((pos // W, pos % W))
        pos += 1
    return dots
