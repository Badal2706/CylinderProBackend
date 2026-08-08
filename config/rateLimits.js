// ─── Phase 30: rate limiting (env-configurable) ───
// CylinderPro uses a SHARED-LOGIN model: several staff at three locations sign in with the same
// credentials. So the auth limits are built to slow brute-force WITHOUT locking out legitimate
// concurrent use:
//   * keyed per (IP + account email), so one location's activity never eats another's budget;
//   * `skipSuccessfulRequests` — only FAILED attempts count, so real logins are never throttled;
//   * a progressive (exponential) backoff via express-slow-down instead of a hard lockout, so a
//     busy location that fat-fingers a password gets small delays, not a wall.
// Runs on a SINGLE PM2 process (no cluster mode, no Redis) → the default in-memory store is
// correct. If PM2 is ever switched to cluster/multiple instances, these in-memory counters would
// be per-process and must move to a shared store (Redis) — see PHASE-30 note in server.js.
//
// Every threshold is env-overridable; the defaults below are the documented production values.
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const slowDown = require('express-slow-down');

const envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
};

// Auth (login / OTP / 2FA / reset / email-verify): strict, failure-only, per IP+account.
const AUTH_WINDOW_MS   = envInt('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000); // 15 min
const AUTH_MAX_FAILS   = envInt('RATE_LIMIT_AUTH_MAX', 20);                   // failed tries / window / (IP+account)
const AUTH_SLOW_AFTER  = envInt('RATE_LIMIT_AUTH_SLOWDOWN_AFTER', 5);        // start backing off after N fails
const AUTH_SLOW_BASE   = envInt('RATE_LIMIT_AUTH_SLOWDOWN_MS', 500);         // base backoff step (ms)
const AUTH_SLOW_MAX    = envInt('RATE_LIMIT_AUTH_SLOWDOWN_MAX_MS', 10000);   // backoff ceiling (ms)

// General authenticated API: loose, generously sized for real usage + list "View All" bursts.
const API_WINDOW_MS = envInt('RATE_LIMIT_API_WINDOW_MS', 60 * 1000);         // 1 min
const API_MAX       = envInt('RATE_LIMIT_API_MAX', 300);                     // requests / window / IP

// Combined per-IP + per-account key. ipKeyGenerator normalises IPv6 into a /56 subnet (required by
// express-rate-limit v8 when a custom key includes the IP). Email keys the account being targeted.
const authKey = (req) => {
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  return `${ipKeyGenerator(req.ip)}|${email}`;
};

// Hard cap on failed auth attempts (safety net above the backoff). Successful logins are skipped so
// shared-login staff are never counted; only failures accrue toward the cap.
const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX_FAILS,
  skipSuccessfulRequests: true,
  keyGenerator: authKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed attempts. Please wait a few minutes and try again.' }
});

// Progressive/exponential backoff on repeated FAILED auth attempts — delays, never blocks. First
// `AUTH_SLOW_AFTER` failures are instant; each failure past that doubles the delay up to the cap.
const authSlowDown = slowDown({
  windowMs: AUTH_WINDOW_MS,
  delayAfter: AUTH_SLOW_AFTER,
  delayMs: (used) => Math.min(AUTH_SLOW_MAX, AUTH_SLOW_BASE * Math.pow(2, Math.max(0, used - AUTH_SLOW_AFTER - 1))),
  maxDelayMs: AUTH_SLOW_MAX,
  skipSuccessfulRequests: true,
  keyGenerator: authKey
});

// General API limiter (per IP). Applied to all authenticated action routes.
const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
});

module.exports = {
  authLimiter, authSlowDown, apiLimiter,
  // exported for logging/tests
  _config: { AUTH_WINDOW_MS, AUTH_MAX_FAILS, AUTH_SLOW_AFTER, AUTH_SLOW_BASE, AUTH_SLOW_MAX, API_WINDOW_MS, API_MAX }
};
