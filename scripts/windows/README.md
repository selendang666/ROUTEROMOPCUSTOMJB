# scripts/windows — Windows helper (PowerShell)

Semua script **Bun-aware** dan baca `PORT` dari `.env` (default 3000). Jalankan dari repo root.

| File | Bun shortcut | Apa |
|---|---|---|
| `setup.ps1` | `bun run setup:win` | Cek Bun + `.env`, `infra:up` (Docker→Laragon fallback), `db:migrate`, `doctor`. Sekali jalan biar langsung `dev:all`. |
| `migrate.ps1` | `bun run migrate:win` | Cuma `db:migrate` + `infra:status`. |
| `dev.ps1` | `bun run dev:win` | Start **backend + dashboard barengan** (log prefix `[backend]`/`[dashboard]`), Ctrl+C matikan keduanya. |
| `stop.ps1` | `bun run stop:win` | Kill `:PORT` & `:5173` + `infra:down`. Flag `-KeepInfra` buat cuma kill dev. |

**Cross-platform (Windows/Mac/Linux):**
- `bun run dev:all` → `scripts/dev-all.ts` (Bun.spawn, prefix log, Ctrl+C).
- `bun run setup` → `infra:up && db:migrate` (tanpa PowerShell).
- `bun run dev` → backend doang (`bun --watch src/main.ts`), `bun run dev:dashboard` → dashboard doang.

> PowerShell butuh `ExecutionPolicy Bypass` sekali: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` atau pakai `powershell -ExecutionPolicy Bypass -File ...` seperti di `package.json`.
