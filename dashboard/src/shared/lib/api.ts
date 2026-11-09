/** Shared API shim — re-export canonical lib/api for backward compat. */
export { ApiError, api, apiDelete, apiDownload, apiGet, apiPatch, apiPost, apiPostForm, apiRaw, setUnauthorizedHandler } from "../../lib/api";
export type { ApiErrorShape } from "../../lib/api";
