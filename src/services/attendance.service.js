import Attendance from '../models/Attendance.js';
import AttendanceCorrection from '../models/AttendanceCorrection.js';
import Employee from '../models/Employee.js';
import Settings from '../models/Settings.js';
import Holiday from '../models/Holiday.js';
import { partsInTz, zonedToUtc, todayIn, weekdayOf, monthDays } from '../utils/time.js';
import { approvedLeaveSet } from './leaveLookup.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';
import { notifyRole, notifyEmployee } from './notification.service.js';

export async function getContext() {
  const settings = await Settings.findOne();
  const holidays = await Holiday.find();
  return { settings, tz: settings.timezone || 'Asia/Karachi', holidayMap: new Map(holidays.map(h => [h.date, h.name])) };
}
const hoursBetween = (a, b) => Math.round(((b - a) / 36e5) * 100) / 100;

// Business rules: late after officeStart+grace; half_day under N hours; missing_checkout for past days without checkout
export function computeStatus({ checkIn, checkOut, date, settings, tz, today }) {
  const [h, m] = settings.officeStart.split(':').map(Number);
  const limitSecs = (h * 60 + m + settings.graceMinutes) * 60;
  const isLate = partsInTz(checkIn, tz).secs > limitSecs;
  const workedHours = checkOut ? hoursBetween(checkIn, checkOut) : 0;
  let status;
  if (checkOut) status = workedHours < settings.halfDayHours ? 'half_day' : (isLate ? 'late' : 'present');
  else if (date < today) status = 'missing_checkout';
  else status = isLate ? 'late' : 'present';
  return { status, isLate, workedHours };
}

// Din guzarne ke baad bina checkout wale records ko missing_checkout karo
export async function sweepMissingCheckout() {
  const { tz } = await getContext();
  await Attendance.updateMany(
    { checkOut: null, status: { $in: ['present', 'late'] }, date: { $lt: todayIn(tz) } },
    { $set: { status: 'missing_checkout' } });
}

export async function requireEmployee(user) {
  if (!user.employeeId) throw new HttpError(403, 'No employee profile linked to this login');
  const emp = await Employee.findById(user.employeeId);
  if (!emp || emp.status === 'exited') throw new HttpError(403, 'Employee is not active');
  return emp;
}
const view = (r) => r && ({ date: r.date, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, isLate: r.isLate, workedHours: r.workedHours, source: r.source });

export async function getToday(user) {
  const emp = await requireEmployee(user);
  const ctx = await getContext(); const date = todayIn(ctx.tz);
  const rec = await Attendance.findOne({ employee: emp._id, date });
  return { date, timezone: ctx.tz, record: view(rec) };
}

export async function checkIn(user) {
  const emp = await requireEmployee(user);
  const ctx = await getContext(); const now = new Date(); const date = todayIn(ctx.tz);
  if (date < emp.joinDate) throw new HttpError(403, 'Your joining date is in the future');
  if (await Attendance.exists({ employee: emp._id, date })) throw new HttpError(409, 'Already checked in today');
  const c = computeStatus({ checkIn: now, checkOut: null, date, today: date, ...ctx });
  try {
    const rec = await Attendance.create({ employee: emp._id, date, checkIn: now, status: c.status, isLate: c.isLate, source: 'web' }); // server time
    return view(rec);
  } catch (e) { if (e.code === 11000) throw new HttpError(409, 'Already checked in today'); throw e; }
}

export async function checkOut(user) {
  const emp = await requireEmployee(user);
  const ctx = await getContext(); const now = new Date(); const date = todayIn(ctx.tz);
  const rec = await Attendance.findOne({ employee: emp._id, date });
  if (!rec) throw new HttpError(409, 'No check-in found for today');
  if (rec.checkOut) throw new HttpError(409, 'Already checked out today');
  rec.checkOut = now;
  Object.assign(rec, computeStatus({ checkIn: rec.checkIn, checkOut: now, date, today: date, ...ctx }));
  await rec.save();
  return view(rec);
}

const COUNTED = ['present', 'late', 'half_day', 'missing_checkout', 'absent', 'on_leave'];

// Ek employee ka mahine ka calendar (absent/holiday/weekend computed)
export async function monthView(emp, month) {
  const ctx = await getContext(); const today = todayIn(ctx.tz);
  const days = monthDays(month);
  const [recs, leave] = await Promise.all([
    Attendance.find({ employee: emp._id, date: { $gte: days[0], $lte: days.at(-1) } }),
    approvedLeaveSet([emp._id], days[0], days.at(-1)),
  ]);
  const map = new Map(recs.map(r => [r.date, r]));
  const out = days.map(date => {
    const rec = map.get(date); const wd = weekdayOf(date);
    let status;
    if (rec) status = rec.status;
    else if (date < emp.joinDate) status = 'before_joining';
    else if (emp.exitDate && date > emp.exitDate) status = 'exited';
    else if (ctx.holidayMap.has(date)) status = 'holiday';
    else if (ctx.settings.weekend.includes(wd)) status = 'weekend';
    else if (leave.has(`${emp._id}|${date}`)) status = 'on_leave';
    else if (date > today) status = 'upcoming';
    else if (date === today) status = 'not_checked_in';
    else status = 'absent';
    return { date, weekday: wd, status, checkIn: rec?.checkIn || null, checkOut: rec?.checkOut || null, workedHours: rec?.workedHours || 0, holiday: ctx.holidayMap.get(date) || null };
  });
  const summary = Object.fromEntries(COUNTED.map(s => [s, out.filter(d => d.status === s).length]));
  return { month, timezone: ctx.tz, days: out, summary };
}

// HR daily board: sab employees ek din ke liye
export async function dailyBoard(date, department) {
  const ctx = await getContext(); const today = todayIn(ctx.tz);
  const filter = { joinDate: { $lte: date }, $or: [{ status: { $ne: 'exited' } }, { exitDate: { $gte: date } }] };
  if (department) filter.department = department;
  const emps = await Employee.find(filter).sort('code').populate('department', 'name').populate('designation', 'name');
  const ids = emps.map(e => e._id);
  const [recs, leave] = await Promise.all([Attendance.find({ date, employee: { $in: ids } }), approvedLeaveSet(ids, date, date)]);
  const map = new Map(recs.map(r => [String(r.employee), r]));
  const offDay = ctx.holidayMap.has(date) || ctx.settings.weekend.includes(weekdayOf(date));
  const rows = emps.map(e => {
    const rec = map.get(String(e._id));
    let status;
    if (rec) status = rec.status;
    else if (offDay) status = 'off';
    else if (leave.has(`${e._id}|${date}`)) status = 'on_leave';
    else if (date > today) status = 'upcoming';
    else if (date === today) status = 'not_checked_in';
    else status = 'absent';
    return { employeeId: e._id, code: e.code, name: e.name, department: e.department?.name, designation: e.designation?.name,
      status, checkIn: rec?.checkIn || null, checkOut: rec?.checkOut || null, workedHours: rec?.workedHours || 0, source: rec?.source || null };
  });
  const summary = Object.fromEntries([...COUNTED, 'not_checked_in', 'off'].map(s => [s, rows.filter(r => r.status === s).length]));
  return { date, timezone: ctx.tz, offDay, holiday: ctx.holidayMap.get(date) || null, summary, rows };
}

/* ---------------- Corrections ---------------- */
export async function requestCorrection(user, { date, checkIn, checkOut, reason }) {
  const emp = await requireEmployee(user);
  const ctx = await getContext(); const today = todayIn(ctx.tz);
  if (date > today) throw new HttpError(422, 'Cannot correct a future date');
  if (date < emp.joinDate) throw new HttpError(422, 'Date is before your joining date');
  if (!checkIn && !checkOut) throw new HttpError(422, 'Give at least a check-in or check-out time');
  if (checkIn && checkOut && checkOut <= checkIn) throw new HttpError(422, 'Check-out must be after check-in');
  if (!checkIn && !(await Attendance.exists({ employee: emp._id, date }))) throw new HttpError(422, 'No record on that day: check-in time is required');
  if (await AttendanceCorrection.exists({ employee: emp._id, date, status: 'pending' })) throw new HttpError(409, 'A pending request already exists for this date');
  const c = await AttendanceCorrection.create({ employee: emp._id, date, checkIn: checkIn || null, checkOut: checkOut || null, reason });
  await audit(user, 'attendance.correction_request', 'AttendanceCorrection', c._id, null, c.toObject());
  await notifyRole('hr', { title: 'Attendance correction request', message: `${emp.name} for ${date}`, link: '/attendance' });
  return c;
}

export async function decideCorrection(id, actor, decision, comment) {
  const c = await AttendanceCorrection.findById(id);
  if (!c) throw new HttpError(404, 'Request not found');
  if (c.status !== 'pending') throw new HttpError(409, `Already ${c.status}`);
  const before = c.toObject();
  if (decision === 'approved') {
    const ctx = await getContext(); const today = todayIn(ctx.tz);
    let rec = await Attendance.findOne({ employee: c.employee, date: c.date });
    const newIn = c.checkIn ? zonedToUtc(c.date, c.checkIn, ctx.tz) : rec?.checkIn;
    const newOut = c.checkOut ? zonedToUtc(c.date, c.checkOut, ctx.tz) : rec?.checkOut || null;
    if (!newIn) throw new HttpError(422, 'Check-in time is required');
    if (newOut && newOut <= newIn) throw new HttpError(422, 'Check-out must be after check-in');
    if (!rec) rec = new Attendance({ employee: c.employee, date: c.date });
    Object.assign(rec, { checkIn: newIn, checkOut: newOut, source: 'correction', correctedBy: actor._id },
      computeStatus({ checkIn: newIn, checkOut: newOut, date: c.date, today, ...ctx }));
    await rec.save();
  }
  Object.assign(c, { status: decision, decidedBy: actor._id, decisionComment: comment || '', decidedAt: new Date() });
  await c.save();
  await audit(actor, `attendance.correction_${decision}`, 'AttendanceCorrection', c._id, before, c.toObject());
  await notifyEmployee(c.employee, { title: `Correction ${decision}`, message: `Your attendance correction for ${c.date} was ${decision}.${comment ? ' HR: ' + comment : ''}`, link: '/my-attendance' });
  return c;
}
