/**
 * 客户端 bundle 的自测（无浏览器）。
 *
 * 这是个**手写 bundle、没有构建步骤**，而这个安装里也没有 react-dom，所以
 * 常规手段（跑一次页面看）在我这里做不到。但组件都是纯函数，`createElement`
 * 的返回值就是一棵可遍历的普通对象树 —— 于是可以：
 *
 *   1. 造一个假的 `window.__ModuleLoader__` 把 factory 抓出来
 *   2. 用最小 react stub（只需要 createElement）执行 factory
 *   3. 直接调用组件函数，遍历返回树，断言文案与标记
 *
 * 覆盖的是最容易出错、也最该被盯住的东西：**三种「不知道」有没有被分开渲染**。
 * 把"对端没报能力"渲染成"什么都没装"，会让用户把任务派到跑不了的机器上。
 *
 *   node lib/_selftest-client.mjs
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "client", "client.js");

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

// ── 最小 react stub：只需要 createElement 的形状与 hook 的存在 ──
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f(),
  useRef: (v) => ({ current: v }),
  Fragment: Symbol("Fragment"),
};

/** 把一个元素树里所有文本收集起来，便于断言"文案里有没有这句话"。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const c of node) textOf(c, out);
    return out;
  }
  if (typeof node === "object") {
    // 函数组件：直接调用（这些组件都是纯函数、不依赖 hook 顺序）
    if (typeof node.type === "function") {
      textOf(node.type(node.props), out);
      return out;
    }
    textOf(node.children, out);
    const kids = node.props && node.props.children;
    if (kids !== undefined) textOf(kids, out);
    return out;
  }
  return out;
}

/** 收集树里所有 title 属性（提示文案也是要验证的内容）。 */
function titlesOf(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) titlesOf(c, out);
    return out;
  }
  if (typeof node.type === "function") {
    titlesOf(node.type(node.props), out);
    return out;
  }
  if (node.props && typeof node.props.title === "string") out.push(node.props.title);
  titlesOf(node.children, out);
  if (node.props && node.props.children !== undefined) titlesOf(node.props.children, out);
  return out;
}

/** 树里有没有指定类型的元素（用来断言 logo 是 SVG 而不是文字）。 */
function hasType(node, type, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) hasType(c, type, out);
    return out;
  }
  if (node.type === type) out.push(node);
  if (typeof node.type === "function") {
    hasType(node.type(node.props), type, out);
    return out;
  }
  hasType(node.children, type, out);
  if (node.props && node.props.children !== undefined) hasType(node.props.children, type, out);
  return out;
}

// ── 用假的 module loader 把 bundle 抓出来 ──
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry;
    },
  },
};

const source = readFileSync(BUNDLE, "utf8");
// 直接在全局作用域里执行：bundle 末尾的语句就是调用 __ModuleLoader__.load
// eslint-disable-next-line no-new-func
new Function("window", `${source}\n`)(globalThis.window);

console.log("\n── bundle 能被加载 ──");

test("__ModuleLoader__.load 被调用，且 id 等于包名（槽位注册依赖它）", () => {
  assert.ok(captured, "bundle 没有调用 __ModuleLoader__.load");
  assert.equal(captured.id, "dsh-plugin-mesh");
});

const mod = captured.factory((name) => {
  if (name === "react") return react;
  throw new Error(`未预期的依赖：${name}`);
});

test("只依赖 react（不该 require 别的东西）", () => {
  assert.ok(mod && typeof mod.apply === "function", "应导出 apply");
  assert.deepEqual(mod.inject, ["slots"]);
});

test("apply() 注册两个槽位：侧栏图标 + 主面板", () => {
  const regs = [];
  const fakeCtx = {
    slots: {
      inject: (name, cb) => {
        // 槽位已声明时 cb 会立刻执行；这里模拟"已声明"，直接调用
        cb();
        regs.push(name);
      },
      register: (spec) => regs.push(spec),
    },
  };
  mod.apply(fakeCtx);
  assert.ok(regs.includes("sidebar.panellist"), `侧栏槽未注册：${JSON.stringify(regs)}`);
  assert.ok(regs.includes("main"), `主面板槽未注册：${JSON.stringify(regs)}`);
});

const { CapabilityLine, PeerRow, TsnetCard, SecretBox, OsLogo } = mod.__test;

console.log("\n── CapabilityLine：三种「不知道」必须分开渲染 ──");

test("对端没报能力 → 说「未知」，绝不能说成「什么都没装」", () => {
  const txt = textOf(CapabilityLine({ peer: { capabilities: null } })).join(" ");
  assert.ok(txt.includes("未知"), txt);
  assert.ok(!txt.includes("未探到运行时"), "把未知说成没有是最危险的错误");
});

test("对端报了运行时 → 每个都渲染成徽章（名字 + 版本）", () => {
  const txt = textOf(
    CapabilityLine({
      peer: {
        capabilities: { runtimes: { python: "3.12", node: "20.19" }, cpuCores: 8, memMb: 16384, arch: "arm64" },
      },
    }),
  ).join(" ");
  assert.ok(txt.includes("python 3.12"), txt);
  assert.ok(txt.includes("node 20.19"), txt);
  assert.ok(txt.includes("8 核"), txt);
  assert.ok(txt.includes("16 GB 内存"), txt);
});

test("对端确实什么运行时都没有 → 说「未探到运行时」（和「未知」不同）", () => {
  const txt = textOf(CapabilityLine({ peer: { capabilities: { runtimes: {} } } })).join(" ");
  assert.ok(txt.includes("未探到运行时"), txt);
  assert.ok(!txt.includes("未知"), "「报过了确实没有」不该说成未知");
});

test("能力已过期 → 标出来", () => {
  const txt = textOf(
    CapabilityLine({ peer: { capabilities: { runtimes: {} }, capabilitiesStale: true } }),
  ).join(" ");
  assert.ok(txt.includes("能力已过期"), txt);
});

test("探测未探准 → 标出来，并在悬停里说明「缺失不能当结论」", () => {
  const el = CapabilityLine({
    peer: { capabilities: { runtimes: {}, runtimesIncomplete: true } },
  });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("探测未探准"), txt);
  const tips = titlesOf(el).join("\n");
  assert.ok(tips.includes("不能当结论"), `悬停解释缺失：${tips}`);
});

test("GPU 会显示成独立徽章，并带上显存", () => {
  const el = CapabilityLine({
    peer: { capabilities: { runtimes: {}, gpu: { present: true, name: "Intel Iris", vramMb: 1536 } } },
  });
  assert.ok(textOf(el).join(" ").includes("GPU Intel Iris"), textOf(el).join(" "));
  assert.ok(titlesOf(el).join("\n").includes("1536MB"), "悬停里应带显存");
});

test("CapabilityLine 显示 WSL 运行时，与宿主机分开", () => {
  const el = CapabilityLine({
    peer: {
      capabilities: {
        runtimes: { node: "20.19" },
        wsl: [{ name: "Ubuntu", runtimes: { node: "22.1", python: "3.12" }, error: "" }],
      },
    },
  });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("WSL Ubuntu"), txt);
  assert.ok(txt.includes("python 3.12"), txt);
  assert.ok(titlesOf(el).join("\n").includes("WSL 运行时"), "悬停里应说明这是 WSL 里的运行时");
});

test("悬停里给出完整信息（系统 / 常用目录 / 采集时间）", () => {
  const el = CapabilityLine({
    peer: {
      capabilities: {
        runtimes: {},
        os: "darwin 21.6.0",
        workspaceHints: ["~/projects"],
        capabilitiesAt: 1792000000000,
      },
    },
  });
  const tips = titlesOf(el).join("\n");
  assert.ok(tips.includes("darwin 21.6.0"), tips);
  assert.ok(tips.includes("~/projects"), tips);
  assert.ok(tips.includes("采集于"), tips);
});

test("坏数据不崩（capabilities 是字符串/数字/数组时）", () => {
  for (const junk of ["python", 42, [], undefined]) {
    const el = CapabilityLine({ peer: { capabilities: junk } });
    assert.ok(el, `capabilities=${JSON.stringify(junk)} 时应仍能渲染`);
  }
  // capabilities 是对象但 runtimes 形状不对
  const el = CapabilityLine({ peer: { capabilities: { runtimes: "nope" } } });
  assert.ok(textOf(el).join(" ").includes("未探到运行时"));
});

console.log("\n── PeerRow 把能力行接进去了 ──");

test("PeerRow 有结构化 osInfo/systems 时显示系统名/版本与 WSL，并渲染 SVG logo", () => {
  const el = PeerRow({
    peer: {
      id: "p2",
      machine: "winbox",
      online: true,
      host: "192.168.1.9",
      port: 45917,
      os: "win32 10.0.26200",
      osInfo: {
        platform: "win32",
        name: "Windows 11 Home China",
        version: "10.0.26200",
        distro: "",
        kernel: "10.0.26200",
        desktop: "",
        arch: "x64",
      },
      systems: [
        {
          kind: "host",
          platform: "win32",
          name: "Windows 11 Home China",
          version: "10.0.26200",
          distro: "",
          kernel: "10.0.26200",
          desktop: "",
          arch: "x64",
        },
        {
          kind: "wsl",
          platform: "linux",
          name: "Ubuntu",
          version: "26.04",
          distro: "ubuntu",
          kernel: "",
          desktop: "",
          arch: "",
        },
      ],
      user: "u",
      lastSeen: Date.now(),
      endpoints: [],
      capabilities: { runtimes: {} },
      capabilitiesStale: false,
    },
    onSend: () => {},
    onProbe: () => {},
  });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("Windows 11 Home China"), txt);
  assert.ok(txt.includes("10.0.26200"), txt);
  assert.ok(txt.includes("x64"), "应显示架构：" + txt);
  assert.ok(txt.includes("Ubuntu"), "应显示 WSL 里的 Ubuntu：" + txt);
  assert.ok(txt.includes("WSL"), "应标出 WSL 环境：" + txt);
  assert.ok(hasType(el, "svg").length >= 2, "宿主机 + WSL 应各有一个 logo");
});

test("PeerRow 只有老 os 字符串时回退显示，不崩且仍能识别 windows", () => {
  const el = PeerRow({
    peer: {
      id: "p3",
      machine: "winbox",
      online: true,
      host: "192.168.1.9",
      port: 45917,
      os: "win32 10.0",
      user: "u",
      lastSeen: Date.now(),
      endpoints: [],
      capabilities: null,
      capabilitiesStale: false,
    },
    onSend: () => {},
    onProbe: () => {},
  });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("win32 10.0"), txt);
  assert.ok(hasType(el, "svg").length > 0, "老字段也能推断出 Windows logo");
});

test("未知系统的 logo 回退成字母徽章", () => {
  const el = OsLogo({ peer: { os: "plan9 1.0" } });
  assert.ok(textOf(el).join("").includes("PLA"), textOf(el).join(""));
  assert.equal(hasType(el, "svg").length, 0, "未知系统不该画某个系统的 logo");
});

test("PeerRow 渲染出的文案里包含对端的能力", () => {
  const el = PeerRow({
    peer: {
      id: "p1",
      machine: "winbox",
      online: true,
      host: "192.168.1.9",
      port: 45917,
      os: "win32 10.0",
      user: "u",
      lastSeen: Date.now(),
      endpoints: [],
      capabilities: { runtimes: { go: "1.25" } },
      capabilitiesStale: false,
    },
    onSend: () => {},
    onProbe: () => {},
  });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("winbox"), txt);
  assert.ok(txt.includes("go 1.25"), `机器卡片里应显示能力：${txt}`);
});

console.log("\n── TsnetCard：用户不该自己去后台找授权码地址 ──");

const noop = () => {};
const tsnetOff = { enabled: false, authKeySaved: false, controlUrl: "", node: null, hostname: "", permissionPresetEffective: "" };

test("未配置时，卡片当场说明「需要授权码」而不是只留一个输入框", () => {
  const txt = textOf(TsnetCard({ tsnet: tsnetOff, onChanged: noop })).join(" ");
  assert.ok(txt.includes("授权码"), txt.slice(0, 200));
  assert.ok(txt.includes("免费"), "应说明可以免费注册");
});

test("给出可直接点开的授权码页面地址", () => {
  const el = TsnetCard({ tsnet: tsnetOff, onChanged: noop });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("https://console.tailscale.com/admin/settings/keys"), "地址必须出现在可见文本里（Electron 里点不动也能复制）");
});

test("地址是可点链接且新窗口打开", () => {
  const el = TsnetCard({ tsnet: tsnetOff, onChanged: noop });
  const links = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type === "function") return walk(n.type(n.props));
    if (n.props && n.props.href) links.push(n.props);
    walk(n.children);
    if (n.props && n.props.children !== undefined) walk(n.props.children);
  })(el);
  const hit = links.find((a) => a.href === "https://console.tailscale.com/admin/settings/keys");
  assert.ok(hit, "应有指向授权码页面的 <a>");
  assert.equal(hit.target, "_blank");
});

test("点明「必须勾选 Reusable」这个真实坑（一次性码重启就失效）", () => {
  const txt = textOf(TsnetCard({ tsnet: tsnetOff, onChanged: noop })).join(" ");
  assert.ok(txt.includes("Reusable"), txt.slice(0, 300));
  assert.ok(txt.includes("一次性"), "应解释为什么必须 Reusable");
});

test("已经存过授权码时不再重复推销取码步骤，只提示已保存", () => {
  // 注意要用 enabled:false —— 那才是"面板会展开"的状态（open 初值 = !enabled）。
  // 用 enabled:true 测这条是假绿：面板默认收起，什么都断言得到。
  const txt = textOf(
    TsnetCard({ tsnet: { ...tsnetOff, enabled: false, authKeySaved: true }, onChanged: noop }),
  ).join(" ");
  assert.ok(txt.includes("已保存"), txt.slice(0, 300));
  assert.ok(!txt.includes("console.tailscale.com"), "已配置后不该再占版面显示取码地址");
});

test("enabled 状态下设置面板默认收起（不占版面）", () => {
  const txt = textOf(
    TsnetCard({ tsnet: { ...tsnetOff, enabled: true, authKeySaved: true }, onChanged: noop }),
  ).join(" ");
  assert.ok(txt.includes("设置"), "应有「设置」按钮可以展开");
  assert.ok(!txt.includes("console.tailscale.com"), "收起时不该显示取码步骤");
});

console.log("\n── SecretBox：配对码要有开关，不能只显示状态 ──");

test("未启用时给出「启用配对码」按钮（而不是叫人去改 YAML）", () => {
  const txt = textOf(SecretBox({ self: { secret: "x".repeat(32) }, config: { requirePairing: false }, onSaved: noop })).join(" ");
  assert.ok(txt.includes("启用配对码"), txt.slice(0, 200));
  assert.ok(!txt.includes("在插件配置里把 requirePairing 设为 true"), "不能只让人去翻配置文件");
});

test("已启用时按钮变成「停用配对码」", () => {
  const txt = textOf(SecretBox({ self: { secret: "x".repeat(32) }, config: { requirePairing: true }, onSaved: noop })).join(" ");
  assert.ok(txt.includes("停用配对码"), txt.slice(0, 200));
});

test("说明改动立即生效、不用重启", () => {
  const txt = textOf(SecretBox({ self: { secret: "x".repeat(32) }, config: { requirePairing: false }, onSaved: noop })).join(" ");
  assert.ok(txt.includes("立即生效"), txt.slice(0, 300));
});

test("配置钉死时按钮禁用并说明原因（不能让人以为点了有用）", () => {
  const el = SecretBox({ self: { secret: "x".repeat(32) }, config: { requirePairing: true, requirePairingPinned: true }, onSaved: noop });
  const txt = textOf(el).join(" ");
  assert.ok(txt.includes("固定开启"), txt.slice(0, 300));
  let disabled = false;
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.type === "function") return walk(n.type(n.props));
    if (n.props && n.props.disabled === true) disabled = true;
    walk(n.children);
    if (n.props && n.props.children !== undefined) walk(n.props.children);
  })(el);
  assert.ok(disabled, "钉死时开关应被禁用");
});

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 通过 / ${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
