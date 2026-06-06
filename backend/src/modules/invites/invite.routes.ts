import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { hashToken, randomToken } from '../../utils/crypto.js'
import { recordAudit } from '../../utils/audit.js'
import { streamGoogleFile } from '../files/stream-google-file.js'

export const inviteRouter = Router()
inviteRouter.use(requireAuth)

const inviteSchema = z.object({ email: z.string().email(), role: z.enum(['viewer', 'editor']).default('viewer'), targetType: z.enum(['file', 'folder']), targetId: z.string().min(1) })

type InviteRecord = { id: string; inviterId: string; inviteeEmail: string; targetType: string; targetId: string; role: string; status: string; revokedAt: Date | null; acceptedAt: Date | null; createdAt: Date; updatedAt: Date }
type TargetRecord = { id: string; name: string; type: 'file' | 'folder'; mimeType?: string; sizeBytes?: string; folderId?: string | null }

async function assertTargetOwner(userId: string, targetType: string, targetId: string) {
  if (targetType === 'file') return prisma.file.findFirstOrThrow({ where: { id: targetId, userId, status: 'active' } })
  return prisma.folder.findFirstOrThrow({ where: { id: targetId, userId, deletedAt: null } })
}

async function resolveTargets(invites: InviteRecord[]) {
  const fileIds = invites.filter((invite) => invite.targetType === 'file').map((invite) => invite.targetId)
  const folderIds = invites.filter((invite) => invite.targetType === 'folder').map((invite) => invite.targetId)
  const [files, folders] = await Promise.all([
    prisma.file.findMany({ where: { id: { in: fileIds }, status: 'active' }, select: { id: true, name: true, mimeType: true, sizeBytes: true, folderId: true } }),
    prisma.folder.findMany({ where: { id: { in: folderIds }, deletedAt: null }, select: { id: true, name: true } }),
  ])
  const targets = new Map<string, TargetRecord>()
  for (const file of files) targets.set(`file:${file.id}`, { id: file.id, name: file.name, type: 'file', mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), folderId: file.folderId })
  for (const folder of folders) targets.set(`folder:${folder.id}`, { id: folder.id, name: folder.name, type: 'folder' })
  return targets
}

function serializeInvite(invite: InviteRecord, target: TargetRecord | null, user?: { id: string; name: string; email: string } | null) {
  return {
    id: invite.id,
    email: invite.inviteeEmail,
    role: invite.role,
    status: invite.status,
    targetType: invite.targetType,
    targetId: invite.targetId,
    target,
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
    user: user ?? null,
  }
}

inviteRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { email: true } })
    const [sent, received] = await Promise.all([
      prisma.workspaceInvite.findMany({ where: { inviterId: req.user!.id, revokedAt: null, targetId: { not: '' } }, orderBy: { createdAt: 'desc' } }),
      prisma.workspaceInvite.findMany({ where: { inviteeEmail: me.email, revokedAt: null, targetId: { not: '' } }, orderBy: { createdAt: 'desc' } }),
    ])
    const allInvites = [...sent, ...received]
    const emails = [...new Set(sent.map((invite) => invite.inviteeEmail))]
    const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, name: true, email: true } })
    const userByEmail = new Map(users.map((user) => [user.email, user]))
    const acceptedInvites = sent.filter((invite) => invite.status === 'pending' && userByEmail.has(invite.inviteeEmail))
    if (acceptedInvites.length > 0) await prisma.workspaceInvite.updateMany({ where: { id: { in: acceptedInvites.map((invite) => invite.id) } }, data: { status: 'accepted', acceptedAt: new Date() } })
    const targetByKey = await resolveTargets(allInvites)
    const sentInvites = sent.map((invite) => serializeInvite({ ...invite, status: userByEmail.has(invite.inviteeEmail) ? 'accepted' : invite.status, acceptedAt: userByEmail.has(invite.inviteeEmail) ? invite.acceptedAt ?? new Date() : invite.acceptedAt }, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null, userByEmail.get(invite.inviteeEmail)))
    const receivedInvites = received.map((invite) => serializeInvite(invite, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null))
    return res.json({ sent: sentInvites, received: receivedInvites, invites: sentInvites })
  } catch (error) {
    return next(error)
  }
})

inviteRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const body = inviteSchema.parse(req.body)
    const email = body.email.trim().toLowerCase()
    const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { email: true } })
    if (email === inviter.email) return res.status(400).json({ code: 'INVITE_SELF_NOT_ALLOWED', message: 'You cannot invite yourself.' })
    await assertTargetOwner(req.user!.id, body.targetType, body.targetId)
    const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true } })
    const invite = await prisma.workspaceInvite.upsert({
      where: { inviterId_inviteeEmail_targetType_targetId: { inviterId: req.user!.id, inviteeEmail: email, targetType: body.targetType, targetId: body.targetId } },
      create: { inviterId: req.user!.id, inviteeEmail: email, role: body.role, targetType: body.targetType, targetId: body.targetId, status: existingUser ? 'accepted' : 'pending', acceptedAt: existingUser ? new Date() : null },
      update: { role: body.role, status: existingUser ? 'accepted' : 'pending', acceptedAt: existingUser ? new Date() : null, revokedAt: null },
    })
    await recordAudit({ userId: req.user!.id, action: 'invite.created', entityType: body.targetType, entityId: body.targetId, metadata: { email, role: body.role } })
    const targetByKey = await resolveTargets([invite])
    return res.status(201).json({ invite: serializeInvite(invite, targetByKey.get(`${invite.targetType}:${invite.targetId}`) ?? null, existingUser) })
  } catch (error) {
    return next(error)
  }
})

inviteRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const invite = await prisma.workspaceInvite.findFirst({ where: { id: String(req.params.id), inviterId: req.user!.id, revokedAt: null } })
    if (!invite) return res.status(404).json({ code: 'INVITE_NOT_FOUND', message: 'Invite not found.' })
    await prisma.workspaceInvite.update({ where: { id: invite.id }, data: { status: 'revoked', revokedAt: new Date() } })
    await recordAudit({ userId: req.user!.id, action: 'invite.revoked', entityType: invite.targetType, entityId: invite.targetId, metadata: { email: invite.inviteeEmail } })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

/**
 * Returns the set of file ids the current user can access through an accepted
 * invite — either a file shared directly, or any active file inside a shared folder.
 */
async function getInvitedFileAccess(userEmail: string) {
  const invites = await prisma.workspaceInvite.findMany({
    where: { inviteeEmail: userEmail, revokedAt: null, status: 'accepted', targetId: { not: '' } },
  })
  const fileIds = invites.filter((invite) => invite.targetType === 'file').map((invite) => invite.targetId)
  const folderIds = invites.filter((invite) => invite.targetType === 'folder').map((invite) => invite.targetId)
  const roleByFileId = new Map<string, string>()
  for (const invite of invites) if (invite.targetType === 'file') roleByFileId.set(invite.targetId, invite.role)
  const roleByFolderId = new Map<string, string>()
  for (const invite of invites) if (invite.targetType === 'folder') roleByFolderId.set(invite.targetId, invite.role)
  return { fileIds, folderIds, roleByFileId, roleByFolderId }
}

async function resolveAccessibleFile(userEmail: string, fileId: string) {
  const access = await getInvitedFileAccess(userEmail)
  const file = await prisma.file.findFirst({ where: { id: fileId, status: 'active', archivedAt: null }, include: { connectedAccount: true } })
  if (!file) return null
  if (access.fileIds.includes(file.id)) return { file, role: access.roleByFileId.get(file.id) ?? 'viewer' }
  if (file.folderId && access.folderIds.includes(file.folderId)) return { file, role: access.roleByFolderId.get(file.folderId) ?? 'viewer' }
  return null
}

inviteRouter.get('/shared-with-me/files', async (req: AuthRequest, res, next) => {
  try {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { email: true } })
    const access = await getInvitedFileAccess(me.email)
    const files = await prisma.file.findMany({
      where: {
        status: 'active',
        archivedAt: null,
        OR: [
          ...(access.fileIds.length ? [{ id: { in: access.fileIds } }] : []),
          ...(access.folderIds.length ? [{ folderId: { in: access.folderIds } }] : []),
        ],
      },
      include: { connectedAccount: { select: { email: true, provider: true } }, folder: { select: { id: true, name: true } }, user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes.toString(),
        createdAt: file.createdAt.toISOString(),
        folderName: file.folder?.name ?? null,
        owner: file.user ? { id: file.user.id, name: file.user.name, email: file.user.email } : null,
        role: access.roleByFileId.get(file.id) ?? (file.folderId ? access.roleByFolderId.get(file.folderId) : undefined) ?? 'viewer',
      })),
    })
  } catch (error) {
    return next(error)
  }
})

inviteRouter.post('/shared-with-me/files/:id/preview-token', async (req: AuthRequest, res, next) => {
  try {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { email: true } })
    const resolved = await resolveAccessibleFile(me.email, String(req.params.id))
    if (!resolved) return res.status(403).json({ code: 'INVITE_ACCESS_DENIED', message: 'You do not have access to this file.' })
    const token = randomToken(32)
    await prisma.filePreviewToken.create({ data: { fileId: resolved.file.id, userId: resolved.file.userId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    await recordAudit({ userId: req.user!.id, action: 'file.viewed', entityType: 'file', entityId: resolved.file.id, metadata: { via: 'invite' } })
    const path = `/files/preview/${token}`
    return res.status(201).json({ path, url: `${req.protocol}://${req.get('host')}${path}` })
  } catch (error) {
    return next(error)
  }
})

inviteRouter.get('/shared-with-me/files/:id/download', async (req: AuthRequest, res, next) => {
  try {
    const me = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { email: true } })
    const resolved = await resolveAccessibleFile(me.email, String(req.params.id))
    if (!resolved) return res.status(403).json({ code: 'INVITE_ACCESS_DENIED', message: 'You do not have access to this file.' })
    await recordAudit({ userId: req.user!.id, action: 'file.downloaded', entityType: 'file', entityId: resolved.file.id, metadata: { via: 'invite' } })
    return streamGoogleFile(resolved.file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})
