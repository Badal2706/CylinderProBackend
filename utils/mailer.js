const { Resend } = require('resend');
// Outbound email (Phase 17). Uses Resend's API — required because this Droplet's
// provider blocks outbound SMTP ports (465/587) at the network level; see DigitalOcean
// ticket #12627478. Domain guruindustries.co.in is verified with Resend as of 2026-07-30.
// Configured via RESEND_API_KEY and RESEND_FROM in the environment.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// The address OTP mail is sent FROM. This is a DEPLOYMENT setting, not a business setting: it has
// to be a domain verified with Resend, so it cannot be typed into the app by a proprietor.
//
// The fallback is the first deployment's verified domain. It is kept because removing it would
// stop OTP login dead on any installation that has not set RESEND_FROM — but it is the wrong
// sender for anyone else, so an installation that falls back is told so at boot.
const FALLBACK_FROM = 'otp@guruindustries.co.in';
const MAIL_FROM = process.env.RESEND_FROM || FALLBACK_FROM;
if (resend && !process.env.RESEND_FROM) {
  console.warn(`[mail] RESEND_FROM is not set — OTP mail will be sent from ${FALLBACK_FROM}. `
    + 'Set RESEND_FROM to this installation\'s own verified sending address.');
}

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
      from: MAIL_FROM,
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
