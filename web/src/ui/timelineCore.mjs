// Ordering for the merged text + file/voice timeline.
//
// Two date-string formats meet here, and they are NOT the same:
//   • message dates: a MUFL transaction-time, e.g.
//       "2026-07-11 21:13:34.892903874 (UTC)"
//     — space separator, nanosecond fraction, "(UTC)" suffix. This is NOT
//       ISO 8601.
//   • file/voice dates: JS `new Date().toISOString()` — strict ISO 8601.
//
// The trap (owner's device bug): `new Date(messageDate)` is ENGINE-DEPENDENT for
// non-ISO strings. Node/V8 parses the MUFL form leniently (so headless tests
// passed), but iOS Safari's JavaScriptCore is strict and returns `Invalid Date`.
// A plain `new Date().getTime()` therefore NaN'd every message on device; the
// NaN guard pinned them all to epoch 0 (top), leaving the ISO-dated files below —
// reproducing the exact "attachments stuck at the bottom" bug the fix meant to
// remove. (The earlier localeCompare bug and this one look identical on screen.)
//
// Fix: normalize BOTH forms to a strict ISO-8601 UTC string OURSELVES and parse
// that — strict ISO parses identically on every engine, iOS included.

// Returns a strict "YYYY-MM-DDTHH:MM:SS.mmmZ" (always UTC — both our sources are
// UTC), or null if the string isn't a date we recognise.
export function toIsoUtc(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(dateStr.trim());
  if (!m) return null;
  const ms = m[7] ? m[7].slice(0, 3).padEnd(3, '0') : '000';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}

export function timeMs(dateStr) {
  const iso = toIsoUtc(dateStr);
  if (iso) {
    const t = Date.parse(iso); // strict ISO — parses on every engine incl. iOS JSC
    if (!Number.isNaN(t)) return t;
  }
  // Last-resort fallback (unreachable for our two formats); never NaN the sort.
  const t2 = new Date(dateStr).getTime();
  return Number.isNaN(t2) ? 0 : t2;
}

// Comparator for entries carrying an `at` date string (messages or file records).
export function compareByTime(a, b) {
  return timeMs(a.at) - timeMs(b.at);
}

// A Date for display formatters (viewmodel.fmtTime/fmtWhen/fmtFull), or null.
// Same root cause as the sort: `new Date(muflDate)` is Invalid on iOS, so
// message timestamps rendered blank on-device. Route display through the same
// engine-independent normalization.
export function toDate(dateStr) {
  const iso = toIsoUtc(dateStr);
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const d2 = new Date(dateStr);
  return Number.isNaN(d2.getTime()) ? null : d2;
}
