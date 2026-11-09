# Redesign — Request Detail & Requests Table (TFFB → TFFT Only)

## 1. Snapshot dari screenshot kamu

**Request Detail drawer** (`b2b91e54` via `/console/api/probe`, surface `probe`, model `mimo-v2.5-free`):
- TFFB `—`, TFFT `—` (kondisi di `page-orig.tsx:186` & `use-usage-snapshot.ts:94-95` — keduanya `null`)
- Overhead `—`, Tokens `—` (null)
- Payload meta `messages:0 images:0 tools:0` — probe tidak kirim messages via telemetry (cuma single prompt)

**Requests table** (10 visible):
- Kolom `TFFB` selalu `—`, `TFFT` `—` untuk semua `mimo-v2.5-free` json mode
- Kolom lain `In/Out/Total` `—` (null) → bukan bug UI, memang `usage` null untuk probe

---

## 2. Scan — file terkait (ground)

### Dashboard (render)
- `dashboard/src/features/usage/page-orig.tsx:185-186` — detail drawer: `tfftMs != null ? `${tfftMs}ms` : "—"` dan `tffbMs != null ? ... : "—"` (2 kolom)
- `page-orig.tsx:465-488` — table header `TFFB` + `TFFT` + sort `tfftSort`, body `row.tffbMs` / `row.tfftMs` (dua kolom, TFFT sortable)
- `page-orig.tsx:402-416` — `tfftSort` state + `sortedRequestItems` (sort by `tfftMs ?? -1`)
- `hooks/use-usage-snapshot.ts:94-95` — `RequestRow { tfftMs: number|null, tffbMs: number|null, overhead, durationMs }`
- `hooks/use-usage-snapshot.ts:146` — fetch `/usage/*` → `RequestRow[]`
- `src/console/services/observability.ts:126,289,344` — map `row.tffbMs ?? null` → `RequestRow`

### Telemetry (produksi angka)
- `src/bootstrap/proxy-port.ts:112-121` — `startedAt = Date.now()`, `firstByteAt=null`, `firstTokenAt=null`, `recordFirstByte()`, `recordFirstToken()`, `finish()` hitung `tffbMs = firstByteAt - startedAt`, `tfftMs = firstTokenAt - startedAt`
- `src/proxy/request/execute.ts:308-314` — `if (!firstByteRecorded) recordFirstByte()` on first SSE event (any), `if (!firstTokenRecorded && event.type==="text_delta") recordFirstToken()` (hanya text)
- `execute.ts:405` — non-stream fallback `recordFirstByte()` di `finish` (jadi TFFB ada, TFFT tetap null jika bukan text)
- `src/persistence/telemetry/store/*` — `tffb_ms` / `tfft_ms` integer nullable (sqlite `schema.ts:21-22`, pg `pg.ts:410-411`, `017_add_tffb_ms.sql`)

### Kenapa TFFT `—` untuk probe `mimo-v2.5-free` json mode
- Probe via `/console/api/probe` pakai `mode: json` (lihat `providers/detail.tsx:250` test toast, bukan stream text). Stream `text_delta` tidak pernah fire → `firstTokenAt` tetap `null` → `tfftMs=null`.
- Non-stream path di `execute.ts:405` cuma `recordFirstByte`, tidak `recordFirstToken`, jadi TFFT tetap `—` walau duration 4.5s ada.
- `durationMs` ada (4.5s) karena `Date.now() - startedAt` di `finish`, tapi `tffbMs/tfftMs` null.

### Payload meta 0
- `RequestRow.messageCount/toolCount/imageCount` berasal dari `telemetry.enqueue({ messageCount, toolCount, imageCount: null })` di `proxy-port.ts:123` — probe tidak isi, jadi 0. Bukan bug render.

---

## 3. Usulan redesign (yang kamu minta)

**Hapus TFFB, sisain TFFT doang + fix kalkulasi biar ga `—`**

### A. Table — `Requests` (page-orig.tsx)
- Hapus header `TFFB` (`page-orig.tsx:466`) dan cell `row.tffbMs` (`488`)
- Sisain `TFFT` doang, rename jadi `Latency` atau tetap `TFFT (First Token)` biar jelas
- Kolom jadi: `Time | Key | Model | Mode | Status | In | Out | Total | TFFT | Overhead | Dur` (11 → 10 col, `colSpan` update 12→11)
- Sort `tfftSort` tetap, tapi fallback: jika `tfftMs==null` pakai `durationMs` atau `tffbMs` sebagai fallback biar sortable tetap meaningful (jangan `?? -1` yang bikin null di atas)

### B. Request Detail drawer (page-orig.tsx:185-190)
- Hapus block `Time to First Byte (TFFB)` seluruhnya
- TFFT jangan conditional `data.tfftMs != null && (...)` — selalu render, dengan fallback: `tfftMs ?? tffbMs ?? durationMs` + label `ms` atau `—` jika semua null + hint `*` kalau fallback
- Tambah `Duration` sebagai primary latency di atas TFFT (udah ada `Duration` di grid, tinggal posisikan TFFT di bawahnya biar hierarchy jelas)
- Overhead tetap di bawah TFFT

### C. Fix kalkulasi (biar TFFT kedetek)
- `src/proxy/request/execute.ts:312` — bukan cuma `event.type==="text_delta"` tapi `event.type==="text_delta" || event.type==="reasoning_delta" || event.type==="tool_call_delta"` atau lebih generik `isContentDelta(event)` — atau fallback: di `finish()`, jika `firstTokenAt==null && firstByteAt!=null` set `firstTokenAt = firstByteAt` (TFFT = TFFB jika tidak ada text token, misal json mode)
- `src/bootstrap/proxy-port.ts:118-121` — `recordFirstToken` fallback di `finish`: `if (firstTokenAt===null && firstByteAt!==null) firstTokenAt = firstByteAt` sebelum hitung `tfftMs`
- Non-stream: di `execute.ts:405` panggil `recordFirstToken()` juga (bukan cuma `recordFirstByte`) kalau `mode==="non_stream"`
- Buang `tffb_ms` dari DB? Tidak perlu hapus kolom (biar backward compat), cukup stop isi & stop tampil. Kolom tetap nullable, query tetap jalan.

### D. File yang akan disentuh (kalau approve)
- `dashboard/src/features/usage/page-orig.tsx` — hapus TFFB header/cell, ubah `colSpan`, ubah detail drawer TFFB block, ubah fallback logic
- `dashboard/src/features/usage/hooks/use-usage-snapshot.ts` — bikin `tffbMs` optional/deprecated tapi keep type (biar API tetap kompat)
- `src/proxy/request/execute.ts` — fix `recordFirstToken` trigger
- `src/bootstrap/proxy-port.ts` — fallback TFFT = TFFB di `finish()`
- (opsional) `src/persistence/telemetry/store/sqlite/writer.ts` & `d1/writer.ts` — tetap tulis `tffbMs` tapi tidak dipakai UI

### E. Hasil yang diharapkan (verify)
- Probe `mimo-v2.5-free` json 4.5s → TFFT `~120ms` (atau `~4500ms` jika fallback ke duration) bukan `—`
- Table `TFFT` terisi untuk semua row, sortable, `TFFB` kolom hilang
- Detail drawer: `Endpoint/Surface/Provider/Model` grid tetap, `TFFT` selalu visible di bawah `Duration`, `Overhead` di bawahnya
- Playwright: buka `/console/usage` → Requests table 10 cols, sort TFFT, klik row → drawer TFFT terisi

---

## 4. Pertanyaan sebelum eksekusi
- Mau `TFFT` fallback ke `TFFB` atau ke `Duration` kalau text token gak ada? (rekomendasi: fallback ke `TFFB` dulu, baru `Duration` — biar tetap measure latency, bukan total)
- Nama kolom mau tetap `TFFT` atau ganti jadi `Latency` / `First Token` biar awam paham?
- `tffb_ms` di DB mau dibiarin nullable atau drop kolom di migrasi 021? (rekomendasi: biarin aja, cuma UI yang sembunyi)

Bilang mau yang mana, aku langsung gas code-nya beb — scan udah komplit, tinggal eksekusi 💕
