import mongoose from 'mongoose';
const s = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  leaveType: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveType', required: true },
  startDate: { type: String, required: true },
  endDate: { type: String, required: true },
  days: { type: Number, required: true }, // working days only
  reason: { type: String, required: true, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decisionComment: { type: String, default: '' },
  decidedAt: { type: Date, default: null },
}, { timestamps: true });
s.index({ employee: 1, startDate: 1 });
s.index({ status: 1, startDate: 1 });
export default mongoose.model('LeaveRequest', s);
