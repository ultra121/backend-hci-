import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import LeaveRequest from '../models/LeaveRequest.js';
import PayrollRun from '../models/PayrollRun.js';
import Payslip from '../models/Payslip.js';
import { getContext } from './attendance.service.js';
import { notifyUsers } from './notification.service.js';
import { monthDays, weekdayOf, todayIn, datesBetween } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const r2 = (n) => Math.round(n * 100) / 100;

// Illustrative annual slab on gross x 12
const SLABS = [
  { from: 0, upTo: 600000, base: 0, rate: 0 },
  { from: 600000, upTo: 1200000, base: 0, rate: 0.05 },
  { from: 1200000, upTo: 2400000, base: 30000, rate: 0.15 },
  { from: 2400000, upTo: 3600000, base: 210000, rate: 0.25 },
  { from: 3600000, upTo: Infinity, base: 510000, rate: 0.35 },
];
export function annualTax(annual) {
  const s = SLABS.find(x => annual <= x.upTo);
  return s.base + (annual - s.from) * s.rate;
}
// Gross = 1.5 x basic (HRA 40%, medical 10%)
export function salaryParts(basic) {
  const hra = r2(basic * 0.4), medical = r2(basic * 0.1);
  return { basic, hra, medical, gross: r2(basic + hra + medical) };
}

// Pure function: ek employee ki ek mahine ki payslip
export function calcPayslip({ emp, month, settings, holidayMap, today, recs, unpaidDates, paidDates }) {
  const days = monthDays(month);
  const isWorking = (d) => !settings.weekend.includes(weekdayOf(d)) && !holidayMap.has(d);
  const employed = (d) => d >= emp.joinDate && (!emp.exitDate || d <= emp.exitDate);
  const W = days.filter(isWorking).length;
  const mine = days.filter(d => isWorking(d) && employed(d)); // prorate: joiners/leavers
  let absent = 0, unpaid = 0, half = 0;
  for (const d of mine) {
    const rec = recs.get(d);
    if (rec) { if (rec.status === 'half_day') half++; }
    else if (unpaidDates.has(d)) unpaid++;
    else if (paidDates.has(d)) { /* paid leave: no deduction */ }
    else if (d < today) absent++;
  }
  const parts = salaryParts(emp.basicSalary);
  const perDay = W ? parts.gross / W : 0;
  const deductionDays = absent + unpaid + 0.5 * half;
  const earned = r2(perDay * mine.length);
  const deduction = r2(Math.min(perDay * deductionDays, earned));
  const tax = W ? r2((annualTax(parts.gross * 12) / 12) * (mine.length / W)) : 0;
  const net = Math.max(0, r2(earned - deduction - tax));
  return { ...parts, workingDays: W, employedDays: mine.length, absentDays: absent, unpaidDays: unpaid, halfDays: half,
    deductionDays, perDay: r2(perDay), earned, deduction, tax, net };
}

async function buildSlips(month) {
  const ctx = await getContext(); const days = monthDays(month); const first = days[0], last = days.at(-1);
  const emps = await Employee.find({ joinDate: { $lte: last }, $or: [{ exitDate: null }, { exitDate: { $gte: first } }] })
    .sort('code').populate('department', 'name').populate('designation', 'name');
  if (!emps.length) throw new HttpError(422, 'No employees were employed in this month');
  const ids = emps.map(e => e._id);
  const [atts, leaves] = await Promise.all([
    Attendance.find({ date: { $gte: first, $lte: last }, employee: { $in: ids } }),
    LeaveRequest.find({ employee: { $in: ids }, status: 'approved', startDate: { $lte: last }, endDate: { $gte: first } }).populate('leaveType', 'isPaid'),
  ]);
  const recMap = new Map(); atts.forEach(a => { const k = String(a.employee); if (!recMap.has(k)) recMap.set(k, new Map()); recMap.get(k).set(a.date, a); });
  const unpaidMap = new Map(), paidMap = new Map();
  for (const l of leaves) {
    const target = l.leaveType?.isPaid === false ? unpaidMap : paidMap; const k = String(l.employee);
    if (!target.has(k)) target.set(k, new Set());
    datesBetween(l.startDate < first ? first : l.startDate, l.endDate > last ? last : l.endDate).forEach(d => target.get(k).add(d));
  }
  const today = todayIn(ctx.tz);
  return emps.map(emp => {
    const k = String(emp._id);
    const c = calcPayslip({ emp, month, settings: ctx.settings, holidayMap: ctx.holidayMap, today,
      recs: recMap.get(k) || new Map(), unpaidDates: unpaidMap.get(k) || new Set(), paidDates: paidMap.get(k) || new Set() });
    return { month, employee: emp._id, employeeCode: emp.code, employeeName: emp.name, department: emp.department?.name, designation: emp.designation?.name, joinDate: emp.joinDate, ...c };
  });
}

const totalsOf = (slips) => ({
  gross: r2(slips.reduce((a, s) => a + s.earned, 0)), deductions: r2(slips.reduce((a, s) => a + s.deduction, 0)),
  tax: r2(slips.reduce((a, s) => a + s.tax, 0)), net: r2(slips.reduce((a, s) => a + s.net, 0)), count: slips.length,
});

export async function createDraft(month, actor) {
  const { tz } = await getContext();
  if (month > todayIn(tz).slice(0, 7)) throw new HttpError(422, 'Cannot run payroll for a future month');
  if (await PayrollRun.exists({ month })) throw new HttpError(409, `Payroll for ${month} already exists`);
  const slips = await buildSlips(month);
  const run = await PayrollRun.create({ month, workingDays: slips[0].workingDays, totals: totalsOf(slips), createdBy: actor._id });
  await Payslip.insertMany(slips.map(s => ({ ...s, run: run._id })));
  await audit(actor, 'payroll.create_draft', 'PayrollRun', run._id, null, { month, ...run.totals.toObject?.() });
  return run;
}

async function draftOrThrow(id) {
  const run = await PayrollRun.findById(id);
  if (!run) throw new HttpError(404, 'Payroll run not found');
  if (run.status === 'finalized') throw new HttpError(409, 'Payroll is finalized and locked');
  return run;
}
export async function recalculate(id, actor) {
  const run = await draftOrThrow(id); const before = run.toObject();
  const slips = await buildSlips(run.month);
  await Payslip.deleteMany({ run: run._id });
  await Payslip.insertMany(slips.map(s => ({ ...s, run: run._id })));
  Object.assign(run, { workingDays: slips[0].workingDays, totals: totalsOf(slips) }); await run.save();
  await audit(actor, 'payroll.recalculate', 'PayrollRun', run._id, before, run.toObject());
  return run;
}
export async function deleteDraft(id, actor) {
  const run = await draftOrThrow(id);
  await Payslip.deleteMany({ run: run._id }); await run.deleteOne();
  await audit(actor, 'payroll.delete_draft', 'PayrollRun', run._id, run.toObject(), null);
}
export async function finalize(id, actor) {
  const run = await draftOrThrow(id); const before = run.toObject();
  Object.assign(run, { status: 'finalized', finalizedBy: actor._id, finalizedAt: new Date() }); await run.save();
  await audit(actor, 'payroll.finalize', 'PayrollRun', run._id, before, run.toObject());
  const slips = await Payslip.find({ run: run._id }).populate({ path: 'employee', select: 'user' });
  await notifyUsers(slips.map(s => s.employee?.user), { title: 'Payslip ready', message: `Your payslip for ${run.month} is available.`, link: '/my-payslips' });
  return run;
}
