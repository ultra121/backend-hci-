import { Router } from 'express';
import { z } from 'zod';
import Announcement from '../models/Announcement.js';
import Notification from '../models/Notification.js';
import AuditLog from '../models/AuditLog.js';
import { authenticate, authorize, requirePasswordChanged } from '../middleware/auth.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const guard = [authenticate, requirePasswordChanged];

/* Announcements: Admin/HR post, sab read */
export const announcements = Router();
announcements.use(...guard);
announcements.get('/', async (req, res, next) => {
  try { const n = z.coerce.number().int().min(1).max(50).default(20).parse(req.query.limit); res.json(await Announcement.find().sort('-createdAt').limit(n)); } catch (e) { next(e); }
});
announcements.post('/', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    const { title, body } = z.object({ title: z.string().min(3).max(120), body: z.string().min(3).max(2000) }).parse(req.body);
    const a = await Announcement.create({ title, body, author: req.user._id, authorName: req.user.name, authorRole: req.user.role });
    await audit(req.user, 'announcement.create', 'Announcement', a._id, null, { title });
    res.status(201).json(a);
  } catch (e) { next(e); }
});
announcements.delete('/:id', authorize('admin', 'hr'), async (req, res, next) => {
  try {
    objectId.parse(req.params.id);
    const a = await Announcement.findById(req.params.id);
    if (!a) throw new HttpError(404, 'Not found');
    if (req.user.role !== 'admin' && String(a.author) !== String(req.user._id)) throw new HttpError(403, 'Only the author or Admin can delete');
    await a.deleteOne(); await audit(req.user, 'announcement.delete', 'Announcement', a._id, { title: a.title }, null);
    res.json({ deleted: true });
  } catch (e) { next(e); }
});

/* Notifications: sirf apni */
export const notifications = Router();
notifications.use(...guard);
notifications.get('/', async (req, res, next) => {
  try {
    const [items, unread] = await Promise.all([
      Notification.find({ user: req.user._id }).sort('-createdAt').limit(30),
      Notification.countDocuments({ user: req.user._id, read: false }),
    ]);
    res.json({ unread, items });
  } catch (e) { next(e); }
});
notifications.post('/read-all', async (req, res, next) => {
  try { await Notification.updateMany({ user: req.user._id, read: false }, { read: true }); res.json({ ok: true }); } catch (e) { next(e); }
});
notifications.patch('/:id/read', async (req, res, next) => {
  try { objectId.parse(req.params.id); await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { read: true }); res.json({ ok: true }); } catch (e) { next(e); }
});

/* Audit log: sirf Admin, sirf read */
export const auditRoutes = Router();
auditRoutes.use(...guard, authorize('admin'));
auditRoutes.get('/', async (req, res, next) => {
  try {
    const q = z.object({
      page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20),
      action: z.string().max(60).optional(), entity: z.string().max(40).optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.query);
    const f = {};
    if (q.action) f.action = new RegExp(q.action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (q.entity) f.entity = q.entity;
    if (q.from || q.to) f.createdAt = { ...(q.from && { $gte: new Date(q.from + 'T00:00:00Z') }), ...(q.to && { $lte: new Date(q.to + 'T23:59:59Z') }) };
    const [data, total] = await Promise.all([
      AuditLog.find(f).sort('-createdAt').skip((q.page - 1) * q.limit).limit(q.limit), AuditLog.countDocuments(f)]);
    res.json({ data, total, page: q.page, pages: Math.max(1, Math.ceil(total / q.limit)) });
  } catch (e) { next(e); }
});
