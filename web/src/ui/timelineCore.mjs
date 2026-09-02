// Ordering for the merged text + file/voice timeline.
//
// Two date-string formats meet here, and they are NOT the same:
//   • message dates: a MUFL transaction-time, e.g.
//       "2026-07-11 21:13:34.892903874 (UTC)"
//     — space separator, nanosecond fraction, "(UTC)" suffix. This is NOT
//       ISO 8601.
//   • file/voice dates: JS `new Date().toISOString()` — strict ISO 8601.
//
// The trap: `new Date(messageDate)` is ENGINE-DEPENDENT for non-ISO strings.
// V8 parses the MUFL form leniently, while stricter engines can return
// `Invalid Date`. A plain `new Date().getTime()` then yields NaN; an epoch
// fallback would pin messages above the ISO-dated files and leave attachments
// grouped at the bottom.
//
// Fix: normalize BOTH forms to a strict ISO-8601 UTC string OURSELVES and parse
// that — strict ISO parses identically across supported engines.

// Returns a strict "YYYY-MM-DDTHH:MM:SS.mmmZ", or null if the string isn't a
// date we recognise. MUFL transaction times and legacy zone-less values are
// UTC. ISO inputs with an explicit numeric offset describe an instant already,
// so preserve that instant instead of relabelling its wall time as UTC.
export function toIsoUtc(dateStr) {
  if (typeof dateStr !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:(Z)|([+-]\d{2}:\d{2})|\s*\(UTC\))?$/i.exec(dateStr.trim());
  if (!m) return null;
  const ms = m[7] ? m[7].slice(0, 3).padEnd(3, '0') : '000';
  const base = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}`;
  const wallTime = new Date(`${base}Z`);
  if (Number.isNaN(wallTime.getTime())
      || wallTime.getUTCFullYear() !== Number(m[1])
      || wallTime.getUTCMonth() + 1 !== Number(m[2])
      || wallTime.getUTCDate() !== Number(m[3])
      || wallTime.getUTCHours() !== Number(m[4])
      || wallTime.getUTCMinutes() !== Number(m[5])
      || wallTime.getUTCSeconds() !== Number(m[6])) return null;
  if (m[9]) {
    const instant = new Date(`${base}${m[9]}`);
    return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
  }
  return wallTime.toISOString();
}

export function timeMs(dateStr) {
  const iso = toIsoUtc(dateStr);
  if (iso) {
    const t = Date.parse(iso); // strict ISO parses consistently across engines
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
