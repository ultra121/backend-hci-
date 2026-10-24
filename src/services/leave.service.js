import mongoose from 'mongoose';
import LeaveRequest from '../models/LeaveRequest.js';
import LeaveType from '../models/LeaveType.js';
import { getContext, requireEmployee } from './attendance.service.js';
import { datesBetween, weekdayOf, todayIn } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';
import { notifyRole, notifyEmployee } from './notification.service.js';

// Sirf working days: weekend aur public holidays skip
export async function countWorkingDays(start, end) {
  if (end < start) throw new HttpError(422, 'End date must be on or after start date');
  const all = datesBetween(start, end);
  if (all.length > 366) throw new HttpError(422, 'Range too long');
  const { settings, holidayMap } = await getContext();
  return all.filter(d => !settings.weekend.includes(weekdayOf(d)) && !holidayMap.has(d)).length;
}

async function usage(employeeId, year) {
  const rows = await LeaveRequest.aggregate([
    { $match: { employee: new mongoose.Types.ObjectId(String(employeeId)), status: { $in: ['approved', 'pending'] }, startDate: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } },
    { $group: { _id: { t: '$leaveType', s: '$status' }, days: { $sum: '$days' } } },
  ]);
  const m = new Map();
  for (const r of rows) { const k = String(r._id.t); m.set(k, { ...(m.get(k) || { approved: 0, pending: 0 }), [r._id.s]: r.days }); }
  return m;
}

export async function getBalance(employeeId, year) {
  const [types, u] = await Promise.all([LeaveType.find().sort('name'), usage(employeeId, year)]);
  return types.map(t => {
    const x = u.get(String(t._id)) || {}; const used = x.approved || 0; const pending = x.pending || 0;
    return { leaveType: { _id: t._id, name: t.name, code: t.code, isPaid: t.isPaid }, quota: t.yearlyQuota, used, pending,
      remaining: t.yearlyQuota == null ? null : t.yearlyQuota - used - pending };
  });
}

const overlapQuery = (employee, start, end, statuses, excludeId) => ({
  employee, status: { $in: statuses }, startDate: { $lte: end }, endDate: { $gte: start }, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
});

export async function applyLeave(user, { leaveType, startDate, endDate, reason }) {
  const emp = await requireEmployee(user);
  const type = await LeaveType.findById(leaveType);
  if (!type) throw new HttpError(422, 'Unknown leave type');
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) throw new HttpError(422, 'Leave cannot span two calendar years: split it into two requests');
  if (startDate < emp.joinDate) throw new HttpError(422, 'Start date is before your joining date');
  const days = await countWorkingDays(startDate, endDate);
  if (days === 0) throw new HttpError(422, 'No working days in this range (weekend/holiday only)');
  if (await LeaveRequest.exists(overlapQuery(emp._id, startDate, endDate, ['pending', 'approved'])))
    throw new HttpError(422, 'These dates overlap with another leave request');
  if (type.yearlyQuota != null) {
    const b = (await getBalance(emp._id, startDate.slice(0, 4))).find(x => String(x.leaveType._id) === String(type._id));
    if (days > b.remaining) throw new HttpError(422, `Not enough ${type.name} balance: ${b.remaining} day(s) left, ${days} requested`);
  }
  const doc = await LeaveRequest.create({ employee: emp._id, leaveType: type._id, startDate, endDate, days, reason });
  await audit(user, 'leave.apply', 'LeaveRequest', doc._id, null, doc.toObject());
  await notifyRole('hr', { title: 'New leave request', message: `${emp.name}: ${days} day(s) of ${type.name} (${startDate} to ${endDate})`, link: '/leave-requests' });
  return doc;
}

export async function cancelLeave(user, id) {
  const l = await LeaveRequest.findById(id);
  if (!l) throw new HttpError(404, 'Request not found');
  if (String(l.employee) !== String(user.employeeId)) throw new HttpError(403, 'Access denied');
  const { tz } = await getContext();
  const ok = l.status === 'pending' || (l.status === 'approved' && l.startDate > todayIn(tz));
  if (!ok) throw new HttpError(409, l.status === 'approved' ? 'Leave has already started' : `Request is already ${l.status}`);
  const before = l.toObject(); l.status = 'cancelled'; await l.save();
  await audit(user, 'leave.cancel', 'LeaveRequest', l._id, before, l.toObject());
  return l;
}

export async function decideLeave(id, actor, decision, comment) {
  const l = await LeaveRequest.findById(id);
  if (!l) throw new HttpError(404, 'Request not found');
  if (l.status !== 'pending') throw new HttpError(409, `Already ${l.status}`);
  if (actor.employeeId && String(actor.employeeId) === String(l.employee)) throw new HttpError(403, 'You cannot decide your own request');
  if (decision === 'rejected' && (!comment || comment.trim().length < 3)) throw new HttpError(422, 'A comment is required when rejecting');
  if (decision === 'approved') {
    if (await LeaveRequest.exists(overlapQuery(l.employee, l.startDate, l.endDate, ['approved'], l._id))) throw new HttpError(422, 'Overlaps with an approved leave');
    const type = await LeaveType.findById(l.leaveType);
    if (type?.yearlyQuota != null) {
      const b = (await getBalance(l.employee, l.startDate.slice(0, 4))).find(x => String(x.leaveType._id) === String(type._id));
      if (b.used + l.days > type.yearlyQuota) throw new HttpError(422, `Over balance: only ${type.yearlyQuota - b.used} day(s) left`);
    }
  }
  const before = l.toObject();
  Object.assign(l, { status: decision, decidedBy: actor._id, decisionComment: comment || '', decidedAt: new Date() });
  await l.save();
  await audit(actor, `leave.${decision === 'approved' ? 'approve' : 'reject'}`, 'LeaveRequest', l._id, before, l.toObject());
  await notifyEmployee(l.employee, { title: `Leave ${decision}`, message: `Your leave ${l.startDate} to ${l.endDate} was ${decision}.${comment ? ' HR: ' + comment : ''}`, link: '/my-leave' });
  return l;
}

// Dashboard / AI ke liye: kaun is din leave par hai
export async function onLeaveOn(date) {
  return LeaveRequest.find({ status: 'approved', startDate: { $lte: date }, endDate: { $gte: date } })
    .populate('employee', 'code name department').populate('leaveType', 'name code');
}
