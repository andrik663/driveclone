import { Router } from 'express'
import { google } from 'googleapis'
import { z } from 'zod'
import { prisma } from '../../config/prisma.js'
import { env } from '../../config/env.js'
import { requireAuth, type AuthRequest } from '../../middleware/auth.middleware.js'
import { decryptText, encryptText, hashToken, randomToken } from '../../utils/crypto.js'
import { recordAudit } from '../../utils/audit.js'
import { getAuthedGoogleClient, syncGoogleAppFolderFiles, syncGoogleQuota } from '../google/google.service.js'
import { streamGoogleFile } from './stream-google-file.js'

export const fileRouter = Router()

const fileInclude = { connectedAccount: { select: { id: true, email: true, provider: true } }, folder: { select: { id: true, name: true } } } as const

type SerializableFile = { sizeBytes: bigint; starredAt?: Date | null; archivedAt?: Date | null; lastViewedAt?: Date | null; createdAt?: Date; updatedAt?: Date }

function serializeFile<T extends SerializableFile>(file: T) {
  return {
    ...file,
    sizeBytes: file.sizeBytes.toString(),
    starredAt: file.starredAt ? file.starredAt.toISOString() : null,
    archivedAt: file.archivedAt ? file.archivedAt.toISOString() : null,
    lastViewedAt: file.lastViewedAt ? file.lastViewedAt.toISOString() : null,
  }
}

fileRouter.get('/preview/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token)
    const preview = await prisma.filePreviewToken.findFirst({
      where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() } },
      include: { file: { include: { connectedAccount: true } } },
    })
    if (!preview || preview.file.status !== 'active') return res.status(404).json({ code: 'PREVIEW_NOT_FOUND', message: 'Preview token not found.' })
    return streamGoogleFile(preview.file, req.headers.range, res, { disposition: 'inline' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.use(requireAuth)

fileRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ folderId: z.string().optional(), q: z.string().trim().max(255).optional() }).parse(req.query)
    const files = await prisma.file.findMany({ where: { userId: req.user!.id, status: 'active', archivedAt: null, ...(query.folderId ? { folderId: query.folderId } : {}), ...(query.q ? { name: { contains: query.q } } : {}) }, include: fileInclude, orderBy: { createdAt: 'desc' } })
    return res.json({ files: files.map(serializeFile) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/starred', async (req: AuthRequest, res, next) => {
  try {
    const files = await prisma.file.findMany({ where: { userId: req.user!.id, status: 'active', archivedAt: null, starred: true }, include: fileInclude, orderBy: { starredAt: 'desc' } })
    return res.json({ files: files.map(serializeFile) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/archived', async (req: AuthRequest, res, next) => {
  try {
    const files = await prisma.file.findMany({ where: { userId: req.user!.id, status: 'active', archivedAt: { not: null } }, include: fileInclude, orderBy: { archivedAt: 'desc' } })
    return res.json({ files: files.map(serializeFile) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/recent', async (req: AuthRequest, res, next) => {
  try {
    const query = z.object({ limit: z.coerce.number().min(1).max(100).default(25) }).parse(req.query)
    const logs = await prisma.auditLog.findMany({
      where: { userId: req.user!.id, entityType: 'file', action: { in: ['file.viewed', 'file.downloaded', 'file.renamed', 'file.moved', 'file.shared'] } },
      orderBy: { createdAt: 'desc' },
      take: query.limit * 3,
    })
    const fileIds = [...new Set(logs.map((log) => log.entityId).filter((id): id is string => Boolean(id)))]
    const files = await prisma.file.findMany({ where: { id: { in: fileIds }, userId: req.user!.id, status: 'active', archivedAt: null }, include: fileInclude })
    const fileById = new Map(files.map((file) => [file.id, file]))
    const seen = new Set<string>()
    const activity = []
    for (const log of logs) {
      if (!log.entityId || seen.has(log.entityId)) continue
      const file = fileById.get(log.entityId)
      if (!file) continue
      seen.add(log.entityId)
      activity.push({ action: log.action, at: log.createdAt.toISOString(), file: serializeFile(file) })
      if (activity.length >= query.limit) break
    }
    return res.json({ activity, files: activity.map((item) => item.file) })
  } catch (error) {
    return next(error)
  }
})

const batchFileSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(100) })

fileRouter.patch('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.extend({ folderId: z.string().nullable().optional() }).parse(req.body)
    if (body.folderId) await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
    const result = await prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' }, data: { folderId: body.folderId ?? null } })
    for (const fileId of body.fileIds) await recordAudit({ userId: req.user!.id, action: 'file.moved', entityType: 'file', entityId: fileId, metadata: { folderId: body.folderId ?? null } })
    return res.json({ status: 'ok', moved: result.count })
  } catch (error) {
    return next(error)
  }
})

const starSchema = batchFileSchema.extend({ starred: z.boolean() })

fileRouter.patch('/batch/star', async (req: AuthRequest, res, next) => {
  try {
    const body = starSchema.parse(req.body)
    const result = await prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' }, data: { starred: body.starred, starredAt: body.starred ? new Date() : null } })
    for (const fileId of body.fileIds) await recordAudit({ userId: req.user!.id, action: body.starred ? 'file.starred' : 'file.unstarred', entityType: 'file', entityId: fileId })
    return res.json({ status: 'ok', updated: result.count })
  } catch (error) {
    return next(error)
  }
})

const archiveSchema = batchFileSchema.extend({ archived: z.boolean() })

fileRouter.patch('/batch/archive', async (req: AuthRequest, res, next) => {
  try {
    const body = archiveSchema.parse(req.body)
    const result = await prisma.file.updateMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' }, data: { archivedAt: body.archived ? new Date() : null } })
    for (const fileId of body.fileIds) await recordAudit({ userId: req.user!.id, action: body.archived ? 'file.archived' : 'file.restored', entityType: 'file', entityId: fileId })
    return res.json({ status: 'ok', updated: result.count })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/batch', async (req: AuthRequest, res, next) => {
  try {
    const body = batchFileSchema.parse(req.body)
    const files = await prisma.file.findMany({ where: { id: { in: body.fileIds }, userId: req.user!.id, status: 'active' }, include: { connectedAccount: true } })
    const deletedIds: string[] = []
    const syncedAccountIds = new Set<string>()
    const failed: Array<{ fileId: string; message: string }> = []

    for (const file of files) {
      try {
        const auth = await getAuthedGoogleClient(file.connectedAccount)
        const drive = google.drive({ version: 'v3', auth })
        await drive.files.delete({ fileId: file.providerFileId })
        deletedIds.push(file.id)
        syncedAccountIds.add(file.connectedAccountId)
      } catch (error) {
        failed.push({ fileId: file.id, message: error instanceof Error ? error.message : 'Delete failed' })
      }
    }

    if (deletedIds.length > 0) await prisma.file.updateMany({ where: { id: { in: deletedIds }, userId: req.user!.id }, data: { status: 'deleted', deletedAt: new Date() } })
    for (const accountId of syncedAccountIds) await syncGoogleQuota(accountId).catch(() => undefined)
    if (deletedIds.length === 0 && failed.length > 0) return res.status(400).json({ code: 'FILES_DELETE_FAILED', message: 'No files were deleted.', deleted: 0, failed })
    return res.json({ status: 'ok', deleted: deletedIds.length, failed })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/shared-links', async (req: AuthRequest, res, next) => {
  try {
    const shares = await prisma.fileShare.findMany({
      where: { userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      include: { file: { include: { connectedAccount: { select: { email: true, provider: true } }, folder: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: 'desc' },
    })
    return res.json({
      shares: shares.filter((share) => share.file.status === 'active').map((share) => {
        let url: string | null = null
        if (share.tokenEncrypted) {
          try { url = `${env.FRONTEND_URL}/public/files/${decryptText(share.tokenEncrypted)}` } catch { url = null }
        }
        return {
          id: share.id,
          url,
          createdAt: share.createdAt.toISOString(),
          expiresAt: share.expiresAt?.toISOString() ?? null,
          file: serializeFile(share.file),
        }
      }),
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/sync-google', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ connectedAccountId: z.string().min(1).optional() }).parse(req.body ?? {})
    const accounts = await prisma.connectedAccount.findMany({
      where: { userId: req.user!.id, provider: 'google_drive', status: 'connected', ...(body.connectedAccountId ? { id: body.connectedAccountId } : {}) },
      select: { id: true },
    })

    const results = []
    for (const account of accounts) results.push(await syncGoogleAppFolderFiles(account.id, req.user!.id))

    return res.json({
      status: 'ok',
      accounts: results.length,
      created: results.reduce((total, result) => total + result.created, 0),
      updated: results.reduce((total, result) => total + result.updated, 0),
      deleted: results.reduce((total, result) => total + result.deleted, 0),
      results,
    })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: fileInclude })
    return res.json({ file: serializeFile(file) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.patch('/:id/star', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ starred: z.boolean() }).parse(req.body)
    const fileId = String(req.params.id)
    await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const updated = await prisma.file.update({ where: { id: fileId }, data: { starred: body.starred, starredAt: body.starred ? new Date() : null }, include: fileInclude })
    await recordAudit({ userId: req.user!.id, action: body.starred ? 'file.starred' : 'file.unstarred', entityType: 'file', entityId: fileId })
    return res.json({ file: serializeFile(updated) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.patch('/:id/archive', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ archived: z.boolean() }).parse(req.body)
    const fileId = String(req.params.id)
    await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const updated = await prisma.file.update({ where: { id: fileId }, data: { archivedAt: body.archived ? new Date() : null }, include: fileInclude })
    await recordAudit({ userId: req.user!.id, action: body.archived ? 'file.archived' : 'file.restored', entityType: 'file', entityId: fileId })
    return res.json({ file: serializeFile(updated) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.patch('/:id', async (req: AuthRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1).max(255).optional(), folderId: z.string().nullable().optional() }).parse(req.body)
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    if (body.folderId) await prisma.folder.findFirstOrThrow({ where: { id: body.folderId, userId: req.user!.id, deletedAt: null } })
    if (body.name) await drive.files.update({ fileId: file.providerFileId, requestBody: { name: body.name } })
    const updated = await prisma.file.update({ where: { id: file.id }, data: { ...(body.name ? { name: body.name } : {}), ...(body.folderId !== undefined ? { folderId: body.folderId } : {}) }, include: fileInclude })
    if (body.name) await recordAudit({ userId: req.user!.id, action: 'file.renamed', entityType: 'file', entityId: file.id, metadata: { name: body.name } })
    if (body.folderId !== undefined) await recordAudit({ userId: req.user!.id, action: 'file.moved', entityType: 'file', entityId: file.id, metadata: { folderId: body.folderId } })
    return res.json({ file: serializeFile(updated) })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/share', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const existingShare = await prisma.fileShare.findFirst({ where: { fileId: file.id, userId: req.user!.id, enabled: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' } })
    if (existingShare?.tokenEncrypted) {
      try { return res.json({ url: `${env.FRONTEND_URL}/public/files/${decryptText(existingShare.tokenEncrypted)}`, shareId: existingShare.id }) } catch { /* fall through to recreate */ }
    }
    if (existingShare) await prisma.fileShare.update({ where: { id: existingShare.id }, data: { enabled: false } })
    const token = randomToken(32)
    const share = await prisma.fileShare.create({ data: { fileId: file.id, userId: req.user!.id, tokenHash: hashToken(token), tokenEncrypted: encryptText(token) } })
    await recordAudit({ userId: req.user!.id, action: 'file.shared', entityType: 'file', entityId: file.id })
    return res.status(201).json({ url: `${env.FRONTEND_URL}/public/files/${token}`, shareId: share.id })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/:id/share', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    await prisma.fileShare.updateMany({ where: { fileId, userId: req.user!.id, enabled: true }, data: { enabled: false } })
    await recordAudit({ userId: req.user!.id, action: 'file.share_revoked', entityType: 'file', entityId: fileId })
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.post('/:id/preview-token', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id, status: 'active' } })
    const token = randomToken(32)
    await prisma.filePreviewToken.create({ data: { fileId: file.id, userId: req.user!.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 10 * 60_000) } })
    await prisma.file.update({ where: { id: file.id }, data: { lastViewedAt: new Date() } })
    await recordAudit({ userId: req.user!.id, action: 'file.viewed', entityType: 'file', entityId: file.id })
    const path = `/files/preview/${token}`
    return res.status(201).json({ path, url: `${req.protocol}://${req.get('host')}${path}` })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id/view-url', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    const metadata = await drive.files.get({ fileId: file.providerFileId, fields: 'webViewLink,webContentLink' })
    return res.json({ url: metadata.data.webViewLink ?? metadata.data.webContentLink })
  } catch (error) {
    return next(error)
  }
})

fileRouter.get('/:id/download', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    await prisma.file.update({ where: { id: file.id }, data: { lastViewedAt: new Date() } })
    await recordAudit({ userId: req.user!.id, action: 'file.downloaded', entityType: 'file', entityId: file.id })
    return streamGoogleFile(file, req.headers.range, res, { disposition: 'attachment' })
  } catch (error) {
    return next(error)
  }
})

fileRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const fileId = String(req.params.id)
    const file = await prisma.file.findFirstOrThrow({ where: { id: fileId, userId: req.user!.id }, include: { connectedAccount: true } })
    const auth = await getAuthedGoogleClient(file.connectedAccount)
    const drive = google.drive({ version: 'v3', auth })
    await drive.files.delete({ fileId: file.providerFileId })
    await prisma.file.update({ where: { id: file.id }, data: { status: 'deleted', deletedAt: new Date() } })
    await recordAudit({ userId: req.user!.id, action: 'file.deleted', entityType: 'file', entityId: file.id, metadata: { name: file.name } })
    await syncGoogleQuota(file.connectedAccountId)
    return res.json({ status: 'ok' })
  } catch (error) {
    return next(error)
  }
})
