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
  "dsh-mesh-tsnet-android-amd64.gz": "ac9e4cedceff284130cba13ea73b64299e69c4ccbc44b8c16fb252516b8561e7",
  "dsh-mesh-tsnet-android-arm64.gz": "0419ca7e09f1b12e76e0990aa2e55aec08f0db7758f30a2da321bca4670dab61",
  "dsh-mesh-tsnet-darwin-amd64.gz": "e8c547f4a869940f73b1a22b2b2c8d69d2a6eb9667428b56e9ab17630554c050",
  "dsh-mesh-tsnet-darwin-arm64.gz": "32225e7a9edb5362dbe0eddcd95124c0e8645cf077b07e68588ef6cbab3af3fe",
  "dsh-mesh-tsnet-linux-amd64.gz": "ed992d9b33ea331747a053ab84cfb35d696c73ada5df3b36ba74b7ba952287fd",
  "dsh-mesh-tsnet-linux-arm64.gz": "27b569073b8ecefd4518a1ee6250baaff942e439cabd2f453092680c48293b80",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "13091f0e9c2fe09a2dc60a1aa50bca8e6c6f10412bbf657c9373d2fef2fbb179",
};
