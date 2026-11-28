/**
 * 把纯 JS 的 `ssh2` 及其依赖「打平」进 `lib/vendor/ssh2/`。
 *
 *   node scripts/vendor-ssh2.mjs          # 重建（要联网）
 *   node scripts/vendor-ssh2.mjs --check  # 离线校验（挂在 npm run check 里）
 *
 * ── 为什么要在仓库里带一份，而不是写成依赖 ──────────────────────────────
 * 写成依赖（`dependencies` / `optionalDependencies`）会触发宿主的安装期门禁：
 * ssh2 自带 `install: node install.js`（编译**可选**的原生加速件），宿主不允许
 * 依赖跑构建脚本时整次安装直接失败 —— iPad 上的 DSH Go 就是
 * `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: cpu-features, ssh2`，
 * 0.5.6–0.5.20 因此装不上（见 `scripts/check-install-safe.mjs`）。
 *
 * 而那个构建脚本本身是可有可无的：`install.js` 无论成败都 `exit(0)`，
 * `cpu-features` 在 ssh2 里是 `try { require('cpu-features')() } catch {}`，
 * 原生 crypto 绑定（`lib/protocol/crypto/build/Release/sshcrypto.node`）同样
 * 是 try/catch 加载、失败就退回纯 JS 实现。功能完全等价，只差吞吐量。
 *
 * 所以这里做的不是「打包」，而是**把上游那个可选加速件彻底拿掉**：只保留
 * `lib/`，删掉 `install.js` / `binding.gyp` / `src/`，并把下游包里的
 * `scripts`、`optionalDependencies` 一并剥掉。产出物满足宿主门禁的原始意图 ——
 * 「安装只是解包」—— 又让 iPad 这类装不了依赖的宿主也能用 SSH。
 *
 * ── 刷新方式 ─────────────────────────────────────────────────────────
 * 改下面的 `PACKAGES`（版本 + 上游 tarball 的 sha256），跑一次重建，
 * 再跑 `--check` 确认产出与 `VENDOR.json` 一致。sha256 是**上游 npm tarball**
 * 的，不是生成物的，这样任何人拿到脚本都能独立复现同一次构建。
 *
 * 这个脚本进 `npm run check` 的只有 `--check` 分支：全程不碰网络。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { extractTarball } from "../lib/upgrade.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TARGET = join(ROOT, "lib", "vendor", "ssh2");
const MANIFEST = join(TARGET, "VENDOR.json");

/** 唯一允许出现在 vendor 里的文件形态；其余一律不落地。 */
const FORBIDDEN_NAMES = new Set(["install.js", "binding.gyp", "prebuild-install.js"]);
/**
 * 白名单里也藏着要剥掉的东西：ssh2 的 `lib/protocol/crypto/` 目录里既有纯 JS
 * 实现（poly1305.js，要用），也有原生加速件的构建文件（binding.gyp + src/，
 * 永远不该带走）。所以「保留 lib/」后面还得再删一次，否则一个 92KB 的 C++
 * 目录会被当成纯 JS 一起发出去。
 */
const FORBIDDEN_EXT = [".node", ".dylib", ".so", ".dll"];

/**
 * 上游包与「保留什么」。
 *
 * `keep` 是路径前缀白名单：列目录等于保留整棵子树。刻意不写 glob ——
 * 白名单越窄越好审，改这里的每一次 diff 都等于一次「我们多信任了什么」。
 */
const PACKAGES = [
  {
    name: "ssh2",
    version: "1.17.0",
    // https://registry.npmjs.org/ssh2/-/ssh2-1.17.0.tgz
    sha256: "8bf2fff9c148973ed24a95087c0b4cea9b8f07a61621c8ab3ded453e3cbcd7d7",
    keep: ["LICENSE", "lib"],
    drop: ["lib/protocol/crypto/binding.gyp", "lib/protocol/crypto/src"],
    into: ".",
  },
  {
    name: "asn1",
    version: "0.2.6",
    sha256: "17ca6fff19e3f681ae310bda39262b9968b57bee3771a730818772d83a8fe250",
    keep: ["LICENSE", "lib"],
    into: "node_modules/asn1",
  },
  {
    name: "bcrypt-pbkdf",
    version: "1.0.2",
    sha256: "e13e9e9f5d438223a02a906e6b77dfc97985a4ccf469ddb65261012973f07826",
    keep: ["LICENSE", "index.js"],
    into: "node_modules/bcrypt-pbkdf",
  },
  {
    name: "tweetnacl",
    version: "0.14.5",
    sha256: "6cea33d67a9bd83f8bd250655c78a2c89ea912bcc6be91c8e65807ce69cfdfd6",
    keep: ["LICENSE", "nacl-fast.js"],
    into: "node_modules/tweetnacl",
  },
  {
    name: "safer-buffer",
    version: "2.1.2",
    sha256: "78812f65ae3b98071ce1c9bacbe0666f4220d0b2753c2a11530eb27df440a3b3",
    keep: ["LICENSE", "safer.js"],
    into: "node_modules/safer-buffer",
  },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** 上游 tarball 的下载地址：只认 npm 官方源，避免镜像给出不同内容。 */
const tarballUrl = (pkg) => `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;

/**
 * 剥掉 package.json 里一切会在安装期执行、或引入构建的东西。
 *
 * 只留 `name/version/license/main/dependencies` 五个键：其余字段（scripts、
 * optionalDependencies、devDependencies、files、engines…）对运行时没有意义，
 * 留着只会给下一个改的人留下重新引入构建脚本的机会。
 */
function patchedManifest(source) {
  const out = {
    name: source.name,
    version: source.version,
    license: source.license || "MIT",
    main: source.main,
  };
  if (source.dependencies && Object.keys(source.dependencies).length > 0) {
    out.dependencies = source.dependencies;
  }
  return out;
}

/** 一个路径是否在某条 `keep` 前缀下。 */
function kept(path, keep) {
  return keep.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function assertSafeRelative(path) {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (path.startsWith("/") || parts.includes("..")) throw new Error(`不安全的路径：${path}`);
  return parts.join("/");
}

/** 递归列出目录下的普通文件（相对路径，正斜杠）。 */
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...listFiles(abs, base));
    else if (st.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function build() {
  const staging = mkdtempSync(join(tmpdir(), "mesh-vendor-ssh2-"));
  try {
    const files = new Map();
    for (const pkg of PACKAGES) {
      const url = tarballUrl(pkg);
      const raw = await fetchBytes(url);
      const got = sha256(raw);
      if (got !== pkg.sha256) {
        throw new Error(`${pkg.name}@${pkg.version} 的 tarball 校验不符：期望 ${pkg.sha256}，实际 ${got}`);
      }
      const entries = extractTarball(raw, { stripComponents: 1 });
      const base = join(staging, pkg.into);
      for (const entry of entries) {
        if (entry.dir) continue;
        const path = assertSafeRelative(entry.path);
        if (!kept(path, pkg.keep)) continue;
        if ((pkg.drop ?? []).some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
        if (FORBIDDEN_NAMES.has(path.split("/").pop()) || FORBIDDEN_EXT.some((ext) => path.endsWith(ext))) {
          throw new Error(`${pkg.name}@${pkg.version} 里混进了不该带的东西：${path}`);
        }
        const dest = join(base, path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, entry.data);
      }
      // 每个包自己那份 package.json 都要重写，不是「原样拷过来」。
      const manifestEntry = entries.find((entry) => !entry.dir && entry.path === "package.json");
      if (!manifestEntry) throw new Error(`${pkg.name}@${pkg.version} 里没有 package.json`);
      const patched = patchedManifest(JSON.parse(manifestEntry.data.toString("utf8")));
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "package.json"), `${JSON.stringify(patched, null, 2)}\n`);
      console.log(`  ✓ ${pkg.name}@${pkg.version} → ${pkg.into === "." ? "lib/vendor/ssh2" : `lib/vendor/ssh2/${pkg.into}`}`);
    }

    const hashes = {};
    for (const file of listFiles(staging).sort()) {
      hashes[file] = sha256(readFileSync(join(staging, file)));
    }
    files.set("files", hashes);

    const manifest = {
      schemaVersion: 1,
      about: "由 scripts/vendor-ssh2.mjs 生成，请勿手改。上下游包都是 MIT，各自 LICENSE 原样保留。",
      packages: PACKAGES.map((pkg) => ({ name: pkg.name, version: pkg.version, tarball: tarballUrl(pkg), sha256: pkg.sha256 })),
      checks: {
        // 这三项是门禁，不是描述：check-install-safe.mjs 与 --check 都会重新算一遍。
        lifecycleScripts: [],
        nativeArtifacts: [],
        entry: "lib/index.js",
      },
      files: hashes,
    };

    rmSync(TARGET, { recursive: true, force: true });
    mkdirSync(TARGET, { recursive: true });
    for (const file of Object.keys(hashes)) {
      const dest = join(TARGET, file);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(staging, file)));
    }
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`\n✓ 已写入 lib/vendor/ssh2：${Object.keys(hashes).length} 个文件，${(JSON.stringify(hashes).length / 1024).toFixed(0)}KB 清单`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function check() {
  const failures = [];
  if (!existsSync(MANIFEST)) {
    console.error("✗ 找不到 lib/vendor/ssh2/VENDOR.json：vendor 目录不完整或从未生成");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const expected = manifest.files ?? {};
  const actual = {};
  for (const file of listFiles(TARGET).filter((f) => f !== "VENDOR.json")) {
    actual[file] = sha256(readFileSync(join(TARGET, file)));
  }
  const missing = Object.keys(expected).filter((f) => !(f in actual));
  const extra = Object.keys(actual).filter((f) => !(f in expected));
  const changed = Object.keys(expected).filter((f) => f in actual && actual[f] !== expected[f]);
  if (missing.length) failures.push(`缺文件：${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` 等 ${missing.length} 个` : ""}`);
  if (extra.length) failures.push(`多出文件：${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ` 等 ${extra.length} 个` : ""}`);
  if (changed.length) failures.push(`内容被改：${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` 等 ${changed.length} 个` : ""}`);

  // 门禁：vendor 里不许有任何安装期脚本或原生产物。
  const lifecycle = [];
  const native = [];
  for (const file of Object.keys(actual)) {
    if (file.endsWith("package.json")) {
      const pkg = JSON.parse(readFileSync(join(TARGET, file), "utf8"));
      for (const key of ["preinstall", "install", "postinstall", "prepare"]) {
        if (pkg.scripts?.[key]) lifecycle.push(`${file}: scripts.${key}`);
      }
      if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length) {
        lifecycle.push(`${file}: optionalDependencies`);
      }
    }
    if (FORBIDDEN_NAMES.has(file.split("/").pop()) || FORBIDDEN_EXT.some((ext) => file.endsWith(ext))) native.push(file);
  }
  if (lifecycle.length) failures.push(`安装期脚本/可选构建依赖：${lifecycle.join("; ")}`);
  if (native.length) failures.push(`原生产物：${native.join(", ")}`);

  if (failures.length) {
    console.error("✗ lib/vendor/ssh2 校验未通过：");
    for (const line of failures) console.error(`    - ${line}`);
    console.error("    重建：node scripts/vendor-ssh2.mjs");
    process.exit(1);
  }
  console.log(`✓ lib/vendor/ssh2 与 VENDOR.json 一致（${Object.keys(actual).length} 个文件，无安装期脚本）`);
}

if (process.argv.includes("--check")) check();
else await build();
