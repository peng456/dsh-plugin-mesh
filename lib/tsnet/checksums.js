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
  "dsh-mesh-tsnet-android-amd64.gz": "8639ed901e18bf0d226b7035472832730b5648bb2c96206fa5ae0372bea573ed",
  "dsh-mesh-tsnet-android-arm64.gz": "9fa13754838bcccc618469b931456e1c036a341cfea1704bb08737630fc70369",
  "dsh-mesh-tsnet-darwin-amd64.gz": "859a6f7474b5adcbc46876bb0b7b8b0b77c172bba47bb28f13c33578ad75b117",
  "dsh-mesh-tsnet-darwin-arm64.gz": "aee831dd4d6dbe16d02e0b452b5bb88cbcd70feb35d103584eb996e6858d5d5b",
  "dsh-mesh-tsnet-linux-amd64.gz": "60d9975b48171c45c2024bf914c0a04881b58f31019d216c10610326d0974b1d",
  "dsh-mesh-tsnet-linux-arm64.gz": "e9cdf6a8701cc97f8eb0c37f2f9c69bf93db0a2ca653cd733f926703ce606e2a",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "ca81ae34e19f595edf1ce811c64f499fe9b3f8a9f1a693a45b4a678728a07cd7",
};
