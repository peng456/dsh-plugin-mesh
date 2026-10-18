/**
 * osInfo 的自测：纯 fixture，不碰真实系统。
 *
 * 为什么不用真实采集：macOS/Android 的分支在开发机上跑不到；这些平台差异
 * 正是最容易出 bug 的地方（sw_vers 输出、os-release 引号、getprop 换行）。
 */
import assert from "node:assert/strict";
import { detectOsInfo, sanitizeOsInfo, detectSystems, sanitizeSystems } from "./osinfo.js";
import { MeshDiscovery } from "./discovery.js";

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${label}`);
    console.log(`      ${err?.message ?? err}`);
  }
}

console.log("\n── 平台分支：四个系统都要给出可读名字/版本 ──");

check("win32：os.version() 是产品名，release 是版本", () => {
  const info = detectOsInfo({
    platform: "win32",
    release: "10.0.26200",
    arch: "x64",
    osVersion: () => "Windows 11 Home China",
  });
  assert.equal(info.platform, "win32");
  assert.equal(info.name, "Windows 11 Home China");
  assert.equal(info.version, "10.0.26200");
  assert.equal(info.kernel, "10.0.26200");
  assert.equal(info.arch, "x64");
  assert.equal(info.distro, "");
});

check("win32：os.version() 拿不到时退回 Windows，不抛", () => {
  const info = detectOsInfo({ platform: "win32", release: "10.0.19045", arch: "x64", osVersion: () => "" });
  assert.equal(info.name, "Windows");
  assert.equal(info.version, "10.0.19045");
});

check("darwin：sw_vers 的 productName/productVersion", () => {
  const info = detectOsInfo({
    platform: "darwin",
    release: "24.1.0",
    arch: "arm64",
    run: (_cmd, args) => (args[0] === "-productName" ? "macOS" : "15.1"),
  });
  assert.equal(info.platform, "darwin");
  assert.equal(info.name, "macOS");
  assert.equal(info.version, "15.1");
  assert.equal(info.kernel, "24.1.0");
  assert.equal(info.arch, "arm64");
});

check("darwin：sw_vers 不可用时仍有 macOS 名字", () => {
  const info = detectOsInfo({
    platform: "darwin",
    release: "24.1.0",
    arch: "arm64",
    run: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(info.name, "macOS");
  assert.equal(info.version, "");
  assert.equal(info.kernel, "24.1.0");
});

check("linux：解析 /etc/os-release 的 NAME/VERSION_ID/ID", () => {
  const fixture = [
    'PRETTY_NAME="Ubuntu 26.04 LTS"',
    'NAME="Ubuntu"',
    'VERSION_ID="26.04"',
    "ID=ubuntu",
    "",
  ].join("\n");
  const info = detectOsInfo({
    platform: "linux",
    release: "6.6.114.1-microsoft-standard-WSL2",
    arch: "x64",
    env: { XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    readFile: () => fixture,
  });
  assert.equal(info.platform, "linux");
  assert.equal(info.name, "Ubuntu");
  assert.equal(info.version, "26.04");
  assert.equal(info.distro, "ubuntu");
  assert.equal(info.desktop, "GNOME");
  assert.equal(info.kernel, "6.6.114.1-microsoft-standard-WSL2");
});

check("linux：os-release 缺失时退回 Linux，desktop 可为空", () => {
  const info = detectOsInfo({
    platform: "linux",
    release: "6.1.0",
    arch: "x64",
    env: {},
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(info.name, "Linux");
  assert.equal(info.version, "");
  assert.equal(info.desktop, "");
});

check("android：getprop 的版本号，带换行也能取对", () => {
  const info = detectOsInfo({
    platform: "android",
    release: "5.10.101-android13",
    arch: "arm64",
    run: () => "14\n",
  });
  assert.equal(info.platform, "android");
  assert.equal(info.name, "Android");
  assert.equal(info.version, "14");
  assert.equal(info.arch, "arm64");
});

check("未知平台：给可读名字，platform 留空（UI 走回退徽章）", () => {
  const info = detectOsInfo({ platform: "freebsd", release: "14.0", arch: "x64" });
  assert.equal(info.platform, "");
  assert.equal(info.name, "freebsd");
  assert.equal(info.version, "14.0");
});

console.log("\n── sanitizeOsInfo：对端名片是网络输入 ──");

check("platform 白名单：未知值被清空", () => {
  const info = sanitizeOsInfo({ platform: "plan9", name: "Plan 9" });
  assert.equal(info.platform, "");
  assert.equal(info.name, "Plan 9");
});

check("控制字符剥掉、空白折叠、字段截断", () => {
  const info = sanitizeOsInfo({
    platform: "linux",
    name: `  Ubuntu\u0000\t${"x".repeat(80)}  `,
    version: "24.04\n",
    kernel: "k".repeat(100),
    desktop: "GNOME",
    arch: "x64",
  });
  assert.ok(!info.name.includes("\u0000"));
  assert.ok(info.name.length <= 48, `name 未截断: ${info.name.length}`);
  assert.equal(info.version, "24.04");
  assert.ok(info.kernel.length <= 64);
});

check("空对象 / 垃圾输入 → null（调用方回退老 os 字段）", () => {
  assert.equal(sanitizeOsInfo(null), null);
  assert.equal(sanitizeOsInfo(undefined), null);
  assert.equal(sanitizeOsInfo("win32"), null);
  assert.equal(sanitizeOsInfo([]), null);
  assert.equal(sanitizeOsInfo({}), null);
  assert.equal(sanitizeOsInfo({ platform: "", name: "" }), null);
});

check("老对端只报 os 字符串：没有 osInfo 时不伪造", () => {
  assert.equal(sanitizeOsInfo(undefined), null);
});

console.log("\n── systems：宿主机 + WSL 发行版（只读注册表，不启动发行版）──");

const WSL_REG = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
  "    DefaultVersion    REG_DWORD    0x2",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{1111}",
  "    State    REG_DWORD    0x1",
  "    DistributionName    REG_SZ    Ubuntu",
  "    Flavor    REG_SZ    ubuntu",
  "    OsVersion    REG_SZ    26.04",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{2222}",
  "    State    REG_DWORD    0x1",
  "    DistributionName    REG_SZ    docker-desktop",
].join("\n");

const winOpts = (run, readFile) => ({
  platform: "win32",
  release: "10.0.26200",
  arch: "x64",
  osVersion: () => "Windows 11 Home China",
  run,
  readFile,
});

check("win32：宿主机 + Ubuntu，docker-desktop 被过滤，且有版本时不该读 UNC", () => {
  const list = detectSystems(
    winOpts(
      () => WSL_REG,
      () => {
        throw new Error("不该在读不到的情况下访问 UNC");
      },
    ),
  );
  assert.equal(list.length, 2);
  assert.equal(list[0].kind, "host");
  assert.equal(list[0].name, "Windows 11 Home China");
  assert.equal(list[1].kind, "wsl");
  assert.equal(list[1].platform, "linux");
  assert.equal(list[1].name, "Ubuntu");
  assert.equal(list[1].version, "26.04");
  assert.equal(list[1].distro, "ubuntu");
});

check("WSL 注册表缺 OsVersion 时，运行中的发行版读 /etc/os-release 补版本", () => {
  const reg = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{3333}",
    "    State    REG_DWORD    0x1",
    "    DistributionName    REG_SZ    Debian",
  ].join("\n");
  const list = detectSystems(
    winOpts(
      () => reg,
      (path) => {
        assert.match(path, /Debian/);
        return 'NAME="Debian"\nVERSION_ID="12"\nID=debian\n';
      },
    ),
  );
  assert.equal(list.length, 2);
  assert.equal(list[1].name, "Debian");
  assert.equal(list[1].version, "12");
  assert.equal(list[1].distro, "debian");
});

check("停着的 WSL 发行版不读 UNC（不启动它），版本留空", () => {
  const reg = [
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{4444}",
    "    State    REG_DWORD    0x0",
    "    DistributionName    REG_SZ    openSUSE",
  ].join("\n");
  const list = detectSystems(
    winOpts(
      () => reg,
      () => {
        throw new Error("停着的发行版不该被访问");
      },
    ),
  );
  assert.equal(list.length, 2);
  assert.equal(list[1].name, "openSUSE");
  assert.equal(list[1].version, "");
});

check("没有 WSL 注册表 → 只报宿主机", () => {
  const list = detectSystems(
    winOpts(
      () => {
        throw new Error("ERROR: The system was unable to find the specified registry key");
      },
      () => "",
    ),
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "host");
});

check("非 win32：不探测 WSL，只报宿主机", () => {
  const list = detectSystems({
    platform: "linux",
    release: "6.1.0",
    arch: "x64",
    env: {},
    readFile: () => 'NAME="Debian"\nVERSION_ID="12"\nID=debian\n',
    run: () => {
      throw new Error("非 Windows 不该跑 reg");
    },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "host");
  assert.equal(list[0].name, "Debian");
});

check("sanitizeSystems：去重、kind 白名单、最多 4 项、宿主机排第一", () => {
  const list = sanitizeSystems([
    { kind: "wsl", platform: "linux", name: "Ubuntu", version: "24.04" },
    { kind: "host", platform: "win32", name: "Win", version: "11" },
    { kind: "wsl", platform: "linux", name: "Ubuntu", version: "24.04" },
    { kind: "vm", platform: "linux", name: "Debian", version: "12" },
    { kind: "container", platform: "linux", name: "Alpine", version: "3.20" },
    { kind: "nope", platform: "linux", name: "Other", version: "1" },
  ]);
  assert.equal(list.length, 4);
  assert.equal(list[0].kind, "host");
  assert.equal(list[0].name, "Win");
  assert.ok(!list.some((s) => s.name === "Other"), "第 5 个及以后的系统应被截断");
});

console.log("\n── 名片收发：selfRecord 带 osInfo，对端 osInfo 会被清洗 ──");

check("selfRecord 带本机 osInfo", () => {
  const d = new MeshDiscovery({ id: "self-os", port: 0, meta: { machine: "me" } });
  const info = d.selfRecord().osInfo;
  assert.ok(info, "selfRecord 应带 osInfo");
  assert.ok(info.name, "至少要有可读的系统名");
  assert.equal(info.platform, process.platform === "win32" ? "win32" : info.platform);
  const list = d.selfRecord().systems;
  assert.ok(Array.isArray(list) && list.length >= 1, "selfRecord 应带 systems[]");
  assert.equal(list[0].kind, "host");
});

check("对端 osInfo 被保存；旧对端没有该字段时为 null", () => {
  const d = new MeshDiscovery({ id: "self-os", port: 0, meta: { machine: "me" } });
  d.note(
    {
      app: "dsh-mesh",
      id: "peer-mac",
      machine: "mac",
      os: "darwin 24.1.0",
      osInfo: {
        platform: "darwin",
        name: "macOS",
        version: "15.1",
        distro: "",
        kernel: "24.1.0",
        desktop: "",
        arch: "arm64",
      },
    },
    "10.0.0.9",
  );
  assert.equal(d.peers()[0].osInfo.platform, "darwin");
  assert.equal(d.peers()[0].osInfo.version, "15.1");

  d.note({ app: "dsh-mesh", id: "peer-old", machine: "old", os: "linux 6.1.0" }, "10.0.0.10");
  const old = d.peers().find((p) => p.machine === "old");
  assert.equal(old.osInfo, null, "旧对端不该被伪造出一个 osInfo");
});

check("对端 systems[] 被清洗并保存；宿主机排第一", () => {
  const d = new MeshDiscovery({ id: "self-sys", port: 0, meta: { machine: "me" } });
  d.note(
    {
      app: "dsh-mesh",
      id: "peer-sys",
      machine: "multi",
      systems: [
        { kind: "wsl", platform: "linux", name: "Ubuntu", version: "26.04", distro: "ubuntu" },
        { kind: "host", platform: "win32", name: "Windows 11", version: "10.0.26200", arch: "x64" },
        { kind: "wsl", platform: "linux", name: "Ubuntu", version: "26.04", distro: "ubuntu" },
      ],
    },
    "10.0.0.12",
  );
  const list = d.peers()[0].systems;
  assert.equal(list.length, 2, "重复项应被去掉");
  assert.equal(list[0].kind, "host");
  assert.equal(list[1].kind, "wsl");
});

check("对端送垃圾 osInfo：platform 白名单 + 文本截断", () => {
  const d = new MeshDiscovery({ id: "self-os", port: 0, meta: { machine: "me" } });
  d.note(
    {
      app: "dsh-mesh",
      id: "peer-evil",
      machine: "evil",
      osInfo: { platform: "evil", name: "<script>".repeat(20), version: "x".repeat(100) },
    },
    "10.0.0.11",
  );
  const info = d.peers()[0].osInfo;
  assert.equal(info.platform, "");
  assert.ok(info.name.length <= 48);
  assert.ok(info.version.length <= 48);
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
