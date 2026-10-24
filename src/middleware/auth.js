import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { HttpError } from '../utils/httpError.js';

// Har request par token + DB se user check (deactivate hote hi access band)
export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new HttpError(401, 'Login required');
    let payload;
    try { payload = jwt.verify(token, process.env.JWT_SECRET); }
    catch { throw new HttpError(401, 'Invalid or expired token'); }
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) throw new HttpError(401, 'Account not active');
    req.user = user;
    next();
  } catch (e) { next(e); }
}

// Role guard: authorize('admin','hr')
export const authorize = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Access denied'));

// Pehli dafa password change zaroori ho to baqi APIs block
export function requirePasswordChanged(req, _res, next) {
  if (req.user.mustChangePassword) return next(new HttpError(403, 'Change your password first'));
  next();
}

// Data-scope helper (Step 3+ mein use hoga): employee sirf apni rows dekhe
export function scopeFilter(req) {
  return req.user.role === 'employee' ? { employee: req.user.employeeId } : {};
}

export function errorHandler(err, _req, res, _next) {
  if (err.name === 'ZodError') {
    return res.status(422).json({ message: 'Validation failed', errors: err.issues.map(i => ({ field: i.path.join('.'), reason: i.message })) });
  }
  if (err.code === 11000) return res.status(409).json({ message: 'Already exists' });
  const status = err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ message: status === 500 ? 'Server error' : err.message });
}
