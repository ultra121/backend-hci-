import mongoose from 'mongoose';
const s = new mongoose.Schema({
  name: { type: String, required: true, unique: true, trim: true },
  department: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
}, { timestamps: true });
export default mongoose.model('Designation', s);
