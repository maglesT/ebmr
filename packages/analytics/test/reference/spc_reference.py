"""Offline reference values for the slice 6A-2 methods (Phase 6A; D-6A-17; interfaces section 6).

Run:  python3 spc_reference.py > spc-reference.json
Tool: Python 3.13, NumPy 2.2.6, SciPy 1.14.1 (recorded in the output's "tool" field).

The data sets are drawn with NumPy's PCG64 generator from a fixed seed and written as decimal text, so the
TypeScript tests read exactly the values the references were computed from. Every reference is computed here
independently of @ebmr/analytics: SciPy's distributions (norm, t, chi2), scipy.stats.linregress,
scipy.stats.fisher_exact, scipy.stats.false_discovery_control and scipy.stats.anderson.
"""
import json
import math
import sys

import numpy as np
import scipy
from scipy import stats

rng = np.random.default_rng(20261017)


def text(values, digits):
    return [f"{v:.{digits}f}" for v in values]


def num(texts):
    return np.array([float(t) for t in texts])


D2 = 2 / math.sqrt(math.pi)
D3 = math.sqrt(2 * (1 - 2 / math.pi))
out = {"tool": f"Python {sys.version.split()[0]}, NumPy {np.__version__}, SciPy {scipy.__version__}", "seed": 20261017}

# I-MR: 30 values of N(10, 1), a +1.5 shift from the 25th; Phase I = the first 20.
imr_t = text(np.concatenate([rng.normal(10, 1, 24), rng.normal(11.5, 1, 6)]), 3)
x = num(imr_t)
p1 = x[:20]
mr = np.abs(np.diff(p1))
sigma = mr.mean() / D2
centre = p1.mean()
out["imr"] = {
    "values": imr_t, "phaseOne": 20, "centre": centre, "sigma": sigma, "upper": centre + 3 * sigma, "lower": centre - 3 * sigma,
    "mrMean": mr.mean(), "mrUpper": (1 + 3 * D3 / D2) * mr.mean(), "z": list((x - centre) / sigma),
}

# Xbar-S: 25 subgroups of 5 readings of N(50, 2); Phase I = the first 20.
groups = [text(rng.normal(50, 2, 5), 2) for _ in range(25)]
g = [num(t) for t in groups]
c4_5 = math.sqrt(2 / 4) * math.gamma(5 / 2) / math.gamma(2)
means = np.array([v.mean() for v in g])
sds = np.array([v.std(ddof=1) for v in g])
sigma_x = float(np.mean(sds[:20] / c4_5))
centre_x = float(means[:20].mean())
out["xbarS"] = {
    "groups": groups, "phaseOne": 20, "c4": c4_5, "centre": centre_x, "sigma": sigma_x,
    "upper": centre_x + 3 * sigma_x / math.sqrt(5), "lower": centre_x - 3 * sigma_x / math.sqrt(5),
    "sUpper": sigma_x * (c4_5 + 3 * math.sqrt(1 - c4_5 ** 2)), "sLower": max(0.0, sigma_x * (c4_5 - 3 * math.sqrt(1 - c4_5 ** 2))),
    "means": list(means), "sds": list(sds),
}
out["c4"] = {str(n): math.sqrt(2 / (n - 1)) * math.gamma(n / 2) / math.gamma((n - 1) / 2) for n in (2, 3, 5, 10, 25, 50)}

# Capability: 40 values of N(10, 0.8), specification 7 to 13.
cap_t = text(rng.normal(10.2, 0.8, 40), 3)
c = num(cap_t)
n = len(c)
m = c.mean()
s = c.std(ddof=1)
w = np.abs(np.diff(c)).mean() / D2
z975 = stats.norm.ppf(0.975)


def bissell(k):
    se = math.sqrt(1 / (9 * n) + k * k / (2 * (n - 1)))
    return [k - z975 * se, k + z975 * se]


ppk = min(13 - m, m - 7) / (3 * s)
cpk = min(13 - m, m - 7) / (3 * w)
y = np.sort((c - m) / s)
i = np.arange(1, n + 1)
a2 = -n - np.sum((2 * i - 1) * (stats.norm.logcdf(y) + stats.norm.logsf(y[::-1]))) / n
a_adj = a2 * (1 + 0.75 / n + 2.25 / n ** 2)
if a_adj >= 0.6:
    p_ad = math.exp(1.2937 - 5.709 * a_adj + 0.0186 * a_adj ** 2)
elif a_adj >= 0.34:
    p_ad = math.exp(0.9177 - 4.279 * a_adj - 1.38 * a_adj ** 2)
elif a_adj >= 0.2:
    p_ad = 1 - math.exp(-8.318 + 42.796 * a_adj - 59.938 * a_adj ** 2)
else:
    p_ad = 1 - math.exp(-13.436 + 101.14 * a_adj - 223.73 * a_adj ** 2)
out["capability"] = {
    "values": cap_t, "lower": "7", "upper": "13", "mean": m, "sigmaOverall": s, "sigmaWithin": w,
    "ppk": ppk, "ppkInterval": bissell(ppk), "cpk": cpk, "cpkInterval": bissell(cpk),
    "andersonDarling": float(a2), "andersonDarlingScipy": float(stats.anderson(c, dist="norm").statistic),
    "andersonDarlingAdjusted": float(a_adj), "andersonDarlingP": p_ad,
}
# A skewed set (exponential): Anderson-Darling should reject normality.
skew_t = text(rng.exponential(1.0, 40) + 5, 3)
k = num(skew_t)
yk = np.sort((k - k.mean()) / k.std(ddof=1))
a2k = -40 - np.sum((2 * i - 1) * (stats.norm.logcdf(yk) + stats.norm.logsf(yk[::-1]))) / 40
out["skewed"] = {"values": skew_t, "andersonDarling": float(a2k), "andersonDarlingScipy": float(stats.anderson(k, dist="norm").statistic)}

# Drift: 10 values with a rising trend; linregress on index 0..9.
drift_t = text(7.5 + 0.05 * np.arange(10) + rng.normal(0, 0.03, 10), 3)
d = num(drift_t)
lr = stats.linregress(np.arange(10), d)
out["drift"] = {"values": drift_t, "slope": lr.slope, "intercept": lr.intercept, "p": lr.pvalue, "t": lr.slope / lr.stderr}
ew = []
zz = 7.5
for v in d:
    zz = 0.2 * v + 0.8 * zz
    ew.append(zz)
out["ewma"] = {"values": drift_t, "centre": 7.5, "lambda": 0.2, "z": ew}

# Distribution functions at chosen points.
out["normalCdf"] = {str(v): float(stats.norm.cdf(v)) for v in (-8.0, -3.0, -1.96, -0.5, 0.0, 0.5, 1.0, 2.5, 6.0)}
out["logNormalCdf"] = {str(v): float(stats.norm.logcdf(v)) for v in (-30.0, -12.0, -8.0)}
out["tTwoSided"] = {f"{t}|{df}": float(2 * stats.t.sf(abs(t), df)) for t, df in ((2.306, 8), (1.0, 8), (4.5, 8), (-2.0, 20), (0.3, 3))}

# Rates: Wilson, Garwood, Fisher (one-sided, greater), Benjamini-Hochberg.
def wilson(k, n):
    z = z975
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [max(0.0, centre - half), min(1.0, centre + half)]


out["wilson"] = {f"{k}/{n}": wilson(k, n) for k, n in ((81, 263), (15, 148), (0, 20), (9, 10), (6, 20), (10, 10))}
out["garwood"] = {str(k): [0.0 if k == 0 else stats.chi2.ppf(0.025, 2 * k) / 2, stats.chi2.ppf(0.975, 2 * k + 2) / 2] for k in (0, 1, 2, 5, 9, 30)}
out["fisher"] = {",".join(map(str, t)): float(stats.fisher_exact([[t[0], t[1]], [t[2], t[3]]], alternative="greater").pvalue)
                 for t in ((3, 1, 1, 3), (9, 1, 6, 14), (3, 7, 12, 8), (5, 0, 10, 15), (0, 5, 4, 11))}
bh_p = [0.0001, 0.0004, 0.0019, 0.0095, 0.0201, 0.0278, 0.0298, 0.0344, 0.0459, 0.3240, 0.4262, 0.5719, 0.6528, 0.7590, 1.000]
out["benjaminiHochberg"] = {"p": bh_p, "q": list(map(float, stats.false_discovery_control(bh_p, method="bh")))}

json.dump(out, sys.stdout, indent=1, default=float)
print()
