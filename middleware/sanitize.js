// NoSQL-injection sanitizer (Express 5 safe).
//
// express-mongo-sanitize can't be used on Express 5 because it reassigns
// req.query, which is a read-only getter in Express 5 (throws at runtime).
// This middleware instead deep-cleans keys in-place: any object key that
// starts with '$' or contains '.' is removed (those are the Mongo operator /
// dotted-path vectors). req.body and req.params are mutated in place; req.query
// is sanitized by cleaning the values it already holds without reassigning it.
function scrub(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) { obj.forEach(scrub); return obj; }
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else {
      scrub(obj[key]);
    }
  }
  return obj;
}

module.exports = (req, res, next) => {
  if (req.body) scrub(req.body);
  if (req.params) scrub(req.params);
  // Don't reassign req.query (read-only in Express 5) — scrub its contents in place.
  if (req.query) scrub(req.query);
  next();
};
