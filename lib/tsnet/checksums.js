/**
 * sidecar 二进制的 sha256 白名单 —— 由 scripts/build-sidecar.sh 发布时生成，请勿手改。
 *
 * 为什么钉在这里而不是下载 release 里的 checksums.txt：
 * 下载源在国内必须走第三方镜像（直连 GitHub 实测不通）。如果校验和也跟着
 * 二进制一起从镜像拿，一个恶意镜像就能同时替换两者，校验形同虚设。钉在
 * 插件源码里（与二进制分属不同渠道）才构成真正的完整性约束。
 *
 * 键是资产名，值是 gzip 压缩后的 sha256。
 */
export const PINNED_CHECKSUMS = {
  "dsh-mesh-tsnet-android-amd64.gz": "2b97c82036f361dfda83551fb5a80f84edfc86630df393cc06153f277725e95f",
  "dsh-mesh-tsnet-android-arm64.gz": "e88385ad8e1746620564543d201fb9f7d4cb3b26b4a12b5c45e56b35cafba449",
  "dsh-mesh-tsnet-darwin-amd64.gz": "793c775bd6b65c491cfa754fe3df3533ef423c0a1d43b95a1a537c7cbe53c8d3",
  "dsh-mesh-tsnet-darwin-arm64.gz": "9256a636787956de4a62a651b999e6a336aeffbf8e6eff4f0b558cf22f9fa321",
  "dsh-mesh-tsnet-linux-amd64.gz": "1a8df647bba95524c32eb277aeb1eec89a2991e9b0ef04f18255379e0fe35d21",
  "dsh-mesh-tsnet-linux-arm64.gz": "c8a3d8d4cad7bf3e28a265b27d79f74c4c807ebb50cb76baef87b8c3cf962bcd",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "4e9676fe371656a91c8d019c9483e0836cea8d28f46a625780cb593419cd6637",
};
