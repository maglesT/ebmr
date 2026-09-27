"""Render the build outline markdown to a styled HTML file for PDF printing."""
import re, sys
import markdown

SP = '/tmp/claude-0/-home-user/0f393df3-64ef-5de6-9328-48ce9ce2b1a5/scratchpad/'
FONTS = SP + 'pdf/node_modules/@fontsource/'
src = sys.argv[1] if len(sys.argv) > 1 else SP + 'outline/build-outline-v2.md'
out = sys.argv[2] if len(sys.argv) > 2 else SP + 'pdf/outline.html'

text = open(src).read()
# drop the document's own H1 and internal "Inputs" paragraph (file paths)
text = re.sub(r'\A# [^\n]*\n', '', text)
text = re.sub(r'(?m)^\*\*Inputs\.\*\*.*\n', '', text)
text = text.replace('research/architecture.md', 'the architecture design').replace('primary/', 'the official texts ')


def prep(t):
    lines = []
    for ln in t.split('\n'):
        s = ln.lstrip(' ')
        ind = len(ln) - len(s)
        lines.append(' ' * (ind * 2) + s)
    t = '\n'.join(lines)
    t = re.sub(r'([^\n])\n(\s*[-*] )', r'\1\n\n\2', t)
    t = re.sub(r'([^\n|])\n(\s*\d+\. )', r'\1\n\n\2', t)
    return t


body = markdown.markdown(prep(text), extensions=['tables', 'sane_lists', 'toc'])
# anchor ids for h2 headings and a contents list
heads = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', body)
toc = ''.join(f'<li><a href="#{i}">{h}</a></li>' for i, h in heads)
body = body.replace('<h2 ', '<h2 class="sec" ')


def ff(fam, path, weight):
    return f"@font-face{{font-family:'{fam}';src:url('file://{FONTS}{path}') format('woff2');font-weight:{weight};}}"


css = ''.join([
    ff('Inter', 'inter/files/inter-latin-400-normal.woff2', 400), ff('Inter', 'inter/files/inter-latin-600-normal.woff2', 600),
    ff('Inter', 'inter/files/inter-latin-700-normal.woff2', 700), ff('Inter', 'inter/files/inter-latin-ext-400-normal.woff2', 400),
    ff('Source Serif', 'source-serif-4/files/source-serif-4-latin-600-normal.woff2', 600),
    ff('Source Serif', 'source-serif-4/files/source-serif-4-latin-700-normal.woff2', 700),
    ff('Mono', 'jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 400),
]) + open(SP + 'pdf/style.css').read() + '''
.doc h2.sec{ page-break-before:always; font-size:17pt; border-bottom:1.5pt solid var(--accent); margin-top:0; }
.doc h3{ font-size:12pt; color:var(--accent); margin:14pt 0 4pt; page-break-after:avoid; }
.doc h4{ font-size:10pt; margin:10pt 0 3pt; page-break-after:avoid; }
.doc table{ font-size:7.8pt; margin:6pt 0 10pt; }
.doc th{ background:var(--accent); color:#fff; text-align:left; padding:3pt 4pt; font-weight:600; }
.doc td{ border-bottom:.6pt solid var(--rule); padding:3pt 4pt; vertical-align:top; }
.doc hr{ border:0; border-top:.6pt solid var(--rule); margin:10pt 0; }
.doc em{ color:#3b4655; }
.doc blockquote{ margin:6pt 0; padding:4pt 10pt; border-left:2.5pt solid var(--accent); background:var(--accent-soft); }
.toc2 li{ margin:3pt 0; font-size:10pt; }
'''

html = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><title>eBMR Build Outline</title><style>{css}</style></head><body>
<div class="cover">
  <div class="cover-top">Build outline · Version 0.2 · For approval before coding</div>
  <h1 class="cover-title">Electronic Batch Manufacturing Record (eBMR)<br>Build Outline</h1>
  <div class="cover-sub">Tablets edition and Injectables edition<br>India (Revised Schedule M) · US FDA · EU GMP</div>
  <div class="cover-stats">
    <div><b>241</b><span>controls implemented and tested</span></div>
    <div><b>8</b><span>build phases, each ending in a working demo</span></div>
    <div><b>14</b><span>decisions for you, each with a recommendation</span></div>
  </div>
  <div class="cover-meta">
    <div><span>Date</span>27 September 2026</div>
    <div><span>Status</span>Revised after two independent critiques (103 issues resolved)</div>
    <div><span>Repository</span>github.com/maglesT/ebmr · docs/outline/build-outline.md</div>
  </div>
  <div class="cover-foot">Plan only: no application code has been written yet. Regulatory content is paraphrased; clause references point to the official texts.</div>
</div>
<div class="page"><h1 class="h1">Contents</h1><ol class="toc2">{toc}</ol></div>
<div class="doc">{body}</div></body></html>'''
open(out, 'w').write(html)
print('sections:', len(heads))
