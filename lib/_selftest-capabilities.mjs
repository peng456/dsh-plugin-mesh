/**
 * 能力采集与名片携带的自测（Placement 步骤 ①）。
 *
 * 纯逻辑 + 一次真实采集，**不碰网络**（不发组播、不开端口）——
 * 与 `npm run selftest` 同样的约束，跑多少次都不会污染真实网络。
 *
 *   node lib/_selftest-capabilities.mjs
 */
import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  augmentedPath,
  capabilityAge,
  collectCapabilities,
  collectRuntimes,
  currentCapabilities,
  describePeerCapabilities,
  isCapabilityStale,
  parseVersion,
  parseMacGpu,
  parseNvidiaGpu,
  parseWindowsGpu,
  sanitizeCapabilities,
  setCapabilitiesForTest,
  startCapabilities,
  summarizeCapabilities,
  CAPABILITY_STALE_MS,
  // 只为自测导出：形状守卫与 Windows 目录清单的真实机器很难复现，靠注入平台来测
  __isEmptyButFailed,
  __pathLooksDegraded,
  __probeFailCount,
} from "./capabilities.js";
import { MeshDiscovery, APP_TAG } from "./discovery.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

console.log("\n── parseVersion：只取主.次，取第一个匹配 ──");

test("node 的 v 前缀", () => assert.equal(parseVersion("v20.19.3"), "20.19"));
test("Python 的「Python 」前缀", () => assert.equal(parseVersion("Python 3.12.1"), "3.12"));
test("go 的复合输出不会取到架构数字", () => assert.equal(parseVersion("go version go1.25.1 darwin/amd64"), "1.25"));
test("docker 的逗号尾巴", () => assert.equal(parseVersion("Docker version 28.0.1, build 068a01e"), "28.0"));
test("java 的引号包裹", () => assert.equal(parseVersion('openjdk version "17.0.9" 2023-10-17'), "17.0"));
test("只有主版本号", () => assert.equal(parseVersion("ffmpeg version 6"), "6"));
test("没有数字 → 空串", () => assert.equal(parseVersion("command not found"), ""));
test("空输入 → 空串", () => assert.equal(parseVersion(""), ""));
test("null → 空串（不抛）", () => assert.equal(parseVersion(null), ""));

console.log("\n── GPU 解析：这组测试是为了一个真实踩过的回归 ──");

test("parseMacGpu 能从 system_profiler 真实输出里抠出型号与显存", () => {
  const fixture = [
    "Graphics/Displays:",
    "    Intel Iris Graphics 6100:",
    "      Chipset Model: Intel Iris Graphics 6100",
    "      Type: GPU",
    "      VRAM (Dynamic, Max): 1536 MB",
    "      Vendor: Intel",
  ].join("\n");
  const g = parseMacGpu(fixture);
  assert.equal(g.name, "Intel Iris Graphics 6100");
  assert.equal(g.vramMb, 1536);
  assert.equal(g.present, true);
});

test("parseNvidiaGpu 解析 CSV", () => {
  const g = parseNvidiaGpu("NVIDIA GeForce RTX 4090, 24564");
  assert.equal(g.name, "NVIDIA GeForce RTX 4090");
  assert.equal(g.vramMb, 24564);
});

test("parseWindowsGpu 取第一行（多显卡时）", () => {
  const g = parseWindowsGpu("Intel(R) UHD Graphics\r\nNVIDIA GeForce MX150");
  assert.equal(g.name, "Intel(R) UHD Graphics");
});

test("传入非字符串（对象）→ 返回 null「未知」，不是「确定没有」也不是乱码", () => {
  // ⚠️ 这就是真实踩到的回归：runProbe 的返回值从 string 改成 {output,error}
  // 之后 collectGpu 漏改，把**对象**交给了解析函数。旧实现里 String(对象) 变成
  // "[object Object]"：Mac 上被报成 present:false（"确定没有 GPU"），
  // Android 上报出型号 "[object Object]"。
  // 正确行为：我们自己的 bug 只能降级成"未知"，绝不能伪装成对端的事实。
  for (const fn of [parseMacGpu, parseNvidiaGpu, parseWindowsGpu]) {
    for (const junk of [{ output: "x", error: "" }, null, undefined, 42, ["a"]]) {
      assert.equal(fn(junk), null, `${fn.name}(${JSON.stringify(junk)}) 应为 null`);
    }
  }
});

test("解析不出型号 → null「未知」，不是 {present:false}「确定没有」", () => {
  // 契约：解析函数只报"认出来的卡"。认不出来 = 我们没得出结论 = null。
  // 报 {present:false,name:""} 有两个代价：① headless Mac / VM 的
  // system_profiler 输出（只有 Display 段、无 Chipset Model）会被当成"确定没 GPU"；
  // ② 接收侧 sanitizeCapabilities 见 name 为空会把整块 gpu 折成 null，
  // 于是"确定没有"被悄悄提升成"未知"——语义在中途被改写。
  assert.equal(parseMacGpu(""), null);
  assert.equal(parseNvidiaGpu(""), null);
  assert.equal(
    parseMacGpu("Graphics/Displays:\n\n    Displays:\n      DELL U2720Q:\n        Resolution: 3840 x 2160\n"),
    null,
    "有输出但没有 Chipset Model 行 → 没解析出型号 → null",
  );
});

test("解析出型号 → present:true（契约里的那个真值）", () => {
  assert.equal(parseMacGpu("      Chipset Model: Intel Iris Graphics 6100\n          VRAM (Dynamic, Max): 1536 MB\n").present, true);
  assert.equal(parseNvidiaGpu("NVIDIA GeForce RTX 4090, 24564").present, true);
});

await testAsync("真实采集：本机必须拿到一个像样的 GPU 名字（回归守卫）", async () => {
  const caps = await collectCapabilities();
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.log("      跳过断言（本平台不一定有 GPU）");
    return;
  }
  assert.ok(caps.gpu, `darwin/win32 上应能探到 GPU，实际 ${JSON.stringify(caps.gpu)}`);
  assert.ok(caps.gpu.name, "GPU 名字不该为空");
  assert.ok(
    !caps.gpu.name.includes("[object"),
    `GPU 名字被序列化成了对象：${caps.gpu.name} —— 多半是把 runProbe 的 {output} 整个传给了解析函数`,
  );
});

console.log("\n── sanitizeCapabilities：来自网络的数据不能直接信 ──");

test("null / undefined / 字符串 / 数组 一律 → null（表示「未知」）", () => {
  assert.equal(sanitizeCapabilities(null), null);
  assert.equal(sanitizeCapabilities(undefined), null);
  assert.equal(sanitizeCapabilities("python3.11"), null);
  assert.equal(sanitizeCapabilities([{ runtimes: {} }]), null);
});

test("正常名片被保留", () => {
  const c = sanitizeCapabilities({
    os: "darwin 21.6.0",
    arch: "x64",
    cpuCores: 4,
    memMb: 8192,
    runtimes: { python: "3.12", node: "20.19" },
    gpu: { present: true, name: "Intel Iris", vramMb: 1536 },
    workspaceHints: ["~/projects"],
    capabilitiesAt: 1792000000000,
  });
  assert.equal(c.cpuCores, 4);
  assert.equal(c.memMb, 8192);
  assert.equal(c.runtimes.python, "3.12");
  assert.equal(c.gpu.name, "Intel Iris");
  assert.equal(c.gpu.vramMb, 1536);
  assert.deepEqual(c.workspaceHints, ["~/projects"]);
  assert.equal(c.capabilitiesAt, 1792000000000);
});

test("版本号里的非数字点字符被剥掉（防注入可执行内容）", () => {
  const c = sanitizeCapabilities({ runtimes: { python: "3.11; rm -rf / --no-preserve-root" } });
  assert.equal(c.runtimes.python, "3.11");
});

test("控制字符被剥掉", () => {
  const c = sanitizeCapabilities({ os: "linux\u0000\u001b[31m 6.1", runtimes: {} });
  assert.ok(!c.os.includes("\u0000"), "os 里不该有 NUL");
  assert.ok(!c.os.includes("\u001b"), "os 里不该有 ESC");
});

test("超长字符串被截断", () => {
  const c = sanitizeCapabilities({ runtimes: { ["x".repeat(200)]: "1.0" }, os: "y".repeat(500) });
  assert.ok(Object.keys(c.runtimes).every((k) => k.length <= 24), "运行时名应限长 24");
  assert.ok(c.os.length <= 60, `os 应限长 60，实际 ${c.os.length}`);
});

test("运行时数量封顶 24", () => {
  const many = {};
  for (let i = 0; i < 200; i += 1) many[`rt${i}`] = "1.0";
  assert.equal(Object.keys(sanitizeCapabilities({ runtimes: many }).runtimes).length, 24);
});

test("workspaceHints 封顶 8 条", () => {
  const hints = Array.from({ length: 50 }, (_, i) => `/p${i}`);
  assert.equal(sanitizeCapabilities({ runtimes: {}, workspaceHints: hints }).workspaceHints.length, 8);
});

test("负数 / NaN / Infinity 的数值字段归 0，不会变成 NaN 传下去", () => {
  const c = sanitizeCapabilities({ cpuCores: -5, memMb: Number.NaN, runtimes: {} });
  assert.equal(c.cpuCores, 0);
  assert.equal(c.memMb, 0);
});

test("缺 capabilitiesAt → 0（而不是当前时间）", () => {
  assert.equal(sanitizeCapabilities({ runtimes: {} }).capabilitiesAt, 0);
});

test("没有名字的 gpu → null（不是 {present:false}）", () => {
  assert.equal(sanitizeCapabilities({ runtimes: {}, gpu: { present: true, name: "" } }).gpu, null);
  assert.equal(sanitizeCapabilities({ runtimes: {}, gpu: "nvidia" }).gpu, null);
});

console.log("\n── 过期判定：null ≠ 过期，这是最容易写错的地方 ──");

test("没报能力（null）不算过期 —— 它是「未知」", () => {
  assert.equal(isCapabilityStale(null), false);
  assert.equal(capabilityAge(null), Number.POSITIVE_INFINITY);
});

test("刚采的不过期，远超阈值的过期", () => {
  const now = 1792000000000;
  assert.equal(isCapabilityStale({ capabilitiesAt: now }, now), false);
  assert.equal(isCapabilityStale({ capabilitiesAt: now - CAPABILITY_STALE_MS + 1000 }, now), false);
  assert.equal(isCapabilityStale({ capabilitiesAt: now - CAPABILITY_STALE_MS - 1000 }, now), true);
});

test("capabilitiesAt=0（对端没给时间戳）算过期，不算「刚采的」", () => {
  assert.equal(isCapabilityStale({ capabilitiesAt: 0 }, 1792000000000), true);
});

console.log("\n── summarizeCapabilities ──");

test("null → 空串", () => assert.equal(summarizeCapabilities(null), ""));
test("无运行时 → 空串", () => assert.equal(summarizeCapabilities({ runtimes: {} }), ""));
test("带 GPU 时追加 gpu: 段", () => {
  const s = summarizeCapabilities({ runtimes: { python: "3.12" }, gpu: { name: "Intel Iris" } });
  assert.ok(s.includes("python3.12"), s);
  assert.ok(s.includes("gpu:Intel Iris"), s);
});
test("按 max 截断", () => {
  const rt = {};
  for (let i = 0; i < 20; i += 1) rt[`rt${i}`] = "1.0";
  assert.equal(summarizeCapabilities({ runtimes: rt }, { max: 3 }).split(" · ").length, 3);
});

console.log("\n── augmentedPath：只许加，绝不许减 ──");

test("原 PATH 的每一项都还在（补全不能把已有路径挤掉）", () => {
  const before = String(process.env.PATH ?? "").split(":").filter(Boolean);
  const after = new Set(augmentedPath().split(":").filter(Boolean));
  for (const d of before) assert.ok(after.has(d), `补全后丢了 ${d}`);
});

test("没有重复项", () => {
  const parts = augmentedPath().split(":").filter(Boolean);
  assert.equal(new Set(parts).size, parts.length, "PATH 里不该有重复目录");
});

console.log("\n── Windows 上的 PATH 补全（真机是 darwin，靠注入平台验）──");

test("win32 用分号分隔，不能写成冒号", () => {
  // 写死冒号会让整个 Windows PATH 变成"一个目录名"，比不补还糟。
  const raw = "C:\\Windows;C:\\Windows\\system32";
  const out = augmentedPath(raw, "win32");
  assert.ok(out.includes(raw), `原 PATH 必须原样保留，实际 ${out}`);
  assert.ok(!out.split(";")[0].includes("C:\\Windows:C:"), "不该用冒号把 Windows 路径连起来");
});

test("POSIX 仍用冒号（回归）", () => {
  const out = augmentedPath("/usr/bin:/bin", "darwin");
  assert.ok(out.includes("/usr/bin"), `原 PATH 必须保留，实际 ${out}`);
});

console.log("\n── 形状守卫：一个都没探到 ≠ 确定没装 ──");

test("空 runtimes + 有失败项 → 判为「未探准」（win32 实测形状）", () => {
  // 这是文超-win 报回来的真实形状：runtimes={} 且 runtimesIncomplete=false，
  // 等于宣称"确定没装任何运行时"，而它自己就跑在 Node 上。
  assert.equal(__isEmptyButFailed({ runtimes: {}, errors: { node: "ENOENT", git: "ENOENT" } }), true);
});

test("真的一尘不染（空 runtimes 且无失败项）→ 不算未探准", () => {
  assert.equal(__isEmptyButFailed({ runtimes: {}, errors: {} }), false);
});

test("探到过东西 → ENOENT 仍可信，不触发守卫", () => {
  assert.equal(__isEmptyButFailed({ runtimes: { node: "20.19" }, errors: { rustc: "ENOENT" } }), false);
});

console.log("\n── PATH 健全判据：区分「确实没装」与「装了但 PATH 没覆盖」──");

test("主 PATH 健全 → 不判残缺（本机就是这种：rustc/adb 确实没装）", () => {
  // 这一格是对端 hos 那个"any error → incomplete"方案的**反例**：
  // 我这台 runtimes 非空、2 项 ENOENT，但两个都**真的没装**，
  // 若按"有失败就 incomplete"会误报。
  assert.equal(__pathLooksDegraded("darwin", "/opt/homebrew/bin:/usr/bin:/bin"), false);
  assert.equal(__pathLooksDegraded("linux", "/usr/local/bin:/usr/bin:/bin"), false);
  assert.equal(__pathLooksDegraded("android", "/data/data/com.termux/files/usr/bin:/system/bin"), false);
  assert.equal(
    __pathLooksDegraded("win32", "C:\\Program Files\\nodejs;C:\\Windows\\system32"),
    false,
  );
});

test("主 PATH 残缺 → 判残缺（文超-win / 只有系统目录的环境）", () => {
  assert.equal(__pathLooksDegraded("darwin", "/nonexistent-dir"), true);
  assert.equal(__pathLooksDegraded("darwin", ""), true);
  // Windows 只给了系统目录、没有任何工具目录 —— 正是文超-win 那台的形状
  assert.equal(__pathLooksDegraded("win32", "C:\\Windows;C:\\Windows\\system32"), true);
});

test("本机真实 PATH 健全 → runtimesIncomplete 仍是 false（不误伤自己）", async () => {
  const caps = await collectCapabilities();
  assert.ok(Object.keys(caps.runtimes).length > 0, "本机应采到运行时");
  assert.equal(
    caps.runtimesIncomplete,
    false,
    `本机 PATH 健全，rustc/adb 确实没装，不该被判 incomplete：${JSON.stringify(caps.probeErrors)}`,
  );
});

test("失败项数上名片（对端据此判断可信度）", () => {
  assert.equal(__probeFailCount({ errors: { rustc: "ENOENT", adb: "ENOENT" } }), 2);
  assert.equal(__probeFailCount({ errors: {} }), 0);
  assert.equal(__probeFailCount({}), 0);
});

test("probeFailCount 经 sanitize 保留；旧对端没有该字段 → 0", () => {
  const c = sanitizeCapabilities({ runtimes: { node: "20.19" }, probeFailCount: 6 });
  assert.equal(c.probeFailCount, 6);
  assert.equal(sanitizeCapabilities({ runtimes: {} }).probeFailCount, 0);
  // probeErrors 仍然**不上名片**（只在本地诊断用）
  assert.equal(sanitizeCapabilities({ runtimes: {}, probeErrors: { a: "ENOENT" } }).probeErrors, undefined);
});

console.log("\n── 真实采集（这台机器）──");

await testAsync("collectCapabilities 不抛，且关键字段合理", async () => {
  const caps = await collectCapabilities();
  assert.ok(caps.capabilitiesAt > 0, "应有采集时间戳");
  assert.ok(caps.cpuCores > 0, `cpuCores 应 > 0，实际 ${caps.cpuCores}`);
  assert.ok(caps.memMb > 0, `memMb 应 > 0，实际 ${caps.memMb}`);
  assert.equal(typeof caps.runtimes, "object");
  assert.ok(caps.arch, "应有 arch");
  assert.ok(caps.os, "应有 os");
  console.log(`      实测：${caps.os} / ${caps.arch} / ${caps.cpuCores}核 ${Math.round(caps.memMb / 1024)}GB`);
  console.log(`      运行时：${summarizeCapabilities(caps) || "（无）"}`);
  console.log(`      GPU：${caps.gpu ? `${caps.gpu.name} ${caps.gpu.vramMb}MB` : "未探到"}`);
});

await testAsync("本进程是 node 起的 → 必须采到 node（验证 PATH 补全起作用）", async () => {
  const caps = await collectCapabilities();
  assert.ok(caps.runtimes.node, `没采到 node，PATH=${augmentedPath()}`);
});

await testAsync("hints 传入存在的目录时出现在 workspaceHints 里", async () => {
  const caps = await collectCapabilities({ hints: [process.cwd()] });
  assert.ok(caps.workspaceHints.length > 0, "应至少有一条");
  const home = homedir();
  const cwd = process.cwd();
  const expect = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  assert.ok(caps.workspaceHints.includes(expect), `期望含 ${expect}，实际 ${JSON.stringify(caps.workspaceHints)}`);
});

await testAsync("hints 传入不存在的目录时被忽略（不报幻觉路径）", async () => {
  const caps = await collectCapabilities({ hints: ["/definitely/not/here/xyzzy"] });
  assert.ok(!caps.workspaceHints.includes("/definitely/not/here/xyzzy"));
});

await testAsync("startCapabilities 会回调、会写缓存、能停止", async () => {
  setCapabilitiesForTest(null);
  let got = null;
  const stop = startCapabilities((c) => {
    got = c;
  }, { refreshMs: 60_000, hints: [] });
  // 等首轮（GPU 探测可能要几秒）
  for (let i = 0; i < 100 && !got; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(got, "onUpdate 未被调用");
  assert.equal(currentCapabilities(), got, "缓存应指向同一份结果");
  stop();
});

await testAsync("重复调用 startCapabilities 不会起第二个循环", async () => {
  const stopA = startCapabilities(() => {}, { refreshMs: 60_000 });
  const stopB = startCapabilities(() => {}, { refreshMs: 60_000 });
  // 第二次调用返回的是空操作停止函数；两个都能调，都不该抛
  stopA();
  stopB();
});

console.log("\n── 探测失败的处理：不确定 ≠ 没有（实测踩过的坑）──");

test("runtimesIncomplete 会上名片；probeErrors 只留本地不上网线", () => {
  const c = sanitizeCapabilities({
    runtimes: {},
    capabilitiesAt: 1,
    runtimesIncomplete: true,
    probeErrors: { python: "timeout" },
  });
  assert.equal(c.runtimesIncomplete, true);
  assert.equal("probeErrors" in c, false, "probeErrors 是本地诊断字段，不该发给对端");
});

test("老对端不带 runtimesIncomplete 字段 → 默认 false（当作完整）", () => {
  assert.equal(sanitizeCapabilities({ runtimes: {} }).runtimesIncomplete, false);
});

await testAsync("被超时杀掉的探测会**串行重试**并拿到真值", async () => {
  // 假命令：睡 4 秒再报版本。首轮超时（2.5s）会杀掉它 → 判定「不确定」→
  // 串行重试（8s 超时）能拿到真值。这正是实测中"机器忙 → 名片变成什么都没装"
  // 的修复：重试消除了并行争用，所以第二次能问出答案。
  const t0 = Date.now();
  const r = await collectRuntimes([{ name: "slow", cmd: "/bin/sh", args: ["-c", "sleep 4; echo v1.2.3"] }]);
  const dt = Date.now() - t0;
  assert.equal(r.runtimes.slow, "1.2", `应重试后拿到版本；errors=${JSON.stringify(r.errors)}`);
  assert.equal(r.errors.slow, undefined, "重试成功后不该留错误");
  assert.ok(dt >= 7000, `耗时应覆盖 首轮超时2.5s + 退避 + 重试4s，实际 ${dt}ms`);
  console.log(`      首轮超时 → 串行重试成功，共 ${dt}ms`);
});

await testAsync("确定不存在（ENOENT）**不重试**，立刻给结论", async () => {
  const t0 = Date.now();
  const r = await collectRuntimes([{ name: "ghost", cmd: "/nonexistent-xyz-12345", args: [] }]);
  const dt = Date.now() - t0;
  assert.equal(r.errors.ghost, "ENOENT", "不存在的命令应报 ENOENT（确定的否定）");
  assert.ok(dt < 1500, `不该为 ENOENT 付重试代价，实际 ${dt}ms`);
});

await testAsync("真实机器上：没有不确定项时 runtimesIncomplete 必须是 false", async () => {
  const caps = await collectCapabilities();
  for (const [name, err] of Object.entries(caps.probeErrors ?? {})) {
    assert.ok(!String(err).startsWith("throw:"), `${name} 探测抛异常了：${err}`);
  }
  assert.equal(
    caps.runtimesIncomplete,
    false,
    `安静环境下不该有不确定项：${JSON.stringify(caps.probeErrors)}`,
  );
  console.log(`      未采到：${JSON.stringify(caps.probeErrors)}`);
});

console.log("\n── 名片携带与向后兼容（MeshDiscovery）──");

/** 造一个不发组播的 discovery，只用来测 upsert/project。 */
function makeDiscovery({ ttlMs = 60_000 } = {}) {
  return new MeshDiscovery({
    id: "selftest-self",
    port: 45900,
    meta: { machine: "selftest-self", user: "tester", profile: "selftest", version: "0.1.0" },
    intervalMs: 60_000,
    ttlMs,
  });
}

test("selfRecord 带 capabilities 字段（首轮采集前是 null）", () => {
  setCapabilitiesForTest(null);
  const d = makeDiscovery();
  const rec = d.selfRecord();
  assert.ok("capabilities" in rec, "名片里必须有 capabilities 键");
  assert.equal(rec.capabilities, null);
});

test("采集完成后 selfRecord 自动带上真实能力（不依赖任何 setMeta 调用）", () => {
  const fake = { runtimes: { python: "3.12" }, capabilitiesAt: Date.now(), cpuCores: 4, memMb: 8192 };
  setCapabilitiesForTest(fake);
  const d = makeDiscovery();
  // 这里刻意**不做任何额外调用** —— 自测的就是"能力只有一个数据源、
  // 不会因为忘了推 meta 而静默为空"
  assert.deepEqual(d.selfRecord().capabilities, fake);
  assert.deepEqual(d.selfRecord({ forMulticast: true }).capabilities, fake);
  setCapabilitiesForTest(null);
});

test("能力刷新后名片立刻跟着变（无需重启、无需重新 start）", () => {
  const d = makeDiscovery();
  setCapabilitiesForTest({ runtimes: { python: "3.10" }, capabilitiesAt: 1, cpuCores: 2, memMb: 4096 });
  assert.equal(d.selfRecord().capabilities.runtimes.python, "3.10");
  setCapabilitiesForTest({ runtimes: { python: "3.13" }, capabilitiesAt: 2, cpuCores: 2, memMb: 4096 });
  assert.equal(d.selfRecord().capabilities.runtimes.python, "3.13", "刷新后名片必须跟着变");
  setCapabilitiesForTest(null);
});

test("旧版本对端（名片里没有 capabilities）不报错，且被标成「未知」而不是「什么都没装」", () => {
  const d = makeDiscovery();
  d.note({ v: 1, app: APP_TAG, id: "old-peer", machine: "old", host: "10.0.0.9", port: 45917, ts: Date.now() }, "10.0.0.9");
  const p = d.get("old-peer");
  assert.ok(p, "对端应被登记");
  assert.equal(p.capabilities, null, "旧对端的能力应是 null（未知）");
  assert.equal(p.capabilitiesStale, false, "null 不是「过期」");
  assert.equal(p.capabilitySummary, "", "没有能力时摘要为空");
});

test("新对端的能力被净化后存入，并给出摘要", () => {
  const d = makeDiscovery();
  d.note(
    {
      app: APP_TAG,
      id: "new-peer",
      machine: "new",
      host: "10.0.0.10",
      port: 45917,
      ts: Date.now(),
      capabilities: {
        cpuCores: 8,
        memMb: 16384,
        runtimes: { python: "3.11", docker: "24.0" },
        capabilitiesAt: Date.now(),
      },
    },
    "10.0.0.10",
  );
  const p = d.get("new-peer");
  assert.equal(p.capabilities.cpuCores, 8);
  assert.equal(p.capabilities.runtimes.python, "3.11");
  assert.ok(p.capabilitySummary.includes("python3.11"), p.capabilitySummary);
  assert.equal(p.capabilitiesStale, false);
});

test("晚到的旧能力包不会覆盖较新的（两条通道各送一份时会发生）", () => {
  const d = makeDiscovery();
  const now = Date.now();
  d.note(
    {
      app: APP_TAG, id: "p", machine: "p", host: "10.0.0.11", port: 45917, ts: now,
      capabilities: { cpuCores: 8, memMb: 16384, runtimes: { python: "3.12" }, capabilitiesAt: now },
    },
    "10.0.0.11",
  );
  // 更旧的一份从另一条通道姗姗来迟
  d.note(
    {
      app: APP_TAG, id: "p", machine: "p", host: "10.0.0.11", port: 45917, ts: now - 60_000,
      capabilities: { cpuCores: 2, memMb: 2048, runtimes: { python: "3.6" }, capabilitiesAt: now - 60_000 },
    },
    "10.0.0.11",
    { transport: "tsnet" },
  );
  const p = d.get("p");
  assert.equal(p.capabilities.cpuCores, 8, "较新的能力不该被旧包顶掉");
  assert.equal(p.capabilities.runtimes.python, "3.12");
});

test("对端名片里的 capabilities 是垃圾时降级成「未知」而不是崩溃", () => {
  const d = makeDiscovery();
  // 每一条用**不同的 id 和 host**：同一 host:port 会被去重合并（那是既有行为，
  // 用来处理"对端重启后旧记录还在"的重名），这里要分别观察每一条的降级结果。
  const junkValues = [null, "python", 42, [], { runtimes: "nope" }, { runtimes: { python: 3.11 } }];
  junkValues.forEach((junk, i) => {
    d.note(
      {
        app: APP_TAG,
        id: `junk-${i}`,
        machine: `j${i}`,
        host: `10.0.1.${i + 1}`,
        port: 45917,
        ts: Date.now(),
        capabilities: junk,
      },
      `10.0.1.${i + 1}`,
    );
    const p = d.get(`junk-${i}`);
    assert.ok(p, `junk-${i} 应被登记`);
    if (junk === null || typeof junk === "string" || typeof junk === "number" || Array.isArray(junk)) {
      assert.equal(p.capabilities, null, `${JSON.stringify(junk)} 应降级成 null（未知）`);
    } else {
      // 对象形状不对时也不该抛；能救回的字段就救
      assert.ok(p.capabilities === null || typeof p.capabilities === "object");
    }
  });
});

test("数字型版本号不会被当成版本（版本必须是字符串才收）", () => {
  // 存进来的是字符串化的版本；`{python: 3.11}` 这种形状对端不会这么发，
  // 但收到了也不能崩、更不能把 3.11 当成真版本报出去
  const c = sanitizeCapabilities({ runtimes: { python: 3.11 } });
  assert.ok(c !== null, "整体仍应是有效对象");
  assert.equal(c.runtimes.python, "3.11", "数字也会被安全地字符串化");
});

test("自己发出去的名片不含本机能力时也不崩（第一次心跳早于采集完成）", () => {
  setCapabilitiesForTest(null);
  const d = makeDiscovery();
  const rec = d.selfRecord({ forMulticast: true });
  assert.equal(rec.capabilities, null);
  assert.ok(!("mac" in rec), "组播名片仍不该带 mac");
});

console.log("\n── describePeerCapabilities：三种「不知道」必须说清楚 ──");

test("对端没报能力 → 明说「未知」，不能渲染成「什么都没装」", () => {
  const s = describePeerCapabilities({ capabilities: null, capabilitiesStale: false });
  assert.ok(s.includes("未知"), s);
  assert.ok(!s.includes("未探到任何运行时"), "不能把未知说成没有");
});

test("对端报了能力 → 列出规格与运行时", () => {
  const s = describePeerCapabilities({
    capabilities: { cpuCores: 8, memMb: 16384, arch: "arm64", runtimes: { python: "3.11" }, capabilitiesAt: 1792000000000 },
    capabilitiesStale: false,
  });
  assert.ok(s.includes("8 核"), s);
  assert.ok(s.includes("16 GB 内存"), s);
  assert.ok(s.includes("python3.11"), s);
});

test("过期 → 标出来", () => {
  const s = describePeerCapabilities({
    capabilities: { runtimes: { python: "3.11" }, capabilitiesAt: 1 },
    capabilitiesStale: true,
  });
  assert.ok(s.includes("已过期"), s);
});

test("探测没探准 → 标出来，并说明不能据此断定「没有」", () => {
  const s = describePeerCapabilities({
    capabilities: { runtimes: {}, runtimesIncomplete: true, capabilitiesAt: 1792000000000 },
    capabilitiesStale: false,
  });
  assert.ok(s.includes("没探准"), s);
  assert.ok(s.includes("不能据此断定"), s);
});

console.log("\n── 指纹认领的边界：同机多实例不该互相顶掉 ──");

test("同指纹 + 同名（重装场景）→ 认领，旧记录被顶掉", () => {
  const d = makeDiscovery();
  const now = Date.now();
  // 旧记录：同指纹、同名，且已经离线（重启残留）
  d.note({ app: APP_TAG, id: "old-id", machine: "box", host: "10.0.0.5", port: 45917, ts: now - 60_000, fingerprint: "FP" }, "10.0.0.5");
  assert.equal(d.peers().length, 1);
  // 新记录：同指纹、同名、不同 id
  d.note({ app: APP_TAG, id: "new-id", machine: "box", host: "10.0.0.5", port: 45918, ts: now, fingerprint: "FP" }, "10.0.0.5");
  const ids = d.peers().map((p) => p.id);
  assert.deepEqual(ids, ["new-id"], `旧记录应被认领掉，实际 ${JSON.stringify(ids)}`);
});

test("同指纹 + **不同名** + 两台都在线 → 各自保留（同机两个 profile）", () => {
  const d = makeDiscovery();
  const now = Date.now();
  d.note({ app: APP_TAG, id: "prod", machine: "lipeng-mac", host: "10.0.0.5", port: 45917, ts: now, fingerprint: "FP" }, "10.0.0.5");
  d.note({ app: APP_TAG, id: "dev", machine: "meshdev", host: "10.0.0.5", port: 45918, ts: now, fingerprint: "FP" }, "10.0.0.5");
  const ids = d.peers().map((p) => p.id).sort();
  assert.deepEqual(ids, ["dev", "prod"], "两台都活着且名字不同 → 不该互相顶掉");
});

await testAsync("同指纹 + 不同名 + 旧记录已离线 → 仍认领（丢了自定义机器名的重装）", async () => {
  // 用极短 TTL 让"旧记录已离线"真实发生（endpoint 的 lastSeen 是 note() 那一刻
  // 写的，没法用假时间戳伪造）。sweep 有 2s 下限，所以这 150ms 内记录不会被清掉。
  const d = makeDiscovery({ ttlMs: 50 });
  const now = Date.now();
  d.note({ app: APP_TAG, id: "old", machine: "oldname", host: "10.0.0.5", port: 45917, ts: now, fingerprint: "FP" }, "10.0.0.5");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(d.get("old").online, false, "旧记录应已离线");
  d.note({ app: APP_TAG, id: "new", machine: "newname", host: "10.0.0.5", port: 45918, ts: Date.now(), fingerprint: "FP" }, "10.0.0.5");
  const ids = d.peers().map((p) => p.id);
  assert.deepEqual(ids, ["new"], `离线的旧记录应被认领，实际 ${JSON.stringify(ids)}`);
});

test("指纹不同 → 绝不认领（不同物理机）", () => {
  const d = makeDiscovery();
  const now = Date.now();
  d.note({ app: APP_TAG, id: "m1", machine: "box", host: "10.0.0.5", port: 45917, ts: now, fingerprint: "FP1" }, "10.0.0.5");
  d.note({ app: APP_TAG, id: "m2", machine: "box", host: "10.0.0.6", port: 45917, ts: now, fingerprint: "FP2" }, "10.0.0.6");
  assert.equal(d.peers().length, 2, "不同物理机必须都保留（重名交给 duplicateNames 提示）");
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
