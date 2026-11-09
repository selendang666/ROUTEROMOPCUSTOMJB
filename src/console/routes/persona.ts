import type { Elysia } from "elysia";
import { errorResponse, jsonResponse } from "../../api/errors.js";
import { toResponse } from "../../api/guard.js";
import type { ConsoleDependencies } from "../api.js";
import { getMonitorStatus } from "../../runtime/monitor.js";
import { MAX_PACK_BYTES } from "../../persona/package.js";

type PersonaPort = {
  get(): Promise<unknown>;
  patch(body: unknown): Promise<{ ok: boolean; status: number; message?: string; data?: unknown }>;
  upload(bytes: Uint8Array, filename: string): Promise<{ ok: boolean; status: number; message?: string; data?: unknown }>;
  syncHermes(): Promise<{ ok: boolean; status: number; message?: string; data?: unknown }>;
};

function personaService(deps: ConsoleDependencies): PersonaPort | undefined {
  const maybe = (deps.services as unknown as { persona?: PersonaPort }).persona;
  return maybe;
}

/** Extracts raw bytes + filename from an Elysia multipart body (defensive). */
async function readUploadFile(body: unknown): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const record = body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
  const file = record?.file ?? record?.pack ?? record?.upload;
  if (file === null || file === undefined) return null;
  if (typeof file === "string") return null;
  if (typeof (file as Blob).arrayBuffer !== "function") return null;
  const blob = file as Blob & { name?: unknown };
  const buffer = await blob.arrayBuffer();
  const filename = typeof blob.name === "string" && blob.name.length > 0 ? blob.name : "persona.zip";
  return { bytes: new Uint8Array(buffer), filename };
}

/** Registers persona pack management, Hermes sync and VPS monitor endpoints. */
export function registerPersonaRoutes(app: Elysia, deps: ConsoleDependencies): void {
  const get = (app as unknown as { get: (path: string, handler: (ctx: unknown) => unknown) => unknown }).get.bind(app);
  const patch = (app as unknown as { patch: (path: string, handler: (ctx: unknown) => unknown) => unknown }).patch.bind(app);
  const post = (app as unknown as { post: (path: string, handler: (ctx: unknown) => unknown) => unknown }).post.bind(app);

  get("/console/api/persona", async () => {
    const persona = personaService(deps);
    if (persona === undefined) return errorResponse(501, "capability_unsupported", "Persona service is unavailable");
    return jsonResponse(await persona.get());
  });

  patch("/console/api/persona", async ({ body }: any /* Elysia ctx */) => {
    const persona = personaService(deps);
    if (persona === undefined) return errorResponse(501, "capability_unsupported", "Persona service is unavailable");
    return toResponse(await persona.patch(body));
  });

  post("/console/api/persona/upload", async ({ body }: any /* Elysia ctx */) => {
    const persona = personaService(deps);
    if (persona === undefined) return errorResponse(501, "capability_unsupported", "Persona service is unavailable");
    const upload = await readUploadFile(body);
    if (upload === null) return errorResponse(400, "invalid_request", "Upload a .zip file as multipart field \"file\"");
    if (upload.bytes.length > MAX_PACK_BYTES + 1024 * 1024) {
      return errorResponse(413, "invalid_request", "Zip exceeds the 100 MB pack limit");
    }
    return toResponse(await persona.upload(upload.bytes, upload.filename));
  });

  post("/console/api/persona/sync-hermes", async () => {
    const persona = personaService(deps);
    if (persona === undefined) return errorResponse(501, "capability_unsupported", "Persona service is unavailable");
    return toResponse(await persona.syncHermes());
  });

  get("/console/api/system/monitor", async () => jsonResponse(getMonitorStatus()));
}
