"""Check that every register row number in a bucket is referenced by a digest.
Usage: python3 check_coverage.py <bucket.jsonl> <digest.md>
Digest must reference rows as 'n123' tokens (e.g. 'Covers: n12, n45')."""
import json, re, sys
bucket, digest = sys.argv[1], sys.argv[2]
ns = {json.loads(l)['n'] for l in open(bucket)}
text = open(digest).read()
refs = {int(m) for m in re.findall(r'\bn(\d+)\b', text)}
missing = sorted(ns - refs)
extra = sorted(refs - ns)
print(f'rows in bucket: {len(ns)}  referenced: {len(ns & refs)}  missing: {len(missing)}  refs outside bucket: {len(extra)}')
if missing: print('missing:', ' '.join(f'n{m}' for m in missing))
