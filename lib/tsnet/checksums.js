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
  "dsh-mesh-tsnet-android-amd64.gz": "1f4d7776ea0c78cfe7c075e9efad40fb2719d4a12e4067534ba89099338e48b7",
  "dsh-mesh-tsnet-android-arm64.gz": "82b3d50c1e0aed455d98071549e9b6910cd5e03a68e3d336849302c3be210531",
  "dsh-mesh-tsnet-darwin-amd64.gz": "e293fb1c1ae1fa88d41d2230ae64ad6434b33936b588b3180a49690beba5eaba",
  "dsh-mesh-tsnet-darwin-arm64.gz": "e3bd81e71caa6ea5ff59adfa2e74f1584e542ec3aabbef1f77fa3c6a7b085de8",
  "dsh-mesh-tsnet-linux-amd64.gz": "f2827a334a51a6c595bcd8603220ad047909017a2b737edbd3233097c32840a3",
  "dsh-mesh-tsnet-linux-arm64.gz": "5fb019663af22410e38cdae91d01238060e6329d736f551c735a02686b4dc6bd",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "87c08233ec5ac724bba5e591306400b5fcb55da3487be795aa17cdb1fb8deb89",
};
