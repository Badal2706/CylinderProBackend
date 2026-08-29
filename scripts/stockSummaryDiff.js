// Diffs two stockSummaryProbe dumps field by field and separates the two kinds of column:
//   * MOVEMENT columns (add/issue/receive) come from the day's BILLS
//   * OPENING/CLOSING come from the ANCHOR — today's live cylinder state, wound backwards
// If movements match but opening/closing do not, the difference is not about the day at all.
const fs = require('fs');

const A = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const B = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const MOVEMENT = [['filled', 'add'], ['filled', 'issue'], ['empty', 'receive'], ['empty', 'issue']];
const DERIVED = [['filled', 'opening'], ['filled', 'closing'], ['empty', 'opening'], ['empty', 'closing']];

const key = (r) => `${r.gas_type} / ${r.capacity}`;
let movementDiffs = 0, derivedDiffs = 0;
const lines = [];

for (const loc of Object.keys(A.locations)) {
  const a = new Map((A.locations[loc] || []).map(r => [key(r), r]));
  const b = new Map((B.locations[loc] || []).map(r => [key(r), r]));
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const ra = a.get(k), rb = b.get(k);
    if (!ra || !rb) { lines.push(`${loc}  ${k}  present only in ${ra ? A.tag : B.tag}`); derivedDiffs++; continue; }
    const parts = [];
    for (const [grp, fld] of MOVEMENT) {
      if (ra[grp][fld] !== rb[grp][fld]) { movementDiffs++; parts.push(`MOVEMENT ${grp}.${fld}: ${A.tag}=${ra[grp][fld]} ${B.tag}=${rb[grp][fld]}`); }
    }
    for (const [grp, fld] of DERIVED) {
      if (ra[grp][fld] !== rb[grp][fld]) { derivedDiffs++; parts.push(`${grp}.${fld}: ${A.tag}=${ra[grp][fld]} ${B.tag}=${rb[grp][fld]} (Δ${rb[grp][fld] - ra[grp][fld]})`); }
    }
    if (parts.length) lines.push(`${loc}  ${k}\n      ` + parts.join('\n      '));
  }
}

console.log(`comparing ${A.tag} vs ${B.tag} for ${A.date}\n`);
console.log(lines.join('\n') || '(identical)');
console.log(`\nMOVEMENT column differences (from the day's bills) : ${movementDiffs}`);
console.log(`OPENING/CLOSING differences (from today's anchor)  : ${derivedDiffs}`);
console.log(movementDiffs === 0 && derivedDiffs > 0
  ? '\n=> The day\'s recorded transactions are IDENTICAL in both databases.\n' +
    '   Every difference is in the wound-back opening/closing, i.e. it comes from what has\n' +
    '   happened to the cylinders SINCE the 26th — not from anything about the 26th itself.'
  : '');
