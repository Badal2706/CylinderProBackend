// ─── Phase 30: validation gate ───
// Runs a zod schema against req.body and rejects malformed input with a clear 400. It is a GATE
// ONLY — on success it does NOT overwrite req.body, so downstream services receive exactly the
// payload they always did (no coercion, no stripped fields). This adds rejection of wrong-typed,
// oversized, or badly-formatted input without changing any behavior for valid requests.
module.exports = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body || {});
  if (result.success) return next();
  const issue = result.error.issues[0];
  const path = issue.path.join('.') || 'input';
  return res.status(400).json({ error: `Invalid ${path}: ${issue.message}` });
};
