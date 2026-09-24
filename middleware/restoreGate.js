// ─── R162: no business writes while an account is being emptied-and-restored ───
//
// Between Empty This Account and the end of the restore that follows it, the account is in a
// state that ordinary work must not disturb:
//
//  · empty_pending_restore — emptied, waiting for a backup. A new customer, bill or cylinder here
//    would make the account "not empty" again, and the restore would then refuse it (R161). So
//    CREATING business records is refused. Settings may still be edited: the restore replaces
//    them wholesale anyway.
//  · restore_in_progress — a restore is writing (or died while writing). ANY change is refused:
//    an edit, a delete, a catalog or location change, even an audit row, would either collide
//    with what the restore inserts (unique names, location codes) or break the count check it
//    finishes with — and a restore that fails that check rolls the whole account back.
//
// The state is read by middleware/auth.js on the request's existing user lookup, so this adds no
// database read. Both refusals point at Settings → Data & Privacy, where the restore is finished,
// cancelled or cleared.
//
// Mount `blockChangesWhileRestoring` on a router (after auth) and `blockCreateWhileRestoring` on
// the individual routes that create business records.

const MESSAGES = {
  empty_pending_restore:
    'This account was emptied so a backup can be restored into it. New records cannot be added ' +
    'until that restore is finished or cancelled — Settings → Data & Privacy.',
  restore_in_progress:
    'A backup is being restored into this account, or a restore did not finish. Nothing can be ' +
    'changed until it finishes or is cleared — Settings → Data & Privacy.'
};

const refuse = (res, state) =>
  // 409, not 423/403: the client already shows a 409's message as-is, and it must never be read as
  // an authentication failure (which would log the user out).
  res.status(409).json({ error: MESSAGES[state], code: 'RESTORE_STATE', restore_state: state });

// Business-record creation: refused in BOTH non-normal states.
function blockCreateWhileRestoring(req, res, next) {
  const s = req.restoreState;
  if (s && s !== 'none') return refuse(res, s);
  next();
}

// Every write (and the reads listed in `alsoBlock`) while a restore is writing. `allow` lists the
// method+path pairs that must stay reachable — the recovery actions themselves.
function blockChangesWhileRestoring({ allow = [], alsoBlock = [] } = {}) {
  const key = (req) => `${req.method} ${req.path}`;
  return (req, res, next) => {
    if (req.restoreState !== 'restore_in_progress') return next();
    const k = key(req);
    if (allow.includes(k)) return next();
    if (req.method === 'GET' && !alsoBlock.includes(k)) return next();
    return refuse(res, 'restore_in_progress');
  };
}

module.exports = { blockCreateWhileRestoring, blockChangesWhileRestoring, MESSAGES };
