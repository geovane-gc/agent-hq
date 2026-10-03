import type { Integration } from '@agent-hq/protocol';

// Optional MCP servers agents can be given. All of them are opt-in per agent;
// Agent HQ itself only needs Node and Claude Code. Users can edit or add
// entries from the Integrations settings.

export const DEFAULT_INTEGRATIONS: Integration[] = [
  {
    id: 'browser',
    name: 'Browser (Playwright)',
    description: 'Open, click through and screenshot web apps to test them.',
    setup: 'Nothing to install up front: npx downloads @playwright/mcp on first use.',
    config: { type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, reviews and repository data.',
    setup: 'Create a GitHub personal access token and expose it as the GITHUB_PERSONAL_ACCESS_TOKEN environment variable before starting Agent HQ.',
    config: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    },
  },
  {
    id: 'figma',
    name: 'Figma',
    description: 'Read designs, components and variables from Figma.',
    setup: 'In the Figma desktop app, enable Preferences → "Enable Dev Mode MCP Server" and keep Figma open.',
    config: { type: 'http', url: 'http://127.0.0.1:3845/mcp' },
  },
  {
    id: 'blender',
    name: 'Blender',
    description: 'Create and edit 3D scenes, objects and materials in a live Blender session.',
    setup: 'Install uv (https://docs.astral.sh/uv/), run `uvx blender-mcp install-addon` or install the addon from github.com/ahujasid/blender-mcp, then click "Connect to Claude" in Blender\'s sidebar.',
    config: { type: 'stdio', command: 'uvx', args: ['blender-mcp'] },
  },
  {
    id: 'unity',
    name: 'Unity',
    description: 'Manage scenes, GameObjects, scripts and play mode in the Unity Editor.',
    setup: 'Install uv and add the "MCP for Unity" package (github.com/CoplayDev/unity-mcp) to your Unity project, then start its bridge from Window → MCP for Unity.',
    config: { type: 'stdio', command: 'uvx', args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'] },
  },
];

/**
 * Claude Code on Windows can't spawn npx/uvx shims directly; wrap them in
 * `cmd /c` as its docs recommend.
 */
export function platformMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (process.platform !== 'win32') return config;
  const command = config.command;
  if (typeof command === 'string' && ['npx', 'uvx', 'npm', 'pnpm', 'yarn', 'bunx'].includes(command)) {
    return { ...config, command: 'cmd', args: ['/c', command, ...((config.args as string[]) ?? [])] };
  }
  return config;
}
