import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config/loader.mjs"
import { apiKeyEnvName, apiKeysEnvName, credentialPath, getApiKeys, hasSavedApiKey, readCredentials, savedApiKeyCount, saveApiKey, secretInputFromChunk, writeCredentials } from "../src/config/credentials.mjs"
import { normalizePath } from "../src/security/path-policy.mjs"
import { assertCommandAllowed } from "../src/security/command-policy.mjs"
import { assertPermission } from "../src/security/permissions.mjs"
import { createRegistry } from "../src/tools/registry.mjs"
import { createRenderer } from "../src/utils/terminal.mjs"
import { createTaskStore, needsApproval, planLocalWorkflow } from "../src/agent/workflow.mjs"
import { polishAssistantText, sanitizeAssistantText } from "../src/agent/agent-loop.mjs"
import { canUseNativeRenderer, detectOpenTui } from "../src/ui/opentui-adapter.mjs"
import { opentuiEnvSchema, readOpenTuiEnv } from "../src/ui/opentui-env.mjs"
import { virtualComponents } from "../src/ui/virtual-components.mjs"
import { extractCodeBlocks } from "../src/ui/dashboard.mjs"
import { closestCommand, isLikelyModelId, mouseScrollDelta, normalizeSlashInput, parseProviderRequest } from "../src/cli/index.mjs"
import { cloudflareEndpoint, isCloudflareChallengeText, normalizeProviderContent, providerHttpError, responseFromJson } from "../src/providers/openrouter-provider.mjs"
import { normalizeProviderName, providerInfo, providerNames } from "../src/providers/catalog.mjs"
import { normalizePetName, petAccess, petInfo, petSidebarLine } from "../src/pets/catalog.mjs"
import { skillList } from "../src/skills/catalog.mjs"
import { isNewerVersion, npmCommandSpec, npmCommandSpecs, npmCliPath, packageMetadata } from "../src/update/checker.mjs"

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
assert.equal(loadConfig(["--model", "@cf/moonshotai/kimi-k2.7-code"]).provider, "cloudflare")
assert.equal(loadConfig(["--model", "cohere/north-mini-code:free"]).provider, "openrouter")
assert.equal(loadConfig([]).updateCheck, true)
assert.equal(isNewerVersion("1.1.10", "1.1.9"), true)
assert.equal(isNewerVersion("1.1.9", "1.1.10"), false)
assert.equal(packageMetadata(process.cwd()).name, "twillight")
const npmInstallSpec = npmCommandSpec(["install", "-g", "twillight@latest"])
assert.equal(npmInstallSpec.display, "npm install -g twillight@latest")
assert.equal(npmInstallSpec.args.includes("install"), true)
assert.notEqual(npmInstallSpec.command, "")
if (npmCliPath()) assert.equal(npmInstallSpec.command, process.execPath)
const npmInstallSpecs = npmCommandSpecs(["install", "-g", "twillight@latest"])
assert.equal(npmInstallSpecs[0].display, "npm install -g twillight@latest")
assert.equal(npmInstallSpecs.some((spec) => spec.strategy), true)
const previousProviderEnv = process.env.TWILLIGHT_PROVIDER
const previousModelEnv = process.env.TWILLIGHT_MODEL
const previousUpdateEnv = process.env.TWILLIGHT_UPDATE_CHECK
process.env.TWILLIGHT_PROVIDER = "cloudflare"
delete process.env.TWILLIGHT_MODEL
assert.equal(loadConfig([]).provider, "cloudflare")
assert.equal(loadConfig([]).model, "@cf/moonshotai/kimi-k2.7-code")
process.env.TWILLIGHT_UPDATE_CHECK = "0"
assert.equal(loadConfig([]).updateCheck, false)
if (previousProviderEnv === undefined) delete process.env.TWILLIGHT_PROVIDER
else process.env.TWILLIGHT_PROVIDER = previousProviderEnv
if (previousModelEnv === undefined) delete process.env.TWILLIGHT_MODEL
else process.env.TWILLIGHT_MODEL = previousModelEnv
if (previousUpdateEnv === undefined) delete process.env.TWILLIGHT_UPDATE_CHECK
else process.env.TWILLIGHT_UPDATE_CHECK = previousUpdateEnv
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
assert.deepEqual(await getApiKeys(root, "openrouter", state.ui), ["saved-key", "saved-key-2"])
saveApiKey(root, "groq", "groq-key")
assert.equal(apiKeyEnvName("groq"), "GROQ_API_KEY")
assert.equal(apiKeysEnvName("groq"), "GROQ_API_KEYS")
assert.equal(readCredentials(root).GROQ_API_KEY, "groq-key")
assert.equal(apiKeyEnvName("ollama"), "")
assert.equal(normalizeProviderName("hf"), "huggingface")
assert.equal(secretInputFromChunk(Buffer.from("\x1b[200~gsk_test_key\x1b[201~")), "gsk_test_key")
assert.equal(secretInputFromChunk("\x1b[Aabc\r"), "abc")
assert.equal(normalizeProviderName("workers-ai"), "cloudflare")
assert.equal(normalizeProviderName("worker"), "cloudflare")
assert.equal(normalizeProviderName("gateway"), "cloudflare")
assert.equal(providerInfo("ollama").noAuth, true)
assert.equal(providerInfo("cloudflare").noAuth, true)
assert.equal(hasSavedApiKey(root, "cloudflare"), true)
assert.equal(apiKeyEnvName("cloudflare"), "TWILLIGHT_CLOUDFLARE_GATEWAY_KEY")
assert.deepEqual(await getApiKeys(root, "cloudflare", state.ui), [""])
saveApiKey(root, "cloudflare", "cf-gateway-key")
assert.deepEqual(await getApiKeys(root, "cloudflare", state.ui), ["cf-gateway-key"])
process.env.TWILLIGHT_WORKER_TOKEN = "cf-worker-token"
assert.deepEqual(await getApiKeys(root, "cloudflare", state.ui), ["cf-worker-token"])
delete process.env.TWILLIGHT_WORKER_TOKEN
assert.equal(savedApiKeyCount(root, "cloudflare"), 1)
assert.equal(providerInfo("cloudflare").defaultModel, "@cf/moonshotai/kimi-k2.7-code")
assert.equal(providerInfo("cloudflare").fallbackModels.includes("@cf/zai/glm-4.7-flash"), true)
assert.equal(providerNames().includes("sambanova"), true)
assert.equal(providerNames().includes("cloudflare"), true)
assert.equal(normalizePetName("dragom"), "dragon")
assert.equal(petAccess("dragon", false).allowed, false)
assert.equal(petAccess("dragon", true).activePet.title, "Lavender Dragon")
assert.equal(petSidebarLine("dragon", { isDeveloper: true, processing: false }), "dragon awake")
assert.equal(petSidebarLine("dragon", { isDeveloper: false, processing: false }), "dragon lock")
assert.equal(petSidebarLine("sprite", { isDeveloper: false, processing: true }), "sprite work")
assert.equal(petInfo("dragon").art.every((line) => line.length <= 48), true)
assert.equal(petInfo("dragon").sidebarArt.every((line) => line.length <= 12), true)
assert.equal(petInfo("sprite").sidebarArt.every((line) => line.length <= 12), true)
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
registry.run(state, "write_file", { path: "move-source.txt", content: "move me" })
registry.run(state, "move_path", { from: "move-source.txt", to: "move-target.txt" })
assert.equal(registry.run(state, "read_file", { path: "move-target.txt" }).content, "move me")

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
const casualFolderWorkflow = planLocalWorkflow(state, "make a folder name t34 and make a python file with everym operation")
assert.equal(casualFolderWorkflow.steps.length, 2)
assert.equal(casualFolderWorkflow.steps[0].tool, "make_directory")
assert.equal(casualFolderWorkflow.steps[1].tool, "write_file")
assert.equal(casualFolderWorkflow.steps[1].input.path.endsWith("basis.py"), true)
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
assert.equal(isLikelyModelId("llama-3.1-8b-instant"), true)
assert.equal(closestCommand("/dragom"), "/dragon")
assert.equal(closestCommand("/cmds"), "/cmd")
assert.equal(closestCommand("/providr"), "/provider")
assert.equal(closestCommand("/provder"), "/provider")
assert.equal(closestCommand("/providerz"), "/providers")
assert.equal(closestCommand("/provider-list"), "/providers list")
assert.equal(closestCommand("/gate"), "/gateway")
assert.equal(closestCommand("/updat"), "/update")
assert.equal(closestCommand("/provider"), "")
assert.equal(closestCommand("/model"), "")
assert.equal(normalizeSlashInput("hello"), "hello")
assert.equal(normalizeSlashInput("/cmds"), "/cmd")
assert.equal(normalizeSlashInput("/providr cloudflare"), "/provider cloudflare")
assert.equal(normalizeSlashInput("/provider-list"), "/providers list")
assert.equal(normalizeSlashInput("/model"), "/model")
assert.equal(normalizeSlashInput("/models"), "/models")
assert.equal(normalizeSlashInput("/model @cf/moonshotai/kimi-k2.7-code"), "/model @cf/moonshotai/kimi-k2.7-code")
assert.equal(normalizeSlashInput("/provider cloudflare"), "/provider cloudflare")
assert.equal(normalizeSlashInput("/dragon"), "/dragon")
assert.equal(polishAssistantText("Theusertypedwhatcando.ThislookslikeatypoTheyprobablymeantwhatcanIdo.Ishouldanswerclearlyandhelpfully.").includes(". This"), true)
assert.deepEqual(parseProviderRequest("@cf/moonshotai/kimi-k2.7-code"), { provider: "cloudflare", gatewayUrl: "", model: "@cf/moonshotai/kimi-k2.7-code" })
assert.deepEqual(parseProviderRequest("cloudflare ai.itzadhi.in @cf/zai/glm-4.7-flash"), { provider: "cloudflare", gatewayUrl: "ai.itzadhi.in", model: "@cf/zai/glm-4.7-flash" })
assert.deepEqual(parseProviderRequest("openrouter qwen/qwen3-coder:free"), { provider: "openrouter", gatewayUrl: "", model: "qwen/qwen3-coder:free" })
assert.equal(polishAssistantText("Theuserasks\"yourmodelname\".ThesystemsaysweareTwillight.Ishouldanswer.").includes("The user asks"), true)
assert.equal(polishAssistantText(Array(8).fill("Ortheywanttorun has a command to show help").join("\n")).includes("repeated itself"), true)
assert.equal(polishAssistantText("Ortheywanttorunhasacommandtoshowhelpfortheassistant?".repeat(5)).includes("repeated itself"), true)
assert.equal(polishAssistantText("I'masenior-gradecodingsystemwithawarmterminalpersonality.Icanhelpinspectfiles.Iunderstandyourproject.Icanusecommands.Ifollowplans.WhatIcanhelpwithincludesdebuggingandbuilds.").includes("I'm a senior-grade coding system"), true)
assert.equal(sanitizeAssistantText("I'll do it.<|tool_calls_section_begin|><|tool_call_begin|>functions.execute_command<|tool_call_argument_begin|>{\"command\":\"mkdir V:\\\\t34\"}<|tool_call_end|><|tool_calls_section_end|>").includes("Detected draft command"), true)
assert.equal(sanitizeAssistantText("I'll create it.<functions.execute_command>{\"command\":\"mkdir V:\\\\t34\"}</functions.execute_command>").includes("Detected draft command"), true)
assert.equal(isLikelyModelId("19"), false)
const blocks = extractCodeBlocks("```js\nconsole.log('hi')\n```\ntext\n```py\nprint('yo')\n```")
assert.equal(blocks.length, 2)
assert.equal(blocks[0].lang, "js")
assert.equal(blocks[0].content, "console.log('hi')")
assert.equal(blocks[1].index, 2)
assert.equal(normalizeProviderContent(" hello "), "hello")
assert.equal(normalizeProviderContent([{ type: "text", text: "hello" }, { content: " world" }]), "hello world")
assert.equal(normalizeProviderContent([{ type: "image_url", image_url: {} }]), "")
assert.equal(normalizeProviderContent([{ message: "nested error" }]), "nested error")
assert.equal(normalizeProviderContent({ response: { text: "nested worker answer" } }), "nested worker answer")
assert.equal(responseFromJson({ result: { response: { content: "cf answer" } } }).content, "cf answer")
assert.equal(responseFromJson({ tasks: [{ response: { response: "task answer" } }] }).content, "task answer")
assert.equal(responseFromJson([{ response: "array task answer" }]).content, "array task answer")
assert.equal(cloudflareEndpoint("https://ai.itzadhi.in", "chat"), "https://ai.itzadhi.in/v1/chat/completions")
assert.equal(cloudflareEndpoint("https://ai.itzadhi.in", "models"), "https://ai.itzadhi.in/models")
assert.equal(cloudflareEndpoint("https://ai.itzadhi.in/chat", "models"), "https://ai.itzadhi.in/models")
assert.equal(cloudflareEndpoint("https://ai.itzadhi.in/models", "chat"), "https://ai.itzadhi.in/v1/chat/completions")
const challengeHtml = "<!doctype html><title>Just a moment...</title><span>Enable JavaScript and cookies to continue</span>"
assert.equal(isCloudflareChallengeText(challengeHtml), true)
const challengeError = await providerHttpError(new Response(challengeHtml, { status: 403, statusText: "Forbidden" }), "", { provider: "cloudflare", endpoint: "https://ai.itzadhi.in" })
assert.equal(challengeError.providerBlocked, true)
assert.equal(challengeError.retryModels, false)
assert.equal(challengeError.message.includes("browser challenge"), true)
const authError = await providerHttpError(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, statusText: "Unauthorized" }), "", { provider: "cloudflare", endpoint: "https://ai.itzadhi.in/v1/chat/completions" })
assert.equal(authError.nonRetryable, true)
assert.equal(authError.retryModels, false)
assert.equal(authError.message.includes("/key cloudflare"), true)

rmSync(root, { recursive: true, force: true })
console.log("tests ok")
