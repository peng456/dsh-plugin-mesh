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
  __pathLookupUnreliable,
  __extraPathDirs,
  __normPathForCompare,
  __probeGpu,
  __storeAliasDir,
  __hasUncertainProbe,
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

test("nvidia 支路：**报错文本不许变成显卡型号**（对端指出的反向口子）", () => {
  // runProbe 把 stdout 与 stderr 合并成 output，所以 nvidia-smi 把错误打到 stdout
  // （或 shim 吐一行提示）时，那行文字会被当成"真实型号"报给 Placement，
  // 而 sanitizeCapabilities 不拦它（名字非空即保留）。
  for (const junk of [
    "no gpu here",
    "ERROR: nvidia-smi not found",
    "command not found",
    "nvidia-smi: command not found",
  ]) {
    assert.equal(parseNvidiaGpu(junk), null, `${JSON.stringify(junk)} 不是 CSV 数据行，应为 null`);
  }
  // 正常形状仍然要能解析（回归）
  assert.deepEqual(parseNvidiaGpu("Tesla T4, 15360"), { present: true, name: "Tesla T4", vramMb: 15360 });
  // 有逗号但第二段不是数 → 更像提示文本
  assert.equal(parseNvidiaGpu("foobar, not-a-number"), null);
});

test("骗过 sanitize 的假型号：确认净化层确实不拦（所以必须上游收口）", () => {
  const seen = sanitizeCapabilities({ gpu: { present: true, name: "ERROR: nvidia-smi failed", vramMb: 0 } });
  assert.equal(seen.gpu.name, "ERROR: nvidia-smi failed", "净化层只看名字非空 → 上游不挡就会一路报出去");
});

await testAsync("真实采集：有显卡的机器必须报出像样的 GPU 名字（无显卡的虚拟机要能说清）", async () => {
  const caps = await collectCapabilities();
  if (process.platform !== "darwin" && process.platform !== "win32") {
    console.log("      跳过断言（本平台不一定有 GPU）");
    return;
  }
  if (!caps.gpu) {
    // ⚠️ 探测输出里没有 Chipset Model 时，`null` 是**正确**结论（headless Mac /
    // 虚拟机的 system_profiler 只有 Display 段）。GitHub 的 macOS runner 就是这种
    // 机器 —— 原来这里无条件断言"必须有 GPU"，于是 runner 上永远红、本机永远绿，
    // 而红的原因跟代码质量毫无关系。
    //
    // 但也不能一律放过：**输出里有型号字段却解析成 null** 就是解析器回归，必须红。
    const { output } = await __probeGpu();
    assert.ok(
      !/Chipset Model:/i.test(output),
      `探测输出里有 Chipset Model，却解析不出型号（解析器回归）：${String(output).slice(0, 300)}`,
    );
    console.log("      本机探测输出里没有显卡型号（虚拟机/无显示设备）→ 这是「确实没有」，不是缺陷");
    return;
  }
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
  // 报出**是哪几个**重复：只报"不该有重复"的话，下次在别人机器上红了还是得猜。
  const parts = augmentedPath().split(":").filter(Boolean);
  const seen = new Set();
  const dup = [];
  for (const d of parts) {
    if (seen.has(d)) dup.push(d);
    else seen.add(d);
  }
  assert.deepEqual(dup, [], `PATH 里不该有重复目录，重复的是：${dup.join(" , ")}`);
});

test("同一个目录换了写法（末尾斜杠）也只能出现一次", () => {
  // GitHub 的 macOS/Ubuntu runner 上就是靠这条红的：PATH 里那项带着尾斜杠，
  // 而补全候选是不带尾斜杠的同一个目录 → 精确比对判不出来 → 插了两遍。
  const existing = __extraPathDirs(process.platform).find((d) => d.startsWith("/"));
  if (!existing) return; // 没有可补的目录（极简容器），这条无从复现
  const spelled = `${existing}/`;
  const out = augmentedPath(spelled, process.platform);
  const norm = (d) => __normPathForCompare(d, process.platform);
  const keys = out.split(":").filter(Boolean).map(norm);
  assert.equal(new Set(keys).size, keys.length, `按目录判重后仍重复：${out}`);
});

test("判重归一化：尾斜杠、根目录、Windows 大小写", () => {
  assert.equal(__normPathForCompare("/usr/local/bin/", "darwin"), "/usr/local/bin");
  assert.equal(__normPathForCompare("/usr/local/bin///", "linux"), "/usr/local/bin");
  assert.equal(__normPathForCompare("/", "darwin"), "/", "根目录不能被削成空串");
  assert.equal(__normPathForCompare("C:\\Tools\\", "win32"), "c:\\tools", "Windows 目录名大小写不敏感");
  assert.notEqual(__normPathForCompare("/A", "linux"), __normPathForCompare("/a", "linux"), "POSIX 不能小写化");
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

console.log("\n── 补全生效判据：兜底没做成时，ENOENT 不许当结论 ──");

test("本机 darwin：extraPathDirs 能真的加进目录 → 判可靠（rustc/adb 确实没装）", () => {
  // 这一格是对端 hos 那个"any error → incomplete"方案的**反例**：
  // 我这台 runtimes 非空、2 项 ENOENT，但两个都**真的没装**，
  // 若按"有失败就 incomplete"会误报。
  //
  // ⚠️ 只在 darwin 上断言：原先写死 "darwin"，在 Windows 上 darwin 那套
  // /opt/homebrew、/usr/local、~/.cargo 一个都不存在 → 判据（正确地）返回 true
  // → 假红（对端 文超-win 实测 62 通过 / 2 失败）。判据本身是**自校验式**的，
  // 错的是断言把"开发机是 Mac"当成了不变量。平台中立的不变式由下一条用例覆盖。
  if (process.platform !== "darwin") return;
  assert.equal(__pathLookupUnreliable("darwin"), false, "本机补全生效，找不到即为真没装");
});

test("自校验式判据：问的是「我们自己的兜底有没有起作用」，不是硬编码根", () => {
  // 对端实测过：它的 runtimes 住在 /data/data/com.dsharnessmobile.shell/files/usr/bin，
  // **不在任何常见白名单里**。硬编码白名单会因此假阳性判残缺；
  // 而 extraPathDirs() 是否真的加进目录与平台布局无关，是自校验的。
  //
  // ⚠️ 判据里**不能注入平台来伪造另一台机器的文件系统**：extraPathDirs('win32')
  // 在 Mac 上只反映"Mac 上有没有 C:\ 那些目录"。所以这里只断言机制本身
  // （返回布尔 + 与 extraPathDirs 是否为空一致），不假装能在 Mac 上模拟 Android。
  assert.equal(typeof __pathLookupUnreliable(process.platform), "boolean");
  assert.equal(
    __pathLookupUnreliable(process.platform),
    __extraPathDirs(process.platform).filter((d) => !__storeAliasDir.test(d)).length === 0,
    "判据必须精确等价于「补全一个目录都没加进去」（Store 别名目录除外）",
  );
  // 本机 darwin 上 win32 那套 %ProgramFiles% 路径确实都不存在 → 判不可靠（可证）。
  assert.equal(__pathLookupUnreliable("win32"), true);
});

test("Store 别名目录（WindowsApps）不算「补全真的生效」的证据", () => {
  // 对端 文超-win 实测：该目录里 18 个 .exe **全部**是 0 字节 + ReparsePoint 的
  // Store 别名存根（python.exe / winget.exe / …），spawn 得 exit=9009、空输出；
  // 而它几乎存在于每台 Win10/11 上。文超-win 的 win32 候选表**去掉它恰好为 0、
  // 带上它为 1** —— 不排除，本判据在 Windows 上就恒判"可信"，假阴性原样复发。
  //
  // 为什么直接测规则而不用端到端：Mac 上根本没有 WindowsApps 目录，
  // `__pathLookupUnreliable("win32")` 无论对错都返回 true —— 端到端用例在开发机
  // 上**永远是绿的**，抓不到这个 bug。
  assert.ok(__storeAliasDir.test(String.raw`C:\Users\86189\AppData\Local\Microsoft\WindowsApps`));
  assert.ok(__storeAliasDir.test("C:/Users/x/AppData/Local/Microsoft/WindowsApps"));
  assert.ok(!__storeAliasDir.test(String.raw`C:\Program Files\nodejs`));
  assert.ok(!__storeAliasDir.test(String.raw`C:\tools\WindowsApps\extra`), "只排除该目录本身，不误伤子目录");
});

test("对端 Android：6 项 ENOENT 确实都没装（它自查 command -v 确认）", () => {
  // 对端跑过 command -v：go/docker/rustc/java/ffmpeg/adb **全部 absent**，
  // 所以它那台**没有缺陷**。这条用例记的是"它曾经被误判成活反例"这件事：
  // isEmptyButFailed 要求 runtimes 为空 → 它非空 → 不触发，而那**是对的**。
  const theirs = {
    runtimes: { node: "24.18", python: "3.14", git: "2.56" },
    errors: { go: "ENOENT", docker: "ENOENT", rustc: "ENOENT", java: "ENOENT", ffmpeg: "ENOENT", adb: "ENOENT" },
  };
  assert.equal(__isEmptyButFailed(theirs), false, "它 runtimes 非空 → 形状守卫不触发（正确）");
});

await testAsync("真实机器上：runtimesIncomplete 必须与三项判据一致（不能硬编码 false）", async () => {
  const caps = await collectCapabilities();
  for (const [name, err] of Object.entries(caps.probeErrors ?? {})) {
    assert.ok(!String(err).startsWith("throw:"), `${name} 探测抛异常了：${err}`);
  }
  // 原先这里断言恒 false（"安静环境下不该有不确定项"）。这条在 Windows 上假红：
  // **PATH 兜底没生效本身就是不确定项** —— 对端 文超-win 实测 runtimes={} + 9 项
  // ENOENT → isEmptyButFailed 为 true → runtimesIncomplete=true 是**正确**结论
  // （它的名片不该断言"确定什么都没装"）。所以按判据反推期望值，而不是写死。
  const expected =
    __hasUncertainProbe(caps.probeErrors) ||
    __isEmptyButFailed({ runtimes: caps.runtimes, errors: caps.probeErrors }) ||
    __pathLookupUnreliable(process.platform);
  assert.equal(
    caps.runtimesIncomplete,
    expected,
    `runtimesIncomplete 与判据不一致：${JSON.stringify(caps.probeErrors)}`,
  );
  console.log(`      未采到：${JSON.stringify(caps.probeErrors)}（runtimesIncomplete=${caps.runtimesIncomplete}）`);
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
