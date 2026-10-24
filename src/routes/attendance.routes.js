import { Router } from 'express';
import { z } from 'zod';
import Employee from '../models/Employee.js';
import AttendanceCorrection from '../models/AttendanceCorrection.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import * as svc from '../services/attendance.service.js';
import { todayIn } from '../utils/time.js';
import { HttpError } from '../utils/httpError.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);
r.use(async (_req, _res, next) => { try { await svc.sweepMissingCheckout(); next(); } catch (e) { next(e); } });

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(d)), 'Invalid date');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const monthQ = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

// Employee (ya jis login par employee profile ho) apni attendance
r.get('/today', async (req, res, next) => { try { res.json(await svc.getToday(req.user)); } catch (e) { next(e); } });
r.post('/check-in', async (req, res, next) => { try { res.status(201).json(await svc.checkIn(req.user)); } catch (e) { next(e); } });
r.post('/check-out', async (req, res, next) => { try { res.json(await svc.checkOut(req.user)); } catch (e) { next(e); } });

r.get('/my', async (req, res, next) => {
  try {
    if (!req.user.employeeId) throw new HttpError(403, 'No employee profile linked to this login');
    const { tz } = await svc.getContext();
    const month = monthQ.default(todayIn(tz).slice(0, 7)).parse(req.query.month);
    const emp = await Employee.findById(req.user.employeeId);
    res.json(await svc.monthView(emp, month));
  } catch (e) { next(e); }
});

// HR/Admin: daily board aur kisi bhi employee ka calendar
r.get('/board', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    const { tz } = await svc.getContext();
    const q = z.object({ date: isoDate.default(todayIn(tz)), department: objectId.optional() }).parse(req.query);
    res.json(await svc.dailyBoard(q.date, q.department));
  } catch (e) { next(e); }
});
r.get('/employee/:id', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const { tz } = await svc.getContext();
    const month = monthQ.default(todayIn(tz).slice(0, 7)).parse(req.query.month);
    const emp = await Employee.findById(req.params.id);
    if (!emp) throw new HttpError(404, 'Employee not found');
    res.json({ employee: { _id: emp._id, code: emp.code, name: emp.name }, ...(await svc.monthView(emp, month)) });
  } catch (e) { next(e); }
});

// Corrections
r.post('/corrections', async (req, res, next) => {
  try {
    const body = z.object({ date: isoDate, checkIn: hhmm.nullable().optional(), checkOut: hhmm.nullable().optional(), reason: z.string().min(5, 'Min 5 characters').max(300) }).parse(req.body);
    res.status(201).json(await svc.requestCorrection(req.user, body));
  } catch (e) { next(e); }
});
r.get('/corrections', async (req, res, next) => {
  try {
    const status = z.enum(['pending', 'approved', 'rejected']).optional().parse(req.query.status);
    const filter = status ? { status } : {};
    if (req.user.role === 'employee') filter.employee = req.user.employeeId; // data scope
    const list = await AttendanceCorrection.find(filter).sort('-createdAt').limit(200).populate('employee', 'code name');
    res.json(list);
  } catch (e) { next(e); }
});
r.patch('/corrections/:id/decision', authorize('hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const { decision, comment } = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(300).optional() }).parse(req.body);
    res.json(await svc.decideCorrection(req.params.id, req.user, decision, comment));
  } catch (e) { next(e); }
});

export default r;
