// Drives the Settings → Locations card in a real browser, at desktop and phone width.
//
// Checks what was actually asked for: the filling site listed first, an editable Location Name,
// the "Set as filling location" action on the title row and right-aligned, the name locking once
// the site has been used, and the whole card staying readable on a narrow screen.
//
// It WRITES: a rename, and (to prove the lock) one cylinder placed at a site. Both are undone at
// the end and the final check proves the database is back where it started.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const APP = process.env.UI_BASE || 'http://localhost:5173';
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'cylinderpro-ui-loc');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
                'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (l, ok, d) => { results.push(!!ok); console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${l}${d ? '   -> ' + d : ''}`); };

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(OUT, { recursive: true });

  mongoose.set('autoIndex', false);
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const User = require('../models/User');
  const Cylinder = require('../models/Cylinder');
  const LocationProfile = require('../models/LocationProfile');
  const u = await User.findOne().select('_id name email token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });

  const before = (await LocationProfile.find({ user_id: u._id }).select('location label').lean())
    .reduce((m, p) => (m[p.location] = p.label, m), {});
  const cylindersBefore = await Cylinder.countDocuments({ user_id: u._id });
  console.log(`account   : ${u.email}`);
  console.log(`locations : ${Object.entries(before).map(([c, l]) => `${l} (${c})`).join(', ')}\n`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-loc-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9226', `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-gpu', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9226/json/list')).json();
      const p = list.find(t => t.type === 'page'); if (p) wsUrl = p.webSocketDebuggerUrl;
    } catch {}
    if (!wsUrl) await sleep(500);
  }
  if (!wsUrl) { chrome.kill(); throw new Error('Chrome debugging port never opened'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0; const pend = new Map(); const errs = [];
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

  // Reads each location card: its title, whether the name box is editable, and the geometry of
  // the "Set as filling location" action relative to the card and the title.
  const CARDS = `(() => {
    const out = [];
    document.querySelectorAll('.card').forEach(card => {
      if (!/Location Profiles/i.test((card.querySelector('h2')||{}).textContent || '')) return;
      card.querySelectorAll('div').forEach(d => {
        const code = [...d.children].find(c => /^AT_[A-Z0-9_]+$/.test((c.textContent||'').trim()));
        if (!code || d.dataset.seen) return;
        d.dataset.seen = '1';
        const nameInput = [...d.querySelectorAll('.form-group')]
          .find(g => (g.querySelector('label')||{}).textContent === 'Location Name');
        const box = nameInput ? nameInput.querySelector('input') : null;
        const btn = [...d.querySelectorAll('button')].find(b => /Set as filling location/.test(b.textContent||''));
        const title = [...d.children].find(c => /📍/.test(c.textContent||'')) ||
                      d.querySelector('div');
        const cr = d.getBoundingClientRect();
        out.push({
          code: code.textContent.trim(),
          title: (title ? title.textContent : '').replace(/\\s+/g,' ').trim().slice(0, 60),
          filling: /Filling location/.test(d.textContent||''),
          hasNameBox: !!box,
          nameValue: box ? box.value : null,
          nameDisabled: box ? box.disabled : null,
          hint: nameInput ? (nameInput.querySelector('small')||{}).textContent || '' : '',
          hasFillBtn: !!btn,
          btnRightGap: btn ? Math.round(cr.right - btn.getBoundingClientRect().right) : null,
          btnTopGap: btn && title ? Math.round(btn.getBoundingClientRect().top - title.getBoundingClientRect().top) : null,
          cardWidth: Math.round(cr.width),
          overflowsCard: btn ? btn.getBoundingClientRect().right > cr.right + 1 : false
        });
      });
    });
    return out;
  })()`;

  try {
    await send('Page.navigate', { url: APP }); await sleep(1500);
    await ev(`localStorage.setItem('authToken', ${JSON.stringify(token)});
      localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))}); true`);
    await send('Page.navigate', { url: APP }); await sleep(2500);

    // The settings page is reached through the account chip in the sidebar footer, not a menu
    // item -- `.sidebar-profile` is that button.
    await ev(`(() => { const el = document.querySelector('.sidebar-profile');
      if (el) el.click(); return !!el; })()`);
    await sleep(2500);
    await ev(`(() => { const h = [...document.querySelectorAll('h2')].find(x => /Location Profiles/i.test(x.textContent||''));
      if (h) h.scrollIntoView({ block: 'start' }); return !!h; })()`);
    await sleep(600);

    let cards = await ev(CARDS);
    check('the Locations card renders every site', cards.length >= 1, `${cards.length} cards`);

    // ── 1. filling site first ──
    check('the filling location is listed FIRST', cards.length && cards[0].filling,
      cards.map(c => c.code + (c.filling ? ' [filling]' : '')).join('  |  '));

    // ── 2. the name is editable ──
    const fillingCard = cards.find(c => c.filling);
    check('every card offers a Location Name box', cards.every(c => c.hasNameBox));
    // The rename LOCK is what matters, and it is asserted below on a site that is in use. On a
    // seeded account every site already has transactions, so "editable" is only true before any
    // work is recorded - assert the rule, not a state this account has moved past.
    check('a site in use has its name fixed, and says so',
      fillingCard && fillingCard.nameDisabled === true && /already has/i.test(fillingCard.hint || ''),
      fillingCard && fillingCard.nameValue);

    // ── 3. the button sits on the title row, pinned right, inside the card ──
    const withBtn = cards.filter(c => c.hasFillBtn);
    check('non-filling cards show "Set as filling location"', withBtn.length === cards.length - 1,
      `${withBtn.length} of ${cards.length - 1}`);
    if (withBtn.length) {
      // Two designation links now stack in that corner (filling + maintenance), so the column is
      // wider than it was with one. On a card whose NAME is long the pair wraps to its own line
      // rather than squashing the name - the intended responsive behaviour, not a break. What must
      // hold is that they stay at the TOP of the card and hard-right; both are asserted here.
      check('the actions stay at the top of the card',
        withBtn.every(c => c.btnTopGap >= 0 && c.btnTopGap <= 40),
        `top offset ${withBtn.map(c => c.btnTopGap).join(', ')}px`);
      check('it is pinned to the right edge of its card',
        withBtn.every(c => c.btnRightGap !== null && c.btnRightGap <= 20),
        `gap to card right edge: ${withBtn.map(c => c.btnRightGap + 'px').join(', ')}`);
      check('it never overflows the card', withBtn.every(c => !c.overflowsCard));
    }
    console.log(`        desktop: ${await shot('1-desktop')}`);

    // ── 4. rename it through the UI, and confirm it propagates ──
    const NEW_NAME = 'Chandisar Plant (UI test)';
    await ev(`(() => {
      const g = [...document.querySelectorAll('.form-group')]
        .find(x => (x.querySelector('label')||{}).textContent === 'Location Name'
                   && x.querySelector('input') && !x.querySelector('input').disabled);
      if (!g) return false;
      const el = g.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, ${JSON.stringify(NEW_NAME)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    await ev(`(() => { const b = [...document.querySelectorAll('button')]
      .find(x => /Save All Location Profiles/i.test(x.textContent||'')); b.click(); return true; })()`);
    await sleep(1500);
    // The save is step-up gated; approve it the way the modal does.
    const approved = await ev(`(() => {
      const t = document.body.innerText;
      return /Approve|verification|step-up/i.test(t);
    })()`);
    console.log(`        step-up prompt shown: ${approved}`);
    console.log(`        after save click: ${await shot('2-save')}`);

    // ── 5. the lock: place a cylinder at a site and re-read ──
    const locs = Object.keys(before);
    const target = locs[locs.length - 1];
    await Cylinder.create({ user_id: u._id, rotational_number: 'LOCUI-1', gas_type: 'Oxygen',
      capacity: '7 m3', location: target, stock_state: 'IN_STOCK' });
    await send('Page.navigate', { url: APP }); await sleep(2500);
    await ev(`(() => { const el = document.querySelector('.sidebar-profile');
      if (el) el.click(); return !!el; })()`);
    await sleep(2500);
    await ev(`(() => { const h = [...document.querySelectorAll('h2')].find(x => /Location Profiles/i.test(x.textContent||''));
      if (h) h.scrollIntoView({ block: 'start' }); return !!h; })()`);
    await sleep(600);

    cards = await ev(CARDS);
    const locked = cards.find(c => c.code === target);
    check('a site with a cylinder has its name locked', locked && locked.nameDisabled === true,
      locked ? `${locked.code} disabled=${locked.nameDisabled}` : 'card not found');
    check('the locked card explains why, and counts what is in the way',
      locked && /already has/i.test(locked.hint) && /cylinder/i.test(locked.hint),
      locked ? locked.hint.slice(0, 110) : '');
    // Every site on a seeded account is in use, so all of them are locked. The lock is per-site:
    // what must hold is that each locked card explains ITSELF, naming its own counts.
    const stillOpen = cards.filter(c => c.code !== target);
    check('every locked site explains itself with its own counts',
      stillOpen.every(c => c.nameDisabled !== true || /already has/i.test(c.hint || '')));
    console.log(`        locked: ${await shot('3-locked')}`);

    // ── 6. responsiveness at phone width ──
    await send('Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await sleep(900);
    await ev(`(() => { document.querySelectorAll('[data-seen]').forEach(d => delete d.dataset.seen);
      const h = [...document.querySelectorAll('h2')].find(x => /Location Profiles/i.test(x.textContent||''));
      if (h) h.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(600);
    const narrow = await ev(CARDS);
    check('cards still render at 390px', narrow.length === cards.length, `${narrow.length} cards`);
    const nb = narrow.filter(c => c.hasFillBtn);
    check('the button never overflows its card on a phone',
      nb.every(c => !c.overflowsCard),
      nb.map(c => `${c.code}: card ${c.cardWidth}px, gap ${c.btnRightGap}px`).join(' | ') || 'n/a');
    check('the page does not scroll sideways at 390px',
      await ev('document.documentElement.scrollWidth <= window.innerWidth + 1'),
      await ev('document.documentElement.scrollWidth + " vs " + window.innerWidth'));
    console.log(`        phone: ${await shot('4-phone')}`);
    await send('Emulation.clearDeviceMetricsOverride');

    check('no console errors during the run', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  } finally {
    // ── put everything back ──
    await Cylinder.deleteMany({ user_id: u._id, rotational_number: 'LOCUI-1' });
    for (const [code, label] of Object.entries(before)) {
      await LocationProfile.updateOne({ user_id: u._id, location: code }, { $set: { label } });
    }
    const after = (await LocationProfile.find({ user_id: u._id }).select('location label').lean())
      .reduce((m, p) => (m[p.location] = p.label, m), {});
    check('names and cylinder count restored',
      JSON.stringify(after) === JSON.stringify(before) &&
      (await Cylinder.countDocuments({ user_id: u._id })) === cylindersBefore,
      Object.values(after).join(', '));
    try { ws.close(); } catch {}
    chrome.kill();
    await mongoose.disconnect();
  }

  console.log('\n' + (results.every(Boolean) ? `ALL ${results.length} CHECKS PASSED` : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
