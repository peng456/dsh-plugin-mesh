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
  "dsh-mesh-tsnet-android-amd64.gz": "e90e35b3b70be2ece3760c2e6bf3a34d7ff6e6bf782c5f0defd5be6dc424768b",
  "dsh-mesh-tsnet-android-arm64.gz": "818429330281ba07f1583856aa6496a0057d1c1903342cf645d9cb5b9a3def19",
  "dsh-mesh-tsnet-darwin-amd64.gz": "98ad5185d804a2140222a4bc50e6db9b21a1fc6a4b65584a2d3e5476bc46dc9d",
  "dsh-mesh-tsnet-darwin-arm64.gz": "d0997acd5949078b889188fdabb87f8ef0e8cb59b5223302f633c594653db9f5",
  "dsh-mesh-tsnet-linux-amd64.gz": "1af2f95a841e116c24d782cac973ab35b6d7fc626565f5b47d7469949b99905f",
  "dsh-mesh-tsnet-linux-arm64.gz": "75825ad61661b44306a5d313ffa06dcdd8721d88a4b03b36ce4760aa4afabbaf",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "374adc8f5c7ecb2175dbf239c430ff273abc70263f6609a3ecf4c25d4cdcba41",
};
