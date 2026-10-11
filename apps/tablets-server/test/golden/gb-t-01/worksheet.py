"""GB-T-01 hand worksheet (independent of the TypeScript and SQL code): exact rationals, roundings as the
tablets spec states them (targets of an active UP to the readability, the compensating excipient HALF_UP)."""
from fractions import Fraction as F
import math, json

def up(x, step):
    k = math.ceil(x / step)
    return k * step
def half_up(x, step):
    k = (x / step)
    n = math.floor(k + F(1, 2))
    return n * step
def txt(x, scale):
    q = F(10) ** -scale
    v = x / q
    assert v.denominator == 1, (x, scale)
    s = str(abs(v.numerator)).rjust(scale + 1, '0')
    return ('-' if x < 0 else '') + (s if scale == 0 else s[:-scale] + '.' + s[-scale:])
def show(x, scale):
    return txt(half_up(x, F(10) ** -scale), scale)

R = F('0.001')  # balance readability, kg
out = {}

# Formula (invented, decision 0006 part 3), per tablet; 2,00,000 tablets.
N = 200000
base_mg = F(250)
mw_form, mw_base = F('322.33'), F('300.35')
f = mw_form / mw_base
api_base_kg = base_mg * N / 10**6  # 50 kg base
qstd = api_base_kg * f
# API lot A: assay 99.20 % on the anhydrous basis, water 0.80 %
asis = F('99.20') * (100 - F('0.80')) / 100
qact = api_base_kg * f * 100 / asis
api_target = up(qact, R)
mcc_std = F('8.000')
qdil = mcc_std - (qact - qstd)
mcc_target = half_up(qdil, R)
out['dispensing'] = {
    'saltFactor': show(f, 6), 'apiStandardForm': show(qstd, 6), 'apiAsIsAssay': str(asis), 'apiCalculated': show(qact, 6),
    'apiTarget': txt(api_target, 3), 'mccCalculated': show(qdil, 6), 'mccTarget': txt(mcc_target, 3),
    'adjustmentPercent': show(abs((qact - qstd) * 100 / qstd), 6),
}
fixed = {'lactose': F('14.000'), 'povidone': F('2.400'), 'croscarmellose': F('2.400'), 'silica': F('0.400'), 'mgst': F('0.800')}
water, ipa = F('9.600'), F('2.400')
intragranular = api_target + mcc_target + fixed['lactose'] + fixed['povidone']
extragranular = fixed['croscarmellose'] + fixed['silica'] + fixed['mgst']
T_core = intragranular + extragranular  # theoretical core mass from the dispensed quantities (solids; water and IPA lost)
out['theoretical'] = {'intragranularSolids': txt(intragranular, 3), 'extragranular': txt(extragranular, 3), 'coreBatch': txt(T_core, 3)}

# Split granulation: two sub-lots of half the intragranular solids each (replicate section x2).
sub = [F('38.600'), F('38.550')]  # dried granules discharged per sub-lot (scripted)
granules = sum(sub)
out['granulation'] = {'driedGranules': [txt(x, 3) for x in sub], 'yieldPercent': show(granules * 100 / intragranular, 2)}
# Recovery addition (case 2, L-28): milled rejects of an earlier batch of the same product, 2.000 kg (<= 3 % of T, <= 3 months)
recovered = F('2.000')
cap = T_core * 3 / 100
assert recovered <= cap
out['recovery'] = {'added': txt(recovered, 3), 'capThreePercent': show(cap, 3), 'percentOfBatch': show(recovered * 100 / T_core, 2)}
blend = F('82.310')  # lubricated blend discharged (scripted)
blend_in = granules + extragranular + recovered
out['blending'] = {'input': txt(blend_in, 3), 'output': txt(blend, 3), 'yieldPercent': show(blend * 100 / blend_in, 2)}
# Compression: good cores (A), reusable residue B (dust, set-up tablets for recovery), rejects for destruction
A, B, rej = F('80.920'), F('0.620'), F('0.390')
T = T_core + recovered  # theoretical for the core stage includes the material added (tablets spec C-07/C-09)
out['compression'] = {
    'goodCores': txt(A, 3), 'reusableResidue': txt(B, 3), 'rejects': txt(rej, 3), 'theoretical': txt(T, 3),
    'goodOutputYieldPercent': show(A * 100 / T, 2), 'yieldWithResidueAplusBoverT': show((A + B) * 100 / T, 2),
    'accountabilityPercent': show((A + B + rej) * 100 / blend, 2),
}
# Coating: 3.0 % weight gain target on the cores charged
cores_in = A
gain = F('3.0')
coat_solids = cores_in * gain / 100
coated = F('83.290')
out['coating'] = {'coatSolidsTheoretical': show(coat_solids, 3), 'coatedTablets': txt(coated, 3),
                  'weightGainPercent': show((coated - cores_in) * 100 / cores_in, 2)}
# Inspection: rejects to identified containers, witnessed destruction
insp_rej = F('0.180')
out['inspection'] = {'accepted': txt(coated - insp_rej, 3), 'rejectsDestroyed': txt(insp_rej, 3)}
print(json.dumps(out, indent=1))
