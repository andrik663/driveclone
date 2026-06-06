import { API_URL, apiFetch, formatBytes, formatDate } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import type { FileItem } from '@/data/drive-data'

export type BackendFile = {
  id: string
  name: string
  mimeType: string
  sizeBytes: string
  createdAt: string
  folderId?: string | null
  starred?: boolean
  starredAt?: string | null
  archivedAt?: string | null
  lastViewedAt?: string | null
  connectedAccount?: { email: string; provider: string }
  folder?: { id: string; name: string } | null
}

export function mimeToKind(mimeType: string): FileItem['kind'] {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.includes('pdf')) return 'pdf'
  return 'doc'
}

export function mapFile(file: BackendFile): FileItem {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
    accountEmail: file.connectedAccount?.email,
    accountProvider: file.connectedAccount?.provider,
    date: formatDate(file.createdAt),
    size: formatBytes(file.sizeBytes),
    access: file.connectedAccount?.email ?? 'Google Drive',
    kind: mimeToKind(file.mimeType),
    shared: 1,
    folderId: file.folderId,
    folderName: file.folder?.name,
    starred: Boolean(file.starred),
    starredDate: file.starredAt ? formatDate(file.starredAt) : undefined,
    archivedDate: file.archivedAt ? formatDate(file.archivedAt) : undefined,
    openedDate: file.lastViewedAt ? formatDate(file.lastViewedAt) : undefined,
    location: file.folder?.name ?? 'All Files',
  }
}

export async function setFileStarred(fileId: string, starred: boolean) {
  await apiFetch(`/files/${fileId}/star`, { method: 'PATCH', body: JSON.stringify({ starred }) })
}

export async function setFileArchived(fileId: string, archived: boolean) {
  await apiFetch(`/files/${fileId}/archive`, { method: 'PATCH', body: JSON.stringify({ archived }) })
}

export async function deleteFile(fileId: string) {
  await apiFetch(`/files/${fileId}`, { method: 'DELETE' })
}

export async function downloadFileById(fileId: string, fileName: string, basePath = '/files') {
  const response = await fetch(`${API_URL}${basePath}/${fileId}/download`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })
  if (!response.ok) throw new Error('Download failed')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}
