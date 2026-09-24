const mongoose = require('mongoose');

// ─── Phase GEN-C: a restore, tracked as a document rather than an in-memory object ───
//
// Three things fall out of storing it in the database, which is why it lives here and not in a Map:
//
//  1. PROGRESS without holding the request open. The confirm call returns a job id immediately;
//     the browser polls. A restore of several hundred thousand documents must not depend on one
//     HTTP connection staying alive.
//  2. THE LOCK. `lock_key` carries a unique partial index, so only one restore can be active at a
//     time — enforced by the database, not by a process-local flag. That still holds if the server
//     is ever moved to PM2 cluster mode, which the rate limiters already warn about in server.js.
//  3. CRASH RECOVERY. A job left RUNNING with a stale heartbeat is visible after a restart, so a
//     half-finished restore can be identified and rolled back instead of silently stranding the
//     account in a state that fails its own "must be empty" precondition forever.

const restoreJobSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  status: {
    type: String,
    enum: [
      'STAGED',       // uploaded and validated; nothing written, waiting for confirmation
      'RUNNING',      // writing
      'DONE',
      'FAILED',       // stopped part-way; whatever it wrote has been rolled back
      'ROLLBACK_FAILED', // could not undo its own partial write — needs a human
      'INTERRUPTED',  // the server died while it was writing (R162); cleared from Settings
      'CANCELLED',
      'EXPIRED'       // staged, never confirmed, temp file cleaned up
    ],
    default: 'STAGED',
    index: true
  },

  // Set to the literal 'RESTORE' only while a job is actively writing; unset the moment it stops.
  // The partial unique index below turns that into a real mutual exclusion.
  lock_key: { type: String, default: undefined },

  zip_path: { type: String, default: '' },        // temp file on disk; removed when the job ends
  manifest: { type: mongoose.Schema.Types.Mixed, default: null },

  // What the preview decided before anything was written.
  validation: { type: mongoose.Schema.Types.Mixed, default: null },

  progress: {
    collection: { type: String, default: '' },
    written: { type: Number, default: 0 },        // documents written so far, this collection
    total: { type: Number, default: 0 },          // documents expected, all collections
    done: { type: Number, default: 0 }            // documents written so far, all collections
  },

  counts_written: { type: mongoose.Schema.Types.Mixed, default: {} },
  mismatches: { type: [String], default: [] },
  error: { type: String, default: '' },

  started_at: { type: Date, default: null },
  finished_at: { type: Date, default: null },
  // Bumped as the job writes. A RUNNING job whose heartbeat has gone quiet has died.
  heartbeat_at: { type: Date, default: null },
  // R162: the account's restore_state when this job began writing, so a failure that rolled back
  // cleanly can put the account back exactly where it was.
  prior_state: { type: String, default: '' }
}, { timestamps: true });

// One active restore at a time, enforced by the database.
restoreJobSchema.index(
  { lock_key: 1 },
  { unique: true, partialFilterExpression: { lock_key: { $type: 'string' } } }
);

// Staged jobs that were never confirmed are swept up by age.
restoreJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('RestoreJob', restoreJobSchema);
