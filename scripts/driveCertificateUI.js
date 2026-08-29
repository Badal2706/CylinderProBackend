// Drives the F-11 Purity Test Certificate flow in a real browser — same zero-dependency CDP
// approach as scripts/driveUI.js (installed Chrome headless, Node's built-in WebSocket).
//
// What it actually clicks: open a customer, open the certificate form, pick each of the eight
// gas types and compare the impurity rows that appear against the defaults table, edit fields,
// save, view the saved certificate, confirm there is no edit control anywhere on it, delete it.
//
// It WRITES: one certificate, saved through the real UI. Everything it creates is removed at the
// end, including the sequence number consumed, and the final checks prove the database is back
// where it started.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const APP = process.env.UI_BASE || 'http://localhost:5173';   // localhost, not 127.0.0.1 — CORS
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'cylinderpro-ui-cert');
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

// The expected defaults, mirrored from CylinderProFrontend/src/App.jsx. Duplicated deliberately:
// reading the app's own copy would let a wrong table agree with itself.
const EXPECTED = {
  'Oxygen':        ['Moisture (H2O)', 'Carbon Dioxide (CO2)', 'Carbon Monoxide (CO)', 'Acetylene (C2H2)', 'Total Hydrocarbons'],
  'Nitrogen':      ['Oxygen (O2)', 'Moisture (H2O)', 'Carbon Dioxide (CO2)', 'Carbon Monoxide (CO)', 'Total Hydrocarbons'],
  'Argon':         ['Oxygen (O2)', 'Nitrogen (N2)', 'Moisture (H2O)', 'Total Hydrocarbons'],
  'CO2':           ['Moisture (H2O)', 'Oxygen (O2)', 'Nitrogen (N2)', 'Carbon Monoxide (CO)', 'Total Hydrocarbons', 'Sulphur Compounds'],
  'Nitrous Oxide': ['Moisture (H2O)', 'Carbon Monoxide (CO)', 'Nitric Oxide / Nitrogen Dioxide (NO/NO2)', 'Ammonia (NH3)', 'Air and other gases'],
  'Acetylene':     ['Phosphine (PH3)', 'Hydrogen Sulphide (H2S)', 'Moisture (H2O)', 'Air and other gases'],
  'Helium':        ['Oxygen (O2)', 'Nitrogen (N2)', 'Moisture (H2O)', 'Total Hydrocarbons'],
  'H2':            ['Oxygen (O2)', 'Nitrogen (N2)', 'Moisture (H2O)', 'Carbon Monoxide (CO)', 'Carbon Dioxide (CO2)']
};

// Writing to a React-controlled input means going through the native value setter — assigning
// .value directly leaves React's internal value tracker stale and the change is discarded.
const SET_VALUE = `
  window.__set = (el, v) => {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
                : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  window.__labelled = (text) => [...document.querySelectorAll('.form-group')]
    .find(g => g.querySelector('label') && g.querySelector('label').textContent.trim().startsWith(text));
  window.__impurityRows = () => [...document.querySelectorAll('.form-group')]
    .filter(g => g.querySelector('label') && g.querySelector('label').textContent.trim() === 'Impurities')
    .flatMap(g => [...g.querySelectorAll('tbody tr')])
    .map(tr => [...tr.querySelectorAll('input')].map(i => i.value));
  true;`;

(async () => {
  if (!CHROME) throw new Error('no Chrome or Edge found');
  fs.mkdirSync(OUT, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const User = require('../models/User');
  const Counter = require('../models/Counter');
  const PurityCertificate = require('../models/PurityCertificate');
  const u = await User.findOne({ email: /gurugases/i }).select('_id name email token_version').lean();
  const token = jwt.sign({ id: String(u._id), tv: u.token_version || 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });

  const beforeCerts = await PurityCertificate.countDocuments({ user_id: u._id });
  const beforeCounter = await Counter.findOne({ user_id: u._id, key: 'purity_certificate_series' }).lean();

  console.log(`browser : ${path.basename(CHROME)}`);
  console.log(`app     : ${APP}`);
  console.log(`account : ${u.email}\n`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-chrome-cert-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9223', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1440,1200', 'about:blank'
  ], { stdio: 'ignore' });

  let wsUrl;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9223/json/list')).json();
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
  await cdp.send('Log.enable').catch(() => {});

  const consoleErrors = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      const x = m.params.entry;
      if (/favicon\.ico/.test(x.url || '') || /favicon\.ico/.test(x.text || '')) return;
      consoleErrors.push(`${x.text}${x.url ? ' [' + x.url + ']' : ''}`);
    }
  });

  const goto = async (url) => { await cdp.send('Page.navigate', { url }); await sleep(1500); };
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(data, 'base64'));
    return f;
  };

  let certNumber = '';
  try {
    // ── sign in ──
    await goto(APP);
    await cdp.eval(`localStorage.setItem('authToken', ${JSON.stringify(token)});
      localStorage.setItem('currentUser', ${JSON.stringify(JSON.stringify({ name: u.name, email: u.email }))}); true`);
    await goto(APP);
    check('signs in and reaches the app shell',
      await cdp.eval(`!!document.body.innerText.match(/Dashboard|Customers|Payments/i)`));

    // ── open a customer ──
    await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('button, a, li, div')]
        .filter(n => n.children.length === 0 || n.tagName === 'BUTTON')
        .find(n => /^\\s*(👥\\s*)?Customers\\s*$/i.test(n.textContent || ''));
      if (el) el.click(); return !!el;
    })()`);
    await sleep(2200);
    const opened = await cdp.eval(`(() => {
      const row = document.querySelector('table tbody tr');
      if (!row) return '';
      const name = (row.children[1] || {}).textContent || '';
      const btn = [...row.querySelectorAll('button')].find(b => /View Detail/i.test(b.textContent || ''));
      if (!btn) return '';
      btn.click(); return name.trim();
    })()`);
    check('opened a customer detail page', !!opened, opened);
    await sleep(2500);
    await cdp.eval(SET_VALUE);

    // ── the section exists ──
    const pageText = await cdp.eval('document.body.innerText');
    check('the "Purity Test Certificates" section is on the page', /Purity Test Certificates/.test(pageText));
    check('it offers "+ New Certificate"', /\+ New Certificate/.test(pageText));
    await cdp.eval(`(() => {
      const el = document.getElementById('purity-certificates');
      if (el) el.scrollIntoView({ block: 'center' });
      return !!el;
    })()`);
    await sleep(600);
    console.log(`        customer page: ${await shot('1-customer-detail')}`);

    // ── open the form ──
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /\\+ New Certificate/.test(x.textContent || ''));
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
    await cdp.eval(SET_VALUE);

    const prefill = await cdp.eval(`(() => {
      const g = (t) => { const el = window.__labelled(t); return el ? (el.querySelector('input,textarea,select')||{}).value : null; };
      return { name: g('Customer Name'), addr: g('Customer Address'), owner: g('Cylinder Owner'), date: g('Certificate Date') };
    })()`);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    check('the form pre-fills the customer name from the customer record',
      !!prefill.name && opened.startsWith(prefill.name.slice(0, 8)), prefill.name);
    check('it pre-fills the cylinder owner from Business Profile', !!prefill.owner, prefill.owner);
    check("it pre-fills today's date", prefill.date === today, `${prefill.date} (expected ${today})`);

    // ── each of the eight gas types loads its own impurity rows ──
    for (const gas of Object.keys(EXPECTED)) {
      const rows = await cdp.eval(`(() => {
        const sel = window.__labelled('Gas Type').querySelector('select');
        window.__set(sel, ${JSON.stringify(gas)});
        return null;
      })()`);
      await sleep(350);
      const got = await cdp.eval(`window.__impurityRows()`);
      const names = (got || []).map(r => r[0]);
      check(`selecting ${gas} loads its impurity rows`,
        JSON.stringify(names) === JSON.stringify(EXPECTED[gas]),
        `${names.length} rows: ${names.join(', ').slice(0, 90)}`);
    }
    console.log(`        form with defaults: ${await shot('2-form')}`);

    // ── edit fields, including an impurity row, and add one ──
    await cdp.eval(`(() => {
      const sel = window.__labelled('Gas Type').querySelector('select');
      window.__set(sel, 'Oxygen');
      return true;
    })()`);
    await sleep(350);
    await cdp.eval(`(() => {
      window.__set(window.__labelled('Purity (%)').querySelector('input'), '99.71');
      window.__set(window.__labelled('Cylinder No.').querySelector('input'), 'UI-CHECK-1');
      window.__set(window.__labelled('Quantity').querySelector('input'), '3');
      window.__set(window.__labelled('Cylinder Water Capacity').querySelector('input'), '46.7');
      // edit the first impurity row in place
      const rows = [...document.querySelectorAll('.form-group')]
        .filter(g => g.querySelector('label') && g.querySelector('label').textContent.trim() === 'Impurities')
        .flatMap(g => [...g.querySelectorAll('tbody tr')]);
      window.__set(rows[0].querySelectorAll('input')[1], '4');
      return true;
    })()`);
    await sleep(300);
    // remove one row, then add a new one and fill it
    await cdp.eval(`(() => {
      const btns = [...document.querySelectorAll('button')].filter(b => (b.textContent||'').trim() === 'Remove');
      btns[btns.length - 1].click(); return true;
    })()`);
    await sleep(300);
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /\\+ Add Impurity Row/.test(x.textContent || ''));
      b.click(); return true;
    })()`);
    await sleep(300);
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.form-group')]
        .filter(g => g.querySelector('label') && g.querySelector('label').textContent.trim() === 'Impurities')
        .flatMap(g => [...g.querySelectorAll('tbody tr')]);
      const last = rows[rows.length - 1].querySelectorAll('input');
      window.__set(last[0], 'Argon (Ar)');
      window.__set(last[1], '2');
      return true;
    })()`);
    await sleep(300);

    const edited = await cdp.eval(`window.__impurityRows()`);
    check('an impurity row can be edited, removed and added',
      edited.length === 5 && edited[0][1] === '4' && edited[4][0] === 'Argon (Ar)',
      `${edited.length} rows, first ppm ${edited[0][1]}, last ${edited[4][0]}`);

    // ── save ──
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /Save Certificate/.test(x.textContent || ''));
      b.click(); return true;
    })()`);
    await sleep(3000);

    const saved = await PurityCertificate.findOne({ user_id: u._id, cylinder_serial_no: 'UI-CHECK-1' }).lean();
    check('the certificate saved through the UI', !!saved, saved && saved.certificate_number);
    certNumber = saved ? saved.certificate_number : '';
    check('the edits were persisted, not the defaults',
      saved && saved.purity_percent === '99.71' && saved.qty === '3' &&
      saved.impurities.length === 5 && saved.impurities[0].ppm_text === '4' &&
      saved.impurities[4].name === 'Argon (Ar)',
      saved ? `purity ${saved.purity_percent}, ${saved.impurities.length} impurities` : '');

    const listText = await cdp.eval('document.body.innerText');
    check('it appears in the customer\'s certificate list', listText.includes(certNumber), certNumber);
    console.log(`        saved: ${await shot('3-saved')}`);

    // ── view it: read-only, no edit anywhere ──
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent||'').trim() === 'View');
      if (b) b.click(); return !!b;
    })()`);
    await sleep(1200);
    // Scoped to the certificate view and its section — the page BEHIND the modal has its own
    // "Edit Customer" button, which is not an edit affordance for the certificate.
    const view = await cdp.eval(`(() => {
      const modal = document.querySelector('.modal-card');
      const section = document.getElementById('purity-certificates');
      const btns = (el) => el ? [...el.querySelectorAll('button')].map(b => (b.textContent||'').trim()) : [];
      return {
        text: modal ? modal.innerText : '',
        inputs: modal ? modal.querySelectorAll('input, textarea, select').length : -1,
        buttons: btns(modal),
        sectionButtons: btns(section)
      };
    })()`);
    check('the view shows the issued values', view.text.includes('99.71') && view.text.includes('Argon (Ar)'));
    check('the view says a certificate cannot be edited', /cannot be edited/i.test(view.text));
    check('the view has no input of any kind — it is read-only markup',
      view.inputs === 0, `${view.inputs} inputs`);
    const editish = (t) => /edit|update|save/i.test(t);
    check('no edit control on the certificate view',
      !view.buttons.some(editish), view.buttons.filter(editish).join(', ') || 'none');
    check('no edit control in the certificate section either',
      !view.sectionButtons.some(editish), view.sectionButtons.filter(editish).join(', ') || 'none');
    check('the view offers only Print and Delete',
      view.buttons.some(t => /Print \/ PDF/.test(t)) && view.buttons.some(t => /Delete Certificate/.test(t)));
    console.log(`        view: ${await shot('4-view')}`);

    // ── print it ──
    // The print handler calls window.open() and document.write()s into the result. Here that is
    // redirected into an on-page iframe with print()/close() stubbed, so the real function runs
    // unmodified and its output can be read and photographed instead of going to a printer.
    await cdp.eval(`(() => {
      const frame = document.createElement('iframe');
      frame.id = '__printframe';
      frame.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:1250px;border:0;background:#fff;z-index:99999';
      document.body.appendChild(frame);
      window.__origOpen = window.open;
      window.open = () => {
        const w = frame.contentWindow;
        w.print = () => { window.__printCalled = true; };
        w.close = () => {};
        return w;
      };
      return true;
    })()`);
    // Scoped to the modal: the customer page behind it has its OWN "Print / PDF" button
    // (the customer ledger), which is the one an unscoped selector finds first.
    await cdp.eval(`(() => {
      const b = [...document.querySelector('.modal-card').querySelectorAll('button')]
        .find(x => /Print \\/ PDF/.test(x.textContent || ''));
      b.click(); return true;
    })()`);
    await sleep(2500);

    const printed = await cdp.eval(`(() => {
      const f = document.getElementById('__printframe');
      const d = f.contentDocument;
      return { html: d.documentElement.outerHTML, text: d.body.innerText,
               rows: d.querySelectorAll('table.ctab tbody tr').length,
               printCalled: !!window.__printCalled };
    })()`);

    check('printing runs the real print handler', printed.printCalled);
    check('the printed page carries the letterhead shell', /hdr-box/.test(printed.html) && /Purity Test Certificate/.test(printed.text));
    check('it prints the certificate number and date',
      printed.text.includes(certNumber) && /Date:/.test(printed.text), certNumber);
    check('it prints the To block with the snapshotted customer',
      /To,/.test(printed.text) && printed.text.includes('M/s. ' + opened), opened);
    check('it prints Sub, the salutation and the declaration',
      /Sub:/.test(printed.text) && /Dear Sir,/.test(printed.text) && /has been tested in our laboratory/.test(printed.text));
    check('the detail block carries the issued values',
      /Purity/.test(printed.text) && printed.text.includes('99.71') &&
      printed.text.includes('UI-CHECK-1') && /Cylinder Water Capacity/.test(printed.text));
    check('blank optional fields print no orphan label',
      !/Date of Delivery/.test(printed.text) && !/Challan Ref/.test(printed.text),
      (printed.text.match(/Date of Delivery|Challan Ref\./g) || ['none']).join(','));
    check('the impurity table prints every row', printed.rows === 5, `${printed.rows} rows`);
    check('the signature block reads For / business / signatory',
      /For,/.test(printed.text) && /Authorised Signatory/.test(printed.text));
    console.log(`        printed page: ${await shot('6-print')}`);
    await cdp.eval(`(() => { window.open = window.__origOpen;
      const f = document.getElementById('__printframe'); if (f) f.remove(); return true; })()`);
    await sleep(400);

    // ── delete it ──
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /Delete Certificate/.test(x.textContent || ''));
      b.click(); return true;
    })()`);
    await sleep(900);
    const confirmText = await cdp.eval('document.body.innerText');
    check('deleting asks for confirmation first', /Delete this certificate\?/i.test(confirmText));
    check('the confirmation says nothing else is affected', /Nothing else is affected/i.test(confirmText));
    await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].filter(x => /Delete Certificate/.test(x.textContent || ''));
      b[b.length - 1].click(); return true;
    })()`);
    await sleep(2200);
    check('the certificate is gone from the database',
      (await PurityCertificate.countDocuments({ user_id: u._id, cylinder_serial_no: 'UI-CHECK-1' })) === 0);
    console.log(`        after delete: ${await shot('5-deleted')}`);

    check('no console errors during the whole run', consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || 'none');
  } finally {
    // ── cleanup: nothing this run created may survive, including the number it consumed ──
    await PurityCertificate.deleteMany({ user_id: u._id, cylinder_serial_no: 'UI-CHECK-1' });
    if (beforeCounter) {
      await Counter.updateOne({ user_id: u._id, key: 'purity_certificate_series' }, { $set: { seq: beforeCounter.seq } });
    } else {
      await Counter.deleteOne({ user_id: u._id, key: 'purity_certificate_series' });
    }
    const afterCerts = await PurityCertificate.countDocuments({ user_id: u._id });
    const afterCounter = await Counter.findOne({ user_id: u._id, key: 'purity_certificate_series' }).lean();
    check('the database is back where it started',
      afterCerts === beforeCerts && (afterCounter && afterCounter.seq) === (beforeCounter && beforeCounter.seq),
      `certificates ${beforeCerts} -> ${afterCerts}`);

    try { ws.close(); } catch {}
    chrome.kill();
    await mongoose.disconnect();
  }

  console.log('\n' + (results.every(Boolean) ? `ALL ${results.length} CHECKS PASSED` : `${results.filter(x => !x).length} of ${results.length} FAILED`));
  process.exit(results.every(Boolean) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
