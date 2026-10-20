/**
 * 静态检查 `const` 的"声明前使用"（TDZ）。
 *
 * 为什么需要：这类错误**语法完全合法**，`node --check` 抓不到，只在运行时抛
 * ReferenceError。而插件里入站任务处理被 try/catch 包着，异常会被吞掉、任务
 * 停在 accepted —— **静默失败**，发送方看不出异常。
 *
 * 实测连续踩了两次：先把 canInject 判断插到闸门之前，但 `key` / `liveSession`
 * 的声明还留在后面。
 *
 * 判定用**花括号深度**界定作用域（这才是 TDZ 的真实语义）：
 * 从声明处往上扫，遇到深度降到声明深度以下就停（说明已经出了这个块）；
 * 只对**深度恰好等于声明深度**的行报错 —— 更深的是内层块、更浅的是外层，
 * 都不属于同一作用域。用缩进判定会误报（类的各个方法缩进相同）。
 *
 * 排除点号前缀：`st.secret` / `msg.host` 这类属性访问会被误判成变量引用
 * （实测 3 处假阳性全是这一类）。
 *
 * 跑法：node scripts/check-tdz.mjs   （挂在 npm run check 里）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["lib/index.js", "lib/discovery.js", "lib/conversation.js", "lib/identity.js", "lib/layout.js"];
let problems = 0;

/** 逐行计算花括号深度（粗略：不解析字符串/模板串，够用） */
function depths(lines) {
  const out = [];
  let d = 0;
  for (const line of lines) {
    out.push(d);
    const code = line.replace(/\/\/.*$/, "");
    for (const ch of code) {
      if (ch === "{") d += 1;
      else if (ch === "}") d -= 1;
    }
  }
  return out;
}

for (const rel of files) {
  const lines = readFileSync(join(root, rel), "utf8").split("\n");
  const depth = depths(lines);
  const seen = new Set();

  lines.forEach((l, i) => {
    const m = /^(\s*)const ([A-Za-z_$][\w$]*) =/.exec(l);
    if (!m) return;
    const name = m[2];
    const key = `${name}@${depth[i]}`;
    if (seen.has(key)) return; // 同一作用域同名只查一次
    seen.add(key);

    const D = depth[i];
    // 前面不能是 `.` —— `st.secret` / `msg.host` 这类属性访问不是变量引用
    const re = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, "\\$")}\\b`);
    for (let j = i - 1; j >= 0; j -= 1) {
      if (depth[j] < D) break; // 出了这个块
      if (depth[j] > D) continue; // 内层块，不同作用域
      const text = lines[j];
      if (/^\s*(\/\/|\*|\/\*)/.test(text)) continue;
      if (re.test(text)) {
        console.error(`✗ ${rel}:${j + 1} 在声明前使用了 '${name}'（声明在 ${i + 1} 行，同属深度 ${D} 的块）`);
        problems += 1;
        break;
      }
    }
  });
}

if (problems > 0) {
  console.error(`\n发现 ${problems} 处 TDZ 风险：语法合法，但运行时必抛 ReferenceError。`);
  process.exit(1);
}
console.log("✓ 无声明前使用（TDZ）");
