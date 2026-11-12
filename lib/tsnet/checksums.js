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
  "dsh-mesh-tsnet-android-amd64.gz": "5bdaaae79ba6530a89b2abcbeb9b3ab211bc9c9bb789cd400575208ef8e4289b",
  "dsh-mesh-tsnet-android-arm64.gz": "b10f13079b5b699d56009890a876f8cef8d391d393da37d348b4012684ffa2cd",
  "dsh-mesh-tsnet-darwin-amd64.gz": "1bdb986591c5bfee6ec1539cf2f7322f4067a700626199254f77d2d9905416f9",
  "dsh-mesh-tsnet-darwin-arm64.gz": "bfe1b07a5be5c4f1841131afbfc319017dd79c3440860e829d8151187845e218",
  "dsh-mesh-tsnet-linux-amd64.gz": "9e5800927abbda33e7c0828ecd882381c8fcab3a7b066491a5eaaee97a22714e",
  "dsh-mesh-tsnet-linux-arm64.gz": "226b6478c35ad893b4d53705103cc4c5233fc4016ee7da2b00b277b1d915a86e",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "d86b269bdf5d7b04615f911c0462ff5437433e26652cbe65a7780be5a31606ed",
};
