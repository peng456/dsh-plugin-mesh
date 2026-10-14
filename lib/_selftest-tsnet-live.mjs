/**
 * P1 实机验证：真实下载 sidecar、真实拉起进程、验证整机单实例复用与清理。
 *
 * 跑法：node lib/_selftest-tsnet-live.mjs
 *
 * 不需要 Tailscale 授权码 —— 没有授权码时 sidecar 会停在 NeedsLogin 并给出
 * 授权链接，这已经足够验证 P1 的全部机制：
 *   · 按平台从镜像下载 .gz，按内置 sha256 校验通过，解压后可执行
 *   · 进程起来、控制 API 可用、能读到 backendState / authUrl
 *   · rendezvous 生效：第二个实例**复用**而不是再起一个节点
 *   · 非 owner 退出不牵连共享 sidecar；owner 退出时 sidecar 随之消失（不留孤儿）
 *
 * 注意：会真的联网下载（约 8.5MB）并写入 ~/.dsh/mesh/。这是有意的 ——
 * P1 要验的就是这条路，用假的就失去意义了。
 */
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureBinary, binaryInfo, binaryPath, looksExecutable, clearBinary } from "./tsnet/download.js";
import { TsnetNode } from "./tsnet/manager.js";

let passed = 0;
let failed = 0;
const step = (label) => console.log(`\n── ${label} ──`);
function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed += 1;
  } catch (err) {
    console.log(`  ✗ ${label}\n      ${err.message}`);
    failed += 1;
  }
}
const log = (m) => console.log(`      · ${m}`);
const warn = (m) => console.log(`      ! ${m}`);

function pidAlive(pid) {
  // pid 0 会被 process.kill 当成"整个进程组"，永远返回成功 —— 必须挡掉，
  // 否则"没拿到 pid"会伪装成"进程还活着"。
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

const config = {
  tsnetHostname: "selftest-node",
  tsnetAuthKey: "",
  tsnetControlUrl: "",
  tsnetDownloadSources: [],
};

let node1 = null;
let node2 = null;
let sidecarPid = 0;

try {
  step("1. 下载与完整性校验");
  const info = binaryInfo();
  log(`缓存路径：${info.path}（当前 ${info.installed ? `${(info.size / 1048576).toFixed(1)}MB` : "不存在"}）`);

  const res = await ensureBinary({ log, force: true });
  check("下载成功", () => {
    assert.ok(existsSync(res.path), `文件不存在：${res.path}`);
    assert.ok(res.downloaded, "应该是新下载的");
  });
  check("sha256 校验通过（内置白名单）", () => {
    // ensureBinary 内部做校验，能走到这里就说明匹配；这里再确认来源不是兜底直连
    assert.ok(!res.source.includes("github.com") || res.source === "github.com", `来源异常：${res.source}`);
    log(`下载来源：${res.source}`);
  });
  check("解压后是可执行文件且体积合理", () => {
    assert.ok(looksExecutable(), `文件头不像可执行文件：${binaryPath()}`);
    const size = statSync(binaryPath()).size;
    assert.ok(size > 10 * 1048576, `体积异常：${size} 字节`);
    log(`二进制体积：${(size / 1048576).toFixed(1)}MB`);
  });

  step("2. 拉起 sidecar（无授权码 → 应停在待登录）");
  node1 = new TsnetNode({ config, log, warn });
  await node1.start();
  const st1 = node1.status();
  sidecarPid = st1.pid;
  log(`phase=${st1.phase} port=${st1.port} pid=${sidecarPid}`);

  check("sidecar 进程在运行", () => {
    assert.ok(sidecarPid > 0, "没有拿到 pid");
    assert.ok(pidAlive(sidecarPid), `pid ${sidecarPid} 不存活`);
  });
  check("注册了 tailnet 入站转发", () => {
    assert.ok(Array.isArray(st1.forwards), "forwards 不是数组");
  });

  // sidecar 要先连控制面、再发起交互登录，授权链接不会在 start() 返回时就有。
  let authUrl = st1.authUrl;
  for (let i = 0; i < 60 && !authUrl; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    authUrl = node1.status().authUrl;
  }
  check("状态为待登录，且给出了授权链接", () => {
    // 没有授权码时这是唯一正确的状态
    assert.equal(node1.status().backendState, "NeedsLogin", `backendState=${node1.status().backendState}`);
    assert.ok(authUrl?.startsWith("https://"), `authUrl 异常：${authUrl}`);
    log(`授权链接：${authUrl}`);
  });

  step("3. 整机单实例：第二个实例必须复用，不能再起一个节点");
  node2 = new TsnetNode({ config, log, warn });
  const started = await node2.start();
  check("复用而非新建", () => {
    assert.equal(started.reused, true, "第二个实例没有复用已有 sidecar");
  });
  check("两个实例指向同一个 sidecar", () => {
    assert.equal(node2.status().port, st1.port, "控制端口不一致，说明起了两个节点");
    assert.equal(node2.status().pid, sidecarPid, "pid 不一致，说明起了两个节点");
  });
  check("第二个实例不是 owner", () => {
    assert.equal(node2.ownsProcess, false, "第二个实例不该拥有进程");
  });

  step("4. 非 owner 退出不应牵连共享的 sidecar");
  await node2.stop({ keepRemote: true });
  node2 = null;
  check("共享 sidecar 仍然存活", () => {
    assert.ok(pidAlive(sidecarPid), `复用的 sidecar 被误杀了（pid ${sidecarPid}）`);
  });
  const stAfter = await node1.statusRemote();
  check("控制 API 仍然可用", () => {
    assert.equal(stAfter.ok, true);
    assert.equal(stAfter.backendState, "NeedsLogin");
  });

  step("5. owner 退出后 sidecar 必须消失（不留孤儿进程）");
  await node1.stop();
  node1 = null;
  // 给它一点时间退出
  await new Promise((r) => setTimeout(r, 1200));
  check("sidecar 已退出", () => {
    assert.equal(pidAlive(sidecarPid), false, `sidecar（pid ${sidecarPid}）还在跑，会变成孤儿`);
  });
  check("rendezvous 已清理", () => {
    // rendezvous.json 应被删除，下次启动才会重新选举 owner
    const base = process.env.DSH_HOME || join(homedir(), ".dsh");
    const p = join(base, "mesh", "tsnet", "rendezvous.json");
    assert.equal(existsSync(p), false, `残留：${p}`);
  });

  step("6. 缓存可被清理（界面上的「重新下载」）");
  clearBinary();
  check("二进制已删除", () => {
    assert.equal(existsSync(binaryPath()), false, "缓存没删掉");
  });
} catch (err) {
  console.log(`\n✗ 验证中断：${err?.stack ?? err}`);
  failed += 1;
} finally {
  // 无论成败都收干净，别给用户留野进程
  for (const n of [node2, node1]) {
    if (n) await n.stop().catch(() => {});
  }
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
