import { Router } from 'express';
import { z } from 'zod';
import { needsSetup, firstRunSetup, signToken, publicUser } from '../services/auth.service.js';

const r = Router();
const schema = z.object({
  companyName: z.string().min(2),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8, 'Min 8 characters'),
});
r.get('/status', async (_req, res, next) => {
  try { res.json({ needsSetup: await needsSetup() }); } catch (e) { next(e); }
});
r.post('/', async (req, res, next) => {
  try {
    const admin = await firstRunSetup(schema.parse(req.body));
    res.status(201).json({ token: signToken(admin), user: publicUser(admin) });
  } catch (e) { next(e); }
});
export default r;
