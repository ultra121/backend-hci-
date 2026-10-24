import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import * as a from '../services/analytics.service.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const q = z.object({ from: isoDate.optional(), to: isoDate.optional(), department: z.string().regex(/^[a-f\d]{24}$/i).optional() });

// Admin/HR: company dashboard (filters: date range + department). Admin ko extra KPIs.
r.get('/', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    const f = q.parse(req.query);
    const base = await a.companyDashboard(f);
    res.json(req.user.role === 'admin' ? { ...base, admin: await a.adminExtras(f) } : base);
  } catch (e) { next(e); }
});
// Employee: sirf apna personal dashboard
r.get('/me', authorize('employee'), async (req, res, next) => { try { res.json(await a.employeeDashboard(req.user)); } catch (e) { next(e); } });

export default r;
