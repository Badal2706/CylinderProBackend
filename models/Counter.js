const mongoose = require('mongoose');

// Persistent monotonic sequence counters (Phase 31). Currently drives the auto-generated
// default Bill Number series (1A001 → 1A999 → 1B001 … 1Z999 → 2A001 …). `seq` holds the
// highest sequence index issued so far; the next default is seq + 1. Bill numbers stay
// globally unique (Bill.bill_number is unique), so the counter is global (not per-user),
// matching how the old BILL-#### sequence was derived across all bills.
const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Counter', counterSchema);
