/**
 * dsh-go/Android proot 环境探测与相关身份逻辑的自测（**全离线**）。
 *
 * 跑法：node lib/_selftest-dshgo.mjs
 *
 * 为什么需要：`lib/dshgo.js` 的判定依赖真机上才有的文件（/system/build.prop、
 * /opt/dsh-go、Android 内核串……），开发机上一律不存在。所有探测都做成可注入，
 * 这里把"真机形状"和"普通 Linux 形状"都钉住 —— 否则这个模块只有上手机才能验，
 * 而它又是权限默认值/tsnet 资产/osInfo 的共同前提。
 *
 * 覆盖：
 *   1. 真机形状（含 Lead 实测事实：DSH_GO_RUNTIME_ROOT 不存在、getprop 不在 PATH）
 *   2. 普通 Linux/桌面 → 必须 false（否则桌面行为会被改）
 *   3. 各单信号（只有环境变量 / 只有目录 / Android 内核但没挂 /system）
 *   4. 属性读取与注入（build.prop / getprop 兜底）
 *   5. 身份指纹兜底顺序（serial → machine-id → hostname+model）
 *   6. `osString()` 兼容旧字段的格式
 *   7. 永不抛 + 进程级缓存
 */
import assert from "node:assert/strict";
import {
  detectDshGo,
  dshGoInfo,
  dshGoSummary,
  isDshGo,
  androidProp,
  __setDshGoForTest,
  __setAndroidPropsForTest,
  __resetDshGoCacheForTest,
} from "./dshgo.js";
import { dshGoMachineId } from "./identity.js";
import { osString } from "./osinfo.js";

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

/**
 * 默认依赖：模拟一台普通 Linux 桌面（所有 dsh-go 标记都不存在）。
 * 每个用例只覆写自己关心的部分。
 */
function deps(overrides = {}) {
  return {
    env: {},
    release: () => "6.8.0-40-generic",
    exists: () => false,
    isFile: () => false,
    isExecutable: () => false,
    props: {},
    ...overrides,
  };
}

/** 真机形状（dsh-go 0.9.7 + proot Ubuntu 24.04.5 + Android 15 内核）。 */
function realDeviceDeps(overrides = {}) {
  const paths = new Set(["/opt/dsh-go", "/etc/dsh-app", "/system/build.prop", "/dev/__properties__"]);
  return deps({
    // 真机实测：DSH_GO_RUNTIME_ROOT **不存在** —— 探测不能只靠它。
    env: {},
    release: () => "6.6.30-android15-8-g1a2b3c4d-abcd1234",
    exists: (p) => paths.has(p),
    isFile: (p) => p === "/system/build.prop",
    isExecutable: (p) => p === "/system/bin/getprop",
    props: {
      "ro.product.model": "Xiaomi 15 Ultra",
      "ro.build.version.release": "15",
    },
    ...overrides,
  });
}

console.log("\n── 1. 真机形状（dsh-go / proot / Android 15）──");

check("真机形状：isDshGo=true、runtime=proot、机型/版本/证据齐全", () => {
  const info = detectDshGo({ deps: realDeviceDeps() });
  assert.equal(info.isDshGo, true);
  assert.equal(info.runtime, "proot");
  assert.equal(info.androidKernel, true);
  assert.equal(info.systemMounted, true);
  assert.equal(info.deviceModel, "Xiaomi 15 Ultra");
  assert.equal(info.androidVersion, "15");
  assert.ok(info.evidence.some((e) => e.startsWith("file:/system/build.prop")), `缺 build.prop 证据：${info.evidence}`);
  assert.ok(info.evidence.some((e) => e.startsWith("bin:/system/bin/getprop")), `缺 getprop 证据：${info.evidence}`);
  assert.ok(info.evidence.some((e) => e.startsWith("kernel:")), `缺内核证据：${info.evidence}`);
  assert.ok(!info.evidence.some((e) => e.startsWith("env:")), "真机没有 DSH_GO_RUNTIME_ROOT，不该有 env 证据");
});

check("真机形状：即使没有 /opt/dsh-go 这类包装标记（Android proot 类环境）也判定为 true", () => {
  const info = detectDshGo({
    deps: realDeviceDeps({
      exists: (p) => p === "/system/build.prop",
      isExecutable: () => false,
    }),
  });
  assert.equal(info.isDshGo, true);
  assert.equal(info.wrapper, false, "没有包装标记时 wrapper 应为 false");
});

console.log("\n── 2. 普通 Linux/桌面：必须 false（桌面行为零变化的前提）──");

check("普通 Linux：isDshGo=false、runtime 空、无机型", () => {
  const info = detectDshGo({ deps: deps() });
  assert.equal(info.isDshGo, false);
  assert.equal(info.runtime, "");
  assert.equal(info.deviceModel, "");
  assert.deepEqual(info.evidence, []);
});

check("Windows/macOS 开发机同样的默认依赖下也是 false", () => {
  assert.equal(detectDshGo({ deps: deps({ release: () => "10.0.26200" }) }).isDshGo, false);
  assert.equal(detectDshGo({ deps: deps({ release: () => "24.1.0" }) }).isDshGo, false);
});

console.log("\n── 3. 单信号边界 ──");

check("只有环境变量 DSH_GO_RUNTIME_ROOT → true（wrapper 证据）", () => {
  const info = detectDshGo({ deps: deps({ env: { DSH_GO_RUNTIME_ROOT: "/data/user/0/x/files/runtime/rootfs" } }) });
  assert.equal(info.isDshGo, true);
  assert.equal(info.wrapper, true);
  assert.ok(info.evidence.includes("env:DSH_GO_RUNTIME_ROOT"));
});

check("只有 /opt/dsh-go 目录（非 Android 内核）→ true（dsh-go 包装）", () => {
  const info = detectDshGo({ deps: deps({ exists: (p) => p === "/opt/dsh-go" }) });
  assert.equal(info.isDshGo, true);
  assert.equal(info.wrapper, true);
  assert.ok(info.evidence.some((e) => e.startsWith("dir:/opt/dsh-go")));
});

check("Android 内核但没挂 /system、也没包装标记 → false（不误判）", () => {
  const info = detectDshGo({ deps: deps({ release: () => "6.6.30-android15" }) });
  assert.equal(info.isDshGo, false);
  assert.equal(info.androidKernel, true);
  assert.equal(info.systemMounted, false);
});

check("Android 内核 + /system/build.prop → true（Android proot 类环境）", () => {
  const info = detectDshGo({
    deps: deps({ release: () => "5.10.43-android13", exists: (p) => p === "/system/build.prop" }),
  });
  assert.equal(info.isDshGo, true);
  assert.equal(info.wrapper, false);
  assert.equal(info.runtime, "proot");
});

console.log("\n── 4. 属性读取与兜底 ──");

check("props 只给机型时 androidVersion 为空（不瞎猜）", () => {
  const info = detectDshGo({
    deps: deps({ release: () => "6.6.30-android15", exists: (p) => p === "/system/build.prop", props: { "ro.product.model": "Pixel" } }),
  });
  assert.equal(info.deviceModel, "Pixel");
  assert.equal(info.androidVersion, "");
});

check("非 dsh-go 时不读属性（避免在桌面 exec getprop）", () => {
  const info = detectDshGo({ deps: deps({ props: { "ro.product.model": "should-not-be-used" } }) });
  assert.equal(info.deviceModel, "");
});

check("androidProp 可注入（真机 build.prop/getprop 在开发机不存在）", () => {
  __setAndroidPropsForTest({ "ro.product.model": "Xiaomi 15 Ultra", "ro.serialno": "SN-123" });
  try {
    assert.equal(androidProp("ro.product.model"), "Xiaomi 15 Ultra");
    assert.equal(androidProp("ro.serialno"), "SN-123");
    assert.equal(androidProp("not.exist"), "");
    assert.equal(androidProp(""), "");
  } finally {
    __setAndroidPropsForTest(null);
  }
});

console.log("\n── 5. 身份指纹兜底顺序（dshGoMachineId）──");

check("dsh-go：ro.serialno 优先 → android:SN", () => {
  __setAndroidPropsForTest({ "ro.serialno": "SN-DEV-1" });
  try {
    assert.equal(dshGoMachineId(), "android:SN-DEV-1");
  } finally {
    __setAndroidPropsForTest(null);
  }
});

check("dsh-go：ro.boot.serialno 次之", () => {
  __setAndroidPropsForTest({ "ro.boot.serialno": "SN-BOOT-2" });
  try {
    assert.equal(dshGoMachineId(), "android:SN-BOOT-2");
  } finally {
    __setAndroidPropsForTest(null);
  }
});

check("dsh-go：serial 空 → hostname+model 组合；两者都空则返回空（绝不乱认领）", () => {
  __setAndroidPropsForTest({ "ro.product.model": "Xiaomi 15 Ultra" });
  try {
    const withModel = dshGoMachineId();
    assert.ok(withModel.startsWith("dshgo:"), `应退到组合指纹，实际 ${JSON.stringify(withModel)}`);
    assert.ok(withModel.includes("Xiaomi 15 Ultra"));
    __setAndroidPropsForTest({});
    // 开发机上 /etc/machine-id、/proc/sys/kernel/hostname、/etc/hostname 都不存在
    // → host 与 model 都为空 → 必须返回空串，而不是造一个假 ID。
    assert.equal(dshGoMachineId(), "");
  } finally {
    __setAndroidPropsForTest(null);
  }
});

console.log("\n── 6. osString()：兼容旧 os 字段 ──");

check("android：`android <ver> (<kernel>)`", () => {
  assert.equal(osString({ platform: "android", version: "15", kernel: "6.6.30-android15" }), "android 15 (6.6.30-android15)");
});

check("android 缺版本/内核时不留空括号", () => {
  assert.equal(osString({ platform: "android", version: "", kernel: "" }), "android");
  assert.equal(osString({ platform: "android", version: "15", kernel: "" }), "android 15");
});

check("非 android 平台保持 0.5.4 的 `<platform> <kernel>` 格式", () => {
  assert.equal(osString({ platform: "linux", version: "24.04", kernel: "6.8.0-40-generic" }), "linux 6.8.0-40-generic");
  assert.equal(osString({ platform: "win32", kernel: "10.0.26200" }), "win32 10.0.26200");
});

check("垃圾输入不抛，退回当前进程事实", () => {
  assert.equal(typeof osString("not-an-object"), "string");
  assert.ok(osString(null).length > 0);
});

console.log("\n── 7. 缓存 / 摘要 / 永不抛 ──");

check("dshGoInfo 进程级缓存；自测注入可覆盖与恢复", () => {
  __resetDshGoCacheForTest();
  assert.equal(dshGoInfo().isDshGo, false, "本机（Windows 开发机）不该被判定为 dsh-go");
  __setDshGoForTest({ isDshGo: true, runtime: "proot", deviceModel: "Fake", androidVersion: "14" });
  assert.equal(dshGoInfo().isDshGo, true);
  assert.equal(isDshGo(), true);
  assert.equal(dshGoInfo().deviceModel, "Fake");
  __resetDshGoCacheForTest();
  assert.equal(isDshGo(), false);
});

check("dshGoSummary：给诊断用的稳定形状", () => {
  __setDshGoForTest({ isDshGo: true, runtime: "proot", deviceModel: "X", androidVersion: "15", evidence: ["dir:/opt/dsh-go"] });
  try {
    const s = dshGoSummary();
    assert.equal(s.isDshGo, true);
    assert.equal(s.runtime, "proot");
    assert.equal(s.deviceModel, "X");
    assert.ok(Array.isArray(s.evidence));
  } finally {
    __resetDshGoCacheForTest();
  }
});

check("deps 全炸也不抛，返回 false 兜底", () => {
  const boom = () => {
    throw Object.assign(new Error("EPERM"), { code: "EPERM" });
  };
  const info = detectDshGo({
    deps: { env: {}, release: boom, exists: boom, isFile: boom, isExecutable: boom, props: "junk" },
  });
  assert.equal(info.isDshGo, false);
  assert.equal(typeof info.evidence, "object");
});

check("无参/垃圾参数也不抛", () => {
  assert.equal(typeof detectDshGo(), "object");
  assert.equal(typeof detectDshGo(null), "object");
  assert.equal(typeof detectDshGo({ deps: null }), "object");
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
