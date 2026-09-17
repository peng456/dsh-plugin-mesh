"""
只适用于 lib/index.js（主机侧）：那里有 applyUnsafe 把一批局部变量
解构传给若干模块级 helper，漏传就是运行时 ReferenceError。
client/client.js 结构不同，本脚本对它没有意义（会报 0 个函数）。

针对本插件最易犯的错误：模块级函数引用了 applyUnsafe 里的局部变量，
却没通过解构参数接收。做法：先收集 applyUnsafe 传给各 helper 的键集合
（= "注入词汇表"），再看每个模块级函数是否引用了词汇表里的名字但没接收。
"""
import re, sys

src = open(sys.argv[1], encoding='utf-8').read()

# 去注释/字符串，避免噪声
def strip_noise(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c == '/' and i+1 < n and s[i+1] == '/':
            j = s.find('\n', i); i = n if j < 0 else j
        elif c == '/' and i+1 < n and s[i+1] == '*':
            j = s.find('*/', i+2); i = n if j < 0 else j+2
        elif c in '"\'`':
            q = c; i += 1
            while i < n and s[i] != q:
                i += 2 if s[i] == '\\' else 1
            i += 1
        else:
            out.append(c); i += 1
    return ''.join(out)

clean = strip_noise(src)

# 1) 收集"注入词汇表"：applyUnsafe 里 startPeerServer/registerTools/registerUiRoutes/setupInbound 的解构键
vocab = set()
for m in re.finditer(r'\b(?:startPeerServer|registerTools|registerUiRoutes|setupInbound)\s*\(\s*ctx\s*,\s*\{([^}]*)\}', clean):
    for k in m.group(1).split(','):
        k = k.strip().split(':')[0].strip()
        if k: vocab.add(k)
vocab.discard('ctx')

def brace_body(s, start):
    d, i, n = 0, start, len(s)
    while i < n:
        if s[i] == '{': d += 1
        elif s[i] == '}':
            d -= 1
            if d == 0: return i
        i += 1
    return n

problems, checked = [], 0
for m in re.finditer(r'^(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)\s*\{', clean, re.M):
    fname, params_raw = m.group(1), m.group(2)
    if fname == 'applyUnsafe': continue
    brace = m.end()-1
    body = clean[brace:brace_body(clean, brace)]

    params = set()
    # 把解构花括号当分隔符，再按逗号切：同时覆盖普通参数和解构键
    for p in re.sub(r'[{}]', ' ', params_raw).split(','):
        p = p.strip().split(':')[0].strip().split('=')[0].strip()
        if re.fullmatch(r'[\w$]+', p): params.add(p)

    # 该函数引用了哪些"词汇表"里的名字
    referenced = {v for v in vocab if re.search(r'(?<![.\w$])' + re.escape(v) + r'\b', body)}
    if not referenced: continue
    checked += 1
    missing = sorted(referenced - params)
    if missing:
        line = clean[:m.start()].count('\n') + 1
        problems.append((line, fname, missing))

print(f'词汇表（applyUnsafe 注入的局部变量）: {", ".join(sorted(vocab))}\n')
for line, fname, miss in sorted(problems):
    print(f'  ❌ {fname}() 引用了但未接收: {", ".join(miss)}')
if problems:
    sys.exit(1)
print(f'  ✅ 检查了 {checked} 个函数，引用全部在解构参数内')
