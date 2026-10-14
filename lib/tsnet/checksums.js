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
  "dsh-mesh-tsnet-darwin-amd64.gz": "49327a37cf9430e101dca9d50d7bdcc5919ec3b41560226f35ca3121794c3051",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "74aa5f270c77cd7a0b179017553403660355252f3691bcb360a41207fac647e1",
};
