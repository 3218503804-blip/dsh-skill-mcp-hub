# dsh-skill-mcp-hub

**One Settings page for DeepSeek Harness: Skills, MCP servers, global prompts and files.**

DSH 里所有「能力」类配置——技能、MCP 服务器、全局指令（AGENTS.md）、受控目录里的文件——
现在都在 **设置 → 能力库** 一个页签里，四个 Tab 管完。

> This plugin is a fusion of two earlier plugins (a skills/MCP capability manager and a local
> config admin panel). It keeps the MCP runtime engine of
> [`dsh-skill-mcp-manager`](https://www.npmjs.com/package/dsh-skill-mcp-manager) and adds a
> filesystem-level skills / prompts / files manager plus a single unified UI on top.

## Features

| Tab | What you can do |
|---|---|
| **技能** | List every skill (local `$DSH_HOME/skills` + bundled read-only ones), toggle model visibility, **edit `SKILL.md` inline**, create, delete (to `.trash`) |
| **MCP** | Tier per server (eager / on-demand / disabled), per-tool enable/disable, tool counts, details, secret reveal, snapshot refresh, **add / modify servers**, delete |
| **全局 Prompt** | Read / edit `$DSH_HOME/AGENTS.md`, `$DSH_HOME/CLAUDE.md`, `~/.agents/AGENTS.md`, `~/.agents/CLAUDE.md` (created on save) |
| **文件** | Browse and edit text files inside the managed roots (`$DSH_HOME`, skills dir, `~/.agents`, `~/.claude`) |

Notes:

- Disabling a skill only writes `disable-model-invocation` — the model stops seeing it, but your
  `/name` slash command still works.
- Bundled skills (inside `app.asar` / `node_modules`) are listed **read-only**; they are never
  modified or deleted.
- The MCP tab keeps the engine's on-demand model: servers are connected when the agent actually
  needs them, one instance per session, so many MCP servers no longer cost context tokens.

## Install

### 1. Add the plugin to a profile

```bash
dsh plugin --profile <profile> add dsh-skill-mcp-hub
```

or, from the DSH Web GUI / agent, install the bundle (this is what the author uses):

```
plugin_manager install_bundle  target=/absolute/path/to/dsh-skill-mcp-hub
```

`dsh-skill-mcp-manager` is installed automatically as a dependency; its **host half** is mounted by
this plugin's `cordis.patch.yml`, so its own settings page never appears.

### 2. Shim the engine's client half (required)

DSH builds the client graph from **mounted rows**, not from `dsh.profile.bundles`, so the engine's
own settings page would otherwise show up as a second「能力库」tab. Replace it with a no-op:

```bash
node scripts/shim-engine-client.mjs            # default profile: desktop
node scripts/shim-engine-client.mjs --check    # verify, exit 2 when it needs re-applying
node scripts/shim-engine-client.mjs --profile web
```

**Re-run it after every engine upgrade/reinstall** (`pnpm add dsh-skill-mcp-manager@x` restores the
original file). Then reload the page / restart DSH.

### 3. Make `profile` explicit

The engine reconciles the profile named in its config. This plugin's patch already pins it:

```yaml
- insert:
    - id: hub-mcp-engine
      name: dsh-skill-mcp-manager
      config:
        profile: desktop      # change to your profile name
    - id: hub
      name: dsh-skill-mcp-hub
```

## Where things live

- Skills: `$DSH_HOME/skills` — delete moves the folder to `$DSH_HOME/skills/.trash`.
- MCP registry / settings: `$DSH_HOME/skill-mcp-manager/` (shared with the engine).
- MCP shadow rows: the engine's managed block in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`.
- Global prompts: `$DSH_HOME/AGENTS.md` etc.

## Architecture

```
Settings → 能力库 (this plugin's single page)
├─ 技能 / 全局 Prompt / 文件 → POST /api/hub      (filesystem level, lib/hub-core.js)
└─ MCP                       → /skill-mcp-manager/*  (engine routes: tiers, tools, snapshots)
                              + POST /api/hub {method:"mcpRegister"} → ctx.tools.execute("mcp_register")
```

- `lib/index.js` — host half: JSON-RPC route, skill merge (local + kernel service via
  `agentPresets.acquireScope()`, falling back to `standingKeyOf`-era `standingKeyFor()`), and MCP
  registration proxied through the engine's own `mcp_register` tool (trial-connect + persist +
  managed-block rewrite; keeps a single writer).
- `lib/hub-core.js` — pure Node engine (skills, prompts, managed files); no cordis dependency.
- `client/client.js` — single-file vanilla-React client (no JSX/TS/bundler), four tabs.

## Known limitations

- Re-run `scripts/shim-engine-client.mjs` after engine upgrades (see step 2).
- Clearing an MCP server's notes to empty is not forwarded yet (other fields are).
- The engine has no "delete while connected" recovery; deleting a server removes its registry entry
  and shadow row, the next session simply won't see it.

## Development

Pure JavaScript, no build step. Client code must stay plain `React.createElement` (no JSX/TS), the
host side is ESM Node.

```bash
node --check lib/index.js
node --check lib/hub-core.js
node --check client/client.js
```

## License

MIT
