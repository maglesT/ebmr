"""Offline reference values for the golden batch profile (slice 6A-6, method GBP.DTW_BAND).

Run with CPython 3 (standard library only): python3 profile-dtw.py > profile-dtw.json
Recorded tool: the interpreter version is written into the output ("tool").

Five curves of 16 points (a ramp, a plateau with a wave, seeded noise and a delay per curve); the DTW distance of every
pair with a Sakoe-Chiba band of 3 points (symmetric step pattern, squared local cost, distance = square root of the
least cumulative cost); the medoid (least sum of distances, lowest index on a tie); each curve aligned to the medoid
(mean of the curve points the warping path pairs with each medoid point; the path traced back preferring the
diagonal, then a step in the curve, then a step in the medoid); the pointwise 5th and 95th percentiles (linear
interpolation between order statistics, Hyndman and Fan type 7).
"""
import json
import math
import random
import sys

N, R = 16, 3
rng = random.Random(6)
curves = []
for c in range(5):
    delay = c % 3
    row = []
    for i in range(N):
        x = max(0, i - delay) / (N - 1)
        ramp = min(1.0, x / 0.2)
        row.append(round(10 * ramp + math.sin(4 * math.pi * x) + (rng.random() - 0.5) * 0.4, 6))
    curves.append(row)


def dtw(a, b, r):
    inf = float("inf")
    n, m = len(a), len(b)
    d = [[inf] * m for _ in range(n)]
    for i in range(n):
        for j in range(max(0, i - r), min(m - 1, i + r) + 1):
            c = (a[i] - b[j]) ** 2
            if i == 0 and j == 0:
                d[i][j] = c
                continue
            best = min(d[i - 1][j - 1] if i > 0 and j > 0 else inf, d[i - 1][j] if i > 0 else inf, d[i][j - 1] if j > 0 else inf)
            d[i][j] = c + best
    path = [(n - 1, m - 1)]
    i, j = n - 1, m - 1
    while i > 0 or j > 0:
        diag = d[i - 1][j - 1] if i > 0 and j > 0 else inf
        up = d[i - 1][j] if i > 0 else inf
        left = d[i][j - 1] if j > 0 else inf
        if diag <= up and diag <= left:
            i, j = i - 1, j - 1
        elif up <= left:
            i -= 1
        else:
            j -= 1
        path.append((i, j))
    path.reverse()
    return math.sqrt(d[n - 1][m - 1]), path


def pct(xs, p):
    s = sorted(xs)
    h = (len(s) - 1) * p / 100
    lo = math.floor(h)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (h - lo) * (s[hi] - s[lo])


dist = [[dtw(a, b, R)[0] for b in curves] for a in curves]
sums = [sum(v for k, v in enumerate(row) if k != i) for i, row in enumerate(dist)]
medoid = min(range(len(curves)), key=lambda i: (sums[i], i))
aligned = []
for c in curves:
    _, path = dtw(c, curves[medoid], R)
    s, k = [0.0] * N, [0] * N
    for i, j in path:
        s[j] += c[i]
        k[j] += 1
    aligned.append([s[j] / k[j] for j in range(N)])
low = [pct([a[j] for a in aligned], 5) for j in range(N)]
high = [pct([a[j] for a in aligned], 95) for j in range(N)]
json.dump({"tool": "CPython " + sys.version.split()[0] + " (standard library)", "radius": R, "curves": curves, "distances": dist, "medoid": medoid,
           "aligned": aligned, "low": low, "high": high}, sys.stdout, indent=1)
sys.stdout.write("\n")
