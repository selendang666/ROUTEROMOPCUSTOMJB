/**
 * Injector dispatch map — aggregates all ToolInjector implementations.
 * Not a barrel re-export; defines the single dispatch point for CliToolService.
 *
 * The injector map is the single dispatch point for CliToolService:
 * given a toolId, look up the injector and call getStatus/apply/reset/download.
 */

import type { ToolInjector } from "../types.js";
import type { ToolId } from "../registry.js";

import { claudeInjector } from "./claude.js";
import { codexInjector } from "./codex.js";
import { clineInjector } from "./cline.js";
import { opencodeInjector } from "./opencode.js";
import { droidInjector } from "./droid.js";
import { hermesInjector } from "./hermes.js";
import { copilotInjector } from "./copilot.js";
import { deepseekTuiInjector } from "./deepseek-tui.js";
import { jcodeInjector } from "./jcode.js";
import { kiloInjector } from "./kilo.js";
import { openclawInjector } from "./openclaw.js";
import { coworkInjector } from "./cowork.js";
import { cursorInjector, rooInjector, continueInjector, ampInjector, qwenInjector } from "./guide.js";

export const INJECTORS: Record<ToolId, ToolInjector> = {
  claude: claudeInjector,
  codex: codexInjector,
  cline: clineInjector,
  opencode: opencodeInjector,
  droid: droidInjector,
  hermes: hermesInjector,
  copilot: copilotInjector,
  "deepseek-tui": deepseekTuiInjector,
  jcode: jcodeInjector,
  kilo: kiloInjector,
  openclaw: openclawInjector,
  cowork: coworkInjector,
  cursor: cursorInjector,
  roo: rooInjector,
  continue: continueInjector,
  amp: ampInjector,
  qwen: qwenInjector,
};
