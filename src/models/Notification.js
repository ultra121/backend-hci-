import mongoose from 'mongoose';
const s = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, default: '' },
  link: { type: String, default: null },
  read: { type: Boolean, default: false },
}, { timestamps: true });
s.index({ user: 1, read: 1, createdAt: -1 });
export default mongoose.model('Notification', s);
