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
  "dsh-mesh-tsnet-darwin-amd64.gz": "11a3efcbe7a36aa535e332734cb364f0b6a1f4f7ab1859f591ab8949bb6f234d",
  "dsh-mesh-tsnet-linux-amd64.gz": "c6bff2b3caffca2daaf449911525f5d808e0a4a10c06bb69b40064617faa0fab",
  "dsh-mesh-tsnet-linux-arm64.gz": "014370210ca22a352f5b951ec9a21cbecd45985696f71eea0dec3abedeca486d",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "4bd1d146a1b74a2c02039b33aabc41dc8a4c76a44421ac995e37ccc4bca473df",
};
