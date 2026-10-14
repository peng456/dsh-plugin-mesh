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
  "dsh-mesh-tsnet-android-amd64.gz": "78b7fc589108bb48dffda7430d95fb15351b7f352590659921faeaf40446e4e1",
  "dsh-mesh-tsnet-android-arm64.gz": "39bbb5d3bcefa12df545a68f05c5ec9b4aa9f9f1d875eff5806945aeaa8596fd",
  "dsh-mesh-tsnet-darwin-amd64.gz": "c519354128ebe1545acbae759dd8be0440d7dd0b5ddc59308f2206c09aae26e2",
  "dsh-mesh-tsnet-darwin-arm64.gz": "07f0596732781ef444677e060578be9007197375b3f8645669f6dbeecf7daa29",
  "dsh-mesh-tsnet-linux-amd64.gz": "9701164100617742af9772cf405d380cdb17b54384fde9bbf5a071e1357eb7d7",
  "dsh-mesh-tsnet-linux-arm64.gz": "2b5a6bca9039a80e8d653d78f746ac46fc46a2f3ec68df1968eb5dbfe38cf805",
  "dsh-mesh-tsnet-windows-amd64.exe.gz": "f7e4098bcedb4c86323c8e96f253cf12cc5345323abfd35fee75c8f014c24d9a",
};
