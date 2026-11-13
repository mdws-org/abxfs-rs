// The fs.abx page under the headers its host sends: plan a folder, check its root on a chain, and report every
// content-security-policy violation, page error and the headers received (serve site/ with its _headers first).
// usage: CHROME_PATH=... node tests/page-csp.mjs <page url> <folder> <chain value>
import { createRequire } from 'node:module';
const require = createRequire(process.env.PLAYWRIGHT_DIR || process.cwd() + '/'); // PLAYWRIGHT_DIR: a node_modules directory that holds playwright-core
const { chromium } = require('playwright-core');
const [url, folder, chain] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
const context = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || '(inline)'}${e.sourceFile ? ` from ${e.sourceFile.replace(/^https?:\/\/[^/]+/, '')}:${e.lineNumber}` : ''}`));
});
const page = await context.newPage();
const errors = [], headers = {};
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => { if (r.url().startsWith(url.replace(/\/[^/]*$/, '/'))) headers[r.url().replace(/^https?:\/\/[^/]+/, '')] = r.headers(); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('#tool-version').textContent.length > 0, null, { timeout: 20000 }).catch(() => errors.push('tool version never appeared (WebAssembly did not load?)'));
await page.setInputFiles('#folder', folder);
await page.waitForFunction(() => !document.querySelector('#result').hidden || /Could not/.test(document.querySelector('#status').textContent), null, { timeout: 60000 }).catch(() => errors.push('plan never finished'));
const root = await page.textContent('#root').catch(() => '');
await page.selectOption('#chain', chain);
await page.click('#check');
await page.waitForFunction(() => /Root stored|Root not stored|failed|did not check out/.test(document.querySelector('#chain-result').textContent), null, { timeout: 60000 }).catch(() => errors.push('chain check never finished'));
const verdict = (await page.textContent('#chain-result').catch(() => '')).trim().replace(/\s+/g, ' ');
const csp = await page.evaluate(() => window.__csp);
for (const [p, h] of Object.entries(headers)) console.log(`${p}: type=${h['content-type'] || '-'} csp=${h['content-security-policy'] ? 'yes' : 'no'} cache=${h['cache-control'] || '-'} nosniff=${h['x-content-type-options'] || '-'}`);
console.log(`root ${root.trim().slice(0, 70)}; verdict "${verdict.slice(0, 90)}"`);
console.log(`${csp.length} CSP violation(s), ${errors.length} error(s)`);
for (const v of csp) console.log('  CSP ' + v);
for (const e of errors) console.log('  ERR ' + e);
await browser.close();
const ok = csp.length === 0 && errors.length === 0 && /^0x[0-9a-f]{64}/i.test(root.trim()) && /Root (not )?stored/.test(verdict);
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
