import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import * as ai from '../services/ai.service.js';

const r = Router();
r.use(authenticate, requirePasswordChanged);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

r.post('/chat', async (req, res, next) => { try { res.json(await ai.chat(req.user, req.body)); } catch (e) { next(e); } });
r.post('/summary', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    const f = z.object({ from: isoDate.optional(), to: isoDate.optional(), department: z.string().regex(/^[a-f\d]{24}$/i).optional() }).parse(req.body || {});
    res.json(await ai.summarize(req.user, f));
  } catch (e) { next(e); }
});
r.post('/smart-leave', authorize('employee', 'hr'), async (req, res, next) => { try { res.json(await ai.smartLeave(req.user, req.body?.text)); } catch (e) { next(e); } });

export default r;
