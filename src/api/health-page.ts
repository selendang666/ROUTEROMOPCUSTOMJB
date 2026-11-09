import healthArtwork from "./health-artwork.html" with { type: "text" };

const HEALTH_ENDPOINTS = `<div style="margin-top:16px">Endpoint:</div><pre style="margin:4px 0 0">OpenAI
  POST /v1/chat/completions
  POST /v1/responses

Anthropic
  POST /v1/messages

Catalog
  GET /v1/models</pre>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Renders the operator-facing liveness page with the embedded ASCII artwork.
 *
 * @param request Request used to derive the displayed public base URL.
 * @returns Complete HTML liveness document.
 */
export function renderHealthPage(request: Request): string {
  const url = new URL(request.url);
  const baseUrl = `${url.origin}/v1`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Oh My Omop - Router</title></head><body style="background:#000;color:#f4d7b8;font-family:monospace;margin:0;padding:24px"><main><h1>Oh My Omop - Router is serving</h1><div>==================================</div><div>Baseurl: ${escapeHtml(baseUrl)}</div>${HEALTH_ENDPOINTS}<div style="margin-top:16px">${healthArtwork}</div></main></body></html>`;
}
