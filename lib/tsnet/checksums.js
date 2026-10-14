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
  "dsh-mesh-tsnet-android-amd64.gz": "2b29c8328cb60d31acdddba5eb0465f64aa1625c877260fcfc35e6eff1b50f31",
  "dsh-mesh-tsnet-android-arm64.gz": "fb74f0f352149b4ac8119b0418e2d2b7577ddc7c33608c91d48dcf2d0ffdc880",
  "dsh-mesh-tsnet-darwin-amd64.gz": "7b12a45e913d920f8d2f27aa383c9a82b0a34b170326e30ec5eb5a206bf4898f",
  "dsh-mesh-tsnet-darwin-arm64.gz": "712fe158dd1d6336026c137f697d3947c9877890cd9e5b24e2f756209cb1b7bd",
  "dsh-mesh-tsnet-linux-amd64.gz": "a111edcfb4a1201f7f2d476478120155bc5fb17397ee9b97c40150f75218d1e1",
  "dsh-mesh-tsnet-linux-arm64.gz": "29ba94b6fb4db799733b7841275c3ffe8fffb70d32977b5030d45819aacc834a",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "3624e3f6df73faf2c90b2527afe3fa85a3dd1085b0761bc7ca6b6b2c7a6dcfc0",
};
