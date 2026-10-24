// Office timezone ke hisaab se date/time (server UTC par ho tab bhi sahi chalta hai)
export function partsInTz(date, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, secs: +p.hour * 3600 + +p.minute * 60 + +p.second, y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const tzOffsetMs = (ms, tz) => {
  const t = Math.floor(ms / 1000) * 1000; const p = partsInTz(new Date(t), tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
};
// "2026-10-24" + "09:30" (office time) -> UTC Date
export function zonedToUtc(dateStr, hhmm, tz) {
  const [y, mo, d] = dateStr.split('-').map(Number); const [H, M] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, H, M);
  const off = tzOffsetMs(guess, tz); let t = guess - off;
  const off2 = tzOffsetMs(t, tz); if (off2 !== off) t = guess - off2;
  return new Date(t);
}
export const todayIn = (tz) => partsInTz(new Date(), tz).date;
export const weekdayOf = (dateStr) => new Date(dateStr + 'T00:00:00Z').getUTCDay();
export function monthDays(month) { // "2026-10" -> ["2026-10-01", ...]
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export function datesBetween(start, end) { // inclusive, ISO strings
  const out = []; let t = Date.parse(start + 'T00:00:00Z'); const e = Date.parse(end + 'T00:00:00Z');
  for (; t <= e; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
