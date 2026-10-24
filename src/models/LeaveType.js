import mongoose from 'mongoose';
const s = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, unique: true, lowercase: true, trim: true }, // annual, sick, casual, unpaid
  yearlyQuota: { type: Number, default: null, min: 0 }, // null = unlimited
  isPaid: { type: Boolean, default: true },
}, { timestamps: true });
export default mongoose.model('LeaveType', s);
