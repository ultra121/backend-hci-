import LeaveRequest from '../models/LeaveRequest.js';
import { datesBetween } from '../utils/time.js';

// Approved leave wale din: Set of `${employeeId}|${YYYY-MM-DD}` (attendance mein absent ki jagah on_leave)
export async function approvedLeaveSet(employeeIds, from, to) {
  const reqs = await LeaveRequest.find({ employee: { $in: employeeIds }, status: 'approved', startDate: { $lte: to }, endDate: { $gte: from } });
  const set = new Set();
  for (const r of reqs) {
    const a = r.startDate > from ? r.startDate : from; const b = r.endDate < to ? r.endDate : to;
    for (const d of datesBetween(a, b)) set.add(`${r.employee}|${d}`);
  }
  return set;
}
