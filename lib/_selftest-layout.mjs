/**
 * 目录布局自测：profile 识别、mesh 根选择、session 工作区、路径逃逸。
 *
 * 不碰网络、不启动 DSH；用临时目录模拟一个 profile。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chooseMeshRoot,
  copyLegacyFiles,
  isProfileDir,
  profileDirFromModuleUrl,
  safeSegment,
  sessionDirFor,
  receiveWorkspaceDir,
} from "./layout.js";

let pass = 0;
let fail = 0;

function ok(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass += 1;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err?.message ?? err}`);
    fail += 1;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "dsh-mesh-layout-"));
try {
  const profile = join(tmp, "profiles", "demo");
  const entry = join(profile, "node_modules", "dsh-plugin-mesh", "lib", "index.js");
  mkdirSync(join(profile, "node_modules", "dsh-plugin-mesh", "lib"), { recursive: true });
  writeFileSync(join(profile, "package.json"), JSON.stringify({ dsh: { profile: { bundles: [] } } }));

  ok("从入口 URL 推导 profile 根目录", () => {
    assert.equal(profileDirFromModuleUrl(pathToFileURL(entry).href), profile);
  });

  ok("只有 dsh.profile 的目录才算 profile", () => {
    assert.equal(isProfileDir(profile), true);
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "repo" }));
    assert.equal(isProfileDir(repo), false);
  });

  ok("带 BOM 的 profile package.json 仍能识别", () => {
    const bom = join(tmp, "profiles", "bom");
    mkdirSync(bom, { recursive: true });
    writeFileSync(join(bom, "package.json"), "\uFEFF" + JSON.stringify({ dsh: { profile: {} } }));
    assert.equal(isProfileDir(bom), true);
  });

  ok("优先 <profile>/mesh", () => {
    assert.equal(
      chooseMeshRoot({ profileDir: profile, dshHome: join(tmp, "dsh-home"), homeDir: tmp }),
      join(profile, "mesh"),
    );
  });

  ok("无 profile 时回退 DSH_HOME/mesh", () => {
    assert.equal(chooseMeshRoot({ dshHome: join(tmp, "dsh-home") }), join(tmp, "dsh-home", "mesh"));
  });

  ok("无 profile、无 DSH_HOME 时回退 ~/.dsh/mesh", () => {
    assert.equal(chooseMeshRoot({ homeDir: tmp }), join(tmp, ".dsh", "mesh"));
  });

  ok("会话工作区在 mesh/sessions/<id> 下", () => {
    assert.equal(
      sessionDirFor(join(profile, "mesh"), "mesh-abc"),
      join(profile, "mesh", "sessions", "mesh-abc"),
    );
  });

  ok("mesh 会话共用 mesh-receive-task 工作区（不再按 session 分散）", () => {
    const profile = "/p";
    assert.equal(receiveWorkspaceDir(join(profile, "mesh")), join(profile, "mesh", "mesh-receive-task"));
  });

  ok("sessionId 不能逃出 sessions/", () => {
    const p = sessionDirFor(join(profile, "mesh"), "../evil");
    assert.equal(p, join(profile, "mesh", "sessions", ".._evil"));
    assert.equal(safeSegment("../../etc/passwd").includes("/"), false);
  });

  ok("旧状态首次迁移，且不覆盖已有状态", () => {
    const legacy = join(tmp, "legacy");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "state.json"), '{"secret":"old"}');
    writeFileSync(join(legacy, "threads.json"), '{"threads":{}}');
    const root = join(tmp, "newroot");
    mkdirSync(root, { recursive: true });
    assert.deepEqual(copyLegacyFiles(root, legacy), ["state.json", "threads.json"]);
    assert.equal(readFileSync(join(root, "state.json"), "utf8"), '{"secret":"old"}');
    writeFileSync(join(root, "state.json"), '{"secret":"new"}');
    assert.deepEqual(copyLegacyFiles(root, legacy), []);
    assert.equal(readFileSync(join(root, "state.json"), "utf8"), '{"secret":"new"}');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "全部通过" : "存在失败"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
