/**
 * 兼容入口：工作台改版后，旧的“卡片组件”自测不再适用。
 * 新的渲染自测在 _selftest-workbench.mjs，保留这个文件名是为了让
 * package.json 里的 selftest:client 继续工作。
 *
 * 旧版断言（CapabilityLine / PeerRow / TsnetCard / SecretBox）已归档到
 * _selftest-client.cards.mjs，仅作历史参考，不参与 npm test。
 */
import "./_selftest-workbench.mjs";
