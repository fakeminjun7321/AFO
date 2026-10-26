export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError('ms must be a non-negative integer');
  }
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h ${p(m)}m ${p(s)}s`;
  if (h > 0) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m > 0) return `${m}m ${p(s)}s`;
  return `${s}s`;
}
