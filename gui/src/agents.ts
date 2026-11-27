// How each agent app registers a local (stdio) MCP server: `<bin> mcp` with HEALTH_TOKEN set. Formats come from
// each vendor's docs (checked Nov 2026; see docs/decisions.md). Apps marked `oneClick` can be written by the shell
// (gui/src-tauri/src/clients.rs); for the rest the UI shows a command or a snippet to paste.

import { t as tr } from "./i18n";

export type Step = { text: string; code?: string };
export type Client = { id: string; name: string; oneClick?: boolean; steps: (bin: string, token: string) => Step[] };

const win = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

/** Quotes one shell argument: POSIX sh, or PowerShell on Windows. */
export function shq(s: string): string {
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return win ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

const entry = (bin: string, token: string, typed = false) => ({
  ...(typed ? { type: "stdio" } : {}),
  command: bin,
  args: ["mcp"],
  env: { HEALTH_TOKEN: token },
});
const json = (v: unknown) => JSON.stringify(v, null, 2);
const servers = (bin: string, token: string, typed = false) => json({ mcpServers: { health: entry(bin, token, typed) } });
// TOML and YAML double-quoted strings take JSON's escapes
const q = (s: string) => JSON.stringify(s);

export const CLIENTS: Client[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    oneClick: true,
    steps: (b, t) => [
      { text: tr("In Claude, open Settings → Developer → Edit Config, and add this to claude_desktop_config.json:"), code: servers(b, t) },
      { text: tr("Quit Claude completely and open it again.") },
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    steps: (b, t) => [
      { text: tr("Run in a terminal:"), code: `claude mcp add --env HEALTH_TOKEN=${t} --transport stdio --scope user health -- ${shq(b)} mcp` },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    steps: (b, t) => [
      { text: tr("Run in a terminal:"), code: `codex mcp add health --env HEALTH_TOKEN=${t} -- ${shq(b)} mcp` },
      { text: tr("Or add to ~/.codex/config.toml:"), code: `[mcp_servers.health]\ncommand = ${q(b)}\nargs = ["mcp"]\n\n[mcp_servers.health.env]\nHEALTH_TOKEN = ${q(t)}` },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    oneClick: true,
    steps: (b, t) => [{ text: tr("Add to ~/.cursor/mcp.json:"), code: servers(b, t, true) }],
  },
  {
    id: "copilot",
    name: "VS Code (GitHub Copilot)",
    oneClick: true,
    // PowerShell mangles the double quotes inside a native command's argument: Windows gets the file only
    steps: (b, t) => [
      ...(win ? [] : [{ text: tr("Run in a terminal:"), code: `code --add-mcp ${shq(JSON.stringify({ name: "health", ...entry(b, t, true) }))}` }]),
      { text: win ? tr("Add to ~/.copilot/mcp-config.json (shared with Copilot CLI):") : tr("Or add to ~/.copilot/mcp-config.json (shared with Copilot CLI):"), code: servers(b, t, true) },
    ],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    oneClick: true,
    steps: (b, t) => [
      { text: tr("Run in a terminal:"), code: `gemini mcp add --scope user --env HEALTH_TOKEN=${t} health ${shq(b)} mcp` },
      { text: tr("Or add to ~/.gemini/settings.json:"), code: servers(b, t) },
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf / Devin",
    steps: (b, t) => [{ text: tr("Open the MCP settings, choose to edit the raw config (mcp_config.json), and add:"), code: servers(b, t) }],
  },
  {
    id: "zed",
    name: "Zed",
    steps: (b, t) => [{ text: tr("Run “zed: open settings file” and add:"), code: json({ context_servers: { health: entry(b, t) } }) }],
  },
  {
    id: "cline",
    name: "Cline",
    steps: (b, t) => [{ text: tr("In Cline, open MCP Servers → Configure MCP Servers, and add to cline_mcp_settings.json:"), code: servers(b, t) }],
  },
  {
    id: "continue",
    name: "Continue",
    steps: (b, t) => [
      {
        text: tr("Save as .continue/mcpServers/health.yaml (MCP works in agent mode):"),
        code: `name: Health\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: Health\n    command: ${q(b)}\n    args:\n      - mcp\n    env:\n      HEALTH_TOKEN: ${q(t)}`,
      },
    ],
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    steps: (b, t) => [{ text: tr("In the Program tab, choose Install → Edit mcp.json, and add:"), code: servers(b, t) }],
  },
  {
    id: "opencode",
    name: "OpenCode",
    steps: (b, t) => [{ text: tr("Run in a terminal:"), code: `opencode mcp add health --env HEALTH_TOKEN=${t} -- ${shq(b)} mcp` }],
  },
  {
    id: "kiro",
    name: "Kiro",
    oneClick: true,
    steps: (b, t) => [{ text: tr("Run “Kiro: Open user MCP config (JSON)” and add:"), code: servers(b, t) }],
  },
  {
    id: "other",
    name: tr("Another MCP app"),
    steps: (b, t) => [
      { text: tr("Add a local (stdio) MCP server with these settings. Command:"), code: b },
      { text: tr("Arguments:"), code: "mcp" },
      { text: tr("Environment variable HEALTH_TOKEN:"), code: t },
    ],
  },
];
