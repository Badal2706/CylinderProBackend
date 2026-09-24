const mongoose = require('mongoose');

// ─── Several writes as ONE unit, where the deployment allows it ───
//
// Production runs a replica set (the droplet's single-node rs0), which supports multi-document
// transactions. A standalone mongod — the local Docker image, and the test databases — does not,
// and reports it on the FIRST operation of the transaction, before anything is written. There the
// work runs without a session and `undo` cleans up after a failure instead: all-or-nothing on
// production, best-effort compensation elsewhere.
//
// `fn` may run more than once: withTransaction retries it on a transient error. It must therefore
// create what it needs on every call rather than reuse objects from a previous attempt.

// How "no transactions here" is reported varies by server version — IllegalOperation (code 20), or,
// on the local Docker image, "does not support retryable writes". Same list services/customer.service
// and services/profile.service already recognise.
function transactionsUnsupported(err) {
  if (!err) return false;
  if (err.code === 20 || err.codeName === 'IllegalOperation') return true;
  return /Transaction numbers are only allowed|Transactions are not supported|replica set member or mongos|does not support retryable writes|does not support transactions/i
    .test(err.message || '');
}

async function runAsOneUnit(fn, undo) {
  let session = null;
  let unsupported = false;
  try {
    session = await mongoose.startSession();
    await session.withTransaction(() => fn(session));
    return;
  } catch (err) {
    if (!transactionsUnsupported(err)) throw err;
    unsupported = true;
  } finally {
    if (session) await session.endSession().catch(() => {});
  }

  if (unsupported) {
    try {
      await fn(null);
    } catch (err) {
      if (undo) await undo().catch((e) => console.error('Clean-up after a failed write failed:', e.message));
      throw err;
    }
  }
}

module.exports = { runAsOneUnit, transactionsUnsupported };
