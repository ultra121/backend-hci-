import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import User from '../models/User.js';
import Settings from '../models/Settings.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

export const hash = (pw) => bcrypt.hash(pw, 10);
export const tempPassword = () => crypto.randomBytes(6).toString('base64url') + '#1';
export const signToken = (user) =>
  jwt.sign({ sub: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '1d' });
export const publicUser = (u) => ({
  id: u._id, name: u.name, email: u.email, role: u.role, employeeId: u.employeeId, mustChangePassword: u.mustChangePassword,
});

export async function needsSetup() {
  return (await Settings.countDocuments()) === 0;
}

export async function firstRunSetup({ companyName, name, email, password }) {
  if (!(await needsSetup())) throw new HttpError(409, 'Setup already completed');
  await Settings.create({ companyName });
  const admin = await User.create({ name, email, passwordHash: await hash(password), role: 'admin' });
  await audit(admin, 'setup.complete', 'Settings', null, null, { companyName });
  return admin;
}

// Optional: .env se ADMIN_EMAIL / ADMIN_PASSWORD
export async function seedAdminFromEnv() {
  const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  if (!(await needsSetup())) return;
  await firstRunSetup({ companyName: 'My Company', name: 'Admin', email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  console.log('Admin created from env');
}

export async function login(email, password) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new HttpError(401, 'Wrong email or password');
  if (!user.isActive) throw new HttpError(403, 'Account is deactivated');
  return { token: signToken(user), user: publicUser(user) };
}

export async function changePassword(userId, oldPassword, newPassword) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!(await bcrypt.compare(oldPassword, user.passwordHash))) throw new HttpError(401, 'Old password is wrong');
  if (oldPassword === newPassword) throw new HttpError(422, 'New password must be different');
  user.passwordHash = await hash(newPassword);
  user.mustChangePassword = false;
  await user.save();
  await audit(user, 'auth.change_password', 'User', user._id);
  return { token: signToken(user), user: publicUser(user) };
}
