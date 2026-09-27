"""Split the merged register into three topic buckets for the digest agents."""
import json, re, collections

SP = '/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/'
rows = [json.loads(l) for l in open(SP + 'register/requirements.jsonl')]

DI = re.compile(r"part 11|annex 11|audit trail|electronic|e-sign|signature|password|access control|"
                r"backup|data integrity|metadata|computeri[sz]ed|alcoa|true copy|raw data|"
                r"user account|login|identity|time ?stamp|clock|archiv|cybersec|di q&a", re.I)

buckets = collections.defaultdict(list)
for r in rows:
    if r['jurisdiction'] == 'IN':
        continue  # India rows are handled by bucket-india.jsonl
    text = ' '.join(str(r.get(k) or '') for k in ('source', 'clause', 'requirement', 'system_implications'))
    sterile = r['applies_to'] == 'injectables' or r['file'].startswith(('aseptic', 'annex1'))
    if sterile:
        b = 'sterile'
    elif DI.search(r.get('source') or '') or DI.search(r.get('requirement') or ''):
        b = 'data-integrity'
    else:
        b = 'production'
    keep = {k: r.get(k) for k in ('n', 'rid', 'source', 'clause', 'binding_basis', 'jurisdiction',
                                  'doc_status', 'strength', 'applies_to', 'process_scope',
                                  'requirement', 'system_implications', 'verification_test',
                                  'verified', 'check_status') if r.get(k)}
    buckets[b].append(keep)

for b, items in buckets.items():
    with open(SP + f'register/bucket-{b}.jsonl', 'w') as f:
        for it in items:
            f.write(json.dumps(it) + '\n')
    size = sum(len(json.dumps(i)) for i in items)
    print(b, len(items), f'{size/1024:.0f} KB', collections.Counter(i['jurisdiction'] for i in items))
