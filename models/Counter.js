const mongoose = require('mongoose');

// Persistent monotonic sequence counters (Phase 31). Drives the auto-generated default Bill
// Number series (1A001 → 1A999 → 1B001 … 1Z999 → 2A001 …). `seq` holds the highest sequence
// index issued so far; the next default is seq + 1.
//
// GEN-C made this per-account AND per-financial-year. It was global until then, which was
// already wrong for a second client — they would have been handed a series starting wherever
// the first client's counter happened to sit — and an account that opts into financial-year
// reset needs to start again at 1A001 every 1 April.
//
// financial_year is '' for accounts that have NOT opted into the reset — one continuous series
// for the life of the account, which is the pre-GEN-C behaviour and stays the default.
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  financial_year: { type: String, default: '' },
  seq: { type: Number, default: 0 }
}, { timestamps: true });

counterSchema.index({ user_id: 1, key: 1, financial_year: 1 }, { unique: true });

module.exports = mongoose.model('Counter', counterSchema);
