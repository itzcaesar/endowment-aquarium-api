# Tel-U Endowment Aquarium API

Repo ini berisi implementasi MVP dengan `IMPLEMENTATION_MODE=NODE_FASTIFY`. Backend API dan
database PostgreSQL menjadi sumber data utama.

## Arsitektur

```text
Endowment API  <-- GET /api/v1/donors/:nik (Bearer ticket, server-to-server) --+
Mock Endowment API --> webhook HMAC --------------------------------------> Game API -- Drizzle --> PostgreSQL / Supabase
                                                                              ^
                                                                              |
                                                                        Unity WebGL HTTPS
```

Struktur monorepo:

- `apps/game-api`: REST API berbasis Fastify, pemrosesan webhook, penyimpanan PostgreSQL, migrasi,
  seed, dan pengujian;
- `apps/mock-endowment-api`: simulator donasi in-memory, replay, refund,
  dan skenario pengujian;
- `packages/contracts`: contract Zod ketat yang dipakai bersama;
- `supabase/migrations`: salinan migrasi Drizzle yang kompatibel dengan Supabase;
- `tests/api`: koleksi request yang bisa dipakai dengan Bruno;
- `docker-compose.yml`: konfigurasi opsional untuk running PostgreSQL dan API secara lokal.

## Requirement

- Node.js 22 atau lebih baru;
- npm 11 atau lebih baru;
- PostgreSQL 14+ atau database PostgreSQL dari Supabase;
- Docker bersifat opsional.

Salin `.env.example` menjadi `.env`, lalu isi setidaknya variabel berikut:

```env
NODE_ENV=development
GAME_API_PORT=3000
MOCK_API_PORT=4000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/endowment_aquarium
ENDOWMENT_WEBHOOK_SECRET=replace-me-with-at-least-16-characters
GAME_API_WEBHOOK_URL=http://localhost:3000/webhooks/v1/endowment
WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS=300
ENDOWMENT_API_BASE_URL=http://localhost:4000
ENDOWMENT_API_TICKET=replace-me-with-the-endowment-ticket
ENDOWMENT_API_TIMEOUT_MS=5000
CORS_ORIGINS=http://localhost:5173,http://localhost:8080
```

`ENDOWMENT_API_TICKET` hanya disimpan di server dan tidak pernah dikirim ke client WebGL. Secara
lokal, Mock API memakai nilai ticket yang sama untuk memvalidasi lookup donor.

Jika memakai Supabase, cukup ganti `DATABASE_URL` dengan connection string PostgreSQL dari panel
Connect di Supabase. SSL akan digunakan otomatis untuk host non-lokal. Sebaiknya gunakan project
khusus development dan jangan pernah memakai `DATABASE_URL` untuk pengujian yang menghapus data.

## Running langsung dengan npm

Docker tidak wajib digunakan.

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

Game API berjalan di `http://localhost:3000`, sedangkan Mock API di `http://localhost:4000`.
Scalar API Reference untuk GAME API tersedia di
[http://localhost:3000/docs](http://localhost:3000/docs), dan dokumen OpenAPI-nya tersedia di
[http://localhost:3000/openapi.json](http://localhost:3000/openapi.json).

Untuk running salah satu service saja, gunakan `npm run dev:game` atau `npm run dev:mock`.
Data donasi pada Mock API hanya disimpan di memory, jadi akan kembali kosong setiap kali service
dimulai ulang.

Command database:

```bash
npm run db:generate   # membuat migrasi Drizzle dari schema
npm run db:migrate    # running migrasi yang sudah disimpan
npm run db:seed       # melakukan upsert untuk empat tier dan empat spesies
npm run db:reset      # khusus development; ditolak jika NODE_ENV=production/database postgres bawaan
npm run db:studio
```

## Docker Compose (opsional)

```bash
docker compose up --build
```

Command ini running PostgreSQL, Game API, dan Mock API. Migrasi dan seed yang sama dapat
dijalankan melalui port PostgreSQL yang diekspos. Docker hanya disediakan sebagai opsi praktis,
bukan syarat untuk running aplikasi.

## Endpoint API

Game API:

- `GET /api/v1/health`, `GET /api/v1/meta`;
- `POST /webhooks/v1/endowment` (HMAC SHA-256, timestamp, dan idempotent);
- `POST /api/v1/auth/exchange`;
- `POST /api/v1/auth/nik` (body `{ "nik": "16 digit" }`; game API mengambil data donor dari
  Endowment, menyimpan cache di tabel `donors`, membuat/menyesuaikan ikan sesuai tier, lalu
  mengembalikan bearer token tujuh hari; dibatasi 10 request/menit per IP);
- `GET /api/v1/me/inventory` (poin dan aksesoris yang dimiliki);
- `GET /api/v1/me/aquarium`;
- `GET /api/v1/aquariums/:publicSlug`;
- `GET /api/v1/big-aquarium?limit=15` (maksimal 50, satu ikan aktif per donatur);
- `POST /api/v1/me/fish/:fishId/feed` (jeda empat jam);
- `PATCH /api/v1/me/fish/:fishId/appearance`;
- `GET /api/v1/aquariums/:publicSlug/events?after=0&limit=100`.

Mock API:

- `GET /health`;
- `GET /api/v1/donors/:nik` (simulasi API Endowment; `Authorization: Bearer <ticket>` atau
  `X-API-Key`), mengembalikan `{ nik, nama, total_donasi }`;
- `GET /mock/v1/donors`, `POST /mock/v1/donors` (menambah/mengubah donor mock). Donor bawaan:
  NIK `3171010101010001`–`3171010101010005` (Common, Rare, Epic, Legendary, dan di bawah Common);
- `POST /mock/v1/donations`, `GET /mock/v1/donations`;
- `POST /mock/v1/donations/:id/replay`;
- `POST /mock/v1/donations/:id/refund`;
- `POST /mock/v1/scenarios/common|rare|epic|legendary|random`.

Semua respons JSON menggunakan format `{ schemaVersion, requestId, data }` atau format error yang
tetap. Setiap request dapat menyertakan `X-Request-ID`; jika tidak ada, nilainya akan dibuat secara
otomatis. DTO publik tidak pernah memuat email donatur, ID eksternal, nominal donasi, payload webhook
mentah, hash access token, atau kredensial database.

## Dashboard operasional

`/dashboard/` menampilkan kesehatan Game API, PostgreSQL, dan API Endowment (latensi p50/p95 dan
error terakhir dari lookup NIK sungguhan), jumlah donor/ikan/webhook, aktivitas game per jam, serta
event terbaru tanpa data pribadi (NIK, nama, dan email tidak pernah ditampilkan). Data diambil dari
`GET /api/v1/admin/stats` yang mewajibkan header `X-Admin-Token` sesuai `ADMIN_DASHBOARD_TOKEN`;
jika variabel itu kosong, endpoint mengembalikan `503 DASHBOARD_DISABLED`.

Tab **Fish**, **Donors**, dan **Audit log** dipakai untuk mengelola data: membuat/mengubah/menonaktifkan
ikan, mengubah profil donor, menyesuaikan poin dan aksesoris inventory, sinkron ulang dari Endowment,
melihat riwayat per ikan, serta ekspor CSV. Setiap perubahan dan ekspor tercatat di
`admin_audit_log`. Perubahan ikan juga menghasilkan game event yang sudah dikenal client Unity.

## Operasional server

- `deploy/backup.sh`: `pg_dump` terverifikasi, simpan 14 hari di `~/backups` (cron 03:15).
- `deploy/healthcheck.sh`: watchdog tiap 5 menit; restart API setelah dua kegagalan berturut-turut,
  log ke journal (`journalctl -t endowment-health`).
- `npm run db:cleanup`: hapus access token kedaluwarsa (>7 hari) dan metrik lookup Endowment
  (>90 hari). Game event dan audit log tidak dihapus.

## Akses personal khusus development

Setelah data donatur tersedia, misalnya setelah running mock scenario, buat token yang berlaku
selama tujuh hari. Token mentah hanya ditampilkan satu kali oleh berikut agar bisa dipakai
dalam request curl lokal. Di database, token disimpan dalam bentuk hash dan tidak pernah ditulis ke
log API.

```bash
npm run dev:issue-token -- --donor-external-id <external-id>
curl -H "Authorization: Bearer <RAW_TOKEN>" http://localhost:3000/api/v1/me/aquarium
```

## Test dan verifikasi

Test dan verifikasi dapat dijalankan dengan:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:api
npm run test:e2e
npm run test:smoke
```

`test:integration` hanya menggunakan `TEST_DATABASE_URL`. Jika variabel tersebut belum diisi, tes
akan dilewati dengan pesan yang jelas. Arahkan variabel itu ke database lokal atau database Supabase
khusus pengujian yang sudah dimigrasikan; nilainya tidak akan pernah mengambil cadangan dari
`DATABASE_URL`. `test:e2e` running Mock API dan Game API secara in-process dengan penyimpanan
memory, sehingga tidak membutuhkan Unity ataupun database. `test:smoke` memeriksa URL lokal atau
hosted yang sudah aktif:

```bash
$env:GAME_API_URL='http://localhost:3000'
$env:MOCK_API_URL='http://localhost:4000'
npm run test:smoke
```

Koleksi request Bruno berada di `tests/api/bruno/Tel-U-Endowment-Aquarium`. Atur variabel melalui
`tests/api/environments/local.bru` atau `hosted.bru`.

## Tabel database

Schema berisi tabel MVP yang sudah ditetapkan: `donors`, `aquariums`, `fish_tiers`, `fish_species`,
`webhook_events`, `donations`, `fish`, `access_tokens`, `game_events`, dan `player_inventory`.
Tabel `donors` juga menyimpan cache Endowment (`nik`, `total_donation`, `tier`, `last_synced_at`).
Warna ikan menerima kode bawaan atau HEX `#RRGGBB`. Poin awal inventory = `floor(total_donasi /
10.000)` dan tidak pernah berkurang saat sinkronisasi ulang. Pasangan tier dan spesies
untuk seed adalah Common/Guppy, Rare/Clownfish, Epic/Angelfish, dan Legendary/Golden Whale. Detail
constraint dan aturan bisnis tersedia di `docs/database.dbml` dan `MASTER_SPEC.md`.

## Batasan MVP

- Donasi pada Mock API disimpan di memory dan bukan bagian dari sistem pembayaran resmi.
- Akses pada MVP menggunakan pertukaran opaque token tanpa password. SSO dan akun pengguna lengkap
  belum termasuk dalam cakupan.
- Pemilihan ikan untuk Big Aquarium memakai data terbaru per donatur secara deterministik, bukan
  katalog acak berbobot.
- Cron tidak dibutuhkan karena tingkat lapar ikan dihitung saat datanya dibaca.
- Supabase Edge Functions dan aset Unity baru didokumentasikan, belum diimplementasikan di repo ini.
