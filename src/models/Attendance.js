import mongoose from 'mongoose';
const s = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true }, // office-local ISO date
  checkIn: { type: Date, required: true },
  checkOut: { type: Date, default: null },
  status: { type: String, enum: ['present', 'late', 'half_day', 'missing_checkout'], required: true },
  isLate: { type: Boolean, default: false },
  workedHours: { type: Number, default: 0 },
  source: { type: String, enum: ['web', 'camera', 'correction'], default: 'web' },
  correctedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
s.index({ employee: 1, date: 1 }, { unique: true }); // ek din = ek record
s.index({ date: 1 });
export default mongoose.model('Attendance', s);
