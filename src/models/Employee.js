import mongoose from 'mongoose';
const s = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true },
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  phone: { type: String, default: '', trim: true },
  address: { type: String, default: '', trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  designation: { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
  joinDate: { type: String, required: true }, // ISO YYYY-MM-DD
  gender: { type: String, enum: ['male', 'female', 'other', null], default: null },
  status: { type: String, enum: ['active', 'probation', 'exited'], default: 'active' },
  exitDate: { type: String, default: null },
  basicSalary: { type: Number, required: true, min: 1 },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });
s.index({ name: 'text' });
export default mongoose.model('Employee', s);
