import { z } from 'zod';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Designation from '../models/Designation.js';
import { parseCsv } from '../utils/csv.js';
import { createEmployee } from './employee.service.js';
import { audit } from '../utils/audit.js';

export const CSV_COLUMNS = ['code', 'name', 'email', 'phone', 'address', 'department', 'designation', 'joinDate', 'gender', 'status', 'basicSalary'];
const REQUIRED = ['code', 'name', 'email', 'department', 'joinDate', 'basicSalary'];

const rowSchema = z.object({
  code: z.string().min(1, 'required'),
  name: z.string().min(2, 'required (min 2 chars)'),
  email: z.string().email('invalid email'),
  joinDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use ISO date YYYY-MM-DD').refine(d => !Number.isNaN(Date.parse(d)), 'invalid date'),
  basicSalary: z.number({ invalid_type_error: 'must be a number' }).positive('must be greater than 0'),
  gender: z.enum(['male', 'female', 'other']).nullable(),
  status: z.enum(['active', 'probation']),
});

// Dry run + real import ka common validation: har error = {row, field, reason}
export async function validateCsv(csv) {
  const errors = []; const valid = [];
  const rows = parseCsv(csv);
  if (rows.length < 2) return { total: 0, valid, errors: [{ row: 1, field: 'file', reason: 'No data rows found' }] };
  const header = rows[0].map(h => h.trim());
  const missing = REQUIRED.filter(c => !header.includes(c));
  if (missing.length) return { total: 0, valid, errors: missing.map(c => ({ row: 1, field: c, reason: 'Missing column in header' })) };

  const [depts, desigs, empCodes, userEmails] = await Promise.all([
    Department.find(), Designation.find(), Employee.distinct('code'), User.distinct('email'),
  ]);
  const deptMap = new Map(depts.map(d => [d.name.toLowerCase(), d._id]));
  const desigMap = new Map(desigs.map(d => [d.name.toLowerCase(), d._id]));
  const seenCodes = new Set(empCodes), seenEmails = new Set(userEmails);

  rows.slice(1).forEach((cells, idx) => {
    const rowNo = idx + 2;
    const get = (c) => (cells[header.indexOf(c)] ?? '').trim();
    const raw = {
      code: get('code'), name: get('name'), email: get('email').toLowerCase(),
      joinDate: get('joinDate'), basicSalary: get('basicSalary') === '' ? NaN : Number(get('basicSalary')),
      gender: get('gender').toLowerCase() || null, status: get('status').toLowerCase() || 'active',
    };
    const rowErrors = [];
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) parsed.error.issues.forEach(i => rowErrors.push({ row: rowNo, field: i.path[0], reason: i.message }));
    if (raw.code && seenCodes.has(raw.code)) rowErrors.push({ row: rowNo, field: 'code', reason: 'duplicate employee code' });
    if (raw.email && seenEmails.has(raw.email)) rowErrors.push({ row: rowNo, field: 'email', reason: 'duplicate email' });
    const deptName = get('department');
    const department = deptMap.get(deptName.toLowerCase());
    if (!deptName) rowErrors.push({ row: rowNo, field: 'department', reason: 'required' });
    else if (!department) rowErrors.push({ row: rowNo, field: 'department', reason: `unknown department "${deptName}"` });
    const desigName = get('designation');
    const designation = desigName ? desigMap.get(desigName.toLowerCase()) : null;
    if (desigName && !designation) rowErrors.push({ row: rowNo, field: 'designation', reason: `unknown designation "${desigName}"` });

    if (rowErrors.length) { errors.push(...rowErrors); return; }
    seenCodes.add(raw.code); seenEmails.add(raw.email); // file ke andar duplicates pakadne ke liye
    valid.push({ ...parsed.data, phone: get('phone'), address: get('address'), department, designation: designation || null });
  });
  return { total: rows.length - 1, valid, errors };
}

export async function importCsv(csv, dryRun, actor) {
  const { total, valid, errors } = await validateCsv(csv);
  if (dryRun) return { dryRun: true, total, validRows: valid.length, errors };
  if (errors.length) return { failed: true, total, validRows: valid.length, errors };
  const credentials = [];
  for (const data of valid) {
    const { employee, temporaryPassword } = await createEmployee(data, actor);
    credentials.push({ code: employee.code, name: employee.name, email: employee.email, temporaryPassword });
  }
  await audit(actor, 'employees.import', 'Employee', null, null, { imported: credentials.length });
  return { dryRun: false, imported: credentials.length, credentials };
}
