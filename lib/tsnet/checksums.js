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
  "dsh-mesh-tsnet-android-amd64.gz": "65740960df9fecb362fe5b8ce8e7e988564555a78ba7e52b1cc8a76a5d517626",
  "dsh-mesh-tsnet-android-arm64.gz": "b410a5ab6e499f44f107acaa0d5b9db1590c62c945bb53d1ed083e7e11c61580",
  "dsh-mesh-tsnet-darwin-amd64.gz": "a12922eb4b7bea74eae018bb5845291e019763a7b9c7f6ab1c68d58078744414",
  "dsh-mesh-tsnet-darwin-arm64.gz": "bfea7e491872824f17a7971edb963220b02ad14b0a47204939587fd1a9642b46",
  "dsh-mesh-tsnet-linux-amd64.gz": "7218a8e472792d8373c3151ade6b73df8a997de24ae4470049d010f60648f6b3",
  "dsh-mesh-tsnet-linux-arm64.gz": "923d897c809c8bd36ecd11f3e69b65d895588d7f4782ebb96701ba2948763299",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "1a01306616a0a6a7c512d0d4d642d7b5aa63906b78165144c04f8c89997745f7",
};
