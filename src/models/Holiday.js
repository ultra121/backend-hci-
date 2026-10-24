import mongoose from 'mongoose';
const s = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  date: { type: String, required: true, unique: true }, // ISO "YYYY-MM-DD"
}, { timestamps: true });
export default mongoose.model('Holiday', s);
