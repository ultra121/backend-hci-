import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';

// Notification fail ho to asal kaam (leave/payroll) nahi rukna chahiye
async function safe(fn) { try { await fn(); } catch (e) { console.error('notify failed', e.message); } }

export const notifyUsers = (userIds, { title, message = '', link = null }) => safe(async () => {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length) await Notification.insertMany(ids.map(user => ({ user, title, message, link })));
});
export const notifyRole = (role, payload) => safe(async () => {
  const users = await User.find({ role, isActive: true }).select('_id');
  await notifyUsers(users.map(u => u._id), payload);
});
export const notifyEmployee = (employeeId, payload) => safe(async () => {
  const emp = await Employee.findById(employeeId).select('user');
  if (emp?.user) await notifyUsers([emp.user], payload);
});
