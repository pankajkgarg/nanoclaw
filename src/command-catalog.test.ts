import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { getCommandAliasMap, getSkillCommandEntries, getTelegramBotCommands } from './command-catalog.js';

function withTempSkills(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skills-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSkill(root: string, dirName: string, frontmatter: string): void {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${dirName}\n`);
}

describe('command catalog', () => {
  it('parses skill names and descriptions', () => {
    withTempSkills((skillsDir) => {
      writeSkill(skillsDir, 'status', 'name: status\ndescription: Quick health check.');

      const commands = getSkillCommandEntries({ skillsDir, selectedSkills: 'all' });

      expect(commands).toMatchObject([
        {
          command: '/status',
          menuCommand: 'status',
          description: 'Quick health check.',
          category: 'skill',
          visibility: 'public',
        },
      ]);
    });
  });

  it('honors explicit skill selection and skips missing or malformed skills', () => {
    withTempSkills((skillsDir) => {
      writeSkill(skillsDir, 'status', 'name: status\ndescription: Quick health check.');
      writeSkill(skillsDir, 'broken', 'name: broken');
      writeSkill(skillsDir, 'fal-image', 'name: fal-image\ndescription: Generate images.');

      const commands = getSkillCommandEntries({
        skillsDir,
        selectedSkills: ['fal-image', 'missing', 'broken'],
      });

      expect(commands.map((cmd) => cmd.command)).toEqual(['/fal-image']);
    });
  });

  it('creates Telegram-safe aliases for hyphenated skill commands', () => {
    withTempSkills((skillsDir) => {
      writeSkill(skillsDir, 'fal-image', 'name: fal-image\ndescription: Generate images.');

      const menu = getTelegramBotCommands({ skillsDir, selectedSkills: ['fal-image'] });
      const aliases = getCommandAliasMap(undefined, { skillsDir, selectedSkills: ['fal-image'] });

      expect(menu).toContainEqual({ command: 'fal_image', description: 'Generate images.' });
      expect(aliases.get('/fal_image')).toBe('/fal-image');
    });
  });

  it('can include admin commands in Telegram command lists', () => {
    const menu = getTelegramBotCommands({ includeAdmin: true, selectedSkills: [] });

    expect(menu).toContainEqual({ command: 'clear', description: 'Start a fresh Claude Code session for this chat.' });
    expect(menu).toContainEqual({
      command: 'compact',
      description: 'Ask Claude Code to compact the current conversation context.',
    });
    expect(menu.map((cmd) => cmd.command)).toEqual(['help', 'clear', 'compact', 'context', 'cost', 'files']);
  });
});
