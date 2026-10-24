import { Router } from 'express';
import { z } from 'zod';
import User from '../models/User.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import { hash, tempPassword, publicUser } from '../services/auth.service.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const r = Router();
r.use(authenticate, requirePasswordChanged, authorize('admin'));

r.get('/', async (_req, res, next) => {
  try { res.json(await User.find().sort('-createdAt')); } catch (e) { next(e); }
});

// Admin sirf HR login banata hai (employee login Step 3 mein HR banayega)
r.post('/hr', async (req, res, next) => {
  try {
    const { name, email } = z.object({ name: z.string().min(2), email: z.string().email() }).parse(req.body);
    const temp = tempPassword();
    const u = await User.create({ name, email, role: 'hr', passwordHash: await hash(temp), mustChangePassword: true });
    await audit(req.user, 'user.create_hr', 'User', u._id, null, { email, role: 'hr' });
    res.status(201).json({ user: publicUser(u), temporaryPassword: temp });
  } catch (e) { next(e); }
});

async function setActive(req, res, next, value) {
  try {
    const u = await User.findById(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.role === 'admin') throw new HttpError(403, 'Admin cannot be deactivated');
    const before = { isActive: u.isActive };
    u.isActive = value; await u.save();
    await audit(req.user, value ? 'user.activate' : 'user.deactivate', 'User', u._id, before, { isActive: value });
    res.json({ user: publicUser(u), isActive: u.isActive });
  } catch (e) { next(e); }
}
r.patch('/:id/deactivate', (req, res, next) => setActive(req, res, next, false));
r.patch('/:id/activate', (req, res, next) => setActive(req, res, next, true));

r.post('/:id/reset-password', async (req, res, next) => {
  try {
    const u = await User.findById(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    if (u.role === 'admin') throw new HttpError(403, 'Not allowed for admin');
    const temp = tempPassword();
    u.passwordHash = await hash(temp); u.mustChangePassword = true; await u.save();
    await audit(req.user, 'user.reset_password', 'User', u._id);
    res.json({ temporaryPassword: temp });
  } catch (e) { next(e); }
});
export default r;
