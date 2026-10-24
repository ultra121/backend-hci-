import mongoose from 'mongoose';
const s = new mongoose.Schema({
  month: { type: String, required: true, unique: true }, // YYYY-MM
  status: { type: String, enum: ['draft', 'finalized'], default: 'draft' },
  workingDays: Number,
  totals: { gross: Number, deductions: Number, tax: Number, net: Number, count: Number },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  finalizedAt: { type: Date, default: null },
}, { timestamps: true });
export default mongoose.model('PayrollRun', s);
