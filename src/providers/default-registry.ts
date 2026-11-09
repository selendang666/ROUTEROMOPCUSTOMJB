import { AnthropicAdapter } from "./api-key/anthropic.js";
import { GeminiAdapter } from "./api-key/gemini.js";
import { OpenAIAdapter } from "./api-key/openai.js";
import { OpenrouterProvider } from "./api-key/openrouter.js";
import { GroqProvider } from "./api-key/groq.js";
import { AlibabaProvider } from "./api-key/alibaba.js";
import { FireworksProvider } from "./api-key/fireworks.js";
import { DeepseekProvider } from "./api-key/deepseek.js";
import { MistralProvider } from "./api-key/mistral.js";
import { SiliconflowProvider } from "./api-key/siliconflow.js";
import { CerebrasProvider } from "./api-key/cerebras.js";
import { NvidiaProvider } from "./api-key/nvidia.js";
import { XiaomipgProvider, XiaomitpProvider } from "./api-key/xiaomi.js";
import { CloudflareProvider } from "./api-key/cloudflare.js";
import { ClineProvider, ClinePassProvider } from "./api-key/cline.js";
import { OpenCodeFreeProvider, OpenCodeZenProvider, OpenCodeGoProvider } from "./api-key/opencode.js";
import { QoderProvider } from "./api-key/qoder.js";
import { CommandCodeProvider } from "./api-key/commandcode.js";
import { CodeBuddyProvider } from "./api-key/codebuddy.js";
import { CodeBuddyCnProvider } from "./api-key/codebuddy-cn.js";
import { AgentRouterProvider } from "./api-key/agentrouter.js";
import { ExaProvider } from "./web-search/exa.js";
import { DevinProvider } from "./web-search/devin.js";
import { PerplexityProvider } from "./web-search/perplexity.js";
import { ParallelProvider } from "./web-search/parallel.js";
import { OllamaProvider } from "./api-key/ollama.js";
import { BlackboxAIProvider } from "./api-key/blackboxai.js";
import { InferHubProvider } from "./api-key/inferhub.js";
import { GmiCloudProvider } from "./api-key/gmi-cloud.js";
import { ZaiProvider } from "./api-key/zai.js";
import { AlibabaCodingPlanProvider } from "./api-key/alibaba-coding-plan.js";
import { NousResearchProvider } from "./api-key/nous-research.js";
import { BaiProvider } from "./api-key/bai.js";
import { TokenharborProvider } from "./api-key/tokenharbor.js";
import { AihubmixProvider } from "./api-key/aihubmix.js";
import { GithubCopilotProvider } from "./oauth-provider/github-copilot.js";
import { ProviderRegistry, loadOptionalProvider } from "./registry.js";

/**
 * Composes the 35 provider adapters explicitly; each module owns its catalog entry.
 * P0 note: Keep eager registration for now — avoids dynamic-import churn during
 * bootstrap parallelization. Future low-memory improvement could lazy-load heavy
 * adapters (e.g., via dynamic import() on first use) but is out of scope for this
 * P0; sequential provider instantiation is cheap (~microseconds) compared to
 * persistence I/O. TODO: evaluate lazy ProviderRegistry when startup memory is
 * profiled under constrained containers.
 */
export async function createDefaultRegistry(): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();
  for (const adapter of [
    new OpenAIAdapter(),
    new AnthropicAdapter(),
    new GeminiAdapter(),
    new OpenrouterProvider(),
    new GroqProvider(),
    new AlibabaProvider(),
    new FireworksProvider(),
    new DeepseekProvider(),
    new MistralProvider(),
    new SiliconflowProvider(),
    new CerebrasProvider(),
    new NvidiaProvider(),
    new XiaomipgProvider(),
    new XiaomitpProvider(),
    new CloudflareProvider(),
    new ClineProvider(),
    new ClinePassProvider(),
    new OpenCodeFreeProvider(),
    new OpenCodeZenProvider(),
    new OpenCodeGoProvider(),
    new QoderProvider(),
    new CommandCodeProvider(),
    new CodeBuddyProvider(),
    new CodeBuddyCnProvider(),
    new AgentRouterProvider(),
    new ExaProvider(),
    new DevinProvider(),
    new PerplexityProvider(),
    new ParallelProvider(),
    new OllamaProvider(),
    new BlackboxAIProvider(),
    new InferHubProvider(),
    new GmiCloudProvider(),
    new ZaiProvider(),
    new ZaiProvider("zaicp"),
    new AlibabaCodingPlanProvider(),
    new NousResearchProvider(),
    new BaiProvider(),
    new TokenharborProvider(),
    new AihubmixProvider(),
    new GithubCopilotProvider(),
  ] as const) {
    registry.register(adapter);
  }
  for (const id of ["codex", "claude", "antigravity"] as const) await loadOptionalProvider(id, registry);
  for (const id of ["cursor", "devin"] as const) await loadOptionalProvider(id, registry);
  return registry;
}
