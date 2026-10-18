# qrcode-generator (vendored)

`qrcode.mjs` 是 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4
（作者 Kazuhiko Arase，MIT）的 `dist/qrcode.mjs`，原样内置（保留文件头里的版权与
MIT 许可声明）。

为什么内置而不是加依赖：本插件的宿主/客户端都不希望引入运行时依赖；二维码只在
配对页面按需生成，一个 52KB 的单文件编码器足够，也避免把配对码发给任何在线 QR 服务。
