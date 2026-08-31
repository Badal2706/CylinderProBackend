// The printed notes block, driven in a real browser.
//
//   node -r dotenv/config scripts/drivePrintNotes.js
//
// The block used to be hardcoded in the challan. It is now free text on the BusinessProfile with
// per-document flags, so the thing that must be proved is:
//
//   1. The challan still prints the SAME four Gujarati notes and the same two English lines.
//   2. A document that is NOT ticked prints nothing at all -- not an empty heading.
//   3. Ticking a document on makes it appear there, and untickng it makes it vanish.
//   4. Blank text prints nothing anywhere, even where the flags are on.
//
// It calls the print builders directly in the page, reading their generated HTML rather than
// opening print dialogs -- window.print() cannot be driven headlessly, and the HTML is the thing
// under test. Every profile change it makes is undone at the end and re-verified.
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const APP = process.env.UI_BASE || 'http://localhost:5173';
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (l, ok, d) => { results.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

const GUJ = 'સિલિન્ડર રીટર્ન આપતી વખતે';           // first note
const ENG = 'Subject to Palanpur Jurisdiction';      // last closing line

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const User = require('../models/User');
  const BusinessProfile = require('../models/BusinessProfile');
  const u = await User.findOne({}).select('_id name email token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });

  const before = await BusinessProfile.findOne({ user_id: u._id }).lean();
  const originalNotes = JSON.parse(JSON.stringify(before.print_notes || {}));
  console.log('account : ' + u.email);
  console.log('notes   : ' + (originalNotes.body || '').split('\n').filter(Boolean).length + ' line(s), '
    + 'challan=' + !!(originalNotes.show_on || {}).challan + '\n');

  const setFlags = (flags) => BusinessProfile.updateOne({ user_id: u._id },
    { $set: { 'print_notes.show_on': Object.assign(
      { challan: false, holding_statement: false, purity_certificate: false, reports: false }, flags) } });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-notes-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9241', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9241/json/list')).json();
      const p = list.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome debugging port never opened'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
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
  await send('Page.enable'); await send('Runtime.enable');

  // Render the block for one document, straight from the live profile, using the SAME helper the
  // print builders call. Importing the module by URL keeps this honest -- it is the shipped code.
  const renderFor = (docKey) => ev(`(async () => {
    const m = await import('/src/components.jsx');
    const r = await fetch('http://localhost:3001/api/profile/business', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('authToken') } });
    const business = await r.json();
    return m.printNotesBlock(business, ${JSON.stringify(docKey)});
  })()`);

  try {
    await send('Page.navigate', { url: APP }); await sleep(1500);
    await ev(`localStorage.setItem('authToken', ${JSON.stringify(token)});
      localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))}); true`);
    await send('Page.navigate', { url: APP }); await sleep(2600);

    // ── 1. the challan still prints what it always did ──
    console.log('the challan, as seeded from the old hardcoded block');
    let html = await renderFor('challan');
    check('the notes block renders', !!html && html.length > 50);
    check('all four Gujarati notes are present',
      (html.match(/\* /g) || []).length >= 4, ((html.match(/\* /g) || []).length) + ' bullets');
    check('the first note is unchanged', html.includes(GUJ));
    check('the closing English line is unchanged', html.includes(ENG));
    check('the heading prints', /નોંધ/.test(html));

    // ── 2. a document that is not ticked prints NOTHING ──
    console.log('\ndocuments that are not ticked');
    for (const k of ['holding_statement', 'purity_certificate', 'reports']) {
      const out = await renderFor(k);
      check(`${k} prints nothing`, out === '', JSON.stringify(String(out).slice(0, 30)));
    }

    // ── 3. ticking one on moves the block there ──
    console.log('\nticking Holding Statement on, Challan off');
    await setFlags({ holding_statement: true });
    await sleep(300);
    check('it now prints on the holding statement', (await renderFor('holding_statement')).includes(GUJ));
    check('and no longer on the challan', (await renderFor('challan')) === '');

    // ── 4. blank text prints nothing even where ticked ──
    console.log('\nblank text, every document ticked on');
    await BusinessProfile.updateOne({ user_id: u._id }, { $set: {
      'print_notes.heading': '', 'print_notes.body': '', 'print_notes.footer': '',
      'print_notes.show_on': { challan: true, holding_statement: true, purity_certificate: true, reports: true }
    } });
    await sleep(300);
    let blank = true;
    for (const k of ['challan', 'holding_statement', 'purity_certificate', 'reports']) {
      if ((await renderFor(k)) !== '') blank = false;
    }
    check('nothing prints anywhere -- no stray heading', blank);

    // ── restore ──
    await BusinessProfile.updateOne({ user_id: u._id }, { $set: { print_notes: originalNotes } });
    await sleep(300);
    const back = await renderFor('challan');
    check('the original notes are restored', back.includes(GUJ) && back.includes(ENG));
    const now = (await BusinessProfile.findOne({ user_id: u._id }).lean()).print_notes;
    check('the stored record matches what it was',
      JSON.stringify(now.body) === JSON.stringify(originalNotes.body) &&
      !!now.show_on.challan === !!(originalNotes.show_on || {}).challan);

    const failed = results.filter(r => !r).length;
    console.log(`\n${failed ? '*** ' + failed + ' CHECK(S) FAILED ***' : 'ALL ' + results.length + ' CHECKS PASSED'}`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    // Belt and braces: whatever happened above, put the profile back exactly as it was.
    await BusinessProfile.updateOne({ user_id: u._id }, { $set: { print_notes: originalNotes } });
    try { ws.close(); } catch {}
    chrome.kill();
    await mongoose.disconnect();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
})().catch(e => { console.error('FAILED: ' + (e && e.message ? e.message : e)); process.exit(1); });
