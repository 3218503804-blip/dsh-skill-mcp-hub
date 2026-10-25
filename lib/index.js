// @local/dsh-hub —— host 半。
//
//  - 技能 / 全局 prompt / 文件：文件系统级（hub-core.js），不依赖内核 skill scope API；
//    再合并内核服务层的技能（app.asar / node_modules 里的随包技能），标成只读。
//  - MCP：不自己写配置，转调引擎的 `mcp_register` 工具（试连 + 落库 + 重写托管块），
//    这样内存态和 patch 都保持单一写入者。
import * as core from "./hub-core.js";

// 内核 skill 服务的读法：0.2.1 之前是 agentPresets.standingKeyFor()，
// 之后换成 acquireScope()（返回一个异步可释放的 scope 租约）。
async function kernelSkillScope(ctx) {
  const presets = ctx.get("agentPresets");
  const noop = () => {};
  if (!presets) return { scope: undefined, release: noop };
  if (typeof presets.acquireScope === "function") {
    try {
      const lease = await presets.acquireScope();
      const scope = lease && lease.key;
      const release = async () => {
        try {
          if (lease && typeof lease[Symbol.asyncDispose] === "function") await lease[Symbol.asyncDispose]();
          else if (lease && typeof lease.dispose === "function") await lease.dispose();
        } catch {
          /* 租约已释放 */
        }
      };
      return { scope, release };
    } catch {
      return { scope: undefined, release: noop };
    }
  }
  if (typeof presets.standingKeyFor === "function") {
    try {
      return { scope: await presets.standingKeyFor(), release: noop };
    } catch {
      return { scope: undefined, release: noop };
    }
  }
  return { scope: undefined, release: noop };
}

async function listKernelSkills(ctx) {
  const skills = ctx.get("skills");
  if (!skills || typeof skills.list !== "function") return [];
  const { scope, release } = await kernelSkillScope(ctx);
  try {
    const list = await skills.list(scope === undefined ? {} : { scope });
    return Array.isArray(list) ? list : [];
  } finally {
    await release();
  }
}

function textOf(result) {
  const blocks = (result && result.content) || [];
  return blocks.map((block) => (block && typeof block.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

export const name = "dsh-hub";
export const inject = ["connection"];

export function apply(ctx) {
  const HANDLERS = {
    async listSkills() {
      const local = await core.listSkills();
      const seen = new Set(local.skills.map((skill) => skill.name));
      let kernel = [];
      try {
        kernel = await listKernelSkills(ctx);
      } catch {
        kernel = [];
      }
      const bundled = kernel
        .filter((skill) => skill && typeof skill.name === "string" && !seen.has(skill.name))
        .map((skill) => ({
          name: skill.name,
          description: skill.description || "",
          path: skill.path || "",
          readonly: true,
          provider: skill.provider || "",
          source: String(skill.source || ""),
          modelInvocable: !(skill.invocation && skill.invocation.modelInvocable === false),
        }));
      return {
        root: local.root,
        skills: [...local.skills, ...bundled].sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
    readSkill: (a) => core.readSkill(a.name),
    writeSkill: (a) => core.writeSkill(a.name, a.content),
    createSkill: (a) => core.createSkill(a.name, a.content, a.description),
    setSkillDisabled: (a) => core.setSkillDisabled(a.name, a.disabled),
    removeSkill: (a) => core.removeSkill(a.name),
    listPrompts: () => core.listPrompts(),
    listRoots: () => core.managedRoots(),
    listDir: (a) => core.listDir(a.path),
    readManagedFile: (a) => core.readManagedFile(a.path),
    writeManagedFile: (a) => core.writeManagedFile(a.path, a.content),
    createManagedFile: (a) => core.createManagedFile(a.dir, a.name, a.content),
    deleteManagedFile: (a) => core.deleteManagedFile(a.path),

    // MCP 的新增/修改：转调引擎自带工具，保留它「试连通过才持久化」的约束。
    async mcpRegister(input) {
      const tools = ctx.get("tools");
      if (!tools || typeof tools.execute !== "function") {
        throw new Error("tools 服务不可用，无法调用 mcp_register");
      }
      const args = { name: String(input.name || "").trim() };
      if (!args.name) throw new Error("name required");
      if (input.tier) args.tier = input.tier;
      if (input.transport) args.transport = input.transport;
      if (input.command) args.command = input.command;
      if (Array.isArray(input.args)) args.args = input.args.map(String);
      if (input.cwd) args.cwd = input.cwd;
      if (input.url) args.url = input.url;
      if (input.env && typeof input.env === "object") args.env = input.env;
      if (input.headers && typeof input.headers === "object") args.headers = input.headers;
      if (input.notes) args.notes = input.notes;

      const result = await tools.execute({
        callId: `hub-mcp-${Date.now()}`,
        name: "mcp_register",
        arguments: args,
        signal: AbortSignal.timeout(120000),
      });
      const text = textOf(result);
      if (result && result.isError) {
        const reason = (result.error && result.error.message) || text || "mcp_register 失败";
        throw new Error(reason);
      }
      return { name: args.name, text };
    },
  };

  const connection = ctx.get("connection");
  if (!connection || !connection.fetch || typeof connection.fetch.register !== "function") return;

  connection.fetch.register({
    path: "/api/hub",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: async (request) => {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: { message: "invalid JSON body" } });
      }
      const fn = HANDLERS[body && body.method];
      if (typeof fn !== "function") {
        return Response.json({ ok: false, error: { message: `unknown method: ${body && body.method}` } });
      }
      try {
        const value = await fn(body.args || {});
        return Response.json({ ok: true, value });
      } catch (e) {
        return Response.json({ ok: false, error: { message: String((e && e.message) || e) } });
      }
    },
  });
}
