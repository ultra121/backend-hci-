import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import Attendance from '../models/Attendance.js';
import AttendanceCorrection from '../models/AttendanceCorrection.js';
import LeaveRequest from '../models/LeaveRequest.js';
import LeaveType from '../models/LeaveType.js';
import Department from '../models/Department.js';
import Payslip from '../models/Payslip.js';
import PayrollRun from '../models/PayrollRun.js';
import AuditLog from '../models/AuditLog.js';
import { getContext, dailyBoard } from './attendance.service.js';
import { getBalance } from './leave.service.js';
import { approvedLeaveSet } from './leaveLookup.js';
import { datesBetween, todayIn, weekdayOf } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';

const r1 = (n) => Math.round(n * 10) / 10;
const pct = (a, b) => (b ? r1((a / b) * 100) : 0);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
export const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Date range: default = is mahine ka 1 se aaj tak
export async function resolveRange({ from, to } = {}) {
  const ctx = await getContext(); const today = todayIn(ctx.tz);
  const f = from || today.slice(0, 8) + '01'; const t = to || today;
  if (t < f) throw new HttpError(422, 'End date must be on or after start date');
  if (datesBetween(f, t).length > 366) throw new HttpError(422, 'Range too long (max 1 year)');
  return { ctx, today, from: f, to: t, end: t > today ? today : t };
}

// Department naam ya id se id (AI tools naam bhejte hain)
export async function resolveDepartment(dep) {
  if (!dep) return null;
  if (/^[a-f\d]{24}$/i.test(dep)) return oid(dep);
  const d = await Department.findOne({ name: new RegExp('^' + dep.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
  if (!d) throw new HttpError(404, `Unknown department "${dep}"`);
  return d._id;
}

const activeOn = (date) => ({ joinDate: { $lte: date }, $or: [{ status: { $ne: 'exited' } }, { exitDate: { $gt: date } }] });

/* ---------- Headcount ---------- */
export async function headcount({ department, date } = {}) {
  const { today } = await resolveRange({});
  const d = date || today; const dep = await resolveDepartment(department);
  const match = { ...activeOn(d), ...(dep ? { department: dep } : {}) };
  const byDept = await Employee.aggregate([
    { $match: match }, { $group: { _id: '$department', count: { $sum: 1 } } },
    { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'd' } },
    { $project: { _id: 0, department: { $ifNull: [{ $arrayElemAt: ['$d.name', 0] }, 'Unknown'] }, count: 1 } }, { $sort: { count: -1 } },
  ]);
  return { date: d, total: byDept.reduce((a, x) => a + x.count, 0), byDepartment: byDept };
}

/* ---------- Attendance stats (har employee ke counts, DB aggregation se) ---------- */
export async function attendanceStats({ from, to, department, employeeIds } = {}) {
  const { ctx, today, from: f, end } = await resolveRange({ from, to });
  const filter = { joinDate: { $lte: end }, $or: [{ status: { $ne: 'exited' } }, { exitDate: { $gte: f } }] };
  if (department) filter.department = await resolveDepartment(department);
  if (employeeIds) filter._id = { $in: employeeIds.map(oid) };
  const emps = await Employee.find(filter).populate('department', 'name').lean();
  const ids = emps.map(e => e._id);
  const workDays = f <= end ? datesBetween(f, end).filter(d => !ctx.settings.weekend.includes(weekdayOf(d)) && !ctx.holidayMap.has(d)) : [];
  const cnt = (s) => ({ $sum: { $cond: [{ $eq: ['$status', s] }, 1, 0] } });
  const [agg, leaveSet] = await Promise.all([
    workDays.length ? Attendance.aggregate([
      { $match: { employee: { $in: ids }, date: { $in: workDays } } },
      { $group: { _id: '$employee', dates: { $push: '$date' }, present: cnt('present'), late: cnt('late'), half: cnt('half_day'), missing: cnt('missing_checkout') } },
    ]) : [],
    approvedLeaveSet(ids, f, end),
  ]);
  const byEmp = new Map(agg.map(a => [String(a._id), a]));
  const rows = emps.map(e => {
    const a = byEmp.get(String(e._id)) || { dates: [], present: 0, late: 0, half: 0, missing: 0 };
    const have = new Set(a.dates); let onLeave = 0, absent = 0;
    for (const d of workDays) {
      if (d < e.joinDate || (e.exitDate && d > e.exitDate) || have.has(d)) continue;
      if (leaveSet.has(`${e._id}|${d}`)) onLeave++; else if (d < today) absent++;
    }
    return { employeeId: e._id, code: e.code, name: e.name, gender: e.gender, department: e.department?.name || 'Unknown',
      present: a.present, late: a.late, half: a.half, missing: a.missing, onLeave, absent };
  });
  return { from: f, to: end, workingDays: workDays.length, workDays, rows };
}

export function roll(rows) {
  const t = rows.reduce((a, r) => ({ present: a.present + r.present, late: a.late + r.late, half: a.half + r.half, missing: a.missing + r.missing, onLeave: a.onLeave + r.onLeave, absent: a.absent + r.absent }),
    { present: 0, late: 0, half: 0, missing: 0, onLeave: 0, absent: 0 });
  const records = t.present + t.late + t.half + t.missing;
  const expected = records + t.absent; // on_leave din denominator se bahar
  return { ...t, attendanceRate: pct(t.present + t.late + t.missing + 0.5 * t.half, expected), latePct: pct(t.late, t.present + t.late),
    absenteeismPct: pct(t.absent, expected + t.onLeave) };
}
const byDeptOf = (rows) => {
  const m = new Map(); for (const r of rows) m.set(r.department, [...(m.get(r.department) || []), r]);
  return [...m].map(([department, rs]) => { const x = roll(rs); return { department, headcount: rs.length, absenteeismPct: x.absenteeismPct, latePct: x.latePct, attendanceRate: x.attendanceRate }; })
    .sort((a, b) => b.absenteeismPct - a.absenteeismPct);
};

export async function lateComers({ from, to, department, limit = 5, employeeIds } = {}) {
  const s = await attendanceStats({ from, to, department, employeeIds });
  return { from: s.from, to: s.to, top: s.rows.filter(r => r.late > 0).sort((a, b) => b.late - a.late || a.name.localeCompare(b.name)).slice(0, limit)
    .map(r => ({ code: r.code, name: r.name, department: r.department, lateDays: r.late })) };
}

export async function attendanceSummary({ from, to, department, employeeIds } = {}) {
  const s = await attendanceStats({ from, to, department, employeeIds });
  const x = roll(s.rows);
  return { from: s.from, to: s.to, workingDays: s.workingDays, employees: s.rows.length, present: x.present, late: x.late, halfDay: x.half, missingCheckout: x.missing,
    onLeave: x.onLeave, absent: x.absent, attendanceRatePct: x.attendanceRate, latePct: x.latePct, absenteeismPct: x.absenteeismPct };
}

/* ---------- Leave ---------- */
export async function leaveSummary({ from, to, department, employeeIds, date } = {}) {
  const { today, from: f, to: t } = await resolveRange({ from, to });
  const day = date || today;
  const empMatch = {};
  if (employeeIds) empMatch._id = { $in: employeeIds.map(oid) };
  if (department) empMatch.department = await resolveDepartment(department);
  const scoped = Object.keys(empMatch).length ? (await Employee.find(empMatch).select('_id')).map(e => e._id) : null;
  const base = scoped ? { employee: { $in: scoped } } : {};
  const [onLeaveNow, byType, pending] = await Promise.all([
    LeaveRequest.find({ ...base, status: 'approved', startDate: { $lte: day }, endDate: { $gte: day } }).populate('employee', 'code name').populate('leaveType', 'name').lean(),
    LeaveRequest.aggregate([
      { $match: { ...base, status: 'approved', startDate: { $lte: t }, endDate: { $gte: f } } },
      { $group: { _id: '$leaveType', days: { $sum: '$days' }, requests: { $sum: 1 } } },
      { $lookup: { from: 'leavetypes', localField: '_id', foreignField: '_id', as: 't' } },
      { $project: { _id: 0, type: { $arrayElemAt: ['$t.name', 0] }, quota: { $arrayElemAt: ['$t.yearlyQuota', 0] }, days: 1, requests: 1 } },
    ]),
    LeaveRequest.countDocuments({ ...base, status: 'pending' }),
  ]);
  const hc = (await headcount({ department })).total;
  return { date: day, onLeaveCount: onLeaveNow.length,
    onLeave: onLeaveNow.map(l => ({ code: l.employee?.code, name: l.employee?.name, type: l.leaveType?.name, from: l.startDate, to: l.endDate })),
    byType: byType.map(b => ({ ...b, utilizationPct: b.quota ? pct(b.days, b.quota * hc) : null })), pendingRequests: pending, from: f, to: t };
}

/* ---------- Payroll ---------- */
export async function payrollSummary({ month } = {}) {
  const run = await PayrollRun.findOne(month ? { month } : {}).sort('-month');
  if (!run) return { message: month ? `No payroll run for ${month}` : 'No payroll run yet' };
  return { month: run.month, status: run.status, workingDays: run.workingDays, employees: run.totals?.count, totalGross: run.totals?.gross, totalDeductions: run.totals?.deductions, totalTax: run.totals?.tax, totalNet: run.totals?.net };
}
export async function myPayslip(employeeId, month) {
  const runs = await PayrollRun.find({ status: 'finalized', ...(month ? { month } : {}) }).select('_id');
  const s = await Payslip.findOne({ employee: employeeId, run: { $in: runs.map(r => r._id) } }).sort('-month').lean();
  return s ? { month: s.month, gross: s.earned, deduction: s.deduction, tax: s.tax, net: s.net } : { message: 'No finalized payslip yet' };
}

/* ---------- Dashboards ---------- */
export async function companyDashboard({ from, to, department } = {}) {
  const { ctx, today, from: f, to: t, end } = await resolveRange({ from, to });
  const dep = department ? await resolveDepartment(department) : null;
  const stats = await attendanceStats({ from: f, to: t, department });
  const ids = stats.rows.map(r => r.employeeId);
  const total = roll(stats.rows);
  const [hc, board, pendingLeave, pendingCorr, trendAgg, leave] = await Promise.all([
    headcount({ department, date: end }),
    dailyBoard(today, dep ? String(dep) : undefined),
    LeaveRequest.countDocuments({ status: 'pending', ...(dep ? { employee: { $in: ids } } : {}) }),
    AttendanceCorrection.countDocuments({ status: 'pending', ...(dep ? { employee: { $in: ids } } : {}) }),
    stats.workDays.length ? Attendance.aggregate([
      { $match: { employee: { $in: ids }, date: { $in: stats.workDays.slice(-31) } } },
      { $group: { _id: '$date', attended: { $sum: { $cond: [{ $eq: ['$status', 'half_day'] }, 0.5, 1] } } } }, { $sort: { _id: 1 } }]) : [],
    leaveSummary({ from: f, to: t, department }),
  ]);
  const s = board.summary;
  return {
    filters: { from: f, to: t, department: department || null },
    kpis: { headcount: hc.total, presentToday: s.present + s.late + s.half_day + s.missing_checkout, onLeaveToday: s.on_leave, lateToday: s.late, pendingApprovals: pendingLeave + pendingCorr,
      attendanceRatePct: total.attendanceRate, latePct: total.latePct, absenteeismPct: total.absenteeismPct },
    headcountByDepartment: hc.byDepartment,
    attendanceTrend: trendAgg.map(x => ({ date: x._id, attendedPct: pct(x.attended, ids.length) })),
    absenteeismByDepartment: byDeptOf(stats.rows),
    leaveByType: leave.byType,
    topLateComers: (await lateComers({ from: f, to: t, department, limit: 5 })).top,
  };
}

export async function adminExtras({ from, to, department } = {}) {
  const { today, to: t, end } = await resolveRange({ from, to });
  const dep = department ? await resolveDepartment(department) : null;
  const dMatch = dep ? { department: dep } : {};
  const yStart = today.slice(0, 4) + '-01-01';
  const [startHc, endHc, exits, avgSalary, genders, tenureEmps, payByMonth, payByDept, audit] = await Promise.all([
    Employee.countDocuments({ ...dMatch, ...activeOn(addDays(yStart, -1)) }),
    Employee.countDocuments({ ...dMatch, ...activeOn(end) }),
    Employee.countDocuments({ ...dMatch, exitDate: { $gte: yStart, $lte: end } }),
    Employee.aggregate([{ $match: { ...dMatch, ...activeOn(end) } },
      { $group: { _id: '$department', avgGross: { $avg: { $multiply: ['$basicSalary', 1.5] } }, count: { $sum: 1 } } },
      { $lookup: { from: 'departments', localField: '_id', foreignField: '_id', as: 'd' } },
      { $project: { _id: 0, department: { $arrayElemAt: ['$d.name', 0] }, avgGross: { $round: ['$avgGross', 0] }, count: 1 } }]),
    Employee.aggregate([{ $match: { ...dMatch, ...activeOn(end) } }, { $group: { _id: { $ifNull: ['$gender', 'unspecified'] }, count: { $sum: 1 } } }]),
    Employee.find({ ...dMatch, ...activeOn(end) }).select('joinDate').lean(),
    Payslip.aggregate([{ $group: { _id: '$month', gross: { $sum: '$earned' }, net: { $sum: '$net' } } }, { $sort: { _id: -1 } }, { $limit: 6 }, { $sort: { _id: 1 } }]),
    Payslip.aggregate([{ $match: { month: (await PayrollRun.findOne().sort('-month'))?.month || '' } }, { $group: { _id: '$department', gross: { $sum: '$earned' }, net: { $sum: '$net' } } }, { $sort: { gross: -1 } }]),
    AuditLog.find().sort('-createdAt').limit(8).select('actorEmail action entity createdAt').lean(),
  ]);
  const yrs = (d) => (Date.parse(end) - Date.parse(d)) / (365.25 * 864e5);
  const tenure = { 'under 1 year': 0, '1-3 years': 0, 'over 3 years': 0 };
  for (const e of tenureEmps) { const y = yrs(e.joinDate); tenure[y < 1 ? 'under 1 year' : y < 3 ? '1-3 years' : 'over 3 years']++; }
  const avgHc = (startHc + endHc) / 2;
  const latest = payByMonth.at(-1);
  return { attritionYtdPct: pct(exits, avgHc), exitsYtd: exits, payrollCostLatest: latest ? { month: latest._id, gross: Math.round(latest.gross), net: Math.round(latest.net) } : null,
    payrollCostByMonth: payByMonth.map(p => ({ month: p._id, gross: Math.round(p.gross), net: Math.round(p.net) })),
    payrollCostByDepartment: payByDept.map(p => ({ department: p._id, gross: Math.round(p.gross), net: Math.round(p.net) })),
    avgSalaryByDepartment: avgSalary, genderSplit: genders.map(g => ({ gender: g._id, count: g.count })), tenure, auditFeed: audit, upTo: t };
}

export async function employeeDashboard(user) {
  const { ctx, today } = await resolveRange({});
  const empId = user.employeeId;
  if (!empId) throw new HttpError(403, 'No employee profile linked to this login');
  const wd = weekdayOf(today); const monday = addDays(today, -((wd + 6) % 7));
  const [week, month, balances, lastSlip] = await Promise.all([
    Attendance.aggregate([{ $match: { employee: oid(empId), date: { $gte: monday, $lte: today } } }, { $group: { _id: null, hours: { $sum: '$workedHours' } } }]),
    attendanceSummary({ from: today.slice(0, 8) + '01', to: today, employeeIds: [empId] }),
    getBalance(empId, today.slice(0, 4)), myPayslip(empId),
  ]);
  return { today, hoursThisWeek: r1(week[0]?.hours || 0), weeklyTarget: 40, lateThisMonth: month.late, absentThisMonth: month.absent, attendanceRatePct: month.attendanceRatePct,
    leaveBalances: balances.map(b => ({ name: b.leaveType.name, remaining: b.remaining, quota: b.quota })), lastPayslip: lastSlip };
}
