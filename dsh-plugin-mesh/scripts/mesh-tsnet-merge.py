#!/usr/bin/env python3
"""把 mesh 的 tailnet(tsnet) 配置**合并**进 cordis.patch.yml，而不是整块替换。

为什么必须有这个工具
--------------------
`@deepseek-ai/cordis-plugin-include` 应用非 insert patch 时是**浅赋值**：
    for (const [key, value] of Object.entries(overrides)) target[key] = value
（见该包 src/index.ts L121-124 / lib/index.js L99-102）

`config` 只是**一个** key，所以 profile 的 cordis.patch.yml 里写

    - id: mesh
      config:
        tsnetEnabled: true

不是"只改这一个键"，而是**把整个 config 对象换掉**。原来写在这一块里的
permissionPreset / workspaceRoot / port / 限速参数……全部消失，回落到 schema
默认值。

后果不是理论：`permissionPreset` 默认 `workspace-write`（lib/index.js L139），
`workspaceRoot` 默认 `''` → 主目录（L141）。在 Windows 上这会让 ACL 沙箱
fail-closed（"Windows ACL temp root must be outside the workspace"），
**本机所有入站 mesh 任务的命令执行全部失败** —— 包括刚打开的 tsnet 那条路，
因为它读的是同一个值（`tsnetPermissionPreset || permissionPreset`，L692/L714）。

而且 tsnet 路径同样吃这个值，所以"整块替换"会让组网刚开就把入站任务全废掉。

所以本工具做的是**文本级、键级**的合并：只增删指定的键，其他键、注释、
缩进风格、行尾、BOM 原样保留。幂等，可重复执行。

用法
----
    # 预览（默认不写盘）
    python3 mesh-tsnet-merge.py --file cordis.patch.yml \\
        --download-source http://192.168.1.6:8791/

    # 落地（自动在同目录留一份 .bak-<时间戳>）
    python3 mesh-tsnet-merge.py --file cordis.patch.yml \\
        --download-source http://192.168.1.6:8791/ --apply

    # 只校验现状（不写盘，非零退出码表示有问题）
    python3 mesh-tsnet-merge.py --file cordis.patch.yml --check

注意：`tsnetEnabled` / `tsnetAuthKey` / `tsnetHostname` 其实**不需要**写进
patch 文件。插件对它们有 state.json 兜底（lib/index.js effectiveTsnetConfig
L328-339），在 Mesh 页面上填一次即可（存 state.json，0600），重启不用再填。
真正**只能**写在 config 里的只有 `tsnetDownloadSources`（只有它没有 state
兜底），所以多数情况下你只需要合并这一个键。
"""
import argparse
import datetime
import os
import re
import sys

# 我们管理的键 → 它们在 config 里的书写顺序
MANAGED_ORDER = [
    "tsnetEnabled",
    "tsnetAuthKey",
    "tsnetControlUrl",
    "tsnetHostname",
    "tsnetDownloadSources",
    "tsnetPermissionPreset",
]

ENTRY_RE = re.compile(r"^(?P<indent>[ \t]*)-\s*id:\s*['\"]?mesh['\"]?\s*(?:#.*)?$")
CONFIG_RE = re.compile(r"^(?P<indent>[ \t]*)config:\s*(?P<rest>.*)$")
KEY_RE = re.compile(r"^(?P<indent>[ \t]*)(?P<key>[A-Za-z_][\w-]*):")


class MergeError(Exception):
    pass


def indent_of(line):
    return len(line) - len(line.lstrip(" \t"))


def is_blank_or_comment(text):
    s = text.strip()
    return s == "" or s.startswith("#")


def split_lines(text):
    """按行切开，保留行尾。返回 (lines, newline_style)。"""
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    newline = "\r\n" if crlf > lf else "\n"
    # splitlines 会吃掉行尾，这里手工切，保证能原样拼回
    lines = text.splitlines(keepends=True)
    return lines, newline


def bare(line):
    return line.rstrip("\r\n")


def find_mesh_entry(lines):
    """返回所有 `- id: mesh` 行的下标。多个就是坏味道，调用方会拒写。"""
    return [i for i, ln in enumerate(lines) if ENTRY_RE.match(bare(ln))]


def find_entry_end(lines, start):
    """entry 的块范围 [start+1, end)，下一个同级或更浅的 `- ` 之前。"""
    base = indent_of(bare(lines[start]))
    i = start + 1
    while i < len(lines):
        text = bare(lines[i])
        if is_blank_or_comment(text):
            i += 1
            continue
        ind = indent_of(text)
        if ind < base:
            break
        if ind == base and text.lstrip().startswith("- "):
            break
        i += 1
    return i


def find_config_line(lines, entry_start, entry_end):
    for i in range(entry_start + 1, entry_end):
        m = CONFIG_RE.match(bare(lines[i]))
        if m:
            return i, m
    return None, None


def config_block_end(lines, config_idx, config_indent):
    i = config_idx + 1
    while i < len(lines):
        text = bare(lines[i])
        if is_blank_or_comment(text):
            i += 1
            continue
        if indent_of(text) <= config_indent:
            break
        i += 1
    return i


def child_indent_of(lines, config_idx, block_end, config_indent):
    for i in range(config_idx + 1, block_end):
        text = bare(lines[i])
        if is_blank_or_comment(text):
            continue
        return indent_of(text)
    return config_indent + 2


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def render_key(key, value, indent, newline):
    pad = " " * indent
    if key == "tsnetDownloadSources":
        urls = value if isinstance(value, (list, tuple)) else [value]
        out = [f"{pad}{key}:{newline}"]
        for u in urls:
            out.append(f"{pad}  - {quote(u)}{newline}")
        return out
    if isinstance(value, bool):
        return [f"{pad}{key}: {'true' if value else 'false'}{newline}"]
    return [f"{pad}{key}: {quote(value)}{newline}"]


def merge(text, settings):
    """返回 (新文本, 变更说明列表)。settings: {key: value}"""
    lines, newline = split_lines(text)

    entries = find_mesh_entry(lines)
    if len(entries) > 1:
        raise MergeError(
            "发现 %d 个 `- id: mesh`（行 %s）。重复条目会让哪个生效变得不确定，"
            "请先手工删到一个再跑本工具。" % (len(entries), [e + 1 for e in entries])
        )

    notes = []
    order = [k for k in MANAGED_ORDER if k in settings]

    if not entries:
        # 整个 profile 里还没有 mesh 条目：追加一个
        if text and not text.endswith(("\n", "\r")):
            lines[-1] = lines[-1] + newline
        if lines:
            lines.append(newline)
        lines.append(f"- id: mesh{newline}")
        lines.append(f"  config:{newline}")
        for key in order:
            lines.extend(render_key(key, settings[key], 4, newline))
        notes.append("文件中没有 `- id: mesh`，已新建该条目（%d 个键）" % len(order))
        return "".join(lines), notes

    entry_start = entries[0]
    entry_end = find_entry_end(lines, entry_start)
    config_idx, config_m = find_config_line(lines, entry_start, entry_end)

    if config_idx is None:
        # 有条目但没有 config：在条目末尾补一个
        pad = " " * (indent_of(bare(lines[entry_start])) + 2)
        block = [f"{pad}config:{newline}"]
        for key in order:
            block.extend(render_key(key, settings[key], len(pad) + 2, newline))
        lines[entry_end:entry_end] = block
        notes.append("`- id: mesh` 没有 config:，已补上并写入 %d 个键" % len(order))
        return "".join(lines), notes

    rest = config_m.group("rest").strip()
    if rest and not rest.startswith("#"):
        raise MergeError(
            "第 %d 行的 config 是内联写法（`config: %s`），文本级合并无法安全处理。"
            "请先手工改成块写法再跑。" % (config_idx + 1, rest)
        )

    config_indent = len(config_m.group("indent"))
    block_end = config_block_end(lines, config_idx, config_indent)

    # 删掉我们要重设的键（幂等：重复执行结果一致）。
    # 注意必须连带删掉它的**续行**（更深缩进的部分，例如 tsnetDownloadSources
    # 的列表项）—— 只删父行会留下一串孤儿 `- 'url'`，YAML 直接坏掉。
    child_indent = child_indent_of(lines, config_idx, block_end, config_indent)
    removed = []
    keep = []
    i = config_idx + 1
    while i < block_end:
        m = KEY_RE.match(bare(lines[i]))
        if m and len(m.group("indent")) == child_indent and m.group("key") in settings:
            removed.append(m.group("key"))
            j = i + 1
            while j < block_end and (is_blank_or_comment(bare(lines[j]))
                                     or indent_of(bare(lines[j])) > child_indent):
                j += 1
            # 续行 = 直到最后一个更深缩进的行为止；之后的空行/注释是键间留白，保留
            last_deep = i
            for k in range(i + 1, j):
                if not is_blank_or_comment(bare(lines[k])) and indent_of(bare(lines[k])) > child_indent:
                    last_deep = k
            keep.extend(lines[last_deep + 1:j])  # 尾部留白/注释留着
            i = j
            continue
        keep.append(lines[i])
        i += 1
    lines[config_idx + 1:block_end] = keep
    if removed:
        notes.append("替换已存在的键：%s" % ", ".join(removed))

    child_indent = child_indent_of(lines, config_idx, config_idx + 1 + len(keep), config_indent)
    block = []
    for key in order:
        block.extend(render_key(key, settings[key], child_indent, newline))
    lines[config_idx + 1:config_idx + 1] = block
    notes.append("写入 %d 个 tsnet 键（保留其他 %d 行原样）" % (len(order), len(keep)))
    return "".join(lines), notes


def summarize(text):
    """只做结构性统计，不解析 YAML —— 用来给 --check 输出可核对的证据。"""
    lines, _ = split_lines(text)
    info = {
        "mesh_entries": len(find_mesh_entry(lines)),
        "bytes": len(text.encode("utf-8")),
    }
    for key in MANAGED_ORDER:
        info[key] = len(re.findall(r"^\s*%s:" % key, text, re.M))
    return info


def main():
    ap = argparse.ArgumentParser(description="把 tsnet 配置合并进 cordis.patch.yml（键级，不整块替换）")
    ap.add_argument("--file", required=True, help="目标 cordis.patch.yml")
    ap.add_argument("--download-source", action="append", default=[], help="tsnetDownloadSources 的前缀，可重复")
    ap.add_argument("--auth-key", help="tsnetAuthKey（一般不需要：建议在 Mesh 页面填，存 state.json）")
    ap.add_argument("--hostname", help="tsnetHostname（同上，一般不需要写进 patch）")
    ap.add_argument("--control-url", help="tsnetControlUrl（Headscale 才需要）")
    ap.add_argument("--enabled", dest="enabled", action="store_true", default=None, help="把 tsnetEnabled 钉死为 true")
    ap.add_argument("--disabled", dest="enabled", action="store_false", help="把 tsnetEnabled 钉死为 false")
    ap.add_argument("--apply", action="store_true", help="真正写盘（默认只预览）")
    ap.add_argument("--check", action="store_true", help="只输出当前结构统计，不写盘")
    args = ap.parse_args()

    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        sys.exit("文件不存在：%s" % path)
    with open(path, "rb") as fh:
        raw = fh.read()
    bom = raw.startswith(b"\xef\xbb\xbf")
    body = raw[3:] if bom else raw
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as err:
        sys.exit("不是合法 UTF-8：%s" % err)

    if args.check:
        for k, v in summarize(text).items():
            print("%-24s %s" % (k, v))
        print("BOM:", "有" if bom else "无")
        print("行尾:", "CRLF" if text.count("\r\n") > text.count("\n") - text.count("\r\n") else "LF")
        return

    settings = {}
    if args.enabled is not None:
        settings["tsnetEnabled"] = bool(args.enabled)
    if args.auth_key:
        settings["tsnetAuthKey"] = args.auth_key
    if args.control_url:
        settings["tsnetControlUrl"] = args.control_url
    if args.hostname:
        settings["tsnetHostname"] = args.hostname
    if args.download_source:
        settings["tsnetDownloadSources"] = list(args.download_source)

    if not settings:
        sys.exit("没有要改的键。至少给一个 --download-source / --auth-key / --hostname / --enabled。")

    try:
        new_text, notes = merge(text, settings)
    except MergeError as err:
        sys.exit("拒绝写入：%s" % err)

    for n in notes:
        print("·", n)

    if not args.apply:
        print("\n（预览模式，未写盘。确认无误后加 --apply）")
        print("---- 结果预览 ----")
        sys.stdout.write(new_text)
        return

    out = new_text.encode("utf-8")
    if bom:
        out = b"\xef\xbb\xbf" + out
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = "%s.bak-merge-%s" % (path, stamp)
    with open(backup, "wb") as fh:
        fh.write(raw)
    with open(path, "wb") as fh:
        fh.write(out)
    print("\n已写入：%s" % path)
    print("备份：  %s" % backup)
    print("字节：  %d → %d" % (len(raw), len(out)))


if __name__ == "__main__":
    main()
