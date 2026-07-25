// Batched, fault-tolerant insertMany for bulk onboarding imports.
//
// `items` is an array of { __row, doc } where __row is the source spreadsheet row number
// (for error reporting) and doc is the Mongoose document body to insert.
//
// Uses { ordered: false } so a single bad row never aborts the rest of the batch, and inserts
// in chunks so very large files (5,000+) don't build one giant operation. Per-row failures are
// mapped back to their spreadsheet row number. Duplicate-key violations (E11000) are reported
// separately as `skipped` (the unique key already exists — expected during onboarding), every
// other failure as `failed`.
async function insertInBatches(Model, items, batchSize = 1000) {
  let created = 0;
  const skipped = [];
  const failed = [];

  const dupReason = (we) => {
    const keyPattern = we.keyPattern || (we.err && we.err.keyPattern) || {};
    const field = Object.keys(keyPattern).find(k => k !== 'user_id');
    const msg = we.errmsg || (we.err && we.err.errmsg) || '';
    if (field === 'physical_number' || /physical_number/.test(msg)) return 'physical_number already exists';
    if (field === 'rotational_number' || /rotational_number/.test(msg)) return 'rotational_number already exists';
    return 'duplicate key — a record with this unique value already exists';
  };

  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const docs = batch.map(b => b.doc);
    try {
      const inserted = await Model.insertMany(docs, { ordered: false });
      created += inserted.length;
    } catch (err) {
      const writeErrors = err.writeErrors || (err.result && err.result.getWriteErrors && err.result.getWriteErrors()) || [];
      const failedIdx = new Set();
      for (const we of writeErrors) {
        const idx = we.index !== undefined ? we.index : (we.err && we.err.index);
        const code = we.code || (we.err && we.err.code);
        const item = (idx !== undefined && batch[idx]) ? batch[idx] : null;
        const row = item ? item.__row : '?';
        if (idx !== undefined) failedIdx.add(idx);
        if (code === 11000) skipped.push({ row, reason: dupReason(we) });
        else failed.push({ row, reason: we.errmsg || (we.err && we.err.errmsg) || 'Insert error' });
      }
      // With ordered:false, everything that didn't error was still inserted.
      const insertedThisBatch = Array.isArray(err.insertedDocs)
        ? err.insertedDocs.length
        : (batch.length - failedIdx.size);
      created += insertedThisBatch;
    }
  }

  return { created, skipped, failed };
}

module.exports = { insertInBatches };
