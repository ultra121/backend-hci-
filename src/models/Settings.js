import mongoose from 'mongoose';
// Singleton: sirf ek document company settings ka
const settingsSchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  timezone: { type: String, default: 'Asia/Karachi' },
  officeStart: { type: String, default: '09:00' },
  graceMinutes: { type: Number, default: 15 },
  halfDayHours: { type: Number, default: 5 },
  weekend: { type: [Number], default: [0, 6] }, // 0=Sun, 6=Sat
  officeLat: { type: Number, default: null },
  officeLng: { type: Number, default: null },
  officeRadiusM: { type: Number, default: 150 },
}, { timestamps: true });
export default mongoose.model('Settings', settingsSchema);
