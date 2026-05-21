import fs from 'fs';
import path from 'path';

import { getContainerConfig } from './db/container-configs.js';
import type { AgentGroup } from './types.js';

export type CommandCategory = 'nanoclaw' | 'claude-code' | 'skill';
export type CommandVisibility = 'public' | 'admin';

export interface CommandEntry {
  command: string;
  menuCommand: string;
  description: string;
  category: CommandCategory;
  visibility: CommandVisibility;
}

export interface CommandCatalogOptions {
  includeAdmin?: boolean;
  skillsDir?: string;
  selectedSkills?: string[] | 'all';
}

const NANOCLAW_COMMANDS: CommandEntry[] = [
  {
    command: '/help',
    menuCommand: 'help',
    description: 'Show available commands.',
    category: 'nanoclaw',
    visibility: 'public',
  },
  {
    command: '/clear',
    menuCommand: 'clear',
    description: 'Start a fresh Claude Code session for this chat.',
    category: 'nanoclaw',
    visibility: 'admin',
  },
];

const CLAUDE_CODE_COMMANDS: CommandEntry[] = [
  {
    command: '/compact',
    menuCommand: 'compact',
    description: 'Ask Claude Code to compact the current conversation context.',
    category: 'claude-code',
    visibility: 'admin',
  },
  {
    command: '/context',
    menuCommand: 'context',
    description: 'Show Claude Code context-window usage.',
    category: 'claude-code',
    visibility: 'admin',
  },
  {
    command: '/cost',
    menuCommand: 'cost',
    description: 'Show Claude Code session cost information.',
    category: 'claude-code',
    visibility: 'admin',
  },
  {
    command: '/files',
    menuCommand: 'files',
    description: 'Show files currently known to Claude Code.',
    category: 'claude-code',
    visibility: 'admin',
  },
];

function defaultSkillsDir(): string {
  return path.join(process.cwd(), 'container', 'skills');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function telegramSafeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  const frontmatter = content.slice(4, end);
  const out: { name?: string; description?: string } = {};
  for (const line of frontmatter.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'name') out.name = value;
    if (key === 'description') out.description = value;
  }
  return out;
}

function selectedSkillNames(skillsDir: string, selectedSkills: string[] | 'all'): string[] {
  if (selectedSkills !== 'all') return [...new Set(selectedSkills)].sort();
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function getSkillCommandEntries(options: CommandCatalogOptions = {}): CommandEntry[] {
  const skillsDir = options.skillsDir ?? defaultSkillsDir();
  const selected = options.selectedSkills ?? 'all';
  const commands: CommandEntry[] = [];

  for (const dirName of selectedSkillNames(skillsDir, selected)) {
    const skillPath = path.join(skillsDir, dirName, 'SKILL.md');
    let parsed: { name?: string; description?: string } | null = null;
    try {
      parsed = parseSkillFrontmatter(fs.readFileSync(skillPath, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed?.name || !parsed.description) continue;

    const menuCommand = telegramSafeName(parsed.name);
    if (!menuCommand) continue;

    commands.push({
      command: `/${parsed.name}`,
      menuCommand,
      description: parsed.description,
      category: 'skill',
      visibility: 'public',
    });
  }

  return commands.sort((a, b) => a.command.localeCompare(b.command));
}

export function getCommandCatalog(agentGroup?: AgentGroup, options: CommandCatalogOptions = {}): CommandEntry[] {
  const includeAdmin = options.includeAdmin ?? false;
  const selectedSkills =
    options.selectedSkills ??
    (agentGroup && getContainerConfig(agentGroup.id)
      ? (JSON.parse(getContainerConfig(agentGroup.id)!.skills) as string[] | 'all')
      : 'all');
  const allCommands = [
    ...NANOCLAW_COMMANDS,
    ...CLAUDE_CODE_COMMANDS,
    ...getSkillCommandEntries({ ...options, selectedSkills }),
  ];

  return allCommands.filter((cmd) => includeAdmin || cmd.visibility === 'public');
}

export function getCommandAliasMap(agentGroup?: AgentGroup, options: CommandCatalogOptions = {}): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of getCommandCatalog(agentGroup, { ...options, includeAdmin: true })) {
    const menuSlash = `/${entry.menuCommand}`;
    if (menuSlash !== entry.command) aliases.set(menuSlash, entry.command);
  }
  return aliases;
}

export function formatCommandHelp(agentGroup: AgentGroup, options: CommandCatalogOptions = {}): string {
  const commands = getCommandCatalog(agentGroup, options);
  const groups: Array<[CommandCategory, string]> = [
    ['nanoclaw', 'NanoClaw'],
    ['claude-code', 'Claude Code'],
    ['skill', 'Skills'],
  ];
  const lines = ['Available commands:'];

  for (const [category, title] of groups) {
    const entries = commands.filter((cmd) => cmd.category === category);
    if (entries.length === 0) continue;
    lines.push('', `${title}:`);
    for (const entry of entries) {
      lines.push(`${entry.command} - ${truncate(entry.description, 140)}`);
    }
  }

  return lines.join('\n');
}

export function getTelegramBotCommands(
  options: CommandCatalogOptions = {},
): Array<{ command: string; description: string }> {
  const seen = new Set<string>();
  const out: Array<{ command: string; description: string }> = [];
  for (const entry of getCommandCatalog(undefined, { ...options, includeAdmin: options.includeAdmin ?? false })) {
    if (seen.has(entry.menuCommand)) continue;
    seen.add(entry.menuCommand);
    out.push({
      command: entry.menuCommand,
      description: truncate(entry.description, 256),
    });
  }
  return out;
}
