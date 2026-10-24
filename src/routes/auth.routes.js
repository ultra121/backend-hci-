import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { login, changePassword, publicUser } from '../services/auth.service.js';

const r = Router();
r.post('/login', async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    res.json(await login(email, password));
  } catch (e) { next(e); }
});
r.get('/me', authenticate, (req, res) => res.json({ user: publicUser(req.user) }));
r.post('/change-password', authenticate, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = z.object({
      oldPassword: z.string().min(1), newPassword: z.string().min(8, 'Min 8 characters'),
    }).parse(req.body);
    res.json(await changePassword(req.user._id, oldPassword, newPassword));
  } catch (e) { next(e); }
});
export default r;
