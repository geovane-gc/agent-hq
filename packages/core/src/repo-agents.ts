import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PermissionMode } from '@agent-hq/protocol';

// Repo agents ("the balcony crew") are the Claude Code subagents a project
// defines in `.claude/agents/*.md`. Each file is Markdown with a YAML
// frontmatter (name, description, tools, model, …); commands and skills are
// not agents and are ignored.

export interface RepoAgentDef {
  /** Passed to `claude --agent`: the frontmatter `name` (usually the file name without .md). */
  name: string;
  description: string;
  /** null: the field is absent, so the agent inherits every tool. */
  tools: string[] | null;
  disallowedTools: string[];
  /** null or 'inherit': the session's default model. */
  model: string | null;
  permissionMode: PermissionMode | null;
  readOnly: boolean;
  /** Path relative to the repository root. */
  file: string;
}

/** Tools that change files. */
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Shells: unrestricted they can change anything. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
/** Tools that start other agents, whose own tools we can't see. */
const DELEGATE_TOOLS = new Set(['Task', 'Agent']);
/** Shell commands a scoped `Bash(<command>…)` rule may allow and still count as read-only. */
const READ_ONLY_COMMANDS = [
  'git log', 'git diff', 'git show', 'git status', 'git blame', 'git grep', 'git branch', 'git rev-parse', 'git ls-files',
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'tree', 'pwd', 'echo', 'which', 'stat', 'file', 'du',
];
const PERMISSION_MODES: PermissionMode[] = ['manual', 'acceptEdits', 'auto', 'bypassPermissions', 'plan'];

/**
 * The rule for "works directly in the repository" versus "gets its own
 * worktree". An agent is read-only when its definition provably can't change
 * files:
 * - it lists `tools` explicitly (no list means it inherits every tool), and
 *   that list has no `*`, no Edit / MultiEdit / Write / NotebookEdit, no
 *   Task / Agent (delegates could edit), and no shell unless every shell rule
 *   is scoped to a read-only command such as `Bash(git log:*)`;
 * - or it has no `tools` list but `disallowedTools` removes all the editing
 *   tools, the shells and the delegates.
 * MCP tools are ignored. Everything else edits, so it runs in a worktree.
 */
export function isReadOnly(tools: string[] | null, disallowed: string[]): boolean {
  if (tools === null) {
    const banned = new Set(disallowed.map((t) => toolName(t)));
    return [...WRITE_TOOLS, ...SHELL_TOOLS, ...DELEGATE_TOOLS].every((t) => banned.has(t));
  }
  return tools.every((rule) => {
    if (rule === '*') return false;
    if (rule.startsWith('mcp__')) return true;
    const name = toolName(rule);
    if (WRITE_TOOLS.has(name) || DELEGATE_TOOLS.has(name)) return false;
    if (SHELL_TOOLS.has(name)) {
      const scope = rule.match(/^\w+\((.*)\)$/)?.[1]?.trim();
      if (!scope || scope === '*') return false;
      const command = scope.replace(/[:\s]*\*$/, '').trim();
      return READ_ONLY_COMMANDS.some((c) => command === c || command.startsWith(`${c} `));
    }
    return true;
  });
}

function toolName(rule: string): string {
  return rule.trim().replace(/\(.*$/, '');
}

// ---------------------------------------------------------------- frontmatter

type FrontValue = string | string[];

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function splitList(raw: string): string[] {
  // `Read, Grep, Bash(git log:*)`: commas inside parentheses belong to the rule.
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of raw) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote).map((s) => s.trim()).filter(Boolean);
}

/** A small YAML-frontmatter reader: scalars, quoted strings, block scalars and lists. Enough for agent files. */
export function parseFrontmatter(text: string): { data: Record<string, FrontValue>; body: string } {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const data: Record<string, FrontValue> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    // Indented lines that follow belong to this key.
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
      if (lines[i + 1].trim() === '' && !/^[|>]/.test(rest)) {
        // A blank line only continues block scalars.
        if (!(i + 2 < lines.length && /^\s+\S/.test(lines[i + 2]))) break;
      }
      more.push(lines[++i]);
    }
    if (/^[|>][+-]?$/.test(rest)) {
      const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
      const body = more.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = rest.startsWith('|') ? body.join('\n').trimEnd() : body.join(' ').replace(/\s+/g, ' ').trim();
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = splitList(rest.slice(1, -1));
    } else if (!rest && more.some((l) => /^\s*-\s/.test(l))) {
      data[key] = more.filter((l) => /^\s*-\s/.test(l)).map((l) => unquote(l.replace(/^\s*-\s*/, '')));
    } else {
      data[key] = unquote([rest, ...more.map((l) => l.trim())].filter(Boolean).join(' '));
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function asList(v: FrontValue | undefined): string[] | null {
  if (v === undefined) return null;
  const list = Array.isArray(v) ? v.flatMap((x) => splitList(x)) : splitList(v);
  return list;
}

export function parseAgentFile(text: string, file: string): RepoAgentDef | null {
  const { data } = parseFrontmatter(text);
  // Claude Code only registers files whose frontmatter has a name and a description.
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!/^[\w.-]+$/.test(name) || typeof data.description !== 'string' || !data.description.trim()) return null;
  const tools = asList(data.tools);
  const disallowedTools = asList(data.disallowedTools) ?? [];
  const model = typeof data.model === 'string' && data.model.trim() && data.model.trim() !== 'inherit' ? data.model.trim() : null;
  const mode = typeof data.permissionMode === 'string' ? data.permissionMode.trim() : '';
  return {
    name,
    description: data.description.trim(),
    tools,
    disallowedTools,
    model,
    permissionMode: mode === 'default' ? 'manual' : PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : null,
    readOnly: isReadOnly(tools, disallowedTools),
    file,
  };
}

/** Reads every agent definition under `<repo>/.claude/agents` (subfolders included). */
export function scanRepoAgents(repoPath: string): RepoAgentDef[] {
  const root = path.join(repoPath, '.claude', 'agents');
  if (!existsSync(root)) return [];
  const defs = new Map<string, RepoAgentDef>();
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        try {
          const def = parseAgentFile(readFileSync(full, 'utf8'), path.relative(repoPath, full));
          if (def && !defs.has(def.name)) defs.set(def.name, def);
        } catch {}
      }
    }
  };
  walk(root, 0);
  return [...defs.values()];
}
