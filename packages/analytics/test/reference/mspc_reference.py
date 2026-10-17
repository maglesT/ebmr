"""Offline reference values for the slice 6A-3 method MSPC.PCA (Phase 6A; D-6A-11, D-6A-17; interfaces section 6).

Run:  python3 mspc_reference.py > mspc-reference.json
Tool: Python 3.13, NumPy 2.2.6, SciPy 1.14.1 (recorded in the output's "tool" field).

The data sets are drawn with NumPy's PCG64 generator from a fixed seed and written as decimal text, so the
TypeScript tests read exactly the values the references were computed from. Every reference is computed here
independently of @ebmr/analytics: NumPy's SVD (numpy.linalg.svd) and SciPy's distributions (beta, f, norm, chi2).

The definitions (the textbook ones, paraphrased):
  - autoscaling: each variable centred on its mean and divided by its sample standard deviation (n - 1);
  - PCA by the SVD of the autoscaled matrix; eigenvalue j is s_j^2 / (n - 1); a component's loading vector is signed so
    that its element of largest magnitude is positive;
  - components: the fewest reaching the cumulative explained-variance target, at most the maximum and at most p - 1;
  - Hotelling's T-squared: the sum over the kept components of score^2 / eigenvalue;
  - Q (SPE): the squared norm of the residual of the autoscaled vector after projection on the kept components;
  - the T-squared limit of a reference batch: (n - 1)^2 / n times the beta quantile with shapes k / 2 and (n - k - 1) / 2;
  - the T-squared limit of a new batch: k (n - 1)(n + 1) / (n (n - k)) times the F quantile with k and n - k degrees;
  - the Q limit: Jackson and Mudholkar from the residual eigenvalues (theta 1 to 3, h0), and Box's g chi-square
    approximation when h0 is not positive;
  - contributions: to T-squared, variable j gives x_j times the sum over components of score_a p_ja / eigenvalue_a (they
    sum to T-squared); to Q, variable j gives its squared residual (they sum to Q).
"""
import json
import math
import sys

import numpy as np
import scipy
from scipy import stats

rng = np.random.default_rng(20261018)


def text(matrix, digits):
    return [[f"{v:.{digits}f}" for v in row] for row in matrix]


def num(texts):
    return np.array([[float(t) for t in row] for row in texts])


def fit(x, target=0.9, max_k=5, alpha=0.99):
    n, p = x.shape
    mean = x.mean(axis=0)
    sd = x.std(axis=0, ddof=1)
    z = (x - mean) / sd
    _, s, vt = np.linalg.svd(z, full_matrices=True)
    lam = np.zeros(p)
    lam[: len(s)] = s ** 2 / (n - 1)
    v = vt.T.copy()
    for j in range(p):
        big = int(np.argmax(np.abs(v[:, j])))
        if v[big, j] < 0:
            v[:, j] = -v[:, j]
    ratio = lam / lam.sum()
    cum = np.cumsum(ratio)
    k = int(np.searchsorted(cum, target - 1e-12) + 1)
    k = max(1, min(k, max_k, p - 1))
    pk = v[:, :k]
    t2_ref = (n - 1) ** 2 / n * stats.beta.ppf(alpha, k / 2, (n - k - 1) / 2)
    t2_new = k * (n - 1) * (n + 1) / (n * (n - k)) * stats.f.ppf(alpha, k, n - k)
    q = q_limit(lam[k:], alpha)
    return {"n": n, "p": p, "mean": mean, "sd": sd, "lam": lam, "ratio": ratio, "k": k, "P": pk, "t2Ref": t2_ref, "t2New": t2_new, "q": q}


def q_limit(residual, alpha):
    th1, th2, th3 = (float(np.sum(residual ** i)) for i in (1, 2, 3))
    h0 = 1 - 2 * th1 * th3 / (3 * th2 ** 2)
    c = stats.norm.ppf(alpha)
    if h0 > 0:
        inner = c * math.sqrt(2 * th2 * h0 ** 2) / th1 + 1 + th2 * h0 * (h0 - 1) / th1 ** 2
        if inner > 0:
            return {"limit": th1 * inner ** (1 / h0), "method": "JACKSON_MUDHOLKAR", "theta": [th1, th2, th3], "h0": h0}
    g = th2 / th1
    h = th1 ** 2 / th2
    return {"limit": g * stats.chi2.ppf(alpha, h), "method": "BOX", "theta": [th1, th2, th3], "h0": h0}


def score(m, x):
    z = (x - m["mean"]) / m["sd"]
    t = z @ m["P"]
    lk = m["lam"][: m["k"]]
    t2 = float(np.sum(t ** 2 / lk))
    e = z - t @ m["P"].T
    q = float(np.sum(e ** 2))
    c_t2 = z * (m["P"] @ (t / lk))
    c_q = e ** 2
    return {"scores": list(t), "t2": t2, "q": q, "t2Contributions": list(c_t2), "qContributions": list(c_q)}


def described(m):
    return {
        "n": m["n"], "mean": list(m["mean"]), "sd": list(m["sd"]), "eigenvalues": list(m["lam"]), "explained": list(m["ratio"]), "components": m["k"],
        "loadings": [list(r) for r in m["P"]], "t2Reference": m["t2Ref"], "t2New": m["t2New"], "q": m["q"]["limit"], "qMethod": m["q"]["method"],
    }


out = {"tool": f"Python {sys.version.split()[0]}, NumPy {np.__version__}, SciPy {scipy.__version__}", "seed": 20261018}

# Basic: 24 reference batches of 4 variables driven by two latent factors, and 3 new batches (one ordinary, one with a
# shifted mean along the model, one breaking the correlation of variables 1 and 2).
f = rng.normal(0, 1, (27, 2))
load = np.array([[1.0, 0.2], [0.9, -0.1], [0.1, 1.0], [-0.3, 0.8]])
raw = f @ load.T + rng.normal(0, 0.25, (27, 4))
raw = raw * np.array([0.5, 0.04, 0.1, 2.0]) + np.array([9.0, 4.2, 7.5, 60.0])
raw[25] = raw[25] + np.array([0.9, 0.07, 0.0, 0.0])
raw[26] = np.array([9.8, 4.12, 7.5, 60.0])
basic_t = text(raw, 4)
x = num(basic_t)
m = fit(x[:24])
out["basic"] = {
    "reference": basic_t[:24], "new": basic_t[24:], "model": described(m),
    "referenceScores": [score(m, r) for r in x[:24]], "newScores": [score(m, r) for r in x[24:]],
}

# Trim: 25 batches of 3 variables (variables 2 and 3 correlated), batch 25 breaks the correlation. The first fit's
# Phase I limits leave it out; the refit is on the other 24.
g = rng.normal(0, 1, 25)
trim = np.column_stack([rng.normal(0, 1, 25), 0.95 * g + 0.3 * rng.normal(0, 1, 25), 0.95 * g + 0.3 * rng.normal(0, 1, 25)])
trim[24] = [0.2, 1.6, -1.6]
trim = trim * np.array([0.1, 0.4, 0.04]) + np.array([7.5, 9.0, 4.2])
trim_t = text(trim, 3)
xt = num(trim_t)
first = fit(xt)
first_scores = [score(first, r) for r in xt]
left_out = [i for i, s in enumerate(first_scores) if s["t2"] > first["t2Ref"] or s["q"] > first["q"]["limit"]]
kept = [i for i in range(25) if i not in left_out]
second = fit(xt[kept])
out["trim"] = {
    "batches": trim_t, "first": described(first), "firstScores": first_scores, "leftOut": left_out, "refit": described(second),
    "leftOutScores": [score(second, xt[i]) for i in left_out],
}

# Limits at chosen points.
out["t2Reference"] = {f"{n}|{k}": (n - 1) ** 2 / n * stats.beta.ppf(0.99, k / 2, (n - k - 1) / 2) for n, k in ((15, 1), (15, 3), (24, 2), (50, 5), (100, 4))}
out["t2New"] = {f"{n}|{k}": k * (n - 1) * (n + 1) / (n * (n - k)) * stats.f.ppf(0.99, k, n - k) for n, k in ((15, 1), (15, 3), (24, 2), (50, 5), (100, 4))}
out["t2New95"] = {"24|2": 2 * 23 * 25 / (24 * 22) * stats.f.ppf(0.95, 2, 22)}
out["qLimit"] = {
    "one": q_limit(np.array([0.12]), 0.99),
    "three": q_limit(np.array([0.3, 0.1, 0.05]), 0.99),
    "spread": q_limit(np.array([1.0] + [0.1] * 50), 0.99),
}

json.dump(out, sys.stdout, indent=1, default=float)
print()
