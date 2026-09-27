"""Merge all research + verification outputs into one requirements register.

Deterministic (no model calls). Re-run whenever a research/verify file changes.
Output: scratchpad/register/requirements.jsonl + summary printed to stdout.
"""
import json, os, re, collections

SP = '/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/'
R, V, OUT = SP + 'research/', SP + 'verify/', SP + 'register/'
os.makedirs(OUT, exist_ok=True)


def jl(path):
    if not os.path.exists(path):
        return []
    rows = []
    for line in open(path):
        line = line.strip()
        if line:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def jurisdiction(source):
    s = source or ''
    if re.search(r'Schedule M|Drugs Rules|Drugs and Cosmetics|IT Act|Information Technology Act|CDSCO|G\.S\.R|Legal Metrology|Indian Pharmacopoeia|Sakshya|Evidence Act', s):
        return 'IN'
    if 'ICH' in s:
        return 'ICH'
    if re.search(r'CFR|FDA|FD&C|DSCSA', s):
        return 'US'
    if re.search(r'EU|EMA|Annex|Ch\.|Chapter|Directive', s):
        return 'EU'
    return '?'


def doc_status(source):
    s = (source or '').lower()
    if 'draft' in s:
        return 'draft'
    if 'guidance' in s or 'q&a' in s or 'guide' in s or 'ich' in s:
        return 'guidance'
    return 'binding'


register = {}   # key -> row
order = []


def add(key, row):
    if key not in register:
        order.append(key)
    register[key] = row


def base(r, file, sterile=False):
    applies = r.get('applies_to') or ('injectables' if sterile else 'both')
    return {
        'rid': f"{file.split('.')[0]}:{r.get('id')}",
        'id': r.get('id'),
        'file': file,
        'source': r.get('source'),
        'clause': r.get('clause') or r.get('section') or '',
        'binding_basis': r.get('binding_basis', ''),
        'jurisdiction': jurisdiction(r.get('source')),
        'doc_status': doc_status(r.get('source')),
        'strength': r.get('strength', ''),
        'applies_to': applies,
        'process_scope': r.get('process_scope', ''),
        'requirement': r.get('requirement'),
        'system_implications': r.get('system_implications'),
        'verification_test': r.get('verification_test'),
        'verified': 'secondary' if r.get('verified') else 'unverified',
        'notes': r.get('note', ''),
    }


# 1. raw research requirement lines
for r in json.load(open(R + 'us-regs.json'))['requirements']:
    add(('us-regs.json', r['id']), base(r, 'us-regs.json'))
for fn in ['intl-eu-ch4-ch5.jsonl', 'intl-annex11-pics.jsonl', 'intl-india-who-ich.jsonl', 'schedule-m.jsonl']:
    for r in jl(R + fn):
        if r.get('kind') == 'requirement':
            add((fn, r['id']), base(r, fn))
        elif r.get('kind') == 'correction' and (fn, r.get('id')) in register:
            row = register[(fn, r['id'])]
            for k in ('clause', 'requirement', 'system_implications', 'verification_test'):
                if r.get(k):
                    row[k] = r[k]
            if r.get('verified'):
                row['verified'] = 'primary'
            row['notes'] = (row['notes'] + ' | ' if row['notes'] else '') + (r.get('note') or 'corrected against official text')

# Schedule M lines checked against the official Gazette text are primary-verified
for key, row in register.items():
    if key[0] == 'schedule-m.jsonl' and 'official text' in (row.get('notes') or '').lower():
        row['verified'] = 'primary'

# 2. primary-text extractions (already from official texts)
for fn, sterile in [('aseptic-requirements.jsonl', True), ('annex1-requirements.jsonl', True)]:
    for r in jl(V + fn):
        if r.get('kind') == 'requirement':
            row = base(r, fn, sterile=True)
            row['verified'] = 'primary'
            add((fn, r['id']), row)

# 3. apply verification checks
def apply_checks(vfile, default_src_file=None):
    applied = collections.Counter()
    for c in jl(V + vfile):
        if c.get('kind') == 'new':
            row = base(c, vfile)
            row['clause'] = c.get('clause') or c.get('reference', '')
            row['verified'] = 'primary'
            add((vfile, c['id']), row)
            applied['new'] += 1
            continue
        if c.get('kind') != 'check':
            continue
        src = c.get('_file') or default_src_file
        key = (src, c['id'])
        if key not in register:
            # ALCOA principle checks or ids from another file: search by id
            matches = [k for k in register if k[1] == c['id']]
            if len(matches) == 1:
                key = matches[0]
            else:
                applied['unmatched'] += 1
                continue
        row = register[key]
        st = c.get('status')
        applied[st] += 1
        if st == 'duplicate':
            row['drop'] = f"duplicate of {c.get('duplicate_of')}"
            continue
        for k in ('clause', 'requirement', 'system_implications'):
            if c.get(k):
                row[k] = c[k]
        if c.get('reference'):
            row['clause'] = c['reference']
        if st in ('confirmed', 'corrected'):
            row['verified'] = 'primary'
        elif st in ('not_in_regulation', 'not_in_guidance'):
            row['verified'] = 'primary'
            row['doc_status'] = 'design-choice/other-source'
        row['check_status'] = st
        row['notes'] = (row['notes'] + ' | ' if row['notes'] else '') + (c.get('note') or '')
    return applied

print('us   ', dict(apply_checks('us-verified.jsonl', 'us-regs.json')))
print('eu-a ', dict(apply_checks('eu-a-verified.jsonl')))
print('eu-b ', dict(apply_checks('eu-b-verified.jsonl', 'intl-eu-ch4-ch5.jsonl')))
print('di   ', dict(apply_checks('di-verified.jsonl', 'us-regs.json')))

rows = [register[k] for k in order if not register[k].get('drop')]
import sys
out_name = sys.argv[1] if len(sys.argv) > 1 else 'requirements.jsonl'
prev = {}
if os.path.exists(OUT + 'requirements-v1.jsonl'):
    for line in open(OUT + 'requirements-v1.jsonl'):
        d = json.loads(line); prev[d['rid']] = d['n']
nxt = max(prev.values(), default=0) + 1
new_rids = []
for r in rows:
    if r['rid'] in prev:
        r['n'] = prev[r['rid']]
    else:
        r['n'] = nxt; nxt += 1; new_rids.append(r['rid'])
rows.sort(key=lambda r: r['n'])
with open(OUT + out_name, 'w') as f:
    for r in rows:
        f.write(json.dumps(r) + '\n')
gone = sorted(set(prev) - {r['rid'] for r in rows})
print('new rows:', len(new_rids), new_rids[:5], '...')
print('rows no longer present:', gone)

print('total kept', len(rows), 'dropped', sum(1 for k in order if register[k].get('drop')))
print('by jurisdiction', collections.Counter(r['jurisdiction'] for r in rows))
print('by edition', collections.Counter(r['applies_to'] for r in rows))
print('by verification', collections.Counter(r['verified'] for r in rows))
print('by doc status', collections.Counter(r['doc_status'] for r in rows))
