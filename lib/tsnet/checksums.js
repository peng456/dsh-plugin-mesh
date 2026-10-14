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
  "dsh-mesh-tsnet-android-amd64.gz": "a1ab572bd49ef8cb961381b77444b01035e8fdd1132a1d1d6f034e3d682228cf",
  "dsh-mesh-tsnet-android-arm64.gz": "63b0db12b1aa101be91a0ea47390cce9f994bff41e62ed6ea085e4e0a9774dc5",
  "dsh-mesh-tsnet-darwin-amd64.gz": "20b2677611f2fb9d2c6690db0d962501fc3d287c9674942985782191bc5b5902",
  "dsh-mesh-tsnet-darwin-arm64.gz": "c98b4975406962dcf6523da92f3242006e7cd281d9f7cbc93833121472b4a686",
  "dsh-mesh-tsnet-linux-amd64.gz": "3a5364bbbef6dc0030a33efaa05e37283f58b6800380738ba8a37d5504f4efa2",
  "dsh-mesh-tsnet-linux-arm64.gz": "558270cc3d2ed77ccb9a54b173f8d0ae658c5d5748ac05847d0038d709634bff",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "39eb66ebc2bca246c89dd4b2d047787d237f259b28d0db2e1ba598403cfa15e8",
};
