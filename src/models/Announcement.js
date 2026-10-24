import mongoose from 'mongoose';
const s = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  body: { type: String, required: true, trim: true },
  author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  authorName: String, authorRole: String,
}, { timestamps: true });
export default mongoose.model('Announcement', s);
