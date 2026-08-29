// Drives the real app in a real browser, with no automation dependency: launches the installed
// Chrome headless with --remote-debugging-port and speaks CDP over Node 24's built-in WebSocket.
//
// Exists because the Payments page was converted to the batch-list pattern and nothing had
// actually clicked it. Logs in by planting the same localStorage keys the login flow writes,
// then screenshots and inspects the live DOM.
//
// Reports only — it never writes to the database.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const APP = process.env.UI_BASE || 'http://127.0.0.1:5173';
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'cylinderpro-ui');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(p => fs.existsSync(p));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId || undefined }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), reject(new Error(method + ' timed out'))), 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  }
}

const results = [];
const check = (label, ok, detail) => {
  results.push(!!ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? '   -> ' + detail : ''}`);
};

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(OUT, { recursive: true });

  // A real session token for the real account — same shape the login endpoint returns.
  await mongoose.connect(process.env.MONGODB_URI);
  const User = require('../models/User');
  const u = await User.findOne().select('_id name email token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });
  await mongoose.disconnect();
  console.log(`browser : ${path.basename(CHROME)}`);
  console.log(`app     : ${APP}`);
  console.log(`account : ${u.email}\n`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9222', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,1000', 'about:blank'
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint.
  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
      const page = list.find(t => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome debugging port never opened'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const consoleErrors = [];
  await cdp.send('Log.enable').catch(() => {});
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const e2 = m.params.entry;
      // The browser asks for /favicon.ico unprompted and index.html declares none. Pre-existing,
      // unrelated to the app, and not worth failing a run over.
      if (/favicon\.ico/.test(e2.url || '') || /favicon\.ico/.test(e2.text || '')) return;
      consoleErrors.push(`${e2.text}${e2.url ? ' [' + e2.url + ']' : ''}`);
    }
  });

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    await sleep(1200);
  };
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    return f;
  };

  // ── 1. the app boots ──
  await goto(APP);
  const title = await cdp.eval('document.title');
  check('app loads and renders', typeof title === 'string' && title.length > 0, `title "${title}"`);
  console.log(`        login screen: ${await shot('1-login')}`);

  // ── 2. plant the session and reload, exactly as a real login does ──
  await cdp.eval(`localStorage.setItem('authToken', ${JSON.stringify(token)});
    localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))}); true`);
  await goto(APP);
  const loggedIn = await cdp.eval(`!!document.body.innerText.match(/Dashboard|Customers|Payments/i)`);
  check('signs in and reaches the app shell', loggedIn);
  console.log(`        dashboard: ${await shot('2-dashboard')}`);

  // ── 3. navigate to Payments by clicking the real nav item ──
  const clicked = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button, a, li, div')]
      .filter(n => n.children.length === 0 || n.tagName === 'BUTTON')
      .find(n => /^\\s*(💰\\s*)?Payments\\s*$/i.test(n.textContent || ''));
    if (!el) return false;
    el.click(); return true;
  })()`);
  check('clicked the Payments nav item', clicked === true);
  await sleep(1800);
  console.log(`        payments: ${await shot('3-payments')}`);

  const pageText = await cdp.eval('document.body.innerText');
  check('Payment History rendered', /Payment History/i.test(pageText));

  // ── 4. the batch-list footer replaced numbered pagination ──
  const rowCount = await cdp.eval(`document.querySelectorAll('table tbody tr').length`);
  check('payment rows rendered', rowCount > 0, `${rowCount} rows`);
  check('shows the batch-list footer, not numbered pages',
    /showing all .* payments|View All \(|Load .* more/i.test(pageText),
    (pageText.match(/showing all [^\n]*/i) || pageText.match(/View All[^\n]*/i) || ['(footer text not matched)'])[0]);
  const numberedPager = await cdp.eval(`(() => {
    const btns = [...document.querySelectorAll('button')].map(b => (b.textContent||'').trim());
    return btns.filter(t => /^(Next|Previous|Page \\d+|\\d+)$/.test(t)).join(',');
  })()`);
  check('no numbered pagination controls remain', !numberedPager, numberedPager || 'none');

  // ── 4b. "View All" batch-loads the rest, in place ──
  const viewAllClicked = await cdp.eval(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => /View All \\(/i.test(b.textContent || ''));
    if (!el) return false;
    el.click(); return true;
  })()`);
  check('clicked "View All"', viewAllClicked === true);
  await sleep(2500);
  const allRows = await cdp.eval(`document.querySelectorAll('table tbody tr').length`);
  const footer = await cdp.eval(`(document.body.innerText.match(/showing all [^\\n]*/i) || [''])[0]`);
  check('View All loaded every payment into the same table', allRows > rowCount,
    `${rowCount} rows -> ${allRows}`);
  check('footer switches to "showing all"', /showing all/i.test(footer), footer || '(not found)');
  console.log(`        after View All: ${await shot('3b-payments-all')}`);

  // ── 5. Net Amount column shows cash alone ──
  const netCheck = await cdp.eval(`(() => {
    const heads = [...document.querySelectorAll('table thead th')].map(h => h.textContent.trim());
    const iRecv = heads.findIndex(h => /Amount Received/i.test(h));
    const iDisc = heads.findIndex(h => /^Discount$/i.test(h));
    const iNet  = heads.findIndex(h => /Net Amount/i.test(h));
    if (iRecv < 0 || iNet < 0) return { ok: false, why: 'columns not found: ' + heads.join('|') };
    const num = (s) => parseFloat((s||'').replace(/[^0-9.\\-]/g, '')) || 0;
    const rows = [...document.querySelectorAll('table tbody tr')].slice(0, 25);
    const bad = [];
    for (const r of rows) {
      const c = r.querySelectorAll('td');
      if (c.length <= iNet) continue;
      const recv = num(c[iRecv].textContent), net = num(c[iNet].textContent),
            disc = iDisc >= 0 ? num(c[iDisc].textContent) : 0;
      if (Math.abs(net - recv) > 0.01) bad.push(\`\${net} != \${recv} (disc \${disc})\`);
    }
    return { ok: bad.length === 0, checked: rows.length, bad: bad.slice(0, 3) };
  })()`);
  check(`"Net Amount" equals "Amount Received" in all ${netCheck.checked || 0} visible rows`,
    netCheck.ok, netCheck.why || (netCheck.bad || []).join(' | ') || 'all match');

  // ── 6. server-side search actually filters ──
  const firstReceipt = await cdp.eval(`(() => {
    const r = document.querySelector('table tbody tr');
    return r ? r.querySelector('td').textContent.trim() : '';
  })()`);
  await cdp.eval(`(() => {
    const inp = [...document.querySelectorAll('input')].find(i => /receipt|search/i.test(i.placeholder || ''));
    if (!inp) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(firstReceipt)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1800);
  const afterSearch = await cdp.eval(`document.querySelectorAll('table tbody tr').length`);
  check(`searching "${firstReceipt}" narrows the list`, afterSearch > 0 && afterSearch < rowCount,
    `${rowCount} rows -> ${afterSearch}`);
  console.log(`        search: ${await shot('4-payments-search')}`);

  check('no console errors during the run', consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(' | ') || 'none');

  console.log('\n' + (results.every(Boolean)
    ? `ALL ${results.length} UI CHECKS PASSED`
    : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  console.log(`screenshots in ${OUT}`);

  ws.close(); chrome.kill();
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
