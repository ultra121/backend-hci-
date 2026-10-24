import mongoose from 'mongoose';
// Har AI call yahan log hoti hai (rate limit bhi isi se count hota hai)
const s = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  kind: { type: String, enum: ['chat', 'summary', 'smart_leave'], required: true },
  input: String,
  output: String,
  tools: [String],
  ok: { type: Boolean, default: true },
  error: String,
  ms: Number,
}, { timestamps: { createdAt: true, updatedAt: false } });
s.index({ user: 1, createdAt: -1 });
export default mongoose.model('AiLog', s, 'ai_logs');
