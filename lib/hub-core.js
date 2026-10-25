// dsh-admin 后端引擎：纯 Node，无 cordis 依赖，可独立测试。
// 管理目标：
//   - skill：<dshHome>/skills 下的目录 bundle（<name>/SKILL.md）或平铺 <name>.md
//   - mcp：  <dshHome>/mcp-servers.json 作为真源，再生成 cordis.patch.yml 的 insert 段
//   - 全局 prompt：<dshHome>/AGENTS.md、<agentsHome>/AGENTS.md（及 CLAUDE.md）
//   - 文件：受控根目录（dshHome / skills / ~/.agents / ~/.claude）内的任意文本文件
import { readFile, writeFile, readdir, mkdir, rename, access, stat } from "node:fs/promises";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, extname, resolve, sep, basename, dirname, relative, normalize } from "node:path";
import { homedir } from "node:os";

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

// 把带认证令牌的 Web URL 写到固定文件，供操作者重新打开 GUI 时读取。
export function writeAuthUrl(url) {
  const p = join(dshHome(), ".dsh-web-url.txt");
  writeFileSync(p, `${url}\n`, "utf8");
  return p;
}

// 写诊断信息（best-effort）。
export function writeDiag(text) {
  const p = join(dshHome(), ".dsh-admin-diag.txt");
  try {
    writeFileSync(p, `${String(text)}\n`, "utf8");
  } catch { /* ignore */ }
  return p;
}

// 使用日志目录（skill / mcp 使用日志）。
export function logsDir() {
  const p = join(dshHome(), "logs");
  mkdirSync(p, { recursive: true });
  return p;
}

// 追加一条 JSONL 记录（调用一次记一笔）。
function appendJsonl(filename, entry) {
  try {
    appendFileSync(join(logsDir(), filename), JSON.stringify(entry) + "\n", "utf8");
  } catch { /* ignore */ }
}

export function logSkillUsage(entry) {
  appendJsonl("skill-usage.log", entry);
}

export function logMcpUsage(entry) {
  appendJsonl("mcp-usage.log", entry);
}
export function skillRoot() {
  return join(dshHome(), "skills");
}
export function agentsHome() {
  return process.env.DSH_AGENTS_HOME || join(homedir(), ".agents");
}
export function claudeHome() {
  return join(homedir(), ".claude");
}
function mcpJsonPath() {
  return join(dshHome(), "mcp-servers.json");
}

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function isTruthy(v) {
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return ["true", "yes", "on", "1"].includes(s);
}

// 简单 frontmatter：--- 开头，遇到第二个 --- 结束；只解析 "key: value" 行。
function parseFrontmatter(raw) {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return { data: {}, body: raw, close: -1, lines };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") { close = i; break; }
  }
  if (close < 0) return { data: {}, body: raw, close: -1, lines };
  const data = {};
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m) data[m[1]] = m[2];
  }
  return { data, body: lines.slice(close + 1).join("\n"), close, lines };
}

// 重建 frontmatter：保留原顺序与未知行；对管理键做覆盖/删除。
function rebuildFrontmatter(parsed, patch) {
  const managed = new Set(["disable-model-invocation", "user-invocable"]);
  const emitted = new Set();
  const out = [];
  if (parsed.close < 0) {
    // 无 frontmatter：当作全新 body，另行拼接
    return null;
  }
  for (let i = 1; i < parsed.close; i++) {
    const line = parsed.lines[i];
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (m && managed.has(m[1])) {
      if (!emitted.has(m[1]) && patch[m[1]] !== undefined) {
        out.push(`${m[1]}: ${patch[m[1]]}`);
        emitted.add(m[1]);
      }
      continue;
    }
    out.push(line);
  }
  for (const key of ["disable-model-invocation", "user-invocable"]) {
    if (!emitted.has(key) && patch[key] !== undefined) out.push(`${key}: ${patch[key]}`);
  }
  return ["---", ...out, "---", parsed.body].join("\n");
}

async function findSkillFile(name) {
  const root = skillRoot();
  const bundle = join(root, name, "SKILL.md");
  if (await pathExists(bundle)) return { path: bundle, kind: "bundle", dir: join(root, name) };
  const flat = join(root, `${name}.md`);
  if (await pathExists(flat)) return { path: flat, kind: "flat", dir: null };
  return null;
}

// ---------- 路径安全 ----------
// 受控根目录列表（只允许在这些根下读写文件）。
export function managedRoots() {
  return [
    { path: dshHome(), label: "DSH 主目录", key: "dsh" },
    { path: skillRoot(), label: "技能目录", key: "skills" },
    { path: agentsHome(), label: "Agents 目录", key: "agents" },
    { path: claudeHome(), label: "Claude 目录", key: "claude" },
  ];
}

function isWithin(root, target) {
  const r = resolve(root);
  const t = resolve(target);
  return t === r || t.startsWith(r + sep);
}

// 把用户传入的路径解析为受控根目录下的绝对路径；越界抛错。
export function resolveManagedPath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path required");
  let abs;
  try {
    abs = resolve(input);
  } catch {
    throw new Error(`invalid path: ${input}`);
  }
  for (const root of managedRoots()) {
    if (isWithin(root.path, abs)) return abs;
  }
  throw new Error(`path "${input}" is outside managed roots`);
}

// ---------- skill ----------

export async function listSkills() {
  const root = skillRoot();
  const skills = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    let file = null, name = null;
    if (entry.isDirectory()) {
      const p = join(root, entry.name, "SKILL.md");
      if (await pathExists(p)) { file = { path: p, kind: "bundle", dir: join(root, entry.name) }; name = entry.name; }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      file = { path: join(root, entry.name), kind: "flat", dir: null };
      name = entry.name.slice(0, -3);
    }
    if (!file) continue;
    try {
      const raw = await readFile(file.path, "utf8");
      const { data } = parseFrontmatter(raw);
      skills.push({
        name: data.name || name,
        description: data.description || "",
        whenToUse: data["when-to-use"] || data.whenToUse || "",
        modelInvocable: data["disable-model-invocation"] === undefined ? true : !isTruthy(data["disable-model-invocation"]),
        userInvocable: data["user-invocable"] === undefined ? true : isTruthy(data["user-invocable"]),
        path: file.path,
        kind: file.kind,
      });
    } catch { /* 坏文件跳过 */ }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { root, skills };
}

export async function readSkill(name) {
  const file = await findSkillFile(name);
  if (!file) throw new Error(`skill "${name}" not found under ${skillRoot()}`);
  const content = await readFile(file.path, "utf8");
  const { data } = parseFrontmatter(content);
  return {
    name: data.name || name,
    path: file.path,
    kind: file.kind,
    dir: file.dir,
    content,
    frontmatter: data,
  };
}

export async function writeSkill(name, content) {
  if (typeof content !== "string") throw new Error("content must be a string");
  const file = await findSkillFile(name);
  if (!file) throw new Error(`skill "${name}" not found`);
  await writeFile(file.path, content, "utf8");
  return { name, path: file.path };
}

export async function createSkill(name, content, description) {
  const clean = String(name || "").trim().replace(/\s+/g, "-").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(clean)) throw new Error(`invalid skill name "${name}"`);
  const dir = join(skillRoot(), clean);
  if (await pathExists(join(dir, "SKILL.md")) || await pathExists(join(skillRoot(), `${clean}.md`)))
    throw new Error(`skill "${clean}" already exists`);
  await mkdir(dir, { recursive: true });
  const frontmatter = [
    "---",
    `name: ${clean}`,
    `description: ${String(description || "").trim() || "A local skill"}`,
    "---",
    "",
    String(content || "").trim(),
    "",
  ].join("\n");
  const p = join(dir, "SKILL.md");
  await writeFile(p, frontmatter, "utf8");
  return { name: clean, path: p };
}

export async function setSkillDisabled(name, disabled) {
  const file = await findSkillFile(name);
  if (!file) throw new Error(`skill "${name}" not found under ${skillRoot()}`);
  const raw = await readFile(file.path, "utf8");
  const parsed = parseFrontmatter(raw);
  if (parsed.close < 0) throw new Error(`skill "${name}" has no frontmatter`);
  // 只切换「模型可见性」：disable-model-invocation 控制模型能否调用，
  // user-invocable（/name 斜杠命令）保持不动 —— 与内核 dsh-skill-filesystem
  // 以及 dsh-skill-mcp-manager 的语义一致：关掉技能只是让模型看不见，人还能手动用。
  const patch = disabled
    ? { "disable-model-invocation": "true" }
    : { "disable-model-invocation": undefined };
  const next = rebuildFrontmatter(parsed, patch);
  await writeFile(file.path, next, "utf8");
  return { name, disabled, path: file.path };
}

export async function removeSkill(name) {
  const file = await findSkillFile(name);
  if (!file) throw new Error(`skill "${name}" not found`);
  const trash = join(skillRoot(), ".trash");
  await mkdir(trash, { recursive: true });
  const target = file.kind === "bundle" ? join(skillRoot(), name) : file.path;
  const dest = join(trash, `${name}-${Date.now()}${file.kind === "bundle" ? "" : extname(target)}`);
  await rename(target, dest);
  return { name, movedTo: dest };
}

// ---------- mcp ----------
//
// 能力库（dsh-skill-mcp-manager）安装后会「接管」原生 MCP 配置：它把 profile
// cordis.patch.yml 里所有 @deepseek-ai/dsh-mcp-client 行收敛进自己的托管块
// （标记见下），并从原位置移除。此时再让本插件往 patch 里写 insert 行会产生
// 重复 loader id，所以一旦检测到托管块，本插件的 MCP 写入口直接拒绝。
const CAPABILITY_MANAGED_MARKER = "# ── Managed MCP servers (dsh-skill-mcp-manager";
const CAPABILITY_MANAGED_END = "# ── End managed MCP servers (dsh-skill-mcp-manager)";
const LEGACY_BEGIN = "# === dsh-admin: MCP servers (begin) ===";
const LEGACY_END = "# === dsh-admin: MCP servers (end) ===";

async function patchText() {
  try {
    return await readFile(patchPath(), "utf8");
  } catch {
    return "";
  }
}

async function assertNotManaged() {
  const raw = await patchText();
  if (raw.includes(CAPABILITY_MANAGED_MARKER)) {
    throw new Error("MCP 服务器已由「设置 → 能力库」(dsh-skill-mcp-manager) 接管，请在该页面管理；本插件的 MCP 编辑已停用以免写出重复的 loader 行。");
  }
}

export async function listMcp() {
  try {
    const raw = await readFile(mcpJsonPath(), "utf8");
    return { servers: JSON.parse(raw), path: mcpJsonPath() };
  } catch {
    return { servers: [], path: mcpJsonPath() };
  }
}

export async function readMcpRaw() {
  try {
    const raw = await readFile(mcpJsonPath(), "utf8");
    return { content: raw, path: mcpJsonPath() };
  } catch {
    return { content: "[\n]\n", path: mcpJsonPath() };
  }
}

function emitHeaders(headers) {
  if (!headers || !Object.keys(headers).length) return "";
  const lines = Object.entries(headers).map(([k, v]) => {
    if (typeof v === "string" && v.startsWith("!!js ")) return `          ${k}: !!js ${v.slice(5)}`;
    return `          ${k}: ${JSON.stringify(v)}`;
  });
  return `\n        headers:\n${lines.join("\n")}`;
}

function mcpPatchSection(servers) {
  if (!servers.length) return "";
  const rows = servers.map((s) => {
    const disabled = s.disabled ? "\n      disabled: true" : "";
    if (s.transport === "streamable-http" || s.transport === "http") {
      const headers = emitHeaders(s.headers);
      return `    - id: mcp-${s.serverName}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${s.serverName}\n        transport: streamable-http\n        url: ${JSON.stringify(s.url || "")}${headers}${disabled}`;
    }
    const args = (s.args || []).map((a) => JSON.stringify(a)).join(", ");
    const env = s.env && Object.keys(s.env).length ? `\n        env: ${JSON.stringify(s.env)}` : "";
    return `    - id: mcp-${s.serverName}\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${s.serverName}\n        transport: stdio\n        command: ${JSON.stringify(s.command || "")}\n        args: [${args}]${env}${disabled}`;
  });
  return `# === dsh-admin: MCP servers (begin) ===\n- insert:\n${rows.join("\n")}\n# === dsh-admin: MCP servers (end) ===`;
}

export function patchPath() {
  return process.env.DSH_PROFILE_PATCH || join(dshHome(), "profiles", "desktop", "cordis.patch.yml");
}

async function syncPatch(servers) {
  const path = patchPath();
  let raw;
  try { raw = await readFile(path, "utf8"); } catch { raw = ""; }

  // 能力库已接管：只清理本插件可能残留的旧标记块，绝不写 MCP 行。
  if (raw.includes(CAPABILITY_MANAGED_MARKER)) {
    const cleaned = removeLegacyBlocks(raw);
    if (cleaned !== raw) await writeFile(path, cleaned, "utf8");
    return path;
  }

  const section = mcpPatchSection(servers);
  const bi = raw.indexOf(LEGACY_BEGIN);
  const ei = raw.indexOf(LEGACY_END);
  let next;
  if (bi >= 0 && ei >= 0) {
    next = raw.slice(0, bi) + section + raw.slice(ei + LEGACY_END.length);
  } else {
    next = raw.replace(/\s+$/, "") + (raw.trim() ? "\n\n" : "") + section + "\n";
  }
  await writeFile(path, next, "utf8");
  return path;
}

// 删掉任何残留的 `# === dsh-admin: MCP servers begin/end ===` 标记块
// （只删标记与块内的 dsh-admin 生成内容，块内其它行原样保留）。
function removeLegacyBlocks(raw) {
  let out = raw;
  for (;;) {
    const bi = out.indexOf(LEGACY_BEGIN);
    const ei = out.indexOf(LEGACY_END);
    if (bi < 0 || ei < 0 || ei < bi) return out;
    const between = out.slice(bi + LEGACY_BEGIN.length, ei);
    const keep = between
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !/^\s*- insert:\s*$/.test(line) && !/^\s{4,}- id: mcp-/.test(line))
      .join("\n");
    out = `${out.slice(0, bi)}${keep ? `${keep}\n` : ""}${out.slice(ei + LEGACY_END.length)}`;
  }
}

async function saveMcp(servers) {
  await assertNotManaged();
  await writeFile(mcpJsonPath(), JSON.stringify(servers, null, 2) + "\n", "utf8");
  return syncPatch(servers);
}

// 写原始 JSON：校验 + 落盘 + 同步 patch。
export async function writeMcpRaw(raw) {
  let servers;
  try {
    servers = JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  if (!Array.isArray(servers)) throw new Error("mcp-servers.json must be a JSON array");
  const patchPath_ = await saveMcp(servers);
  return { servers, patchPath: patchPath_ };
}

export async function addMcp(server) {
  if (!server || !server.serverName) throw new Error("serverName required");
  if (!server.transport) throw new Error("transport required (stdio | streamable-http)");
  const { servers } = await listMcp();
  if (servers.some((s) => s.serverName === server.serverName)) throw new Error(`MCP server "${server.serverName}" already exists`);
  servers.push(server);
  const p = await saveMcp(servers);
  return { servers, patchPath: p };
}

export async function removeMcp(serverName) {
  const { servers } = await listMcp();
  const next = servers.filter((s) => s.serverName !== serverName);
  if (next.length === servers.length) throw new Error(`MCP server "${serverName}" not found`);
  const p = await saveMcp(next);
  return { servers: next, patchPath: p };
}

export async function setMcpDisabled(serverName, disabled) {
  const { servers } = await listMcp();
  const s = servers.find((x) => x.serverName === serverName);
  if (!s) throw new Error(`MCP server "${serverName}" not found`);
  s.disabled = !!disabled;
  const p = await saveMcp(servers);
  return { servers, patchPath: p };
}

// ---------- 全局 prompt ----------

export function globalPromptFiles() {
  const dh = dshHome();
  const ah = agentsHome();
  return [
    { key: "dsh-agents", path: join(dh, "AGENTS.md"), label: "全局指令 · DSH (AGENTS.md)", scope: "user-global" },
    { key: "dsh-claude", path: join(dh, "CLAUDE.md"), label: "全局指令 · DSH (CLAUDE.md)", scope: "user-global" },
    { key: "agents-agents", path: join(ah, "AGENTS.md"), label: "全局指令 · Agents (AGENTS.md)", scope: "shared-agents" },
    { key: "agents-claude", path: join(ah, "CLAUDE.md"), label: "全局指令 · Agents (CLAUDE.md)", scope: "shared-agents" },
  ];
}

export async function listPrompts() {
  const files = globalPromptFiles();
  const out = [];
  for (const f of files) {
    const exists = await pathExists(f.path);
    out.push({ ...f, exists });
  }
  return { files: out, dshHome: dshHome(), agentsHome: agentsHome() };
}

// ---------- 通用文件 ----------

export async function listDir(input) {
  const p = resolveManagedPath(input);
  let st;
  try { st = await stat(p); } catch { throw new Error(`cannot stat ${p}`); }
  if (!st.isDirectory()) throw new Error(`${p} is not a directory`);
  const entries = await readdir(p, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(p, e.name);
    const isDir = e.isDirectory();
    let size = null, mtime = null;
    if (!isDir) {
      try {
        const s = await stat(full);
        size = s.size;
        mtime = s.mtimeMs;
      } catch { /* ignore */ }
    }
    items.push({ name: e.name, path: full, isDirectory: isDir, size, mtime });
  }
  items.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  const roots = managedRoots();
  const parent = p === resolve(p) && roots.some((r) => resolve(r.path) === p) ? null : dirname(p);
  return { path: p, parent, entries: items, roots };
}

export async function readManagedFile(input) {
  const p = resolveManagedPath(input);
  let st;
  try { st = await stat(p); } catch { throw new Error(`file not found: ${p}`); }
  if (st.isDirectory()) throw new Error(`${p} is a directory`);
  if (st.size > 2 * 1024 * 1024) throw new Error(`file too large (${st.size} bytes) for preview`);
  const content = await readFile(p, "utf8");
  return { path: p, content, size: st.size, mtime: st.mtimeMs };
}

export async function writeManagedFile(input, content) {
  if (typeof content !== "string") throw new Error("content must be a string");
  const p = resolveManagedPath(input);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, "utf8");
  const s = await stat(p);
  return { path: p, size: s.size, mtime: s.mtimeMs };
}

export async function createManagedFile(dirInput, name, content) {
  const clean = String(name || "").trim().replace(/[\\/]/g, "");
  if (!clean || clean.startsWith(".")) throw new Error("invalid file name");
  const p = resolveManagedPath(join(dirInput, clean));
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, String(content || ""), "utf8");
  return { path: p };
}

export async function deleteManagedFile(input) {
  const p = resolveManagedPath(input);
  const roots = managedRoots();
  for (const r of roots) {
    if (resolve(p) === resolve(r.path)) throw new Error("cannot delete a managed root");
  }
  await rename(p, `${p}.trash-${Date.now()}`);
  return { path: p };
}
