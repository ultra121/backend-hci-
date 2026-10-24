import mongoose from 'mongoose';
const auditSchema = new mongoose.Schema({
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorEmail: String,
  action: { type: String, required: true },
  entity: String,
  entityId: String,
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });
// Audit log immutable: update/delete block
for (const op of ['updateOne', 'findOneAndUpdate', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  auditSchema.pre(op, function () { throw new Error('Audit log is immutable'); });
}
export default mongoose.model('AuditLog', auditSchema);
