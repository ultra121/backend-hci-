import { Router } from 'express';
import { z } from 'zod';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import Designation from '../models/Designation.js';
import User from '../models/User.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import { createEmployee, updateEmployee } from '../services/employee.service.js';
import { importCsv, CSV_COLUMNS } from '../services/employeeImport.service.js';
import { toCsv } from '../utils/csv.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(d)), 'Invalid date');
const base = z.object({
  code: z.string().min(1), name: z.string().min(2), email: z.string().email(),
  phone: z.string().max(30).optional().default(''), address: z.string().max(300).optional().default(''),
  department: objectId, designation: objectId.nullable().optional(),
  joinDate: isoDate, gender: z.enum(['male', 'female', 'other']).nullable().optional(),
  basicSalary: z.number().positive('Salary must be > 0'),
});
const createSchema = base.extend({ status: z.enum(['active', 'probation']).optional().default('active') });
const updateSchema = base.extend({ status: z.enum(['active', 'probation', 'exited']), exitDate: isoDate.nullable().optional() }).partial();
const selfSchema = z.object({ phone: z.string().max(30), address: z.string().max(300) });

const POP = [{ path: 'department', select: 'name' }, { path: 'designation', select: 'name' }];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSelf = (req, id) => req.user.employeeId && String(req.user.employeeId) === String(id);

// Employee apna profile dekhe / sirf phone + address edit kare
r.get('/me', authorize('employee'), async (req, res, next) => {
  try {
    const emp = await Employee.findById(req.user.employeeId).populate(POP);
    if (!emp) throw new HttpError(404, 'Profile not found');
    res.json(emp);
  } catch (e) { next(e); }
});
r.patch('/me', authorize('employee'), async (req, res, next) => {
  try {
    const data = selfSchema.parse(req.body);
    const emp = await Employee.findById(req.user.employeeId);
    const before = { phone: emp.phone, address: emp.address };
    Object.assign(emp, data); await emp.save();
    await audit(req.user, 'employees.self_update', 'Employee', emp._id, before, data);
    res.json(await emp.populate(POP));
  } catch (e) { next(e); }
});

// CSV export / import: sirf HR
r.get('/export', authorize('hr'), async (_req, res, next) => {
  try {
    const list = await Employee.find().sort('code').populate(POP);
    const rows = list.map(e => ({ ...e.toObject(), department: e.department?.name, designation: e.designation?.name }));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
    res.send(toCsv(CSV_COLUMNS, rows));
  } catch (e) { next(e); }
});
r.post('/import', authorize('hr'), async (req, res, next) => {
  try {
    const { csv, dryRun } = z.object({ csv: z.string().min(1), dryRun: z.boolean().default(true) }).parse(req.body);
    const result = await importCsv(csv, dryRun, req.user);
    if (result.failed) return res.status(422).json({ message: 'CSV has errors. Run a dry run and fix them first.', errors: result.errors });
    res.json(result);
  } catch (e) { next(e); }
});

// Directory: server-side search, filters, paging. Employee ko sirf apni row milti hai.
r.get('/', async (req, res, next) => {
  try {
    const q = z.object({
      q: z.string().optional(), department: objectId.optional(), designation: objectId.optional(),
      status: z.enum(['active', 'probation', 'exited']).optional(),
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(10),
    }).parse(req.query);
    const filter = {};
    if (req.user.role === 'employee') filter._id = req.user.employeeId;
    if (q.q) { const rx = new RegExp(esc(q.q), 'i'); filter.$or = [{ name: rx }, { email: rx }, { code: rx }]; }
    if (q.department) filter.department = q.department;
    if (q.designation) filter.designation = q.designation;
    if (q.status) filter.status = q.status;
    const [data, total] = await Promise.all([
      Employee.find(filter).sort('code').skip((q.page - 1) * q.limit).limit(q.limit).populate(POP),
      Employee.countDocuments(filter),
    ]);
    res.json({ data, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  } catch (e) { next(e); }
});

r.post('/', authorize('hr'), async (req, res, next) => {
  try {
    const out = await createEmployee(createSchema.parse(req.body), req.user);
    res.status(201).json({ employee: out.employee, temporaryPassword: out.temporaryPassword });
  } catch (e) { next(e); }
});

// Employee 360
r.get('/:id', async (req, res, next) => {
  try {
    if (!objectId.safeParse(req.params.id).success) throw new HttpError(404, 'Not found');
    if (req.user.role === 'employee' && !isSelf(req, req.params.id)) throw new HttpError(403, 'Access denied');
    const emp = await Employee.findById(req.params.id).populate(POP);
    if (!emp) throw new HttpError(404, 'Employee not found');
    const user = await User.findById(emp.user).select('isActive mustChangePassword role');
    res.json({ employee: emp, login: user && { isActive: user.isActive, mustChangePassword: user.mustChangePassword } });
  } catch (e) { next(e); }
});

r.put('/:id', authorize('hr'), async (req, res, next) => {
  try {
    if (!objectId.safeParse(req.params.id).success) throw new HttpError(404, 'Not found');
    const emp = await updateEmployee(req.params.id, updateSchema.parse(req.body), req.user);
    res.json(await emp.populate(POP));
  } catch (e) { next(e); }
});

export default r;
