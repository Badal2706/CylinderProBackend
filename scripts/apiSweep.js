// Walk every page of the running app and report EVERY failed API call.
//
//   node -r dotenv/config scripts/apiSweep.js
//
// READ ONLY — it navigates and clicks nothing that writes. The point is to answer one question
// honestly: is anything the frontend asks for not served by the backend?
//
// A route can be "connected" at the mount level (/api/profile exists) and still 404 on the exact
// path the UI calls, or 500 because a service was renamed. Grepping for prefixes cannot see that;
// only exercising the real pages against the real server can. Every request the page makes is
// captured from the network layer, so nothing depends on the UI surfacing an error.
//
// Also verifies the Dashboard's Backup tile deep-links INTO the local-backup block rather than
// just opening Profile at the top.
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

// Which account to act on. EMAIL=... names one explicitly; with nothing set this falls back to the
// single account in the local database, and refuses if there is more than one rather than guessing.
// Deliberately NOT a hardcoded address: this file is published, and an address baked into source is
// both a privacy leak and wrong on every machine but one.
async function resolveUser(User) {
  const wanted = (process.env.EMAIL || '').trim().toLowerCase();
  if (wanted) {
    const u = await User.findOne({ email: wanted });
    if (!u) throw new Error('No account found for ' + wanted);
    return u;
  }
  const all = await User.find({}, { email: 1, name: 1 }).limit(2).lean();
  if (!all.length) throw new Error('No accounts in this database.');
  if (all.length > 1) throw new Error('More than one account here - name one with EMAIL=you@example.com');
  return User.findOne({ _id: all[0]._id });
}


const APP = process.env.UI_BASE || 'http://localhost:5173';
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'cylinderpro-sweep');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Every sidebar destination, by the nav key the app uses.
const PAGES = ['dashboard', 'new-transaction', 'payments', 'outstanding', 'customers',
               'cylinders', 'aging-report', 'filling-list', 'transactions', 'reports', 'profile'];

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(OUT, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const User = require('../models/User');
  const u = (await resolveUser(User)).toObject();
  if (!u) throw new Error('no account found');
  const sid = (u.sessions && u.sessions.length) ? u.sessions[u.sessions.length - 1].sid : undefined;
  const token = jwt.sign({ id: String(u._id), name: u.name, email: u.email, tv: u.token_version || 0, sid },
                         process.env.JWT_SECRET, { expiresIn: '30m' });
  console.log('account : ' + u.email + '\n');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sweep-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9238', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9238/json/list')).json();
      const p = list.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome debugging port never opened'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0; const pend = new Map();
  const consoleErrs = [];
  const api = [];               // every /api/ response seen
  let currentPage = '(boot)';

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const x = m.params.entry;
      if (!/favicon/.test(x.url || '')) consoleErrs.push(`${currentPage}: ${x.text}`.slice(0, 200));
    }
    // Network.responseReceived carries the status for every request the page made, whether or
    // not the UI chose to show it.
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r && /\/api\//.test(r.url)) {
        api.push({ page: currentPage, url: r.url.replace(/^https?:\/\/[^/]+/, ''), status: r.status });
      }
    }
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  });
  const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise((res, rej) => pend.set(i, { res, rej })); };
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };
  const shot = async (n) => { const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, n + '.png'); fs.writeFileSync(f, Buffer.from(data, 'base64')); return f; };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Log.enable').catch(() => {});

  try {
    await send('Page.navigate', { url: APP }); await sleep(1500);
    await ev(`localStorage.setItem('authToken', ${JSON.stringify(token)});
      localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))}); true`);
    await send('Page.navigate', { url: APP }); await sleep(3000);

    const crashed = [];
    for (const page of PAGES) {
      currentPage = page;
      // Click the sidebar entry (Profile lives in the footer chip, not the menu).
      const clicked = await ev(`(() => {
        if (${JSON.stringify(page)} === 'profile') {
          const el = document.querySelector('.sidebar-profile'); if (el) { el.click(); return true; }
          return false;
        }
        const links = [...document.querySelectorAll('.nav-link')];
        const want = ${JSON.stringify(page)};
        const byText = {
          'dashboard':'Dashboard','new-transaction':'New Transaction','payments':'Payments',
          'outstanding':'Outstanding','customers':'Customers','cylinders':'Cylinder Inventory',
          'aging-report':'Aging Report','filling-list':'Filling List',
          'transactions':'Transaction History','reports':'Reports'
        }[want];
        const el = links.find(l => (l.textContent||'').includes(byText));
        if (el) { el.click(); return true; }
        return false;
      })()`);
      await sleep(2600);
      const boom = await ev(`/This page hit an error/.test(document.body.innerText)`);
      if (boom) crashed.push(page);
      console.log(`  ${boom ? 'CRASH' : 'ok   '}  ${page}${clicked ? '' : '   (nav link not found)'}`);
      if (boom) await shot('crash-' + page);
    }

    // ── The Dashboard Backup tile must land ON the local-backup block ──
    currentPage = 'backup-deeplink';
    await ev(`(() => { const l=[...document.querySelectorAll('.nav-link')].find(x=>/Dashboard/.test(x.textContent||'')); if(l) l.click(); })()`);
    await sleep(2200);
    await ev(`(() => { const c=[...document.querySelectorAll('.stat-card')].find(x=>/Backup/i.test(x.innerText||'')); if(c) c.click(); return !!c; })()`);
    await sleep(2600);
    const deep = await ev(`(() => {
      const el = document.getElementById('local-backup');
      if (!el) return { found:false };
      const r = el.getBoundingClientRect();
      return { found:true, inView: r.top >= -50 && r.top <= window.innerHeight,
               top: Math.round(r.top), vh: window.innerHeight,
               onProfile: /Backup to a Folder on This Computer/.test(document.body.innerText) };
    })()`);
    await shot('backup-deeplink');
    console.log('');
    console.log('Backup tile deep-link:');
    console.log('  lands on Profile              : ' + (deep.onProfile === true));
    console.log('  the local-backup block exists : ' + (deep.found === true));
    console.log('  and is scrolled into view     : ' + (deep.inView === true) +
                (deep.found ? `   (top ${deep.top}px of ${deep.vh}px viewport)` : ''));

    // ── The verdict ──
    const failed = api.filter(r => r.status >= 400);
    console.log('\n' + '='.repeat(84));
    console.log(`API calls observed: ${api.length}   failures: ${failed.length}`);
    if (failed.length) {
      const seen = new Set();
      for (const f of failed) {
        const k = f.status + ' ' + f.url.split('?')[0];
        if (seen.has(k)) continue; seen.add(k);
        console.log(`  !! ${f.status}  ${f.url.split('?')[0]}      (on ${f.page})`);
      }
    } else {
      console.log('  every request the app made was served.');
    }
    if (crashed.length) console.log('\nPAGES THAT CRASHED: ' + crashed.join(', '));
    if (consoleErrs.length) {
      console.log('\nConsole errors:');
      [...new Set(consoleErrs)].slice(0, 8).forEach(e => console.log('  - ' + e));
    }
    console.log('\nscreenshots: ' + OUT);
    process.exitCode = (failed.length || crashed.length) ? 1 : 0;
  } finally {
    try { ws.close(); } catch {}
    chrome.kill();
    await mongoose.disconnect();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
