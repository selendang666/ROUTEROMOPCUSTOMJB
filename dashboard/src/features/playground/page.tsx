import { useQuery } from "@tanstack/react-query";
import { Bot, CircleStop, Play, RefreshCw, Send, Settings2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardHeader } from "../../components/ui/card";
import { Input, Label, Textarea } from "../../components/ui/input";
import { StatePanel } from "../../components/ui/state";
import { apiGet, apiPost, apiRaw } from "../../lib/api";
import { getErrorMessage } from "../../lib/helpers.js";
import { qk } from "../../lib/query-keys";

interface CatalogModel {
  id: string;
  provider: string;
  displayName: string;
  status: "active" | "inactive";
  reason: string | null;
  capabilities: Record<string, unknown> | null;
  routingHealth: { accountCount: number; healthyAccountCount: number };
}

interface CatalogResponse {
  items: readonly CatalogModel[];
}

interface RelaySecretState {
  configured: boolean;
  masked: string | null;
  deploymentGuidance: string;
}

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

function parseSseBlock(block: string): { name: string; data: Record<string, unknown> } | null {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return null;
  try {
    const value = JSON.parse(data.join("\n")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? { name, data: value as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

export function PlaygroundPage() {
  const [search, setSearch] = useState("");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [running, setRunning] = useState(false);
  const [relaySecret, setRelaySecret] = useState("");
  const [relaySaved, setRelaySaved] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const catalogQuery = useQuery({
    queryKey: qk.playground.catalog,
    queryFn: () => apiGet<CatalogResponse>("/playground/catalog"),
  });
  const relayQuery = useQuery({
    queryKey: qk.playground.relaySecret,
    queryFn: () => apiGet<RelaySecretState>("/playground/relay-secret"),
  });
  const models = catalogQuery.data?.items ?? [];
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query.length === 0 ? models : models.filter((item) => `${item.id} ${item.displayName} ${item.provider}`.toLowerCase().includes(query));
  }, [models, search]);
  const selected = models.find((item) => item.id === model);

  const stop = (): void => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setRunning(false);
  };

  const submit = async (): Promise<void> => {
    if (running || !model || prompt.trim().length === 0 || selected?.status !== "active") return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setOutput("");
    setError(null);
    setUsage(null);
    try {
      const response = await apiRaw("/playground/stream", {
        method: "POST",
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], maxTokens: 1024, reasoningEffort: "low", stream: true }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Playground request failed (${response.status})`);
      if (response.body === null) throw new Error("Playground response had no stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = await reader.read();
        pending += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
        const blocks = pending.split("\n\n");
        pending = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = parseSseBlock(block);
          if (event === null) continue;
          if (event.name === "text" && typeof event.data.text === "string") setOutput((value) => value + event.data.text);
          if (event.name === "reasoning" && typeof event.data.text === "string") setOutput((value) => `${value}${event.data.text}`);
          if (event.name === "usage") setUsage(event.data as Usage);
          if (event.name === "error" && typeof event.data.message === "string") setError(event.data.message);
        }
        if (chunk.done) break;
      }
    } catch (value) {
      if (!controller.signal.aborted) setError(getErrorMessage(value, "Playground request failed"));
    } finally {
      controllerRef.current = null;
      setRunning(false);
    }
  };

  const saveRelaySecret = async (): Promise<void> => {
    if (relaySecret.trim().length === 0) return;
    try {
      await apiPost("/playground/relay-secret", { secret: relaySecret });
      setRelaySecret("");
      setRelaySaved(true);
      await relayQuery.refetch();
    } catch (value) {
      setError(getErrorMessage(value, "Unable to save relay secret"));
    }
  };

  return (
    <div className="dashboard-page space-y-4">
      <Card density="comfortable" surface="elevated">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardHeader title="AI Playground" sub="Run a real request through the configured Oh My Omop - Router route." icon={Bot} />
          <Button variant="secondary" onClick={() => void catalogQuery.refetch()} disabled={catalogQuery.isFetching}>
            <RefreshCw size={14} className={catalogQuery.isFetching ? "animate-spin" : ""} /> Refresh catalog
          </Button>
        </div>
      </Card>

      {catalogQuery.isError ? <StatePanel kind="error" title="Catalog unavailable" description={getErrorMessage(catalogQuery.error, "The playground catalog could not be loaded.")} icon={Bot} /> : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <Card density="comfortable" surface="elevated">
          <CardHeader title="Request" sub="Disabled models remain visible for diagnostics but cannot be submitted." icon={Send} />
          <div className="space-y-3">
            <div>
              <Label htmlFor="playground-model-search">Find a model</Label>
              <Input id="playground-model-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search provider or model" />
            </div>
            <div>
              <Label htmlFor="playground-model">Model</Label>
              <select id="playground-model" value={model} onChange={(event) => setModel(event.target.value)} className="h-10 w-full rounded-xl border border-[var(--inner-border)] bg-[var(--input-bg)] px-3 text-sm text-[var(--text-1)] outline-none">
                <option value="">Select a model</option>
                {filteredModels.map((item) => <option key={item.id} value={item.id} disabled={item.status === "inactive"}>{item.id} · {item.status === "active" ? "active" : "inactive"}</option>)}
              </select>
            </div>
            {selected !== undefined ? <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone={selected.status === "active" ? "ok" : "default"}>{selected.status}</Badge><span className="text-[var(--text-2)]">{selected.displayName}</span>{selected.reason !== null ? <span className="text-[var(--text-3)]">{selected.reason}</span> : null}<span className="text-[var(--text-3)]">{selected.routingHealth.healthyAccountCount}/{selected.routingHealth.accountCount} healthy accounts</span></div> : null}
            <div>
              <Label htmlFor="playground-prompt">Prompt</Label>
              <Textarea id="playground-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-48" placeholder="Ask the selected model something…" />
            </div>
            {running ? <Button variant="secondary" onClick={stop}><CircleStop size={14} /> Stop</Button> : <Button onClick={() => void submit()} disabled={!model || prompt.trim().length === 0 || selected?.status !== "active"}><Play size={14} /> Submit</Button>}
          </div>
        </Card>

        <Card density="comfortable" surface="elevated">
          <CardHeader title="Response" sub={running ? "Streaming through the live proxy path…" : "Output appears here as it arrives."} icon={Bot} />
          <div className="min-h-48 whitespace-pre-wrap rounded-xl border border-[var(--inner-border)] bg-[var(--hover)] p-3 text-sm leading-6 text-[var(--text-1)]">{output.length > 0 ? output : <span className="text-[var(--text-3)]">No output yet.</span>}</div>
          {usage !== null ? <div className="mt-3 flex flex-wrap gap-3 text-xs text-[var(--text-3)]"><span>Prompt {usage.promptTokens ?? "—"}</span><span>Completion {usage.completionTokens ?? "—"}</span><span>Total {usage.totalTokens ?? "—"}</span></div> : null}
          {error !== null ? <p role="alert" className="mt-3 text-sm text-[var(--status-danger)]">{error}</p> : null}
        </Card>
      </div>

      <Card density="comfortable" surface="elevated">
        <CardHeader title="Vercel relay secret" sub="Store the relay authentication secret encrypted on the server." icon={Settings2} />
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
          <div>
            <Label htmlFor="relay-secret">Relay secret</Label>
            <Input id="relay-secret" type="password" autoComplete="new-password" value={relaySecret} onChange={(event) => { setRelaySecret(event.target.value); setRelaySaved(false); }} placeholder={relayQuery.data?.configured === true ? `Configured ${relayQuery.data.masked ?? "••••"}` : "Enter relay secret"} />
            <p className="mt-1 text-[11px] text-[var(--text-3)]">{relayQuery.data?.deploymentGuidance ?? "Vercel platform access tokens are deployment-only and cannot be entered in the browser."}</p>
            {relaySaved ? <p className="mt-1 text-[11px] text-[var(--status-success)]">Relay secret saved.</p> : null}
          </div>
          <Button onClick={() => void saveRelaySecret()} disabled={relaySecret.trim().length === 0}>Save secret</Button>
        </div>
      </Card>
    </div>
  );
}
