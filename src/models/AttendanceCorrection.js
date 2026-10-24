import mongoose from 'mongoose';
const s = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  checkIn: { type: String, default: null },  // "HH:MM" office time
  checkOut: { type: String, default: null },
  reason: { type: String, required: true, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decisionComment: { type: String, default: '' },
  decidedAt: { type: Date, default: null },
}, { timestamps: true });
s.index({ employee: 1, date: 1, status: 1 });
export default mongoose.model('AttendanceCorrection', s);
