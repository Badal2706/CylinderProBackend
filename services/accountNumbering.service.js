const User = require('../models/User');
const BusinessProfile = require('../models/BusinessProfile');
const N = require('./numbering.service');

// ─── Phase GEN-C: the database-aware half of numbering ───
// numbering.service.js is deliberately pure. This is the thin layer that reads the two stored
// facts a number needs: which account it belongs to, and whether that account restarts its
// series each financial year.

// account_code is IMMUTABLE by schema declaration — set once at signup, never changed. That is
// what makes an unbounded process-lifetime cache safe here: the value cannot go stale. Without
// it, every bill save would cost an extra User lookup.
const codeCache = new Map();

async function accountCodeFor(userId) {
  const key = String(userId);
  if (codeCache.has(key)) return codeCache.get(key);
  const user = await User.findById(userId).select('account_code').lean();
  const code = (user && user.account_code) || '';
  // Only cache a real answer. Caching '' would permanently poison an account whose code is
  // being backfilled by the migration while the server is running.
  if (code) codeCache.set(key, code);
  return code;
}

// Test suites create and drop accounts constantly; without this they would see another test's code.
function _clearCache() { codeCache.clear(); }

// Everything a number needs to know about its account and its moment in time.
//
//   financialYear — the FY the DOCUMENT belongs to. Always set. This is what the unique index
//                   is scoped by, so it applies whether or not the account resets its series.
//   counterFy     — which counter row to draw the next number from. '' means one continuous
//                   series for the life of the account (reset OFF, the default and the
//                   pre-GEN-C behaviour); otherwise it is the financial year, so the series
//                   starts again at 1A001 / RCP-0001 every 1 April.
async function getContext(userId, date = new Date()) {
  const [accountCode, profile] = await Promise.all([
    accountCodeFor(userId),
    BusinessProfile.findOne({ user_id: userId }).select('fy_reset_numbering').lean()
  ]);
  const resets = !!(profile && profile.fy_reset_numbering);
  const financialYear = N.financialYear(date);
  return { accountCode, financialYear, counterFy: resets ? financialYear : '', resets };
}

module.exports = { accountCodeFor, getContext, _clearCache };
