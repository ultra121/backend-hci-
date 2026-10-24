import { Router } from 'express';
import { z } from 'zod';
import Settings from '../models/Settings.js';
import Department from '../models/Department.js';
import Designation from '../models/Designation.js';
import LeaveType from '../models/LeaveType.js';
import Holiday from '../models/Holiday.js';
import Employee from '../models/Employee.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(d => !Number.isNaN(Date.parse(d)), 'Invalid date');

/* ---------- Company settings: sab dekh sakte hain, sirf Admin change ---------- */
const settingsSchema = z.object({
  companyName: z.string().min(2),
  timezone: z.string().refine(v => { try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; } catch { return false; } }, 'Invalid timezone (e.g. Asia/Karachi)'),
  officeStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM'),
  graceMinutes: z.number().int().min(0).max(120),
  halfDayHours: z.number().min(1).max(12),
  weekend: z.array(z.number().int().min(0).max(6)).max(6),
  officeLat: z.number().min(-90).max(90).nullable(),
  officeLng: z.number().min(-180).max(180).nullable(),
  officeRadiusM: z.number().min(10).max(5000),
});

r.get('/settings', async (_req, res, next) => {
  try { res.json(await Settings.findOne()); } catch (e) { next(e); }
});
r.put('/settings', authorize('admin'), async (req, res, next) => {
  try {
    const data = settingsSchema.parse(req.body);
    const s = await Settings.findOne();
    const before = s.toObject();
    Object.assign(s, data);
    await s.save();
    await audit(req.user, 'settings.update', 'Settings', s._id, before, s.toObject());
    res.json(s);
  } catch (e) { next(e); }
});

/* ---------- Generic CRUD: GET sab, POST/PUT/DELETE sirf Admin ---------- */
const resources = {
  departments: {
    Model: Department, sort: 'name',
    schema: z.object({ name: z.string().min(2) }),
  },
  designations: {
    Model: Designation, sort: 'name', populate: 'department',
    schema: z.object({ name: z.string().min(2), department: objectId.nullable().optional() }),
  },
  'leave-types': {
    Model: LeaveType, sort: 'name',
    schema: z.object({
      name: z.string().min(2),
      code: z.string().regex(/^[a-z_]{2,20}$/i, 'Letters/underscore only'),
      yearlyQuota: z.number().int().min(0).nullable(),
      isPaid: z.boolean(),
    }),
  },
  holidays: {
    Model: Holiday, sort: 'date',
    schema: z.object({ name: z.string().min(2), date: isoDate }),
  },
};
const DEFAULT_LEAVE_TYPES = [
  { name: 'Annual Leave', code: 'annual', yearlyQuota: 14, isPaid: true },
  { name: 'Sick Leave', code: 'sick', yearlyQuota: 8, isPaid: true },
  { name: 'Casual Leave', code: 'casual', yearlyQuota: 10, isPaid: true },
  { name: 'Unpaid Leave', code: 'unpaid', yearlyQuota: null, isPaid: false },
];

// Pehle defined: warna '/:resource/:id' se match ho jata
r.post('/leave-types/defaults', authorize('admin'), async (req, res, next) => {
  try {
    const created = [];
    for (const lt of DEFAULT_LEAVE_TYPES) {
      if (!(await LeaveType.exists({ code: lt.code }))) {
        const doc = await LeaveType.create(lt);
        await audit(req.user, 'leave-types.create', 'LeaveType', doc._id, null, doc.toObject());
        created.push(doc);
      }
    }
    res.status(201).json({ created: created.length });
  } catch (e) { next(e); }
});

function resolve(req) {
  const cfg = resources[req.params.resource];
  if (!cfg) throw new HttpError(404, 'Unknown resource');
  return cfg;
}
const idCheck = (id) => { if (!objectId.safeParse(id).success) throw new HttpError(404, 'Not found'); };

r.get('/:resource', async (req, res, next) => {
  try {
    const { Model, sort, populate } = resolve(req);
    let q = Model.find().sort(sort);
    if (populate) q = q.populate(populate);
    res.json(await q);
  } catch (e) { next(e); }
});

r.post('/:resource', authorize('admin'), async (req, res, next) => {
  try {
    const { Model, schema } = resolve(req);
    const doc = await Model.create(schema.parse(req.body));
    await audit(req.user, `${req.params.resource}.create`, Model.modelName, doc._id, null, doc.toObject());
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

r.put('/:resource/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { Model, schema } = resolve(req);
    idCheck(req.params.id);
    const doc = await Model.findById(req.params.id);
    if (!doc) throw new HttpError(404, 'Not found');
    const before = doc.toObject();
    Object.assign(doc, schema.parse(req.body));
    await doc.save();
    await audit(req.user, `${req.params.resource}.update`, Model.modelName, doc._id, before, doc.toObject());
    res.json(doc);
  } catch (e) { next(e); }
});

r.delete('/:resource/:id', authorize('admin'), async (req, res, next) => {
  try {
    const { Model } = resolve(req);
    idCheck(req.params.id);
    const doc = await Model.findById(req.params.id);
    if (!doc) throw new HttpError(404, 'Not found');
    if (req.params.resource === 'departments' && (await Employee.exists({ department: doc._id })))
      throw new HttpError(409, 'Department is used by employees');
    if (req.params.resource === 'designations' && (await Employee.exists({ designation: doc._id })))
      throw new HttpError(409, 'Designation is used by employees');
    await doc.deleteOne();
    await audit(req.user, `${req.params.resource}.delete`, Model.modelName, doc._id, doc.toObject(), null);
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

export default r;
