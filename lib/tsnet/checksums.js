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
  "dsh-mesh-tsnet-android-amd64.gz": "6006fdd647af32cafdeedf4cd7b9d712ed6f7c211e960a21a54a27a31998c8fb",
  "dsh-mesh-tsnet-android-arm64.gz": "af81c3216454c5d800d883b6504464f3d25317413150f53ad764c50f5ee6f08c",
  "dsh-mesh-tsnet-darwin-amd64.gz": "87c274a38d168331aa64f6a1920088ba9b2f31eda5c8c8d7bf783ad6e95dd42b",
  "dsh-mesh-tsnet-darwin-arm64.gz": "60c41a6e79586da3f807d94650cbf9c05aa261935cf9f14ccf0c32d12418e85b",
  "dsh-mesh-tsnet-linux-amd64.gz": "85dfb668b3bd89d57a935877dfcdfafba0a11ed08941dd81b17a48dfe7055526",
  "dsh-mesh-tsnet-linux-arm64.gz": "96553993279dc936ebaf87d4ba64b844d0581323ece51774afa8e116f0b7162c",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "56de96cea95d5dfb9b693f81a9d879439298bad2ef8238279ed5eb434eb2127a",
};
