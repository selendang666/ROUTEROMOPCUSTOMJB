import type { NetworkSelection, ProviderOutput } from "../types/request.js";
import type { PayloadCapture } from "../types/telemetry.js";
import type { StreamMapper, StreamEvent } from "../types/stream.js";
import { AbortCoordinator, type AbortCoordinatorOptions } from "../transport/abort.js";
import { UpstreamError, parseUpstreamFailure } from "../transport/errors.js";
import { assertUpstreamContentType, executeFetch, readJsonObject } from "../transport/fetch.js";
import { mapSseStream, STREAM_BOUNDS } from "../transport/sse.js";

export interface DispatchWithCoordinatorOptions {
  readonly url: string;
  readonly method?: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
  readonly timeouts: AbortCoordinatorOptions;
  readonly network?: NetworkSelection | null;
  readonly capture?: PayloadCapture;
  readonly stream: boolean;
  readonly mapStream: StreamMapper;
  readonly mapNonStream?: (body: Record<string, unknown>, headers: Headers) => ProviderOutput;
  readonly parseFailure?: (response: Response) => Promise<never>;
  readonly retryOnFailure?: (response: Response, coordinator: AbortCoordinator) => Promise<Response | null>;
  readonly streamConfig?: { maxLineBytes: number; idleTimeoutMs?: number };
  readonly mapStreamOutput?: (events: AsyncIterable<StreamEvent>, headers: Headers) => ProviderOutput;
}

/**
 * Shared upstream dispatch with AbortCoordinator lifetime management.
 * Handles executeFetch, optional compatibility retry, content-type guard,
 * bounded JSON parsing, and SSE stream handoff (transferring coordinator
 * ownership to the stream when streaming).
 */
export async function dispatchWithCoordinator(options: DispatchWithCoordinatorOptions): Promise<ProviderOutput> {
  const {
    url,
    method = "POST",
    headers,
    body,
    signal,
    timeouts,
    network,
    capture,
    stream,
    mapStream,
    mapNonStream,
    parseFailure,
    retryOnFailure,
    streamConfig,
    mapStreamOutput,
  } = options;

  const coordinator = new AbortCoordinator(signal, timeouts);
  let streamHandedOff = false;
  try {
    let response = await executeFetch(url, { method, headers, body }, coordinator, network, capture);

    if (!response.ok && retryOnFailure) {
      const retried = await retryOnFailure(response, coordinator);
      if (retried !== null) response = retried;
    }

    if (!response.ok) {
      if (parseFailure) throw await parseFailure(response);
      throw await parseUpstreamFailure(response);
    }

    await assertUpstreamContentType(response, stream ? "sse" : "json", coordinator, capture);

    if (!stream) {
      const jsonBody = await readJsonObject(response, coordinator);
      if (mapNonStream) return mapNonStream(jsonBody, response.headers);
      return { mode: "non_stream", body: jsonBody };
    }

    if (!response.body) {
      throw new UpstreamError({
        kind: "provider_protocol_error",
        message: "Upstream returned an empty stream body",
        routeScope: "provider",
      });
    }

    const maxLineBytes = streamConfig?.maxLineBytes ?? STREAM_BOUNDS.lineBytes;
    const idleTimeoutMs = streamConfig?.idleTimeoutMs ?? timeouts.idleTimeoutMs;
    streamHandedOff = true;
    const events = mapSseStream(
      { body: response.body, coordinator, maxLineBytes, idleTimeoutMs },
      mapStream,
    );
    if (mapStreamOutput) return mapStreamOutput(events, response.headers);
    return { mode: "stream", events };
  } finally {
    if (!streamHandedOff) coordinator.dispose();
  }
}
