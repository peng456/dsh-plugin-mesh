// Exercise the real wakeAgent function with inert host services; no model calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("./index.js", import.meta.url), "utf8");
const start = source.indexOf("async function wakeAgent(");
const end = source.indexOf("\nfunction resolveWorkspace(", start);
assert.ok(start >= 0 && end > start, "wakeAgent source boundaries must exist");
const wake = vm.runInNewContext(`(${source.slice(start, end)})`, {
  randomUUID: () => "test-id",
  brandString: (id) => id,
  resolveWorkspace: () => "/test",
  permissionPresetFor: () => "read-only",
  createUserMessage: (message) => message,
  buildPrompt: () => "test task",
  RULE_KIND: "test", RULE_ID: "test",
});

for (const effort of ["low", "high", undefined]) {
  let captured;
  let prompted = false;
  const selection = { provider: "test-provider", model: "test-model" };
  if (effort !== undefined) selection.reasoningEffort = effort;
  const ctx = {
    agentPresets: { resolve: async () => ({ id: "standard" }), mount: async () => {} },
    workspaceRegistry: { create: async () => ({ path: "/test", attachSession: async () => {} }) },
    agentDefaultModel: { currentSelection: () => selection },
    agents: { create: async (options) => {
      captured = options.agentOptions;
      await options.setup({});
      return { agent: { session: {}, followup: () => { prompted = true; } } };
    } },
    permissionPresets: { set: () => {} },
    sessionTitle: { rename: () => {} },
  };
  await wake({ ctx }, { agentPreset: "standard" }, { id: "task-id", from: "peer" });
  assert.equal(captured.provider, selection.provider);
  assert.equal(captured.model, selection.model);
  assert.equal(captured.reasoningEffort, effort);
  assert.equal(Object.hasOwn(captured, "reasoningEffort"), effort !== undefined);
  assert.ok(prompted, "session setup must still reach followup");
  console.log(`✓ wakeAgent ${effort === undefined ? "omits unset reasoningEffort" : `preserves reasoningEffort=${effort}`}`);
}
