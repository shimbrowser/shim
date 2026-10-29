// The authoring guide (skills/shim-authoring), for agents that don't load Claude Code
// skills: the shim_guide tool and `shim guide` serve it. Without a topic, the main
// guide (SKILL.md, minus its frontmatter); with one, a reference file. The build embeds
// every file (SHIM_GUIDE), so the one-file bundles serve it from anywhere; unbundled
// (a harness), it reads skills/ beside the package source.

import * as fs from 'fs';
import * as path from 'path';

declare const SHIM_GUIDE: { main: string; references: Record<string, string> } | undefined;

export const GUIDE_TOPICS = [
  'handlers',
  'api',
  'databases',
  'network-and-modules',
  'site-data',
  'compositions',
  'page-driving',
  'sites',
  'headless',
  'hosts',
] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

export function isGuideTopic(v: string): v is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(v);
}

/** SKILL.md without its YAML frontmatter. */
export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)+/, '');
}

function guideDir(): string {
  let dir = __dirname;
  // src/ (or a compiled mirror of it, out/packages/mcp/src) up to the package or the
  // workspace root, which holds it as packages/mcp.
  for (let i = 0; i < 6; i++) {
    for (const candidate of [path.join(dir, 'skills', 'shim-authoring'), path.join(dir, 'packages', 'mcp', 'skills', 'shim-authoring')]) {
      if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error('the authoring guide (skills/shim-authoring) is not beside this package');
}

const NOTE =
  '> Served by the shim MCP server (shim_guide). Where this guide names `references/<topic>.md`, ' +
  'call shim_guide with that topic to read it.\n\n';

/** The main guide, or one reference file. */
export function guideText(topic?: GuideTopic): string {
  if (typeof SHIM_GUIDE !== 'undefined') {
    if (!topic) return NOTE + SHIM_GUIDE.main;
    const ref = SHIM_GUIDE.references[topic];
    if (ref === undefined) throw new Error(`the embedded guide has no ${topic} reference`);
    return ref;
  }
  const dir = guideDir();
  if (!topic) return NOTE + stripFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  return fs.readFileSync(path.join(dir, 'references', `${topic}.md`), 'utf8');
}
