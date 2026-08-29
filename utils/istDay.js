// Every date this software reports on is a CALENDAR DAY IN INDIA — never a UTC day, and never a
// day in whatever timezone the server happens to be running in.
//
// WHY THIS EXISTS. Each caller used to build its own day window like this:
//
//     const start = new Date('2026-08-30');          // -> 2026-08-30T00:00:00Z  (UTC midnight!)
//     const end   = new Date('2026-08-30');
//     end.setHours(23, 59, 59, 999);                 // -> local-midnight-relative end
//
// Two different bugs come out of that:
//
//   1. MISMATCHED WINDOW. `new Date('YYYY-MM-DD')` parses as UTC midnight, but `setHours` works in
//      the SERVER'S timezone. On an IST machine the window became
//      [30 Aug 00:00 UTC → 30 Aug 23:59 IST] — a window that starts at 05:30 IST. Every bill
//      written between midnight and 5:30 am IST fell outside its own day and vanished from the
//      Transaction History. That is the bug that was reported.
//
//   2. SILENT TIMEZONE DEPENDENCE. Where start and end were built consistently with `setHours`,
//      the result was right on a machine set to IST and wrong on one set to UTC — the same code
//      quietly reporting a different day depending on where it runs. A dev machine in IST cannot
//      reveal that; a UTC server shifts every daily figure by 5.5 hours.
//
// Both disappear if the day window is computed from the IST offset arithmetically and never from
// the host clock. Nothing here reads the server timezone, so these functions give the same answer
// on any machine.
const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30, no DST — India has never observed it

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

// A Date (or anything Date-able) -> the 'YYYY-MM-DD' IST calendar day it falls on.
function istDayString(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// 'YYYY-MM-DD' (or a Date, or undefined for today) -> { start, end } as real UTC instants
// covering that whole IST calendar day. `end` is inclusive (…T18:29:59.999Z), matching the
// $lte the callers use.
function istDayRange(value) {
  let dayStr;
  if (value == null || value === '') {
    dayStr = istDayString(new Date());
  } else if (typeof value === 'string' && DAY_RE.test(value)) {
    dayStr = value.slice(0, 10);            // already a calendar day — use it verbatim
  } else {
    dayStr = istDayString(value);           // a Date/instant — find which IST day it lands on
  }
  if (!dayStr) return { start: null, end: null, dayStr: null };

  const m = DAY_RE.exec(dayStr);
  const startMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
  return {
    start: new Date(startMs),
    end: new Date(startMs + 86400000 - 1),
    dayStr
  };
}

// Inclusive multi-day window: from the START of `fromValue`'s IST day to the END of `toValue`'s.
function istRange(fromValue, toValue) {
  return { start: istDayRange(fromValue).start, end: istDayRange(toValue).end };
}

module.exports = { istDayRange, istDayString, istRange, IST_OFFSET_MS };
