"""Build the regulatory review pack (HTML) from the register + control digests.

Output: pdf/review-pack.html (rendered to PDF by render.js).
"""
import html, json, re, collections, datetime
import markdown

SP = '/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/'
FONTS = SP + 'pdf/node_modules/@fontsource/'
DATE = '27 September 2026'

# ---------------------------------------------------------------- register
REG = {}
for line in open(SP + 'register/requirements.jsonl'):
    r = json.loads(line)
    REG[r['n']] = r

SUPPORTING = re.compile(r'Annex 15|Annex 16|ICH|EMA|Chapter 1\b|Ch\.1\b|Annex 22', re.I)


def doc_name(src):
    s = src or ''
    rules = [
        (r'Schedule M', 'Revised Schedule M (India)'),
        (r'Drugs Rules|IT Act|Information Technology|Sakshya|Evidence Act', 'Other Indian law'),
        (r'Annex 1\b(?!\d)|Annex 1 \(', 'EU GMP Annex 1'),
        (r'Annex 11', 'EU GMP Annex 11'), (r'Annex 15', 'EU GMP Annex 15'),
        (r'Annex 16', 'EU GMP Annex 16'), (r'Annex 22', 'EU GMP Annex 22 (draft)'),
        (r'Ch\.4|Chapter 4', 'EU GMP Chapter 4'), (r'Ch\.5|Chapter 5', 'EU GMP Chapter 5'),
        (r'Chapter 1|Ch\.1\b', 'EU GMP Chapter 1'), (r'EMA', 'EMA GMP Q&A'),
        (r'DI Q&A|Data Integrity', 'FDA Data Integrity Q&A'), (r'Aseptic', 'FDA Aseptic Processing Guidance'),
        (r'ICH', 'ICH Q9(R1) / Q10 / Q12'),
        (r'Part 11\b|21 CFR 11', '21 CFR Part 11'), (r'Part 211|21 CFR 211', '21 CFR Part 211'),
        (r'FDA|FD&C|DSCSA|CFR', 'Other US FDA law / guidance'),
    ]
    for pat, name in rules:
        if re.search(pat, s):
            return name
    return 'Other'


VER_LABEL = {'primary': 'Checked', 'secondary': 'Search-based', 'unverified': 'Unverified'}

# ---------------------------------------------------------------- markdown helpers

def md(text):
    """Markdown -> HTML with 2-space nested lists supported and '<' escaped."""
    if not text or not text.strip():
        return ''
    lines = []
    for ln in text.split('\n'):
        stripped = ln.lstrip(' ')
        ind = len(ln) - len(stripped)
        lines.append(' ' * (ind * 2) + stripped)
    t = '\n'.join(lines)
    t = t.replace('&', '&amp;').replace('<', '&lt;')
    t = t.replace('->', '→').replace('&lt;-', '←').replace('>=', '≥').replace('&lt;=', '≤')
    # a list directly after a paragraph line needs a blank line for Python-Markdown
    t = re.sub(r'([^\n])\n(\s*[-*] )', r'\1\n\n\2', t)
    t = re.sub(r'([^\n])\n(\s*\d+[.)] )', r'\1\n\n\2', t)
    out = markdown.markdown(t, extensions=['tables', 'sane_lists'])
    out = out.replace('&amp;amp;', '&amp;')
    return out


def inline(text):
    return md(text).replace('<p>', '').replace('</p>', '')


# ---------------------------------------------------------------- digest parsing
CTRL_RE = re.compile(r'^(#{3,4})\s+((?:DI|PR|ST|IN)-\d+)\s*[:\-–—]?\s*(.*)$')
HEAD_RE = re.compile(r'^(#{1,4})\s+(.*)$')
LABELS = ['Covers', 'Types', 'Type', 'Behaviour', 'Behavior', 'Citations', 'Jurisdiction', 'Test', 'Verify',
          'Theme', 'Scope', 'Process scope', 'Edition', 'Verification', 'Relation to FDA/EU', 'FDA vs EU',
          'Notes', 'Note', 'Defaults', 'Default']
LABEL_RE = re.compile(r'^(\s*)(?:[-*]\s+)?(?:\*\*)?(' + '|'.join(re.escape(l) for l in LABELS) +
                      r')(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$')


def parse_fields(body_lines):
    fields = collections.OrderedDict()
    cur, base = None, 0
    for ln in body_lines:
        m = LABEL_RE.match(ln)
        if m and (cur is None or len(m.group(1)) <= base):
            label, rest = m.group(2), m.group(3)
            # India style: "**Edition:** both. **Type:** ENFORCED ..."
            if label == 'Edition' and '**Type:**' in rest:
                ed, ty = rest.split('**Type:**', 1)
                fields['Edition'] = [ed.strip().rstrip('.')]
                label, rest = 'Type', ty.strip()
            cur, base = label, len(m.group(1))
            fields.setdefault(cur, []).append(rest)
        elif cur is not None:
            s = ln
            # dedent nested lines of a bulleted field by (base + 2)
            cut = base + 2 if ln.startswith(' ' * (base + 2)) else len(ln) - len(ln.lstrip(' '))
            fields[cur].append(s[cut:] if cut <= len(s) - len(s.lstrip(' ')) else s.lstrip(' '))
        else:
            fields.setdefault('Notes', []).append(ln)
    return {k: '\n'.join(v).strip() for k, v in fields.items()}


def clean(text):
    text = re.sub(r'(?m)^\s*(\*\*)?Inputs?:(\*\*)?.*\n?', '', text)
    text = re.sub(r'`?primary/[\w.-]+`?', 'the official text', text)
    for a, b in [('in primary/', 'in the official texts supplied'), ('register row numbers', 'requirement numbers (see Appendix)'),
                 ('register rows', 'requirements in the Appendix'), ('register row', 'requirement'),
                 ('bucket row', 'requirement'), ('during this digest', 'during this review'),
                 ('the register', 'the requirements list')]:
        text = text.replace(a, b)
    return text


def parse_digest(path, prefix):
    text = clean(open(path).read())
    lines = text.split('\n')
    intro, sections = [], []          # sections: dict(title, groups/narrative)
    cur_sec = None
    cur_group = None
    ctrl = None

    def close_ctrl():
        nonlocal ctrl
        if ctrl:
            ctrl['fields'] = parse_fields(ctrl.pop('body'))
            cur_group['controls'].append(ctrl)
        ctrl = None

    for ln in lines:
        cm = CTRL_RE.match(ln)
        hm = HEAD_RE.match(ln)
        if cm:
            close_ctrl()
            if cur_sec is None:
                cur_sec = {'title': '', 'intro': [], 'groups': []}
                sections.append(cur_sec)
            if cur_group is None:
                cur_group = {'title': '', 'intro': [], 'controls': []}
                cur_sec['groups'].append(cur_group)
            ctrl = {'id': cm.group(2), 'name': cm.group(3).strip(), 'body': []}
            continue
        if hm and len(hm.group(1)) <= 3:
            level = len(hm.group(1))
            close_ctrl()
            if level == 1:
                continue
            if level == 2:
                cur_sec = {'title': hm.group(2).strip(), 'intro': [], 'groups': []}
                sections.append(cur_sec)
                cur_group = None
                continue
            if level == 3:  # sub-group heading inside a section
                cur_group = {'title': hm.group(2).strip(), 'intro': [], 'controls': []}
                if cur_sec is None:
                    cur_sec = {'title': '', 'intro': [], 'groups': []}
                    sections.append(cur_sec)
                cur_sec['groups'].append(cur_group)
                continue
        if ctrl is not None:
            ctrl['body'].append(ln)
        elif cur_group is not None:
            cur_group['intro'].append(ln)
        elif cur_sec is not None:
            cur_sec['intro'].append(ln)
        else:
            intro.append(ln)
    close_ctrl()
    return '\n'.join(intro).strip(), sections


# ---------------------------------------------------------------- control enrichment

def covers(ctrl):
    t = ctrl['fields'].get('Covers', '')
    return [int(x) for x in re.findall(r'\bn(\d+)\b', t)]


def type_chips(t):
    t = (t or '').upper()
    chips = []
    for key, label, cls in [('ENFORCED', 'Enforced', 'enf'), ('CONFIGURABLE', 'Configurable', 'cfg'),
                            ('DESIGN-CHOICE', 'Design choice', 'dsg'), ('DESIGN CHOICE', 'Design choice', 'dsg')]:
        if key in t and label not in [c[0] for c in chips]:
            chips.append((label, cls))
    return chips


def edition_of(ctrl, part):
    if part == 'ST':
        return 'Injectables'
    ed = ctrl['fields'].get('Edition', '')
    name = ctrl['name']
    if part == 'IN' and ed:
        e = ed.lower()
        if 'tablet' in e and 'inject' not in e:
            return 'Tablets'
        if 'inject' in e and 'tablet' not in e:
            return 'Injectables'
        return 'Both editions'
    if re.search(r'\[T\]', name) and not re.search(r'\[I\]', name):
        return 'Tablets'
    if re.search(r'\[I\]', name) and not re.search(r'\[T\]', name):
        return 'Injectables'
    return 'Both editions'


def verification(ns):
    rows = [REG[n] for n in ns if n in REG]
    if not rows:
        return 'No source rows', 'ver-none', 0, 0
    c = collections.Counter(r['verified'] for r in rows)
    total, prim = len(rows), c.get('primary', 0)
    if prim == total:
        return f'All {total} source requirement{"s" if total > 1 else ""} checked against official text', 'ver-ok', prim, total
    if prim == 0:
        return f'Search-based only (0 of {total} checked against official text)', 'ver-low', prim, total
    return f'{prim} of {total} source requirements checked against official text', 'ver-mid', prim, total


def tier(ns):
    rows = [REG[n] for n in ns if n in REG]
    if rows and all(SUPPORTING.search(r.get('source') or '') for r in rows):
        return 'Supporting'
    return 'Core'


# ---------------------------------------------------------------- HTML building
PARTS = [
    ('A', 'DI', 'Data integrity and computerised systems', 'Shared compliance kernel · both editions',
     SP + 'digest/digest-data-integrity.md'),
    ('B', 'PR', 'Production, documentation and batch release', 'Shared compliance kernel · both editions',
     SP + 'digest/digest-production.md'),
    ('C', 'ST', 'Sterile manufacturing controls', 'Injectables edition',
     SP + 'digest/digest-sterile-controls.md'),
    ('D', 'IN', 'India layer: Revised Schedule M and Indian law', 'Mandatory for every batch made in India',
     SP + 'digest/digest-india.md'),
]

ctrl_index = {}           # control id -> part
mentioned_in = collections.defaultdict(set)
row_used_by = collections.defaultdict(list)
part_data = []
for letter, pfx, title, sub, path in PARTS:
    intro, sections = parse_digest(path, pfx)
    ctrls = [c for s in sections for g in s['groups'] for c in g['controls']]
    for n in re.findall(r'\bn(\d+)\b', clean(open(path).read())):
        mentioned_in[int(n)].add(letter)
    for c in ctrls:
        c['covers'] = covers(c)
        for n in c['covers']:
            row_used_by[n].append(c['id'])
        ctrl_index[c['id']] = letter
    part_data.append((letter, pfx, title, sub, intro, sections, ctrls))


def control_html(c, pfx):
    f = c['fields']
    ns = c['covers']
    ver_text, ver_cls, _, _ = verification(ns)
    chips = type_chips(f.get('Type') or f.get('Types'))
    ed = edition_of(c, pfx)
    t = tier(ns)
    name = re.sub(r'\s*\[(T|I)\]\s*', ' ', c['name']).strip()
    head_chips = ''.join(f'<span class="chip {cls}">{lab}</span>' for lab, cls in chips)
    head_chips += f'<span class="chip ed">{ed}</span>'
    if t == 'Supporting':
        head_chips += '<span class="chip sup">Supporting</span>'
    scope = f.get('Scope') or f.get('Process scope')
    if scope and pfx == 'ST':
        head_chips += f'<span class="chip ed">Scope: {html.escape(scope.split(chr(10))[0][:40])}</span>'

    blocks = []

    def block(label, key_list):
        for k in key_list:
            if f.get(k):
                blocks.append(f'<div class="fld"><div class="lbl">{label}</div><div class="val">{md(f[k])}</div></div>')
                return

    block('What the system does', ['Behaviour', 'Behavior'])
    type_text = f.get('Type') or f.get('Types') or ''
    if type_text and len(type_text) > 14:
        blocks.append(f'<div class="fld"><div class="lbl">Type detail</div><div class="val">{md(type_text)}</div></div>')
    block('Defaults', ['Defaults', 'Default'])
    block('Regulatory basis', ['Citations'])
    block('India / US / EU differences', ['Relation to FDA/EU', 'Jurisdiction', 'FDA vs EU'])
    block('How it will be tested', ['Test', 'Verify'])
    if f.get('Verification'):
        blocks.append(f'<div class="fld"><div class="lbl">Source check</div><div class="val">{md(f["Verification"])}</div></div>')
    if f.get('Notes') and f['Notes'].strip('- \n'):
        blocks.append(f'<div class="fld"><div class="lbl">Notes</div><div class="val">{md(f["Notes"])}</div></div>')
    refs = ', '.join(f'<a href="#r{n}">n{n}</a>' for n in ns)
    return f'''
<section class="ctrl" id="{c['id']}">
  <div class="ctrl-head"><span class="cid">{c['id']}</span><span class="cname">{inline(name)}</span></div>
  <div class="chips">{head_chips}<span class="chip {ver_cls}">{ver_text}</span></div>
  {''.join(blocks)}
  <div class="srcrows">Source requirements: {refs or '—'}</div>
  <div class="decision">
    <span class="dlabel">Reviewer decision</span>
    <span class="box"></span>Follow <span class="box"></span>Don't follow <span class="box"></span>Modify
    <span class="comment">Comments</span>
  </div>
</section>'''


def section_is_narrative(s):
    return not any(g['controls'] for g in s['groups'])


# ---------- counts for summary
summary_rows = []
for letter, pfx, title, sub, intro, sections, ctrls in part_data:
    tc = collections.Counter()
    for c in ctrls:
        for lab, _ in type_chips(c['fields'].get('Type') or c['fields'].get('Types')):
            tc[lab] += 1
    rows = {n for c in ctrls for n in c['covers']}
    prim = sum(1 for n in rows if REG.get(n, {}).get('verified') == 'primary')
    summary_rows.append((letter, title, sub, len(ctrls), tc['Enforced'], tc['Configurable'], tc['Design choice'],
                         len(rows), prim))

# ---------- sources table
src_stats = collections.defaultdict(lambda: collections.Counter())
for r in REG.values():
    src_stats[doc_name(r['source'])][r['verified']] += 1
SOURCE_META = [
    ('21 CFR Part 211', 'US', 'eCFR, current as of 24 Sep 2026', 'Binding regulation', 'Uploaded official text', 'Core'),
    ('21 CFR Part 11', 'US', 'eCFR, current as of 24 Sep 2026', 'Binding regulation', 'Uploaded official text', 'Core'),
    ('FDA Data Integrity Q&A', 'US', 'December 2018', 'Guidance', 'Uploaded official text', 'Core'),
    ('FDA Aseptic Processing Guidance', 'US', 'September 2004', 'Guidance', 'Uploaded official text', 'Core (Injectables)'),
    ('Other US FDA law / guidance', 'US', 'Various (DSCSA, Part 201, Part 210, CSA 2025, PV 2011)', 'Law / guidance', 'Search results', 'Core / supporting'),
    ('EU GMP Chapter 4', 'EU', '2011 (in force 30 Jun 2011); July 2025 draft', 'Binding; draft pending', 'Uploaded official text (2011)', 'Core'),
    ('EU GMP Chapter 5', 'EU', 'Revision in force 1 Mar 2015', 'Binding', 'Uploaded official text', 'Core'),
    ('EU GMP Annex 11', 'EU', '2011 (in force 30 Jun 2011); July 2025 draft', 'Binding; draft pending', 'Uploaded official text (2011)', 'Core'),
    ('EU GMP Annex 1', 'EU', 'C(2022) 5938, in force 25 Aug 2023 (8.123 from 25 Aug 2024)', 'Binding', 'Uploaded official text', 'Core (Injectables)'),
    ('EU GMP Annex 16', 'EU', '2016', 'Binding (EU release only)', 'Search results', 'Supporting'),
    ('EU GMP Annex 15', 'EU', '2015', 'Binding (validation)', 'Search results', 'Supporting'),
    ('EU GMP Chapter 1', 'EU', '2013', 'Binding (quality system)', 'Search results', 'Supporting'),
    ('EU GMP Annex 22 (draft)', 'EU', 'July 2025 draft', 'Draft', 'Search results', 'Supporting'),
    ('EMA GMP Q&A', 'EU', 'Q&A pages (e.g. data integrity, Aug 2016)', 'Guidance', 'Search results', 'Supporting'),
    ('ICH Q9(R1) / Q10 / Q12', 'ICH', 'Q9(R1) 2023; Q10 2008; Q12 2019', 'Guidance adopted by FDA and EU', 'Search results', 'Supporting'),
    ('Revised Schedule M (India)', 'IN', 'G.S.R. 922(E), 28 Dec 2023', 'Binding (Drugs Rules 1945)', 'Uploaded official text (compressed copy, some pages missing)', 'Core'),
    ('Other Indian law', 'IN', 'Drugs Rules 1945; IT Act 2000; Bharatiya Sakshya Adhiniyam 2023', 'Binding law', 'Search results', 'Core / supporting'),
]

# ---------- appendix rows
JUR_ORDER = {'IN': 0, 'US': 1, 'EU': 2, 'ICH': 3}
appendix = sorted(REG.values(), key=lambda r: (JUR_ORDER.get(r['jurisdiction'], 9), doc_name(r['source']), r['n']))


def fontface(fam, path, weight, style='normal'):
    return f"@font-face{{font-family:'{fam}';src:url('file://{FONTS}{path}') format('woff2');font-weight:{weight};font-style:{style};}}"


CSS = ''.join([
    fontface('Inter', 'inter/files/inter-latin-400-normal.woff2', 400),
    fontface('Inter', 'inter/files/inter-latin-500-normal.woff2', 500),
    fontface('Inter', 'inter/files/inter-latin-600-normal.woff2', 600),
    fontface('Inter', 'inter/files/inter-latin-700-normal.woff2', 700),
    fontface('Inter', 'inter/files/inter-latin-ext-400-normal.woff2', 400),
    fontface('Source Serif', 'source-serif-4/files/source-serif-4-latin-600-normal.woff2', 600),
    fontface('Source Serif', 'source-serif-4/files/source-serif-4-latin-700-normal.woff2', 700),
    fontface('Mono', 'jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 400),
]) + open(SP + 'pdf/style.css').read()

out = []
w = out.append
w(f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>eBMR Regulatory Requirements Review Pack</title><style>{CSS}</style></head><body>')

# ---------- cover
total_ctrls = sum(r[3] for r in summary_rows)
total_rows = len(REG)
total_prim = sum(1 for r in REG.values() if r['verified'] == 'primary')
w(f'''
<div class="cover">
  <div class="cover-top">Regulatory review pack · Draft for expert verification</div>
  <h1 class="cover-title">Electronic Batch Manufacturing Record (eBMR)<br>Regulatory Requirements</h1>
  <div class="cover-sub">Tablets edition and Injectables edition<br>India (Revised Schedule M) · US FDA · EU GMP</div>
  <div class="cover-stats">
    <div><b>{total_ctrls}</b><span>controls the system will implement</span></div>
    <div><b>{total_rows}</b><span>clause-level requirements behind them</span></div>
    <div><b>{total_prim}</b><span>requirements checked against official texts</span></div>
  </div>
  <div class="cover-meta">
    <div><span>Version</span>0.9 (draft for review)</div>
    <div><span>Date</span>{DATE}</div>
    <div><span>Purpose</span>Independent verification of the rules the eBMR will follow, before any software is built</div>
  </div>
  <div class="cover-foot">All regulatory content is paraphrased. Clause references point to the official texts; they are not quotations.</div>
</div>''')

# ---------- how to use
w('<div class="page"><h1 class="h1">How to use this document</h1>')
w('''<p class="lead">This pack lists every rule the eBMR software will follow, where each rule comes from, and how the software will
satisfy and test it. Please review each control and mark a decision. We will then build only what you confirm.</p>
<h3>What to do for each control</h3>
<ol class="steps">
<li><b>Read "What the system does".</b> This is the behaviour we intend to build.</li>
<li><b>Check the "Regulatory basis".</b> Each clause reference points to the official text. Confirm that the clause says what we claim and that nothing is missing.</li>
<li><b>Mark a decision:</b> <i>Follow</i> (build as described), <i>Don't follow</i> (drop it), or <i>Modify</i> (write the change in Comments).</li>
<li><b>Pay most attention</b> to controls marked <span class="chip ver-mid">partly checked</span> or <span class="chip ver-low">search-based</span>, and to all <span class="chip dsg">Design choice</span> items. Design choices are our own proposals and are not required by any regulation.</li>
</ol>
<h3>Legend</h3>
<table class="legend">
<tr><td><span class="chip enf">Enforced</span></td><td>A hard rule inside the software. No customer, site or administrator setting can switch it off.</td></tr>
<tr><td><span class="chip cfg">Configurable</span></td><td>The customer sets a value within safe limits. A setting may be made stricter, never looser than the regulation.</td></tr>
<tr><td><span class="chip dsg">Design choice</span></td><td>Good practice that we propose. No regulation requires it. You may decide to drop it.</td></tr>
<tr><td><span class="chip ed">Both editions</span> <span class="chip ed">Tablets</span> <span class="chip ed">Injectables</span></td><td>Which product the control applies to. The two editions are separate products that share one compliance core (audit trail, e-signatures, access control).</td></tr>
<tr><td><span class="chip ver-ok">All checked</span></td><td>Every requirement behind the control was compared with the official text you supplied.</td></tr>
<tr><td><span class="chip ver-mid">Partly checked</span> <span class="chip ver-low">Search-based</span></td><td>Some or all source requirements come from web-search summaries because the official text was not available. Verify these first.</td></tr>
<tr><td><span class="chip sup">Supporting</span></td><td>Comes only from supporting documents (EU Annex 15/16, EU Chapter 1, EMA Q&amp;A, ICH). Lower priority for batch records.</td></tr>
<tr><td>(s) · (u) · (draft)</td><td>Markers inside citations: (s) secondary source only, (u) unverified, (draft) July 2025 EU draft that is not yet in force.</td></tr>
<tr><td>P · P~ · S · U · [chk] · [gk]</td><td>India part only: P = re-read in the Gazette text; P~ = in the text but the clause number is inferred; S = secondary source; U = unconfirmed detail. [chk] = FDA/EU comparison value checked in the official files; [gk] = general knowledge.</td></tr>
<tr><td>n123</td><td>Reference to a clause-level requirement in the Appendix (click to jump in the PDF).</td></tr>
</table>
<h3>How the markets combine</h3>
<p>Every batch is made in India, so Revised Schedule M always applies. Each product also declares its export markets (US, EU).
The software applies every rule of every market the batch serves. Where two rules set different values, the stricter value wins
(for example the longest record-retention period or the tightest time limit). Part D lists each topic where India differs from US or EU
and the value applied for every market combination.</p>
</div>''')

# ---------- sources
w('<div class="page"><h1 class="h1">Scope and sources</h1>')
w('''<p>The pack covers the rules that govern batch manufacturing records and the software that holds them. Documents are grouped as
<b>Core</b> (needed for any compliant batch record) and <b>Supporting</b> (only a small part applies, mostly the release step or the quality system).</p>''')
w('<table class="grid"><thead><tr><th>Document</th><th>Market</th><th>Version used</th><th>Status</th><th>Obtained from</th><th>Tier</th><th class="num">Req.</th><th class="num">Checked</th></tr></thead><tbody>')
for name, mk, ver, st, got, tr in SOURCE_META:
    c = src_stats.get(name, collections.Counter())
    tot = sum(c.values())
    if not tot:
        continue
    w(f'<tr><td><b>{html.escape(name)}</b></td><td>{mk}</td><td>{html.escape(ver)}</td><td>{html.escape(st)}</td><td>{html.escape(got)}</td><td>{tr}</td><td class="num">{tot}</td><td class="num">{c.get("primary", 0)}</td></tr>')
w('</tbody></table>')
w('''<h3>Not included</h3>
<ul>
<li><b>EU GMP Annex 2</b> (biological medicinal products) and <b>Annex 13</b> (investigational products): not applicable to tablets or standard injectables. Tell us if your customers make biological injectables such as vaccines or insulin.</li>
<li><b>WHO-GMP</b> and other export markets: largely covered by meeting US FDA and EU GMP; not mapped separately.</li>
<li><b>Pharmacopoeial test limits</b> (USP, Ph. Eur., IP): handled as configurable master data per market; listed in the build outline rather than here.</li>
</ul>
<h3>Known gaps in the source material</h3>
<ul>
<li>The uploaded copy of Revised Schedule M was compressed and is missing some pages (see Part D, section F). Those items are marked for verification.</li>
<li>EU Annex 15, Annex 16, EU Chapter 1, EMA Q&amp;A pages and ICH texts were not supplied; their items are search-based.</li>
<li>The July 2025 EU drafts of Annex 11 and Chapter 4 were not supplied and are not yet in force. Where we adopt a stricter draft expectation, it is marked (draft).</li>
</ul></div>''')

# ---------- summary
w('<div class="page"><h1 class="h1">At a glance</h1><table class="grid"><thead><tr><th>Part</th><th>Topic</th><th>Applies to</th><th class="num">Controls</th><th class="num">Enforced</th><th class="num">Configurable</th><th class="num">Design choice</th><th class="num">Source req.</th><th class="num">Checked</th></tr></thead><tbody>')
for letter, title, sub, n, e, cf, d, rows, prim in summary_rows:
    w(f'<tr><td><b>{letter}</b></td><td><a href="#part-{letter}">{html.escape(title)}</a></td><td>{html.escape(sub)}</td><td class="num">{n}</td><td class="num">{e}</td><td class="num">{cf}</td><td class="num">{d}</td><td class="num">{rows}</td><td class="num">{prim}</td></tr>')
w('</tbody></table><p class="small">A control can be both enforced and configurable (for example a fixed minimum with a configurable stricter value), so type counts can exceed the number of controls.</p>')
w('<h3>Contents</h3><ol class="toc">')
for letter, pfx, title, sub, intro, sections, ctrls in part_data:
    w(f'<li><a href="#part-{letter}">Part {letter} · {html.escape(title)}</a> <span class="muted">({len(ctrls)} controls)</span><ul>')
    for s in sections:
        if s['title'] and not s['title'].lower().startswith(('legend', 'conventions', 'controls')):
            w(f'<li>{html.escape(s["title"])}</li>')
    w('</ul></li>')
w('<li><a href="#appendix">Appendix · Clause-level requirements register</a></li><li><a href="#signoff">Reviewer sign-off</a></li></ol></div>')

# ---------- parts
for letter, pfx, title, sub, intro, sections, ctrls in part_data:
    w(f'<div class="part" id="part-{letter}"><div class="part-letter">Part {letter}</div><h1 class="part-title">{html.escape(title)}</h1><div class="part-sub">{html.escape(sub)} · {len(ctrls)} controls</div>')
    if intro:
        w(f'<div class="note">{md(intro)}</div>')
    w('</div>')
    for s in sections:
        st = s['title']
        if st.lower().startswith(('legend',)):
            continue
        is_narr = section_is_narrative(s)
        if st and not st.lower().startswith('controls'):
            w(f'<h2 class="sec{" narr" if is_narr else ""}">{inline(st)}</h2>')
        if s['intro'] and '\n'.join(s['intro']).strip().strip('-'):
            w(f'<div class="{"narrative" if is_narr else "note"}">{md(chr(10).join(s["intro"]))}</div>')
        for g in s['groups']:
            if g['title']:
                w(f'<h3 class="grp">{inline(g["title"])}</h3>')
            if g['intro'] and '\n'.join(g['intro']).strip().strip('-'):
                w(f'<div class="narrative">{md(chr(10).join(g["intro"]))}</div>')
            for c in g['controls']:
                w(control_html(c, pfx))

# ---------- appendix
w('<div class="part" id="appendix"><div class="part-letter">Appendix</div><h1 class="part-title">Clause-level requirements register</h1>'
  f'<div class="part-sub">{total_rows} requirements · {total_prim} checked against official texts</div>'
  '<div class="note"><p>Each row is one requirement as paraphrased from its source. "Used in" shows the controls built from it. '
  'Rows are grouped by market and document. "Checked" means compared with the official text you supplied.</p></div></div>')
cur = None
for r in appendix:
    key = (r['jurisdiction'], doc_name(r['source']))
    if key != cur:
        if cur is not None:
            w('</tbody></table>')
        cur = key
        w(f'<h3 class="grp">{html.escape(key[1])}</h3><table class="grid reg"><thead><tr><th>Ref</th><th>Clause</th><th>Requirement (paraphrased)</th><th>Status</th><th>Check</th><th>Used in</th></tr></thead><tbody>')
    used = ', '.join(f'<a href="#{cid}">{cid}</a>' for cid in dict.fromkeys(row_used_by.get(r['n'], []))) or ('<span class="muted">discussed in notes of Part ' + ', '.join(sorted(mentioned_in.get(r['n'], []))) + '</span>' if mentioned_in.get(r['n']) else '<span class="muted">—</span>')
    ver = VER_LABEL.get(r['verified'], r['verified'])
    vcls = {'primary': 'ok', 'secondary': 'mid', 'unverified': 'low'}.get(r['verified'], '')
    status = r.get('doc_status', '').replace('design-choice/other-source', 'not in cited text')
    ed = {'tablets': ' · Tablets', 'injectables': ' · Injectables'}.get(r.get('applies_to'), '')
    w(f'<tr id="r{r["n"]}"><td class="ref">n{r["n"]}</td><td class="clause">{html.escape(str(r.get("clause") or ""))[:160]}</td>'
      f'<td>{inline(r.get("requirement") or "")}</td><td class="small">{html.escape(status)}{ed}</td>'
      f'<td><span class="v {vcls}">{ver}</span></td><td class="small">{used}</td></tr>')
w('</tbody></table>')

# ---------- sign-off
w('''<div class="page signoff" id="signoff"><h1 class="h1">Reviewer sign-off</h1>
<p>I have reviewed the controls in this pack and recorded my decisions against each control.</p>
<table class="sign"><tr><td>Reviewer name</td><td></td></tr><tr><td>Qualification / role</td><td></td></tr>
<tr><td>Organisation</td><td></td></tr><tr><td>Parts reviewed</td><td>☐ A &nbsp; ☐ B &nbsp; ☐ C &nbsp; ☐ D &nbsp; ☐ Appendix</td></tr>
<tr><td>Signature</td><td></td></tr><tr><td>Date</td><td></td></tr></table>
<h3>General comments</h3><div class="lines"></div></div>''')
w('</body></html>')
open(SP + 'pdf/review-pack.html', 'w').write('\n'.join(out))
print('controls per part:', [(p[0], len(p[6])) for p in part_data])
print('rows used:', len(row_used_by), 'of', len(REG))
