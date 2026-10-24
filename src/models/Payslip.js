import mongoose from 'mongoose';
// Snapshot: baad mein salary/naam badle to purani payslip nahi badalti
const s = new mongoose.Schema({
  run: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollRun', required: true },
  month: { type: String, required: true },
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeCode: String, employeeName: String, department: String, designation: String, joinDate: String,
  basic: Number, hra: Number, medical: Number, gross: Number,
  workingDays: Number, employedDays: Number, absentDays: Number, unpaidDays: Number, halfDays: Number, deductionDays: Number,
  perDay: Number, earned: Number, deduction: Number, tax: Number, net: Number,
}, { timestamps: true });
s.index({ run: 1, employee: 1 }, { unique: true });
s.index({ employee: 1, month: 1 });
export default mongoose.model('Payslip', s);
