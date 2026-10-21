// SOURCE_DATE_EPOCH is optional for ordinary builds; selected recipes require it.
export function buildTimestamp(raw) {
  if (raw === undefined) return new Date().toISOString();
  if (!/^\d+$/.test(raw)) throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds');
  const milliseconds = Number(raw) * 1000;
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported Date range');
  }
  return new Date(milliseconds).toISOString();
}
