import { Router } from 'express';
import { z } from 'zod';
import LeaveRequest from '../models/LeaveRequest.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import * as svc from '../services/leave.service.js';
import { getContext } from '../services/attendance.service.js';
import { todayIn } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(d)), 'Invalid date');
const year = z.string().regex(/^\d{4}$/);
const POP = [{ path: 'employee', select: 'code name' }, { path: 'leaveType', select: 'name code' }];
const needProfile = (req) => { if (!req.user.employeeId) throw new HttpError(403, 'No employee profile linked to this login'); };

// Form ke liye live "kitne working days"
r.get('/preview', async (req, res, next) => {
  try { const q = z.object({ start: isoDate, end: isoDate }).parse(req.query); res.json({ days: await svc.countWorkingDays(q.start, q.end) }); } catch (e) { next(e); }
});

r.get('/balance', async (req, res, next) => {
  try {
    needProfile(req); const { tz } = await getContext();
    const y = year.default(todayIn(tz).slice(0, 4)).parse(req.query.year);
    res.json({ year: y, balances: await svc.getBalance(req.user.employeeId, y) });
  } catch (e) { next(e); }
});
r.get('/balance/:employeeId', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.employeeId); const { tz } = await getContext();
    const y = year.default(todayIn(tz).slice(0, 4)).parse(req.query.year);
    res.json({ year: y, balances: await svc.getBalance(req.params.employeeId, y) });
  } catch (e) { next(e); }
});

r.get('/my', async (req, res, next) => {
  try { needProfile(req); res.json(await LeaveRequest.find({ employee: req.user.employeeId }).sort('-createdAt').limit(200).populate(POP)); } catch (e) { next(e); }
});

// HR approval inbox (Admin: view)
r.get('/', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), employee: objectId.optional() }).parse(req.query);
    res.json(await LeaveRequest.find(q).sort('-createdAt').limit(300).populate(POP));
  } catch (e) { next(e); }
});

r.post('/', async (req, res, next) => {
  try {
    const body = z.object({ leaveType: objectId, startDate: isoDate, endDate: isoDate, reason: z.string().min(3, 'Min 3 characters').max(300) }).parse(req.body);
    res.status(201).json(await svc.applyLeave(req.user, body));
  } catch (e) { next(e); }
});
r.patch('/:id/cancel', async (req, res, next) => { try { objectId.parse(req.params.id); res.json(await svc.cancelLeave(req.user, req.params.id)); } catch (e) { next(e); } });
r.patch('/:id/decision', authorize('hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const { decision, comment } = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(300).optional() }).parse(req.body);
    res.json(await svc.decideLeave(req.params.id, req.user, decision, comment));
  } catch (e) { next(e); }
});

export default r;
