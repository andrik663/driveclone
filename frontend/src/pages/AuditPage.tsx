import { useState } from 'react'
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Code2, Database, FileWarning, Globe, Info, Layers, Lock, RefreshCw, Server, ShieldAlert, X, XCircle, Zap } from 'lucide-react'

type Severity = 'critical' | 'warning' | 'info' | 'good'

type Finding = {
  id: string
  severity: Severity
  title: string
  location: string
  description: string
  recommendation: string
}

type Category = {
  id: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  findings: Finding[]
}

const categories: Category[] = [
  {
    id: 'security',
    label: 'Keamanan (Security)',
    icon: ShieldAlert,
    findings: [
      {
        id: 's1',
        severity: 'critical',
        title: 'Token plaintext disimpan di database (FileShare)',
        location: 'backend/prisma/schema.prisma — model FileShare',
        description: 'Field `token` menyimpan raw share token di database. Jika database bocor, semua share link langsung bisa dipakai oleh attacker. `tokenHash` sudah benar, tapi `token` plaintext seharusnya tidak ada.',
        recommendation: 'Hapus kolom `token` plaintext. Hanya simpan `tokenHash`. Generate token saat dibutuhkan, kirim ke klien hanya sekali (saat pembuatan), dan validasi selalu via hash.',
      },
      {
        id: 's2',
        severity: 'critical',
        title: 'CORS hanya dari satu origin — mudah salah konfigurasi di production',
        location: 'backend/src/app.ts — line 14',
        description: 'CORS dikonfigurasi dari `env.FRONTEND_URL`. Jika variabel kosong atau salah, semua request bisa ditolak atau justru terbuka lebar. Tidak ada fallback atau validasi whitelist.',
        recommendation: 'Validasi `FRONTEND_URL` saat startup. Pertimbangkan daftar origin yang diizinkan (array) untuk mendukung multiple environments (staging, production).',
      },
      {
        id: 's3',
        severity: 'warning',
        title: 'Tidak ada rate limiting di endpoint auth',
        location: 'backend/src/modules/auth/auth.routes.ts — /register, /login',
        description: 'Endpoint `/auth/login` dan `/auth/register` tidak memiliki rate limiting. Tanpa pembatasan, brute-force password dan account enumeration sangat mudah dilakukan. reCAPTCHA bersifat opsional (`captchaToken: z.string().optional()`) sehingga bisa di-bypass.',
        recommendation: 'Tambahkan rate limiting (misal: express-rate-limit) di endpoint login/register. Buat reCAPTCHA wajib di production via env flag.',
      },
      {
        id: 's4',
        severity: 'warning',
        title: 'iconUrl hanya divalidasi prefix — bisa abuse untuk SSRF/data exfil',
        location: 'backend/src/modules/folders/folder.routes.ts — iconUrlSchema',
        description: '`iconUrlSchema` hanya memvalidasi bahwa URL dimulai dengan `https://api.iconify.design/lucide:`. Backend tidak pernah melakukan fetch ke URL tersebut, tetapi URL tetap disimpan di DB dan dikembalikan ke klien lain. Jika logika berubah di masa depan, SSRF bisa terjadi.',
        recommendation: 'Pertahankan allowlist yang ketat. Jangan pernah fetch URL yang dikontrol user dari server. Pertimbangkan menyimpan hanya nama icon (misal: `folder`) bukan full URL.',
      },
      {
        id: 's5',
        severity: 'warning',
        title: 'Google OAuth callback error tidak konsisten — bisa leak info',
        location: 'backend/src/modules/auth/auth.routes.ts — authRouter.get("/google/callback")',
        description: 'Error catch block pada callback redirect ke `/google-auth?status=error` tanpa detail, tapi beberapa path ada yang tidak dihandle dengan benar (misal: tidak ada `await` yang konsisten pada beberapa operasi) dan bisa menyebabkan unhandled rejection.',
        recommendation: 'Pastikan semua path pada callback menggunakan `try/catch` yang sama. Tambahkan logging server-side untuk setiap failure tanpa mengekspos detail ke klien.',
      },
      {
        id: 's6',
        severity: 'info',
        title: 'Refresh token tidak dirotasi saat digunakan',
        location: 'backend/src/modules/auth/auth.routes.ts — /refresh',
        description: 'Endpoint `/auth/refresh` mengeluarkan access token baru tapi tidak merotasi refresh token. Jika refresh token bocor, attacker bisa generate access token baru selamanya hingga sesi dihapus manual.',
        recommendation: 'Implementasikan token rotation: pada setiap `/refresh`, revoke refresh token lama dan buat refresh token baru. Ini adalah best practice untuk stateful refresh tokens.',
      },
    ],
  },
  {
    id: 'backend',
    label: 'Backend & API',
    icon: Server,
    findings: [
      {
        id: 'b1',
        severity: 'critical',
        title: 'Invite system tidak enforce akses — invitee bisa lihat/edit tanpa verifikasi',
        location: 'backend/src/modules/invites/invite.routes.ts & file.routes.ts',
        description: 'WorkspaceInvite model sudah ada, tapi tidak ada middleware atau guard yang memeriksa apakah user yang mengakses file/folder memiliki invite yang valid. Semua endpoint file/folder hanya cek `userId === owner`. Invitee tidak bisa mengakses file yang di-share kecuali melalui public link.',
        recommendation: 'Tambahkan logika di `file.routes.ts` dan `folder.routes.ts` untuk memeriksa WorkspaceInvite saat `userId !== owner`. Buat helper `assertFileAccess(userId, fileId)` yang cek ownership ATAU invite aktif.',
      },
      {
        id: 'b2',
        severity: 'critical',
        title: 'Upload route tidak membatasi jumlah file concurrent uploads per user',
        location: 'backend/src/modules/uploads/upload.routes.ts — uploadRouter.post("/")',
        description: 'Meskipun `limits: { files: 25 }` dibatasi per request, tidak ada batasan berapa banyak request upload yang bisa dilakukan user secara bersamaan. User bisa spawn ratusan koneksi upload paralel dan menghabiskan quota Google API serta resource server.',
        recommendation: 'Tambahkan per-user concurrent upload limit (misal: dengan Redis atau in-memory counter). Tambahkan juga rate limiting khusus untuk upload endpoint.',
      },
      {
        id: 'b3',
        severity: 'warning',
        title: 'syncGoogleAppFolderFiles tidak ditrigger otomatis setelah upload',
        location: 'backend/src/modules/files/file.routes.ts — /sync-google',
        description: 'Sync file dari Google Drive harus dilakukan manual oleh user via tombol "Sync Drive". Jika user upload file langsung dari Google Drive (bukan melalui app), file tidak akan muncul kecuali sync dilakukan. Tidak ada webhook atau polling otomatis.',
        recommendation: 'Pertimbangkan polling background job atau Google Drive push notifications (webhook) untuk auto-sync. Minimal, trigger sync otomatis saat halaman AllFiles dibuka.',
      },
      {
        id: 'b4',
        severity: 'warning',
        title: 'Folder delete tidak handle error individual — file yang gagal dihapus di Google Drive tidak ditrack',
        location: 'backend/src/modules/folders/folder.routes.ts — folderRouter.delete("/:id")',
        description: 'Saat menghapus folder, jika `drive.files.delete` gagal untuk satu file, error di-silent (catch blok kosong) dan proses lanjut. File yang gagal dihapus di Google Drive tetap di-mark `deleted` di database lokal, menyebabkan inconsistency.',
        recommendation: 'Log semua Google Drive delete failures. Pertimbangkan rollback atau partial failure response. Minimal, simpan `lastError` di File record untuk audit.',
      },
      {
        id: 'b5',
        severity: 'warning',
        title: 'storageAccount tidak diupdate setelah file dihapus — quota bisa stale',
        location: 'backend/src/modules/files/file.routes.ts — fileRouter.delete("/:id")',
        description: '`syncGoogleQuota` dipanggil setelah delete, tapi ini async dan tidak ditunggu dalam semua path. Jika sync gagal, `StorageAccount.usedBytes` tidak terupdate dan UI menampilkan data quota yang salah.',
        recommendation: 'Pastikan `syncGoogleQuota` selalu ditunggu (await) dan error-nya di-handle. Pertimbangkan optimistic update di backend: kurangi `usedBytes` secara langsung sebelum sync.',
      },
      {
        id: 'b6',
        severity: 'info',
        title: 'AuditLog model ada di schema tapi tidak pernah diisi',
        location: 'backend/prisma/schema.prisma — model AuditLog',
        description: 'Model `AuditLog` lengkap dengan field `action`, `entityType`, `entityId`, dan `metadata`, tapi tidak ada satu pun route yang melakukan `prisma.auditLog.create()`. Semua operasi kritis (login, upload, delete, share) tidak teradit.',
        recommendation: 'Implementasikan audit logging minimal untuk: login/logout, upload, delete file/folder, create/revoke share, connect/disconnect account. Bisa menggunakan middleware atau helper `logAudit()`.',
      },
      {
        id: 'b7',
        severity: 'info',
        title: 'Tidak ada pagination di GET /files dan GET /folders',
        location: 'backend/src/modules/files/file.routes.ts & folder.routes.ts',
        description: 'Endpoint `/files` dan `/folders` mengembalikan seluruh data tanpa limit atau cursor pagination. Jika user memiliki ribuan file, response akan sangat besar dan bisa menyebabkan timeout atau memory spike di server.',
        recommendation: 'Tambahkan `cursor`/`offset` + `limit` pagination. Default limit: 50-100 item. Tambahkan total count di response untuk mendukung UI pagination.',
      },
    ],
  },
  {
    id: 'database',
    label: 'Database & Schema',
    icon: Database,
    findings: [
      {
        id: 'd1',
        severity: 'warning',
        title: 'Database MySQL bukan PostgreSQL — missing fitur advanced',
        location: 'backend/prisma/schema.prisma — datasource db',
        description: 'Project menggunakan MySQL sebagai database. MySQL tidak mendukung beberapa fitur yang berguna: full-text search yang lebih kuat, array columns, JSONB indexing, dan concurrent transaction isolation yang lebih baik. BigInt di MySQL juga memiliki batasan representasi di beberapa ORM.',
        recommendation: 'Pertimbangkan migrasi ke PostgreSQL untuk production. PostgreSQL lebih baik untuk aplikasi yang butuh full-text search file names, JSONB queries untuk scopes/metadata, dan performa tinggi.',
      },
      {
        id: 'd2',
        severity: 'warning',
        title: 'WorkspaceInvite tidak memiliki relasi ke invitee User',
        location: 'backend/prisma/schema.prisma — model WorkspaceInvite',
        description: 'Model `WorkspaceInvite` hanya menyimpan `inviteeEmail` (string) tanpa foreign key ke `User`. Ini membuat join query lebih sulit dan tidak bisa cascade delete saat user dihapus. Lookup harus selalu via email string.',
        recommendation: 'Tambahkan optional `inviteeUserId` field dengan relasi ke User, diisi saat invite di-accept. Ini memungkinkan proper cascade dan query yang lebih efisien.',
      },
      {
        id: 'd3',
        severity: 'info',
        title: 'File.checksum ada di schema tapi tidak pernah diisi',
        location: 'backend/prisma/schema.prisma — model File.checksum',
        description: 'Field `checksum` ada di model File tapi tidak pernah dihitung atau disimpan selama upload. Tanpa checksum, tidak ada cara untuk mendeteksi file corruption atau duplikat.',
        recommendation: 'Hitung checksum (MD5 atau SHA-256) saat upload dan simpan di field ini. Ini juga berguna untuk deduplikasi file di masa depan.',
      },
      {
        id: 'd4',
        severity: 'good',
        title: 'Index database sudah cukup komprehensif',
        location: 'backend/prisma/schema.prisma — semua model',
        description: 'Semua model memiliki index yang relevan: composite index pada File (userId, status, createdAt), (userId, status, folderId, createdAt), ConnectedAccount (userId, status, createdAt), dsb. Index ini sudah cover query pattern yang paling umum.',
        recommendation: 'Sudah baik. Monitor slow query log di production untuk menemukan index tambahan yang mungkin dibutuhkan seiring data bertambah.',
      },
    ],
  },
  {
    id: 'frontend',
    label: 'Frontend & UX',
    icon: Globe,
    findings: [
      {
        id: 'f1',
        severity: 'critical',
        title: 'StarredPage, ArchivedPage, RecentPage menggunakan dummy data statis',
        location: 'frontend/src/pages/StarredPage.tsx, ArchivedPage.tsx, RecentPage.tsx',
        description: 'Halaman Starred, Archived, dan Recent masih menggunakan data dari `@/data/drive-data` (mock data statis). Tidak ada koneksi ke backend API. User yang login akan melihat data palsu yang tidak mencerminkan file mereka yang sebenarnya.',
        recommendation: 'Hubungkan ketiga halaman ke API backend. Backend perlu menambahkan endpoint: `GET /files?starred=true`, `GET /files?status=archived`, dan `GET /files?recent=true` (sorted by updatedAt). Juga tambahkan field `starred` di model File.',
      },
      {
        id: 'f2',
        severity: 'critical',
        title: 'Sidebar menu Starred dinonaktifkan (disabled) padahal route-nya ada',
        location: 'frontend/src/layouts/DriveLayout.tsx — menu array',
        description: 'Item menu "Starred" memiliki `disabled: true` sehingga user tidak bisa mengaksesnya dari sidebar. Namun route `/starred` tetap ada dan bisa diakses langsung via URL. Inkonsisten dan membingungkan.',
        recommendation: 'Jika fitur belum siap, hapus route-nya juga. Jika sudah siap, hapus flag `disabled`. Jangan biarkan route accessible tapi menu-nya disabled.',
      },
      {
        id: 'f3',
        severity: 'warning',
        title: 'AllFilesPage.tsx terlalu besar — 607+ baris, sulit di-maintain',
        location: 'frontend/src/pages/AllFilesPage.tsx',
        description: 'AllFilesPage memiliki 607+ baris kode dengan puluhan state, handler, dan modal dalam satu komponen. Ini melanggar prinsip single responsibility dan membuat testing, debugging, serta onboarding developer baru sangat sulit.',
        recommendation: 'Pecah menjadi beberapa komponen: `UploadModal`, `FolderCreateModal`, `FolderRenameModal`, `FilePreviewModal`, `InviteModal`. State management bisa diextract ke custom hooks: `useFilesState`, `useUploadHandler`, `useFolderHandler`.',
      },
      {
        id: 'f4',
        severity: 'warning',
        title: 'useEffect dengan fetch di dalam komponen — tidak menggunakan SWR/React Query',
        location: 'frontend/src/pages/AllFilesPage.tsx, QuotaTrackerPage.tsx, SettingsPage.tsx',
        description: 'Semua halaman menggunakan `useEffect + fetch` manual untuk load data. Tidak ada caching, stale-while-revalidate, deduplication, atau loading state management yang proper. Error handling juga tidak konsisten.',
        recommendation: 'Migrasi ke SWR atau TanStack Query. Ini akan memberikan automatic caching, background revalidation, deduplication, dan built-in loading/error states tanpa manual state management.',
      },
      {
        id: 'f5',
        severity: 'warning',
        title: 'View mode (list/grid) disimpan di localStorage — tidak sesuai best practice',
        location: 'frontend/src/pages/AllFilesPage.tsx — fileViewStorageKey',
        description: 'File view mode menggunakan `localStorage` untuk persistence. Ini adalah satu-satunya penggunaan localStorage yang terlihat, yang berarti preferensi UI tidak sinkron antar device/browser dan tidak bisa dimanage dari server.',
        recommendation: 'Untuk preferensi user, pertimbangkan menyimpannya di backend (tabel UserPreference atau JSON field di User). Alternatif sederhana: simpan di URL parameter agar bisa di-bookmark.',
      },
      {
        id: 'f6',
        severity: 'warning',
        title: 'Gravatar image di-load melalui client tanpa error fallback yang proper',
        location: 'frontend/src/lib/gravatar.ts & DriveLayout.tsx, SettingsPage.tsx',
        description: 'Gravatar URL di-fetch dan state-nya di-set via `useEffect`. Jika user tidak memiliki Gravatar, gambar yang muncul adalah default Gravatar avatar. Tidak ada fallback ke initials/icon user yang lebih branded.',
        recommendation: 'Tambahkan fallback UI (initials avatar) ketika gambar gagal dimuat dengan `onError` handler. Atau gunakan library seperti `@dicebear/core` untuk generate avatar konsisten berdasarkan email.',
      },
      {
        id: 'f7',
        severity: 'info',
        title: 'GitHub repo yang di-hardcode di DriveLayout adalah zenhosta/9drive',
        location: 'frontend/src/layouts/DriveLayout.tsx — RepoUpdatesDropdown',
        description: 'Tombol bell di header mem-fetch commit dari `https://api.github.com/repos/zenhosta/9drive/commits`. Ini hardcoded ke repo lain, bukan `andrik663/driveclone`. Selain itu, GitHub API rate limit (60 req/jam tanpa auth) bisa menyebabkan error 403.',
        recommendation: 'Update URL ke repo yang benar (`andrik663/driveclone`) atau jadikan configurable via env variable `VITE_GITHUB_REPO`. Tambahkan GitHub token untuk meningkatkan rate limit.',
      },
      {
        id: 'f8',
        severity: 'info',
        title: 'Tidak ada error boundary di level halaman',
        location: 'frontend/src/App.tsx',
        description: 'Tidak ada React Error Boundary yang membungkus routes. Jika salah satu komponen throw error, seluruh aplikasi akan crash dengan blank screen. User tidak mendapat pesan error yang informatif.',
        recommendation: 'Tambahkan `<ErrorBoundary>` di level `<Routes>` atau per-halaman. Tampilkan fallback UI yang informatif dengan tombol "Try again" dan pesan error yang ramah user.',
      },
      {
        id: 'f9',
        severity: 'good',
        title: 'Upload progress dengan XMLHttpRequest yang proper',
        location: 'frontend/src/pages/AllFilesPage.tsx — uploadWithProgress()',
        description: 'Upload progress tracking menggunakan `XMLHttpRequest.upload.onprogress` yang benar, mendukung cancel, dan multi-file upload dengan estimasi progress yang akurat.',
        recommendation: 'Sudah baik. Pertimbangkan menambahkan cancel/abort functionality agar user bisa membatalkan upload yang sedang berjalan.',
      },
    ],
  },
  {
    id: 'architecture',
    label: 'Arsitektur & Code Quality',
    icon: Layers,
    findings: [
      {
        id: 'a1',
        severity: 'warning',
        title: 'Tidak ada test (unit/integration/e2e) di seluruh codebase',
        location: 'backend/ & frontend/ — tidak ada test file',
        description: 'Seluruh codebase tidak memiliki satu pun test file. Tidak ada unit test untuk utils (crypto, jwt, password), tidak ada integration test untuk API routes, dan tidak ada e2e test untuk user flows. Perubahan apapun berisiko memperkenalkan regression yang tidak terdeteksi.',
        recommendation: 'Mulai dengan test untuk fungsi kritis: `hashPassword`, `verifyPassword`, `signAccessToken`. Tambahkan integration test untuk endpoint auth (login, register, refresh). Gunakan Vitest untuk frontend dan Jest/supertest untuk backend.',
      },
      {
        id: 'a2',
        severity: 'warning',
        title: 'Google Service functions tidak memiliki proper error type',
        location: 'backend/src/modules/google/google.service.ts',
        description: 'Error dari Google API (token expired, quota exceeded, permission denied) di-catch sebagai generic `Error`. Tidak ada mapping ke typed error codes yang bisa dihandle secara berbeda di routes. Semua Google error menjadi generic 500.',
        recommendation: 'Buat `GoogleServiceError` class dengan `code` field (TOKEN_EXPIRED, QUOTA_EXCEEDED, dll). Di routes, catch error ini dan return HTTP status yang sesuai (401 untuk token expired, 429 untuk quota).',
      },
      {
        id: 'a3',
        severity: 'warning',
        title: 'Tidak ada Docker health check yang proper untuk backend',
        location: 'backend/Dockerfile & docker-compose.yml',
        description: 'Endpoint `/health` ada di backend, tapi docker-compose tidak menggunakan `healthcheck` directive. Container akan dianggap sehat segera setelah start, padahal database connection mungkin belum ready (race condition).',
        recommendation: 'Tambahkan healthcheck di docker-compose: `healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:4000/health"], interval: 10s, retries: 5 }`. Tambahkan juga database ping di `/health` endpoint.',
      },
      {
        id: 'a4',
        severity: 'info',
        title: 'Encryption key management tidak ada key rotation',
        location: 'backend/src/utils/crypto.ts & env.ts — TOKEN_ENCRYPTION_KEY',
        description: 'Access token dan refresh token Google OAuth dienkripsi dengan `TOKEN_ENCRYPTION_KEY`. Tidak ada mekanisme key rotation. Jika key perlu diganti (misal: dicurigai bocor), semua connected accounts menjadi tidak bisa digunakan.',
        recommendation: 'Implementasikan key versioning: simpan key version (v1, v2) bersama ciphertext. Saat decrypt gagal dengan key terbaru, coba key lama. Ini memungkinkan zero-downtime key rotation.',
      },
      {
        id: 'a5',
        severity: 'info',
        title: 'Tidak ada request ID / correlation ID untuk tracing',
        location: 'backend/src/app.ts & middleware/',
        description: 'Tidak ada middleware yang menambahkan `X-Request-ID` header ke setiap request. Log upload menggunakan `sessionId` tapi endpoint lain tidak memiliki request ID. Sulit untuk men-trace request end-to-end saat debugging di production.',
        recommendation: 'Tambahkan middleware yang generate UUID per request dan attach ke `res.locals.requestId`. Log semua error dengan request ID. Return `X-Request-ID` header ke klien untuk debugging.',
      },
      {
        id: 'a6',
        severity: 'good',
        title: 'Validasi input menggunakan Zod di semua route backend',
        location: 'backend/src/modules/ — semua route file',
        description: 'Semua route backend menggunakan Zod untuk validasi request body dan query params. Ini mencegah injection attacks via invalid types dan memberikan error messages yang jelas.',
        recommendation: 'Sudah sangat baik. Pastikan semua schema juga mem-validate panjang maksimum string untuk mencegah oversized input.',
      },
      {
        id: 'a7',
        severity: 'good',
        title: 'Tokens dienkripsi di database — tidak disimpan plaintext',
        location: 'backend/src/utils/crypto.ts & prisma/schema.prisma',
        description: 'Google OAuth access token dan refresh token disimpan dalam bentuk encrypted di database (`accessTokenEncrypted`, `refreshTokenEncrypted`). Password menggunakan bcrypt hash. Ini adalah security practice yang benar.',
        recommendation: 'Sudah benar. Pastikan `TOKEN_ENCRYPTION_KEY` minimal 256-bit dan disimpan di secrets manager (bukan .env file) di production.',
      },
    ],
  },
  {
    id: 'performance',
    label: 'Performa',
    icon: Zap,
    findings: [
      {
        id: 'p1',
        severity: 'warning',
        title: 'selectAccount() melakukan sync Google quota pada setiap upload request',
        location: 'backend/src/modules/uploads/upload.routes.ts — selectAccount()',
        description: '`selectAccount()` memeriksa apakah quota data lebih dari 5 menit, lalu sync jika stale. Ini artinya setiap batch upload bisa trigger multiple API calls ke Google Drive hanya untuk mendapatkan storage info, menambah latency upload.',
        recommendation: 'Pisahkan quota cache dari account selection. Gunakan background job untuk periodic quota sync (setiap 15 menit) daripada sync on-demand saat upload. Cache result di Redis atau database dengan TTL.',
      },
      {
        id: 'p2',
        severity: 'warning',
        title: 'File thumbnail/preview tidak ada — selalu fetch dari Google Drive',
        location: 'frontend/src/pages/AllFilesPage.tsx — viewFile()',
        description: 'Preview file selalu generate token baru dan stream dari Google Drive. Tidak ada thumbnail caching. Image preview yang sama akan di-fetch ulang setiap kali dibuka, menghabiskan bandwidth dan Google API quota.',
        recommendation: 'Untuk gambar, gunakan Google Drive thumbnail URL (`thumbnailLink` dari files.get) untuk preview kecil. Cache thumbnail URLs di database. Hanya stream full file saat download atau preview full-size.',
      },
      {
        id: 'p3',
        severity: 'info',
        title: 'loadAll() dipanggil bersamaan tanpa debounce saat searchQuery berubah',
        location: 'frontend/src/pages/AllFilesPage.tsx — useEffect dengan dependency [activeFolderId, searchQuery]',
        description: 'Setiap karakter yang diketik di search akan trigger `loadAll()` baru (setelah form submit). Meski submit manual, URL params berubah dan trigger fetch. Jika user mengetik cepat dan submit berulang kali, multiple concurrent requests bisa terjadi.',
        recommendation: 'Tambahkan debounce di search input (300-500ms) menggunakan `useDeferredValue` React 19 atau library seperti `use-debounce`. Cancel request sebelumnya saat request baru dimulai menggunakan AbortController.',
      },
    ],
  },
]

const severityConfig: Record<Severity, { label: string; color: string; bg: string; border: string; icon: React.ComponentType<{ className?: string }> }> = {
  critical: { label: 'Kritis', color: 'text-red-600', bg: 'bg-red-50', border: 'border-red-200', icon: XCircle },
  warning: { label: 'Peringatan', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', icon: AlertTriangle },
  info: { label: 'Info', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', icon: Info },
  good: { label: 'Baik', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: CheckCircle },
}

function SeverityBadge({ severity }: { severity: Severity }) {
  const config = severityConfig[severity]
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${config.bg} ${config.border} ${config.color}`}>
      <Icon className="h-3.5 w-3.5" />
      {config.label}
    </span>
  )
}

function FindingCard({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(false)
  const config = severityConfig[finding.severity]

  return (
    <div className={`rounded-xl border ${config.border} bg-white overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-4 p-4 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="mt-0.5 shrink-0">
          <SeverityBadge severity={finding.severity} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-slate-900 leading-snug">{finding.title}</p>
          <p className="mt-1 text-xs text-slate-500 font-mono truncate">{finding.location}</p>
        </div>
        <div className="shrink-0 mt-1 text-slate-400">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3 grid gap-3">
          <div>
            <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Masalah</p>
            <p className="text-sm text-slate-700 leading-relaxed">{finding.description}</p>
          </div>
          <div className={`rounded-lg p-3 ${config.bg} border ${config.border}`}>
            <p className="text-xs font-bold uppercase tracking-wider mb-1.5 flex items-center gap-1.5 ${config.color}">
              <RefreshCw className="h-3 w-3" />
              <span className={config.color}>Rekomendasi</span>
            </p>
            <p className="text-sm text-slate-700 leading-relaxed">{finding.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function CategorySection({ category }: { category: Category }) {
  const [open, setOpen] = useState(true)
  const Icon = category.icon
  const counts = {
    critical: category.findings.filter((f) => f.severity === 'critical').length,
    warning: category.findings.filter((f) => f.severity === 'warning').length,
    info: category.findings.filter((f) => f.severity === 'info').length,
    good: category.findings.filter((f) => f.severity === 'good').length,
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-4 p-5 text-left hover:bg-slate-50 transition-colors"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100">
          <Icon className="h-5 w-5 text-slate-700" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-extrabold text-slate-900">{category.label}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {counts.critical > 0 && <span className="text-xs text-red-600 font-bold">{counts.critical} kritis</span>}
            {counts.warning > 0 && <span className="text-xs text-amber-600 font-bold">{counts.warning} peringatan</span>}
            {counts.info > 0 && <span className="text-xs text-blue-600 font-bold">{counts.info} info</span>}
            {counts.good > 0 && <span className="text-xs text-emerald-600 font-bold">{counts.good} baik</span>}
          </div>
        </div>
        <div className="shrink-0 text-slate-400">
          {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 grid gap-3">
          {category.findings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} />
          ))}
        </div>
      )}
    </section>
  )
}

export function AuditPage() {
  const [filter, setFilter] = useState<Severity | 'all'>('all')

  const allFindings = categories.flatMap((cat) => cat.findings)
  const totalCritical = allFindings.filter((f) => f.severity === 'critical').length
  const totalWarning = allFindings.filter((f) => f.severity === 'warning').length
  const totalInfo = allFindings.filter((f) => f.severity === 'info').length
  const totalGood = allFindings.filter((f) => f.severity === 'good').length
  const totalFindings = allFindings.length
  const healthScore = Math.max(0, Math.round(100 - totalCritical * 15 - totalWarning * 5 - totalInfo * 1))

  const filteredCategories = filter === 'all'
    ? categories
    : categories.map((cat) => ({ ...cat, findings: cat.findings.filter((f) => f.severity === filter) })).filter((cat) => cat.findings.length > 0)

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <Code2 className="h-5 w-5 text-slate-500" />
                <span className="text-sm font-mono text-slate-500">andrik663/driveclone</span>
              </div>
              <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Audit Codebase</h1>
              <p className="mt-1 text-sm text-slate-500">Analisis komprehensif — Backend, Frontend, Database, Security, Arsitektur</p>
            </div>
            <div className="flex items-center gap-3 mt-3 sm:mt-0">
              <div className="text-right">
                <p className="text-xs text-slate-500 font-medium">Health Score</p>
                <p className={`text-3xl font-extrabold ${healthScore >= 70 ? 'text-emerald-600' : healthScore >= 40 ? 'text-amber-500' : 'text-red-600'}`}>{healthScore}<span className="text-lg">/100</span></p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-8">
          {[
            { label: 'Total Temuan', value: totalFindings, color: 'text-slate-900', bg: 'bg-white border-slate-200', icon: FileWarning },
            { label: 'Kritis', value: totalCritical, color: 'text-red-600', bg: 'bg-red-50 border-red-200', icon: XCircle },
            { label: 'Peringatan', value: totalWarning, color: 'text-amber-600', bg: 'bg-amber-50 border-amber-200', icon: AlertTriangle },
            { label: 'Baik / Positif', value: totalGood, color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', icon: CheckCircle },
          ].map(({ label, value, color, bg, icon: Icon }) => (
            <div key={label} className={`rounded-2xl border p-4 ${bg}`}>
              <Icon className={`h-5 w-5 ${color} mb-2`} />
              <p className={`text-2xl font-extrabold ${color}`}>{value}</p>
              <p className="text-xs text-slate-500 mt-1 font-medium">{label}</p>
            </div>
          ))}
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap gap-2 mb-6">
          {(['all', 'critical', 'warning', 'info', 'good'] as const).map((sev) => {
            const labels = { all: `Semua (${totalFindings})`, critical: `Kritis (${totalCritical})`, warning: `Peringatan (${totalWarning})`, info: `Info (${totalInfo})`, good: `Baik (${totalGood})` }
            const active = filter === sev
            return (
              <button
                key={sev}
                type="button"
                onClick={() => setFilter(sev)}
                className={`rounded-xl px-4 py-2 text-sm font-bold transition-all border ${
                  active
                    ? sev === 'all' ? 'bg-slate-900 text-white border-slate-900' : sev === 'critical' ? 'bg-red-600 text-white border-red-600' : sev === 'warning' ? 'bg-amber-500 text-white border-amber-500' : sev === 'info' ? 'bg-blue-600 text-white border-blue-600' : 'bg-emerald-600 text-white border-emerald-600'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                {labels[sev]}
              </button>
            )
          })}
        </div>

        {/* Legend */}
        <div className="mb-6 flex flex-wrap gap-4 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="w-full text-xs font-bold text-slate-500 uppercase tracking-wider">Keterangan Tingkat Keparahan</p>
          {(Object.entries(severityConfig) as [Severity, typeof severityConfig.critical][]).map(([key, cfg]) => {
            const Icon = cfg.icon
            return (
              <div key={key} className="flex items-center gap-2">
                <Icon className={`h-4 w-4 ${cfg.color}`} />
                <span className={`text-sm font-bold ${cfg.color}`}>{cfg.label}</span>
                <span className="text-xs text-slate-400">—</span>
                <span className="text-xs text-slate-500">
                  {key === 'critical' && 'Harus segera diperbaiki sebelum production'}
                  {key === 'warning' && 'Perlu diperbaiki dalam waktu dekat'}
                  {key === 'info' && 'Rekomendasi untuk peningkatan'}
                  {key === 'good' && 'Sudah diimplementasikan dengan baik'}
                </span>
              </div>
            )
          })}
        </div>

        {/* Priority Fix List */}
        {(filter === 'all' || filter === 'critical') && (
          <div className="mb-8 rounded-2xl border-2 border-red-200 bg-red-50 p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert className="h-5 w-5 text-red-600" />
              <h2 className="font-extrabold text-red-700">Prioritas Perbaikan Segera ({totalCritical} item kritis)</h2>
            </div>
            <ol className="grid gap-2">
              {allFindings.filter((f) => f.severity === 'critical').map((f, i) => (
                <li key={f.id} className="flex items-start gap-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-200 text-xs font-extrabold text-red-700">{i + 1}</span>
                  <div>
                    <span className="font-bold text-red-800">{f.title}</span>
                    <span className="ml-2 text-xs text-red-500 font-mono">{f.location.split(' — ')[0]}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Category Sections */}
        <div className="grid gap-5">
          {filteredCategories.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center">
              <X className="mx-auto h-8 w-8 text-slate-300 mb-3" />
              <p className="text-slate-500 font-medium">Tidak ada temuan dengan filter ini.</p>
            </div>
          ) : filteredCategories.map((category) => (
            <CategorySection key={category.id} category={category} />
          ))}
        </div>

        {/* Footer Note */}
        <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 flex items-start gap-3">
          <Lock className="h-5 w-5 text-slate-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-slate-700">Catatan Audit</p>
            <p className="mt-1 text-sm text-slate-500 leading-relaxed">
              Audit ini dilakukan secara statis berdasarkan pembacaan kode sumber pada branch <span className="font-mono text-slate-700">main</span> repo <span className="font-mono text-slate-700">andrik663/driveclone</span>. Total <span className="font-bold">{totalFindings} temuan</span> ditemukan di {categories.length} kategori. Prioritaskan perbaikan item <span className="text-red-600 font-bold">Kritis</span> sebelum deployment ke production.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
