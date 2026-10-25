#!/usr/bin/env node
// 能力库（@local/dsh-hub）维护脚本：把 MCP 引擎包自带的设置页换成空壳。
//
// 为什么要这一步：引擎包 dsh-skill-mcp-manager 的 client 会随它的 host 行一起挂载，
// 于是内核里多出一个同名的「能力库」页签。融合后的唯一入口在 @local/dsh-hub，
// 所以引擎的 client 必须注册为零内容。
//
// 什么时候要重跑：升级/重装引擎（pnpm add dsh-skill-mcp-manager@x）之后，
// 以及 profile 被 pnpm 重新链接之后。
//
// 用法：
//   node scripts/shim-engine-client.mjs            # 默认作用于当前 profile
//   node scripts/shim-engine-client.mjs --profile desktop
//   node scripts/shim-engine-client.mjs --check    # 只检查，不写
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const SHIM = `// shim: 能力库（unified hub）client half.
//
// The MCP engine package (dsh-skill-mcp-manager) is mounted as a HOST row for its
// runtime only; its own settings page must not appear, otherwise「能力库」会重复。
// The engine's client entry is replaced by this no-op shim. The real page lives in
// @local/dsh-hub/client/client.js.
//
// Re-apply after any engine reinstall/upgrade:
//   node D:\\DeepseekHarnessWorkspace\\dsh-hub\\scripts\\shim-engine-client.mjs
window.__ModuleLoader__.load({
  id: "dsh-skill-mcp-manager",
  factory: () => ({
    name: "dsh-skill-mcp-manager",
    inject: [],
    apply() {
      // intentionally empty — UI 由 @local/dsh-hub 提供
    },
  }),
});
`;

const args = process.argv.slice(2);
const check = args.includes("--check");
const profileFlag = args.indexOf("--profile");
const profile = profileFlag >= 0 ? args[profileFlag + 1] : process.env.DSH_PROFILE || "desktop";

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const clientPath = join(dshHome, "profiles", profile, "node_modules", "dsh-skill-mcp-manager", "client", "client.js");

if (!existsSync(clientPath)) {
  console.error(`[shim] 找不到引擎 client：${clientPath}`);
  console.error("[shim] 该 profile 没装 dsh-skill-mcp-manager？先安装再跑本脚本。");
  process.exit(1);
}

const current = await readFile(clientPath, "utf8");
const already = current.includes("intentionally empty — UI 由 @local/dsh-hub 提供");

if (check) {
  console.log(already ? `[shim] OK：${clientPath}` : `[shim] 需要重打：${clientPath}`);
  process.exit(already ? 0 : 2);
}

if (already) {
  console.log(`[shim] 已是 shim，跳过：${clientPath}`);
  process.exit(0);
}

await writeFile(clientPath, SHIM, "utf8");
console.log(`[shim] 已替换引擎设置页：${clientPath}`);
console.log("[shim] 刷新页面（或重启 DSH）后生效。");
