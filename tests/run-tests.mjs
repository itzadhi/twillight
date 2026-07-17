import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config/loader.mjs"
import { apiKeyEnvName, apiKeysEnvName, credentialPath, hasSavedApiKey, readCredentials, savedApiKeyCount, saveApiKey, writeCredentials } from "../src/config/credentials.mjs"
import { normalizePath } from "../src/security/path-policy.mjs"
import { assertCommandAllowed } from "../src/security/command-policy.mjs"
import { assertPermission } from "../src/security/permissions.mjs"
import { createRegistry } from "../src/tools/registry.mjs"
import { createRenderer } from "../src/utils/terminal.mjs"
import { createTaskStore, needsApproval, planLocalWorkflow } from "../src/agent/workflow.mjs"
import { polishAssistantText } from "../src/agent/agent-loop.mjs"
import { canUseNativeRenderer, detectOpenTui } from "../src/ui/opentui-adapter.mjs"
import { opentuiEnvSchema, readOpenTuiEnv } from "../src/ui/opentui-env.mjs"
import { virtualComponents } from "../src/ui/virtual-components.mjs"
import { extractCodeBlocks } from "../src/ui/dashboard.mjs"
import { closestCommand, isLikelyModelId, mouseScrollDelta } from "../src/cli/index.mjs"
import { normalizeProviderContent } from "../src/providers/openrouter-provider.mjs"
import { normalizeProviderName, providerInfo, providerNames } from "../src/providers/catalog.mjs"
import { skillList } from "../src/skills/catalog.mjs"

const root = mkdtempSync(join(tmpdir(), "twillight-"))
process.env.TWILLIGHT_CONFIG_DIR = join(root, "config")
const state = {
  root,
  cwd: root,
  config: { permissionMode: "standard" },
  changes: [],
  commands: [],
  audit: [],
  backups: [],
  ui: createRenderer(""),
}

assert.equal(loadConfig(["--read-only"]).permissionMode, "read-only")
assert.equal(credentialPath(root).toLowerCase().includes("twillight"), true)
writeCredentials(root, { OPENROUTER_API_KEY: "test-key" })
assert.equal(readCredentials(root).OPENROUTER_API_KEY, "test-key")
writeCredentials(root, { OPENROUTER_KEY: "alias-key", OPENAI_API_KEY: "your_new_key_here" })
assert.equal(readCredentials(root).OPENROUTER_API_KEY, "alias-key")
assert.equal(hasSavedApiKey(root, "openrouter"), true)
assert.equal(hasSavedApiKey(root, "openai"), false)
saveApiKey(root, "openrouter", "saved-key")
assert.equal(readCredentials(root).OPENROUTER_API_KEY, "saved-key")
assert.equal(readCredentials(root).OPENROUTER_API_KEYS.length, 1)
saveApiKey(root, "openrouter", "saved-key-2", { append: true })
assert.equal(savedApiKeyCount(root, "openrouter"), 2)
saveApiKey(root, "groq", "groq-key")
assert.equal(apiKeyEnvName("groq"), "GROQ_API_KEY")
assert.equal(apiKeysEnvName("groq"), "GROQ_API_KEYS")
assert.equal(readCredentials(root).GROQ_API_KEY, "groq-key")
assert.equal(apiKeyEnvName("ollama"), "")
assert.equal(normalizeProviderName("hf"), "huggingface")
assert.equal(providerInfo("ollama").noAuth, true)
assert.equal(providerInfo("cloudflare").noAuth, true)
assert.equal(providerInfo("cloudflare").defaultModel, "@cf/moonshotai/kimi-k2.7-code")
assert.equal(providerNames().includes("sambanova"), true)
assert.equal(providerNames().includes("cloudflare"), true)
assert.equal(skillList().some((skill) => skill.id === "plan-first-build"), true)
assert.equal(normalizePath(state, "file.txt").endsWith("file.txt"), true)
assert.throws(() => normalizePath(state, `${root}2\\escape.txt`, { workspaceOnly: true }))
assert.throws(() => normalizePath(state, "safe.txt\0bad", { workspaceOnly: true }))
assert.throws(() => normalizePath(state, "file.txt:secret", { workspaceOnly: true }))
assert.throws(() => normalizePath(state, "C:relative.txt", { workspaceOnly: true }))
assert.throws(() => normalizePath(state, "\\\\?\\C:\\Windows\\system32", { workspaceOnly: true }))
assert.throws(() => assertPermission({ config: { permissionMode: "god-mode" } }, "read-only"))
assert.throws(() => assertCommandAllowed(state, "git reset --hard"))
assert.doesNotThrow(() => assertCommandAllowed({ config: { permissionMode: "standard", commandAllowlist: "npm test,node --check" } }, "npm test"))
assert.doesNotThrow(() => assertCommandAllowed({ config: { permissionMode: "standard", commandAllowlist: "npm test,node --check" } }, "npm test -- --runInBand"))
assert.throws(() => assertCommandAllowed({ config: { permissionMode: "standard", commandAllowlist: "npm test,node --check" } }, "npm test-malicious"))
assert.throws(() => assertCommandAllowed({ config: { permissionMode: "standard", commandAllowlist: "npm test,node --check" } }, "npm test && del x"))
assert.throws(() => assertCommandAllowed({ config: { permissionMode: "standard", commandAllowlist: "npm test,node --check" } }, "pnpm install"))

const registry = createRegistry()
registry.run(state, "write_file", { path: "a.txt", content: "hello" })
assert.equal(registry.run(state, "read_file", { path: "a.txt" }).content, "hello")
assert.equal(state.backups.length > 0, true)
assert.throws(() => registry.run(state, "delete_path", { path: root, confirm: true }))
assert.throws(() => registry.run(state, "write_file", { path: ".git/config", content: "no" }))
assert.throws(() => registry.run(state, "run_command", { command: "node --check tests/run-tests.mjs", cwd: `${root}2` }))
assert.doesNotThrow(() => registry.run(state, "run_command", { command: "node --version", env: { SAFE_FLAG: "1", API_KEY: "blocked" } }))
state.enabledTools = ["read_file"]
assert.throws(() => registry.run(state, "write_file", { path: "blocked.txt", content: "no" }))
state.enabledTools = []
writeFileSync(join(root, "b.txt"), "needle")
assert.equal(registry.run(state, "search_text", { query: "needle" }).length, 1)

state.config.agentMode = "build"
const workflow = planLocalWorkflow(state, "create a folder name sample in desktop")
assert.equal(workflow.steps[0].tool, "make_directory")
assert.equal(workflow.risk, "medium")
assert.equal(needsApproval(state, workflow), true)
const combinedWorkflow = planLocalWorkflow(state, "create a folder name adhi and make bunch of python function realted to filehandling class 12 cbse python make it into one basis.py file under newly created adhi file")
assert.equal(combinedWorkflow.steps.length, 2)
assert.equal(combinedWorkflow.steps[0].tool, "make_directory")
assert.equal(combinedWorkflow.steps[1].tool, "write_file")
assert.equal(combinedWorkflow.steps[1].input.path.endsWith("basis.py"), true)
assert.equal(combinedWorkflow.steps[1].input.content.includes("count_lines"), true)
const directPythonWorkflow = planLocalWorkflow(state, "hello create a python file name basis.py and add all file handling function of text file in it and then use select system in it and then save")
assert.equal(directPythonWorkflow.steps.length, 1)
assert.equal(directPythonWorkflow.steps[0].tool, "write_file")
assert.equal(directPythonWorkflow.steps[0].input.path, "basis.py")
assert.equal(directPythonWorkflow.steps[0].input.content.includes("write_text_file"), true)
const moveWorkflow = planLocalWorkflow(state, "move basis.py file to adhi folder")
assert.equal(moveWorkflow.steps.length, 1)
assert.equal(moveWorkflow.steps[0].tool, "move_path")
assert.equal(moveWorkflow.steps[0].input.from, "basis.py")
assert.equal(moveWorkflow.steps[0].input.to.endsWith("adhi\\basis.py"), true)
state.config.permissionMode = "full-access"
assert.equal(needsApproval(state, workflow), false)
const taskStore = createTaskStore(root)
const savedTask = taskStore.create(workflow)
assert.equal(taskStore.load(savedTask.id).objective, workflow.objective)

assert.equal(canUseNativeRenderer("20.19.6"), false)
assert.equal(canUseNativeRenderer("26.4.0"), true)
const uiEngine = await detectOpenTui({ nodeVersion: "20.19.6" })
assert.equal(uiEngine.available, true)
assert.equal(uiEngine.nativeRenderer, false)
assert.equal(uiEngine.mode, "node20-virtual-opentui")
assert.equal(opentuiEnvSchema.length, 23)
const openTuiEnv = readOpenTuiEnv({ OPENTUI_NOTIFICATIONS: "off", OTUI_PALETTE_IDLE_TIMEOUT_MS: "42" })
assert.equal(openTuiEnv.OPENTUI_NOTIFICATIONS.value, false)
assert.equal(openTuiEnv.OTUI_PALETTE_IDLE_TIMEOUT_MS.value, 42)
assert.equal(virtualComponents.length, 16)
assert.equal(virtualComponents.includes("QR Code"), true)
assert.equal(mouseScrollDelta("\x1b[<64;10;10M"), 3)
assert.equal(mouseScrollDelta("\x1b[<65;10;10M"), -3)
assert.equal(mouseScrollDelta("\x1b[96;10;10M"), 3)
assert.equal(mouseScrollDelta("\x1b[97;10;10M"), -3)
assert.equal(mouseScrollDelta(Buffer.from([0x1b, 0x5b, 0x4d, 96, 40, 40])), 3)
assert.equal(mouseScrollDelta(Buffer.from([0x1b, 0x5b, 0x4d, 97, 40, 40])), -3)
assert.equal(isLikelyModelId("cohere/north-mini-code:free"), true)
assert.equal(isLikelyModelId("@cf/moonshotai/kimi-k2.7-code"), true)
assert.equal(closestCommand("/dragom"), "/dragon")
assert.equal(closestCommand("/cmds"), "/cmd")
assert.equal(closestCommand("/provider"), "")
assert.equal(polishAssistantText("Theusertypedwhatcando.ThislookslikeatypoTheyprobablymeantwhatcanIdo.Ishouldanswerclearlyandhelpfully.").includes(". This"), true)
assert.equal(polishAssistantText("Theuserasks\"yourmodelname\".ThesystemsaysweareTwillight.Ishouldanswer.").includes("The user asks"), true)
assert.equal(isLikelyModelId("19"), false)
const blocks = extractCodeBlocks("```js\nconsole.log('hi')\n```\ntext\n```py\nprint('yo')\n```")
assert.equal(blocks.length, 2)
assert.equal(blocks[0].lang, "js")
assert.equal(blocks[0].content, "console.log('hi')")
assert.equal(blocks[1].index, 2)
assert.equal(normalizeProviderContent(" hello "), "hello")
assert.equal(normalizeProviderContent([{ type: "text", text: "hello" }, { content: " world" }]), "hello world")
assert.equal(normalizeProviderContent([{ type: "image_url", image_url: {} }]), "")
assert.equal(normalizeProviderContent([{ reasoning: "fallback answer" }]), "")

rmSync(root, { recursive: true, force: true })
console.log("tests ok")
