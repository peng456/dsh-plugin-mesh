/**
 * 入站权限 preset 解析的自测（**全离线、纯函数**）。
 *
 * 跑法：node lib/_selftest-inbound-preset.mjs
 *
 * 为什么值得单独一套：这是真机阻塞项的修复核心（「每个入站任务都停在待确认」）。
 * 规则本身很短，但"桌面端零变化"和"dsh-go 上覆盖生效"必须同时被钉住 ——
 * 只靠上手机试不可能防回归。这里把 dshGo true/false × 空键/非空键 ×
 * lan/tsnet 的组合全部枚举。
 */
import assert from "node:assert/strict";
import {
  resolveInboundPermissionPreset,
  describeInboundPermissionPreset,
} from "./inbound-preset.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err?.message ?? err}`);
    failed += 1;
  }
}

const LAN = { transport: "lan" };
const TSNET = { transport: "tsnet" };
const dshGoConfig = (overrides = {}) => ({
  permissionPreset: "workspace-write",
  tsnetPermissionPreset: "",
  permissionPresetOnDshGo: "",
  ...overrides,
});

console.log("\n── 1. 桌面端零变化（非 dsh-go 时新键完全不生效）──");

check("非 dsh-go：lan 用 permissionPreset", () => {
  assert.equal(resolveInboundPermissionPreset({ config: dshGoConfig(), task: LAN, dshGo: false }), "workspace-write");
});

check("非 dsh-go：配了 permissionPresetOnDshGo 也不生效", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "danger-full-access" });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: false }), "workspace-write");
  assert.equal(resolveInboundPermissionPreset({ config, task: TSNET, dshGo: false }), "workspace-write");
});

check("非 dsh-go：tailnet 收紧语义原样（tsnetPermissionPreset 非空时优先）", () => {
  const config = dshGoConfig({ tsnetPermissionPreset: "read-only" });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: false }), "workspace-write");
  assert.equal(resolveInboundPermissionPreset({ config, task: TSNET, dshGo: false }), "read-only");
});

check("非 dsh-go：tsnet 键为空时回退到 permissionPreset", () => {
  const config = dshGoConfig({ tsnetPermissionPreset: "" });
  assert.equal(resolveInboundPermissionPreset({ config, task: TSNET, dshGo: false }), "workspace-write");
});

console.log("\n── 2. dsh-go：permissionPresetOnDshGo 覆盖生效 ──");

check("dsh-go + 非空覆盖：lan 与 tsnet 都用覆盖值（环境约束优先）", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "danger-full-access", tsnetPermissionPreset: "read-only" });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: true }), "danger-full-access");
  assert.equal(resolveInboundPermissionPreset({ config, task: TSNET, dshGo: true }), "danger-full-access");
});

check("dsh-go + 空覆盖：完全退回旧语义（lan 默认 / tsnet 收紧）", () => {
  const config = dshGoConfig({ tsnetPermissionPreset: "read-only" });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: true }), "workspace-write");
  assert.equal(resolveInboundPermissionPreset({ config, task: TSNET, dshGo: true }), "read-only");
});

check("空白覆盖值视为未配置（不能被 ' ' 意外触发）", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "   " });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: true }), "workspace-write");
  assert.equal(describeInboundPermissionPreset({ config, task: LAN, dshGo: true }).source, "default");
});

check("覆盖值首尾空白被裁掉（手写 yaml 常见）", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "  danger-full-access  " });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: true }), "danger-full-access");
});

console.log("\n── 3. 来源说明（日志/诊断要能说清为什么）──");

check("describe：dsh-go 覆盖 → source=dsh-go", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "danger-full-access" });
  assert.deepEqual(describeInboundPermissionPreset({ config, task: LAN, dshGo: true }), {
    value: "danger-full-access",
    source: "dsh-go",
  });
});

check("describe：tsnet 收紧 → source=tsnet；默认 → source=default；全空 → source=none", () => {
  assert.deepEqual(
    describeInboundPermissionPreset({ config: dshGoConfig({ tsnetPermissionPreset: "read-only" }), task: TSNET, dshGo: false }),
    { value: "read-only", source: "tsnet" },
  );
  assert.deepEqual(describeInboundPermissionPreset({ config: dshGoConfig(), task: LAN, dshGo: false }), {
    value: "workspace-write",
    source: "default",
  });
  assert.deepEqual(describeInboundPermissionPreset({ config: {}, task: LAN, dshGo: false }), { value: "", source: "none" });
});

check("dshGo 必须是严格 true 才覆盖（字符串 'yes' 不算）", () => {
  const config = dshGoConfig({ permissionPresetOnDshGo: "danger-full-access" });
  assert.equal(resolveInboundPermissionPreset({ config, task: LAN, dshGo: "yes" }), "workspace-write");
});

console.log("\n── 4. 绝不抛（启动路径上的函数）──");

check("无参 / null config / null task / 垃圾值都不抛", () => {
  assert.equal(resolveInboundPermissionPreset(), "");
  assert.equal(resolveInboundPermissionPreset({ config: null, task: null, dshGo: false }), "");
  assert.equal(resolveInboundPermissionPreset({ config: { permissionPreset: 42 }, task: LAN, dshGo: false }), "42");
  assert.equal(
    resolveInboundPermissionPreset({ config: { permissionPreset: "x" }, task: "not-an-object", dshGo: true }),
    "x",
  );
  assert.deepEqual(describeInboundPermissionPreset({ config: null }), { value: "", source: "none" });
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
