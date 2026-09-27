// Render review-pack.html to PDF with headless Chromium (Playwright).
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const dir = __dirname;
  const out = process.argv[2] || path.join(dir, 'review-pack.pdf');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(dir, 'review-pack.html'), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const footer = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:7px;color:#7a8594;width:100%;padding:0 16mm;display:flex;justify-content:space-between;">
    <span>eBMR Regulatory Requirements · Review Pack v0.9 · Draft for expert verification</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
  await page.pdf({
    path: out, format: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footer,
    margin: { top: '16mm', bottom: '16mm', left: '16mm', right: '16mm' },
    outline: true,
  });
  await browser.close();
  console.log('wrote', out);
})();
