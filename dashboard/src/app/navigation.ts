import { Bot, Boxes, Cable, ChartSpline, Coins, Filter, Gauge, LayoutDashboard, Layers, Server, Settings, SlidersHorizontal, Sparkles, Terminal, TerminalSquare, Users } from "lucide-react";

export interface NavEntry {
  to: string;
  label: string;
  icon: typeof Boxes;
  badge?: string;
  /** When set, clicking this entry switches the sidebar page instead of navigating. */
  switchTo?: 0 | 1;
}

export const NAV_GROUPS: { label: string; items: NavEntry[] }[] = [
  {
    label: "Main",
    items: [
      { to: "/overview", label: "Overview", icon: LayoutDashboard },
      { to: "/usage", label: "Usage", icon: ChartSpline },
      { to: "/providers", label: "Providers", icon: Cable },
    ],
  },
  {
    label: "Control",
    items: [
      { to: "/buyers", label: "Buyers", icon: Users },
      { to: "/combos-routes", label: "Combos", icon: Layers },
      { to: "/quota", label: "Quota Management", icon: Gauge },
      { to: "/proxy-requests", label: "Proxy & Requests", icon: SlidersHorizontal },
    ],
  },
  {
    label: "Tools",
    items: [
      { to: "/customization", label: "Customization", icon: SlidersHorizontal },
      { to: "/filter-sanitize", label: "Filter Sanitize", icon: Filter },
      { to: "/token-saver", label: "Token Saver", icon: Coins },
      { to: "/cli-tools", label: "CLI Tools", icon: TerminalSquare },
      { to: "/persona-playground", label: "Persona Playground", icon: Bot },
      { to: "/playground", label: "AI Playground", icon: Sparkles },
      { to: "/coolify", label: "Coolify", icon: Server },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/console-log", label: "Console Log", icon: Terminal },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export const TITLES: Record<string, { title: string; sub: string; mobileSub: string }> = {
  "/overview": { title: "Overview", sub: "Traffic, endpoints, and fast shortcuts", mobileSub: "Traffic & shortcuts" },
  "/usage": { title: "Usage", sub: "Usage summary and request overview", mobileSub: "Request activity" },
  "/providers": { title: "Providers", sub: "All supported AI providers", mobileSub: "All AI providers" },
  "/combos-routes": { title: "Combos & Routes", sub: "Aliases, combos, and fusion routing", mobileSub: "Routing" },
  "/buyers": { title: "Buyers", sub: "Opencode buyer keys, licenses, and usage", mobileSub: "Buyer keys" },  "/combos": { title: "Combos & Routes", sub: "Aliases, combos, and fusion routing", mobileSub: "Routing" },
  "/quota": { title: "Quota Management", sub: "Provider account limits and reset windows", mobileSub: "Quota & resets" },
  "/proxy-requests": { title: "Proxy & Requests", sub: "Routing and request policy controls", mobileSub: "Proxy controls" },
  "/console-log": { title: "Console Log", sub: "Request and probe activity", mobileSub: "Request activity" },
  "/customization": { title: "Customization", sub: "Background, sidebar icon, and appearance controls", mobileSub: "Appearance" },
  "/filter-sanitize": { title: "Filter Sanitize", sub: "Reasoning tag stripping and response content filtering", mobileSub: "Filter" },
  "/token-saver": { title: "Token Saver", sub: "Reduce token usage with compact encoding and caching", mobileSub: "Tokens" },
  "/cli-tools": { title: "CLI Tools", sub: "Configure CLI tools for terminal access", mobileSub: "CLI config" },
  "/cli-tools/:toolId": { title: "CLI Tool", sub: "Tool configuration", mobileSub: "Tool config" },
  "/persona-playground": { title: "Persona Playground", sub: "Global persona, Hermes sync, and host monitoring", mobileSub: "Persona & monitor" },
  "/playground": { title: "AI Playground", sub: "Run a live request through configured routes", mobileSub: "Live AI requests" },
  "/coolify": { title: "Coolify", sub: "Instance monitoring and deployed projects", mobileSub: "Deployments" },
  "/settings": { title: "Settings", sub: "Security, backup, runtime toggles", mobileSub: "Security & runtime" },
};
