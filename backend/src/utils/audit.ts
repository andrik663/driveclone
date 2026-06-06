import { prisma } from '../config/prisma.js'

export type AuditAction =
  | 'file.viewed'
  | 'file.downloaded'
  | 'file.renamed'
  | 'file.moved'
  | 'file.starred'
  | 'file.unstarred'
  | 'file.archived'
  | 'file.restored'
  | 'file.deleted'
  | 'file.deleted_permanent'
  | 'file.shared'
  | 'file.share_revoked'
  | 'folder.created'
  | 'folder.renamed'
  | 'folder.deleted'
  | 'invite.created'
  | 'invite.revoked'
  | 'auth.login'
  | 'auth.register'

/**
 * Records an audit log entry. Fire-and-forget: failures are swallowed so
 * auditing never breaks the primary request flow.
 */
export async function recordAudit(params: {
  userId: string | null
  action: AuditAction
  entityType: string
  entityId?: string | null
  metadata?: Record<string, unknown>
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId ?? null,
        metadata: params.metadata ? (params.metadata as object) : undefined,
      },
    })
  } catch (error) {
    console.warn('[audit] failed to record', params.action, error instanceof Error ? error.message : error)
  }
}
