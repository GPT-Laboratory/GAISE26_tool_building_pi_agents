/**
 * Activity log extension.
 *
 * Appends one line per tool call and result to .activity.log so the
 * read-only "Activity" pane (watching that file) shows what pi is doing
 * without mixing into the chat view.
 *
 * Auto-discovered from .pi/extensions/ in the working directory.
 */
import type {
  EditToolDetails,
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const logPath = `${process.cwd()}/.activity.log`;

  function log(line: string): void {
    const ts = new Date().toISOString().substring(11, 19); // HH:MM:SS
    try {
      appendFileSync(logPath, `[${ts}] ${line}\n`);
    } catch {
      // best-effort; ignore ENOSPC / permission errors
    }
  }

  // ── tool_call: log what pi is about to do ──────────────────────────────────
  pi.on("tool_call", async (event: ToolCallEvent, _ctx) => {
    const inp = event.input as Record<string, unknown>;
    let summary: string;

    switch (event.toolName) {
      case "bash":
        summary = `$ ${String(inp.command ?? "").replace(/\s+/g, " ").slice(0, 120)}`;
        break;
      case "read":
      case "write":
      case "edit":
        summary = `${event.toolName} ${inp.path}`;
        break;
      case "grep":
        summary = `grep "${inp.pattern}"${inp.path ? ` in ${inp.path}` : ""}`;
        break;
      case "find":
        summary = `find ${inp.pattern ?? inp.path ?? ""}`;
        break;
      case "ls":
        summary = `ls ${inp.path ?? "."}`;
        break;
      default:
        summary = event.toolName;
    }

    log(`→ ${summary}`);
    return undefined; // don't block
  });

  // ── tool_result: log outcome + output ─────────────────────────────────────
  pi.on("tool_result", async (event: ToolResultEvent, _ctx) => {
    const rawText = event.content[0]?.type === "text" ? event.content[0].text : "";

    if (event.isError) {
      log(`  ✗ ${event.toolName}`);
      logBlock(rawText, 40);
      return;
    }

    switch (event.toolName) {
      case "bash": {
        // Output ends with "\nexit code: N" — strip that suffix before displaying
        const exitMatch = rawText.match(/\nexit code: (\d+)\s*$/);
        const exitCode = exitMatch ? exitMatch[1] : "0";
        const output = exitMatch ? rawText.slice(0, exitMatch.index) : rawText;
        log(`  ✓ bash exit=${exitCode}`);
        logBlock(output, 60);
        break;
      }
      case "edit": {
        const details = event.details as EditToolDetails | undefined;
        if (details?.diff) {
          const d = details.diff.split("\n");
          const add = d.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
          const del = d.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
          log(`  ✓ edit +${add}/-${del} lines`);
          logBlock(details.diff, 40);
        } else {
          log(`  ✓ edit done`);
        }
        break;
      }
      case "read": {
        const lines = rawText.split("\n");
        log(`  ✓ read (${lines.length} lines)`);
        logBlock(rawText, 20);
        break;
      }
      case "write": {
        const lines = rawText.split("\n");
        log(`  ✓ write (${lines.length} lines)`);
        break;
      }
      default: {
        const lines = rawText ? rawText.split("\n").length : 0;
        log(`  ✓ ${event.toolName}${lines > 1 ? ` (${lines} lines)` : ""}`);
        logBlock(rawText, 30);
      }
    }
  });

  /** Append up to maxLines of text, indented, then a separator. */
  function logBlock(text: string, maxLines: number): void {
    if (!text.trim()) return;
    const lines = text.split("\n");
    const shown = lines.slice(0, maxLines);
    for (const line of shown) {
      try { appendFileSync(logPath, `    ${line}\n`); } catch {}
    }
    if (lines.length > maxLines) {
      try { appendFileSync(logPath, `    ... (${lines.length - maxLines} more lines)\n`); } catch {}
    }
    try { appendFileSync(logPath, `\n`); } catch {}
  }
}
