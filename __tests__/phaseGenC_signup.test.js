// Phase GEN-C: the signup duplicate-email dead end.
//
// The fix is a frontend button that appears only when the error text matches EXACTLY. That makes
// the two strings a silent coupling: reword the backend message and the button quietly stops
// appearing, with nothing failing and no way to notice. This test is the thing that notices.
const fs = require('fs');
const path = require('path');

const BACKEND_MSG = 'Email is already registered';
const AUTH = path.join(__dirname, '..', 'services', 'auth.service.js');
const APP = path.join(__dirname, '..', '..', 'CylinderProFrontend', 'src', 'App.jsx');

describe('the duplicate-email message is a contract between backend and frontend', () => {
  test('the backend throws exactly that message, from both of its check sites', () => {
    const src = fs.readFileSync(AUTH, 'utf8');
    const hits = src.split('\n').filter(l => l.includes(BACKEND_MSG));
    // One in signupRequest's pre-check, one in the post-OTP create.
    expect(hits.length).toBeGreaterThanOrEqual(2);
    hits.forEach(l => expect(l).toMatch(/HttpError\(400, 'Email is already registered'\)/));
  });

  test('the frontend matches on the identical string', () => {
    if (!fs.existsSync(APP)) return;                   // backend checked out on its own
    const src = fs.readFileSync(APP, 'utf8');
    expect(src).toContain(`const EMAIL_TAKEN = '${BACKEND_MSG}'`);
    expect(src).toMatch(/error === EMAIL_TAKEN/);
  });

  test('the action switches to sign-in and keeps the typed email', () => {
    if (!fs.existsSync(APP)) return;
    const src = fs.readFileSync(APP, 'utf8');
    const i = src.indexOf('Log in instead');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, i - 900), i);
    expect(block).toMatch(/setMode\('signin'\)/);
    // The whole point is not retyping the address: password/name/licence are cleared, email is not.
    expect(block).toMatch(/setFormData\(f => \(\{ \.\.\.f, password: '', name: '', licence_number: '' \}\)\)/);
    expect(block).not.toMatch(/email: ''/);
  });
});
