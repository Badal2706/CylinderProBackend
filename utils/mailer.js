const { Resend } = require('resend');
// Outbound email (Phase 17). Uses Resend's API — required because this Droplet's
// provider blocks outbound SMTP ports (465/587) at the network level; see DigitalOcean
// ticket #12627478. Domain guruindustries.co.in is verified with Resend as of 2026-07-30.
// Configured via RESEND_API_KEY and RESEND_FROM in the environment.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function isConfigured() {
  return !!resend;
}

async function sendMail({ to, subject, text }) {
  if (!resend) {
    console.log(`[DEV MAIL — RESEND_API_KEY not configured] To: ${to} | ${subject} | ${text}`);
    return { sent: false };
  }
  try {
    await resend.emails.send({
      from: process.env.RESEND_FROM || 'otp@guruindustries.co.in',
      to,
      subject,
      text,
    });
    return { sent: true };
  } catch (err) {
    console.error(`OTP email to ${to} failed (${err.message})`);
    return { sent: false };
  }
}

module.exports = { sendMail, isConfigured };
