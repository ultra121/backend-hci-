import { Router } from 'express';
import { z } from 'zod';
import Employee from '../models/Employee.js';
import PayrollRun from '../models/PayrollRun.js';
import Payslip from '../models/Payslip.js';
import Settings from '../models/Settings.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import * as svc from '../services/payroll.service.js';
import { sendPayslipPdf } from '../services/payslipPdf.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

// Salary structure: HR manage, Admin view (Gross = 1.5 x basic)
r.get('/salary-structures', authorize('admin', 'hr'), async (_req, res, next) => {
  try {
    const list = await Employee.find({ status: { $ne: 'exited' } }).sort('code').populate('department', 'name');
    res.json(list.map(e => ({ _id: e._id, code: e.code, name: e.name, department: e.department?.name, ...svc.salaryParts(e.basicSalary) })));
  } catch (e) { next(e); }
});
r.put('/salary-structures/:employeeId', authorize('hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.employeeId);
    const { basicSalary } = z.object({ basicSalary: z.number().positive('Salary must be > 0') }).parse(req.body);
    const emp = await Employee.findById(req.params.employeeId);
    if (!emp) throw new HttpError(404, 'Employee not found');
    const before = { basicSalary: emp.basicSalary }; emp.basicSalary = basicSalary; await emp.save();
    await audit(req.user, 'salary.update', 'Employee', emp._id, before, { basicSalary });
    res.json({ _id: emp._id, ...svc.salaryParts(emp.basicSalary) });
  } catch (e) { next(e); }
});

// Runs
r.get('/runs', authorize('admin', 'hr'), async (_req, res, next) => { try { res.json(await PayrollRun.find().sort('-month')); } catch (e) { next(e); } });
r.post('/runs', authorize('hr'), async (req, res, next) => {
  try {
    const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }).parse(req.body);
    res.status(201).json(await svc.createDraft(month, req.user));
  } catch (e) { next(e); }
});
r.get('/runs/:id', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const run = await PayrollRun.findById(req.params.id);
    if (!run) throw new HttpError(404, 'Payroll run not found');
    res.json({ run, payslips: await Payslip.find({ run: run._id }).sort('employeeCode') });
  } catch (e) { next(e); }
});
r.post('/runs/:id/recalculate', authorize('hr'), async (req, res, next) => { try { objectId.parse(req.params.id); res.json(await svc.recalculate(req.params.id, req.user)); } catch (e) { next(e); } });
r.delete('/runs/:id', authorize('hr'), async (req, res, next) => { try { objectId.parse(req.params.id); await svc.deleteDraft(req.params.id, req.user); res.json({ deleted: true }); } catch (e) { next(e); } });
r.post('/runs/:id/finalize', authorize('admin'), async (req, res, next) => { try { objectId.parse(req.params.id); res.json(await svc.finalize(req.params.id, req.user)); } catch (e) { next(e); } });

// Employee: apni finalized payslips
r.get('/my-payslips', async (req, res, next) => {
  try {
    if (!req.user.employeeId) throw new HttpError(403, 'No employee profile linked to this login');
    const runs = await PayrollRun.find({ status: 'finalized' }).select('_id');
    res.json(await Payslip.find({ employee: req.user.employeeId, run: { $in: runs.map(x => x._id) } }).sort('-month'));
  } catch (e) { next(e); }
});
r.get('/payslips/:id/pdf', async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const slip = await Payslip.findById(req.params.id);
    if (!slip) throw new HttpError(404, 'Payslip not found');
    const run = await PayrollRun.findById(slip.run);
    if (req.user.role === 'employee') { // data scope: sirf apni, sirf finalized
      if (String(slip.employee) !== String(req.user.employeeId) || run.status !== 'finalized') throw new HttpError(403, 'Access denied');
    }
    const s = await Settings.findOne();
    sendPayslipPdf(res, { slip, run, company: s?.companyName || 'Company' });
  } catch (e) { next(e); }
});

export default r;
