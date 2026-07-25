const nodemailer = require('nodemailer');

// Outbound email (Phase 17). Configured entirely via environment:
//   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, SMTP_FROM
// Without SMTP_HOST there is NO transport (typical local dev) — sendMail then logs the
// message to the server console and reports { sent: false } so callers can fall back to
// a dev-mode code reveal. Never enable that fallback path in production.
let transport = null;
if (process.env.SMTP_HOST) {
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
}

async function sendMail({ to, subject, text }) {
  if (!transport) {
    console.log(`[DEV MAIL — SMTP not configured] To: ${to} | ${subject} | ${text}`);
    return { sent: false };
  }
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to, subject, text
  });
  return { sent: true };
}

module.exports = { sendMail, isConfigured: () => !!transport };
