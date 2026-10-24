import AuditLog from '../models/AuditLog.js';
export async function audit(actor, action, entity, entityId, before = null, after = null) {
  try {
    await AuditLog.create({
      actor: actor?._id, actorEmail: actor?.email, action, entity,
      entityId: entityId ? String(entityId) : undefined, before, after,
    });
  } catch (e) { console.error('audit failed', e.message); }
}
