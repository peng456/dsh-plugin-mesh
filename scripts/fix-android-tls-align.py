#!/usr/bin/env python3
"""把 PT_TLS 的 p_align 抬到 bionic 能接受的值（原地改写 ELF 文件）。

为什么需要这一步（真机实测 2026-10，Android 5.10.43 aarch64）：

    error: "…/dsh-mesh-tsnet": executable's TLS segment is underaligned:
           alignment is 8, needs to be at least 64 for ARM64 Bionic

Go 的**内部链接器**在产 PIE 时把 PT_TLS 的 p_align 硬编码成寄存器宽度：

    cmd/link/internal/ld/elf.go:  ph.Align = uint64(ctxt.Arch.RegSize)   // arm64 上是 8

而 ARM64 bionic 要求 ≥64（x86_64 bionic 要求 ≥16）。外部链接器（NDK 的 lld）
会按符号对齐算这个值，所以 Go 自己不管 —— 用内部链接器就得自己补。

安全性：ELF 的 TLS 块按 variant II 布局，**块尾贴着线程指针 TP，符号地址 =
TP - (tls_size - sym_offset)**。p_align 只影响块**起点**（更低地址）留多少填充，
不改变任何符号相对块尾的偏移，所以把 8 改成 64 只是多留 48 字节填充，
Go 运行时算出来的 TLS 地址不变（真机上改完 p_align 进程即可正常加载运行）。

用法：
    scripts/fix-android-tls-align.py <elf-file> [更多文件…]
"""
import struct
import sys

EM_X86_64 = 62
EM_AARCH64 = 183
PT_TLS = 7

# bionic 对主可执行文件 TLS 段对齐的最低要求（linker/linker.cpp）。
MIN_ALIGN = {
    EM_AARCH64: 64,
    EM_X86_64: 16,
}


def fix(path):
    with open(path, "rb") as fh:
        data = bytearray(fh.read())

    if data[:4] != b"\x7fELF" or data[4] != 2:
        sys.exit(f"{path}: 不是 64 位 ELF，拒绝改写")

    e_machine = struct.unpack_from("<H", data, 18)[0]
    e_phoff = struct.unpack_from("<Q", data, 32)[0]
    e_phentsize = struct.unpack_from("<H", data, 54)[0]
    e_phnum = struct.unpack_from("<H", data, 56)[0]

    want = MIN_ALIGN.get(e_machine)
    if want is None:
        print(f"    · {path}: e_machine={e_machine} 不在已知 bionic 目标里，跳过")
        return

    patched = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_TLS:
            continue
        # Elf64_Phdr: p_type(4) p_flags(4) p_offset(8) p_vaddr(8) p_paddr(8)
        #             p_filesz(8) p_memsz(8) p_align(8)  → p_align 在 +48
        cur = struct.unpack_from("<Q", data, off + 48)[0]
        if cur >= want:
            patched.append(f"p_align={cur} 已达标")
            continue
        struct.pack_into("<Q", data, off + 48, want)
        patched.append(f"p_align {cur} → {want}")

    if not patched:
        # 没有 TLS 段就没什么可修的：Go 只在有 TLS 符号时才发 PT_TLS。
        print(f"    · {path}: 没有 PT_TLS，跳过")
        return

    with open(path, "wb") as fh:
        fh.write(data)
    print(f"    ✓ {path}: {'; '.join(patched)}")


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[-1].strip())
    for path in sys.argv[1:]:
        fix(path)


if __name__ == "__main__":
    main()
