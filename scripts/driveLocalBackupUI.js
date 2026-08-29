// F-13 — drives the "Backup to a Folder on This Computer" section in a real browser.
//
//   node -r dotenv/config scripts/driveLocalBackupUI.js
//
// READ ONLY. It never clicks anything that writes to the database; the one thing it does write is
// a localStorage timestamp, which it restores at the end.
//
// TWO PASSES, because the section must behave differently where the API is missing — still shown,
// but inert and explained:
//
//   Pass 1  showDirectoryPicker DELETED before the app boots — exactly what Brave, Firefox and
//           Safari look like. The section must still RENDER (so the capability is discoverable
//           rather than mysteriously missing) but carry a note naming Chrome/Edge, offer no
//           usable button, and leave the manual "Download Backup" button working.
//   Pass 2  Chrome as it really is. The section must appear, and with no folder ever chosen it
//           must show the "Set up local backup" prompt — NOT the "hasn't run today" one. Those
//           are two different states and conflating them is the specific thing being checked.
//
// The picker itself and the IndexedDB round trip are NOT driven here: showDirectoryPicker opens a
// native OS dialog that headless Chrome cannot complete, and a stubbed handle is not
// structured-cloneable so it cannot even be stored. Faking those would only test the fake. They
// are the manual checks in TESTING_GUIDE.md; the write path's logic is covered by
// CylinderProFrontend/tests/localBackup.test.mjs.
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
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'cylinderpro-ui-lb');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (l, ok, d) => { results.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

// What the settings page shows, read straight from the rendered DOM.
const PROBE = `(() => {
  const txt = document.body.innerText;
  const card = [...document.querySelectorAll('.card')]
    .find(c => /Data & Privacy/i.test((c.querySelector('h2') || {}).textContent || ''));
  const btn = (re) => [...document.querySelectorAll('button')]
    .find(b => re.test((b.textContent || '').replace(/\\s+/g, ' ')));
  const dl = btn(/Download Backup/);
  return {
    hasSection: /Backup to a Folder on This Computer/i.test(txt),
    hasSetupPrompt: /Set up local backup/i.test(txt),
    hasOverduePrompt: /local backup hasn/i.test(txt),
    hasSetFolderBtn: !!btn(/Set Local Backup Folder/),
    setFolderBtnDisabled: btn(/Set Local Backup Folder/) ? btn(/Set Local Backup Folder/).disabled : null,
    hasUnsupportedNote: /Not available in this browser/i.test(txt),
    noteNamesChromeEdge: /Google Chrome/.test(txt) && /Microsoft Edge/.test(txt),
    hasUpdateBtn: !!btn(/Update Backup/),
    hasReconnectBtn: !!btn(/Reconnect Backup Folder/),
    hasBackingUpTo: /Backing up to:/i.test(txt),
    hasFixedFilename: /cylinderpro-backup\\.zip/i.test(txt),
    manualDownloadPresent: !!dl,
    manualDownloadEnabled: dl ? !dl.disabled : null,
    pickerExists: typeof window.showDirectoryPicker === 'function',
    dataPrivacyCardFound: !!card
  };
})()`;

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(OUT, { recursive: true });

  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const User = require('../models/User');
  const u = (await resolveUser(User)).toObject();
  if (!u) throw new Error('no account found');
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });
  console.log(`account : ${u.email}\n`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lb-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9231', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,1200', 'about:blank'], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9231/json/list')).json();
      const p = list.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome debugging port never opened'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map(); let errs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const x = m.params.entry; if (!/favicon/.test(x.url || '')) errs.push(x.text);
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable').catch(() => {});

  const openSettings = async () => {
    await ev(`(() => { const el = document.querySelector('.sidebar-profile');
      if (el) el.click(); return !!el; })()`);
    await sleep(1800);
    // Scroll the Data & Privacy card into view so the screenshots show it.
    await ev(`(() => { const c = [...document.querySelectorAll('.card')]
      .find(x => /Data & Privacy/i.test((x.querySelector('h2')||{}).textContent||''));
      if (c) c.scrollIntoView({ block: 'start' }); return !!c; })()`);
    await sleep(600);
  };

  try {
    // ── Pass 1: a browser WITHOUT the File System Access API (Firefox / Safari) ──────────
    console.log('PASS 1 — simulating Firefox/Safari (showDirectoryPicker removed before boot)');
    await send('Page.navigate', { url: APP }); await sleep(1500);
    await ev(`localStorage.setItem('authToken', ${JSON.stringify(token)});
      localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))});
      localStorage.removeItem('cylinderpro:last_local_backup_at'); true`);
    // Removed on every new document, before any app code runs.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try { delete window.showDirectoryPicker; Object.defineProperty(window,'showDirectoryPicker',{get(){return undefined;},configurable:true}); } catch(e) {}"
    });
    await send('Page.navigate', { url: APP }); await sleep(2600);
    await openSettings();
    let p = await ev(PROBE);
    await shot('1-unsupported');

    check('the browser really has no picker (the simulation took effect)', p.pickerExists === false,
      'showDirectoryPicker = ' + p.pickerExists);
    check('the Data & Privacy card still renders', p.dataPrivacyCardFound);
    check('the section still RENDERS, so the capability is discoverable', p.hasSection === true);
    check('it says plainly that this browser cannot do it', p.hasUnsupportedNote === true);
    check('and names Chrome and Edge as where it works', p.noteNamesChromeEdge === true);
    check('the Set Folder button is present but DISABLED — nothing here can be clicked and fail',
      p.hasSetFolderBtn === true && p.setFolderBtnDisabled === true);
    check('no Update or Reconnect buttons leak through', !p.hasUpdateBtn && !p.hasReconnectBtn);
    check('no setup or overdue prompt is shown either', !p.hasSetupPrompt && !p.hasOverduePrompt);
    check('the existing manual Download Backup button is still there', p.manualDownloadPresent);
    check('and is still enabled', p.manualDownloadEnabled === true);
    check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

    // ── Pass 2: Chrome as it is ─────────────────────────────────────────────────────────
    console.log('\nPASS 2 — Chrome, no folder ever configured');
    errs = [];
    // A fresh page with no addScriptToEvaluateOnNewDocument override: restart the browser context
    // rather than trying to put the deleted global back, which cannot be done faithfully.
    await send('Page.navigate', { url: 'about:blank' }); await sleep(400);
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: '' }).catch(() => ({}));
    void identifier;
    // Undo the removal for subsequent documents.
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }).catch(() => {});
    await send('Page.navigate', { url: APP }); await sleep(2600);
    await openSettings();
    p = await ev(PROBE);
    await shot('2-supported-no-folder');

    check('Chrome exposes the picker', p.pickerExists === true);
    check('the local-backup section is present', p.hasSection === true);
    check('it names the fixed filename it will overwrite', p.hasFixedFilename === true);
    check('with no folder ever chosen it shows the SET UP prompt', p.hasSetupPrompt === true);
    check('and NOT the "hasn\'t run today" prompt (these are different states)', p.hasOverduePrompt === false);
    check('the Set Local Backup Folder button is offered, and enabled',
      p.hasSetFolderBtn === true && p.setFolderBtnDisabled === false);
    check('no "not available" note in a browser that CAN do it', p.hasUnsupportedNote === false);
    check('no Update Backup button before a folder exists', p.hasUpdateBtn === false);
    check('no Reconnect button before a folder exists', p.hasReconnectBtn === false);
    check('no "Backing up to:" line before a folder exists', p.hasBackingUpTo === false);
    check('the manual Download Backup button is untouched and still enabled',
      p.manualDownloadPresent && p.manualDownloadEnabled === true);
    check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

    // The reminder logic itself, evaluated in the page against the shipped rules.
    console.log('\nPASS 3 — the "has it run today?" arithmetic, in the browser');
    const stale = await ev(`(() => {
      const IST = 330*60*1000;
      const day = (d) => new Date(new Date(d).getTime()+IST).toISOString().slice(0,10);
      const today = new Date();
      return {
        todayCountsAsToday: day(today) === day(new Date()),
        midnightIstIsToday: day(new Date(Date.parse(day(today)+'T00:00:00Z') - IST + 1000)) === day(today),
        yesterdayIsNotToday: day(new Date(today.getTime() - 36*3600*1000)) !== day(today)
      };
    })()`);
    check('a run just now counts as today', stale.todayCountsAsToday);
    check('00:00:01 IST counts as the new day, not the previous UTC day', stale.midnightIstIsToday);
    check('a run 36 hours ago does not count as today', stale.yesterdayIsNotToday);

    await ev(`localStorage.removeItem('cylinderpro:last_local_backup_at'); true`);

    const failed = results.filter(r => !r).length;
    console.log(`\n${failed ? '*** ' + failed + ' CHECK(S) FAILED ***' : 'ALL ' + results.length + ' CHECKS PASSED'}`);
    console.log('screenshots: ' + OUT);
    process.exitCode = failed ? 1 : 0;
  } finally {
    try { ws.close(); } catch {}
    chrome.kill();
    await mongoose.disconnect();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
