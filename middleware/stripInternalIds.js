// Removes the account's internal identity fields from every JSON response on the router it is
// mounted on (24 Sep 2026).
//
// account_code is a backend identity: it scopes bill, receipt and certificate numbers to one
// account and is never shown in the UI or on a printed document. It still reached the browser on
// every bill, payment and certificate response — both directly and as the prefix of the *_uid
// fields ("JRT2YGX5-2627-1A001"), so all four go. Nothing in the frontend reads any of them.
//
// Deliberately NOT mounted on /api/profile: the restore preview shows the archive's code to the
// operator on purpose, and the business-profile response already blanks it (profile.service).
//
// Implemented as a JSON replacer rather than per-service deletes, so an endpoint added later — or
// a field nested inside a statement or a report — cannot quietly leak it again. Everything else
// about res.json is reproduced exactly: same serialisation, same Content-Type, same send path.
const INTERNAL = new Set(['account_code', 'bill_uid', 'receipt_uid', 'certificate_uid']);
const replacer = (key, value) => (INTERNAL.has(key) ? undefined : value);

module.exports = function stripInternalIds(req, res, next) {
  res.json = function (body) {
    const text = JSON.stringify(body, replacer);
    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json');
    return this.send(text);
  };
  next();
};
