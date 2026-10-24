import Employee from '../models/Employee.js';
import User from '../models/User.js';
import { hash, tempPassword } from './auth.service.js';
import { HttpError } from '../utils/httpError.js';
import { audit } from '../utils/audit.js';

const today = () => new Date().toISOString().slice(0, 10);

// Employee + uska login (temporary password, pehle login par change)
export async function createEmployee(data, actor) {
  data.email = data.email.toLowerCase();
  if (await User.exists({ email: data.email })) throw new HttpError(409, 'This email already has a login');
  if (await Employee.exists({ code: data.code })) throw new HttpError(409, 'Employee code already exists');
  const emp = await Employee.create(data);
  const temp = tempPassword();
  let user;
  try {
    user = await User.create({
      name: emp.name, email: emp.email, role: 'employee', employeeId: emp._id,
      passwordHash: await hash(temp), mustChangePassword: true,
    });
  } catch (e) { await Employee.deleteOne({ _id: emp._id }); throw e; } // rollback
  emp.user = user._id;
  await emp.save();
  await audit(actor, 'employees.create', 'Employee', emp._id, null, emp.toObject());
  return { employee: emp, temporaryPassword: temp };
}

export async function updateEmployee(id, data, actor) {
  const emp = await Employee.findById(id);
  if (!emp) throw new HttpError(404, 'Employee not found');
  const before = emp.toObject();
  if (data.email) data.email = data.email.toLowerCase();
  if (data.status === 'exited' && emp.status !== 'exited') data.exitDate = data.exitDate || today();
  if (data.status && data.status !== 'exited') data.exitDate = null;
  Object.assign(emp, data);
  await emp.save();
  // Login ko sync rakho
  const user = emp.user && await User.findById(emp.user);
  if (user) {
    user.name = emp.name; user.email = emp.email;
    user.isActive = emp.status !== 'exited'; // exited = login band
    await user.save();
  }
  await audit(actor, 'employees.update', 'Employee', emp._id, before, emp.toObject());
  return emp;
}
