import { existsSync, mkdirSync } from "node:fs"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { emitKeypressEvents } from "node:readline"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createPlan } from "../agent/planner.mjs"
import { chat, createCommandMenu, routeLocal, runSlash, runTask } from "../agent/agent-loop.mjs"
import { createTaskStore } from "../agent/workflow.mjs"
import { loadConfig } from "../config/loader.mjs"
import { apiKeyEnvName, apiKeysEnvName, credentialPath, hasSavedApiKey, promptSecret, savedApiKeyCount, saveApiKey } from "../config/credentials.mjs"
import { createProvider } from "../providers/openrouter-provider.mjs"
import { normalizeProviderName, providerInfo, providerNames } from "../providers/catalog.mjs"
import { skillList } from "../skills/catalog.mjs"
import { createSessionStore } from "../storage/sessions.mjs"
import { createRegistry } from "../tools/registry.mjs"
import { renderCommandPalette, renderChatTurn, renderDashboard, renderInputBoundaryClose, renderInputPrompt, renderPalette, scrollConversation, shouldRedrawInputPrompt } from "../ui/dashboard.mjs"
import { detectOpenTui } from "../ui/opentui-adapter.mjs"
import { summarizeOpenTuiEnv } from "../ui/opentui-env.mjs"
import { renderComponentShowcase } from "../ui/virtual-components.mjs"
import { bg, createRenderer, rgb, theme, titleCase, truncate } from "../utils/terminal.mjs"

export async function main(argv = process.argv.slice(2)) {
  const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const config = loadConfig(argv)
  const root = config.workspace
  const logs = join(root, ".ai", "logs")
  mkdirSync(logs, { recursive: true })
  const logPath = process.env.TWILLIGHT_LOG || join(logs, `twillight-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}-${process.pid}.log`)
  const ui = createRenderer(logPath)
  ui.init()
  const task = argv.filter((item, index) => !item.startsWith("--") && !["--provider", "--model"].includes(argv[index - 1])).join(" ").trim()
  const store = createSessionStore(root)

  if (!process.env.TWILLIGHT_WRAPPED) {
    ui.write(`[Twillight] Starting in ${root}`)
    ui.write(`[Twillight] App: ${appRoot}`)
    ui.write(`[Twillight] Log: ${logPath}`)
    ui.write(`[Twillight] Node: ${process.version}`)
  }

  if (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    const state = createState(root, config, ui, { id: "help", task: "help" })
    state.uiEngine = await detectOpenTui()
    ui.clear()
    renderDashboard(state)
    help(state)
    ui.destroy()
    return
  }
  if (argv[0] === "sessions") {
    listSessions(ui, store)
    ui.destroy()
    return
  }
  if (argv[0] === "resume") {
    await runTask(createState(root, config, ui, store.load(argv[1] || "latest")), `Resume session ${argv[1] || "latest"}`)
    ui.destroy()
    return
  }

  const session = store.create(task || "interactive")
  const state = createState(root, config, ui, session)
  state.uiEngine = await detectOpenTui()
  ui.clear()
  renderDashboard(state)

  if (task) {
    await safeRunTask(state, task)
    store.save({ ...session, messages: state.messages, changes: state.changes, commands: state.commands, plan: state.plan })
    ui.destroy()
    return
  }

  await ensureInteractiveKey(state)
  await interactive(state, store, session)
  ui.destroy()
}

function createState(root, config, ui, session) {
  return {
    id: session.id || randomUUID().slice(0, 8),
    root,
    appRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    cwd: config.workspace,
    config,
    ui,
    provider: createProvider(config, root, ui),
    createProvider() {
      return createProvider(this.config, this.root, this.ui)
    },
    registry: createRegistry(),
    taskStore: createTaskStore(root),
    messages: session.messages || [],
    changes: session.changes || [],
    commands: session.commands || [],
    audit: [],
    backups: [],
    activeTask: null,
    commandMenu: [],
    uiEngine: { available: false, nativeRenderer: false, note: "loading", exports: [] },
    pendingImage: "",
    freeModels: [],
    enabledTools: config.enabledTools ? String(config.enabledTools).split(",").map((item) => item.trim()).filter(Boolean) : [],
    inputQueue: [],
    pendingImplementationPlan: null,
    processing: false,
    exiting: false,
    inputActive: false,
    currentInput: "",
    queueScheduled: false,
    plan: createPlan(session.task || "Interactive assistance", { config }),
    started: Date.now(),
    turns: 0,
    tokens: 0,
    reasoningTokens: 0,
    isProjectDeveloper: isProjectDeveloperWorkspace(root, config),
  }
}

function isProjectDeveloperWorkspace(root, config = {}) {
  const id = String(config.developerId || "").trim().toLowerCase()
  if (config.developerMode || ["itzadhi", "itz.adhi", "adhi"].includes(id)) return true
  if (existsSync(join(root, "src", "cli", "index.mjs")) && existsSync(join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      if (pkg.name === "twillight") return true
    } catch {
      return true
    }
  }
  try {
    return /github\.com[:/]itzadhi\/twillight(?:\.git)?/i.test(readFileSync(join(root, ".git", "config"), "utf8"))
  } catch {
    return false
  }
}

async function interactive(state, store, session) {
  if (!process.stdin.isTTY) {
    for (const line of (await readStdin()).split(/\r?\n/)) {
      if (!(await handleInput(state, line.trim()))) break
    }
    store.save({ ...session, messages: state.messages, changes: state.changes, commands: state.commands, plan: state.plan })
    state.ui.dim("[Twillight] bye")
    return
  }
  process.on("SIGINT", () => {
    setMouseTracking(false)
    state.ui.write("")
    state.ui.dim("[Twillight] bye")
    process.exit(0)
  })
  setMouseTracking(true)
  while (!state.exiting) {
    const input = await readPromptInput(state).catch(() => "")
    const nextInput = ["/cmd", "/cmds", "/commands"].includes(input) ? await openCommandPalette(state) : input
    if (nextInput === null) continue
    if (!enqueueInput(state, store, session, nextInput)) break
    if (requiresExclusiveInput(nextInput)) {
      while ((state.queueScheduled || state.processing) && !state.exiting) await sleep(50)
    }
  }
  while (state.processing) await sleep(50)
  setMouseTracking(false)
  state.ui.dim("[Twillight] bye")
}

function requiresExclusiveInput(input) {
  const value = String(input || "").trim().toLowerCase()
  return value === "/key" || value.startsWith("/key ") || value.startsWith("/key-add ") || value.startsWith("/provider ") || ["/groq", "/openrouter", "/openai"].includes(value)
}

function enqueueInput(state, store, session, input) {
  const value = String(input || "").trim()
  if (!value) return true
  if (state.inputQueue.length >= 8) {
    showTwillight(state, value, "Queue is full. Let the current task finish, then send the next message.")
    return true
  }
  state.inputQueue.push(value)
  if (!state.queueScheduled && !state.processing) {
    state.queueScheduled = true
    setTimeout(() => processInputQueue(state, store, session), 0)
  }
  return true
}

async function processInputQueue(state, store, session) {
  if (state.processing) return
  state.queueScheduled = false
  state.processing = true
  try {
    while (state.inputQueue.length && !state.exiting) {
      const input = state.inputQueue.shift()
      try {
        const keepGoing = await handleInput(state, input)
        store.save({ ...session, messages: state.messages, changes: state.changes, commands: state.commands, plan: state.plan })
        if (!keepGoing) {
          state.exiting = true
          break
        }
      } catch (error) {
        showTwillight(state, input, friendlyError(error))
      }
      if (state.inputQueue.length) await sleep(Number(state.config.queueDelayMs || 350))
    }
  } finally {
    state.processing = false
    refreshActiveView(state)
  }
}

async function readPromptInput(state) {
  if (!process.stdin.isTTY) return ""
  let value = isApprovalPending(state) ? "/approve" : ""
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  let approvalChoice = "approve"
  state.inputActive = true
  state.currentInput = value
  state.ui.print(renderInputPrompt(state, value))
  return new Promise((resolve) => {
    function redraw() {
      if (state.lastInput && state.lastOutput) {
        renderChatTurn(state, state.lastInput, state.lastOutput)
      } else {
        renderDashboard(state)
      }
      state.ui.print(renderInputPrompt(state, value))
    }
    function onResize() {
      redraw()
    }
    function done(answer) {
      process.stdin.off("keypress", onKey)
      process.stdin.off("data", onData)
      process.stdout.off?.("resize", onResize)
      state.inputActive = false
      state.currentInput = ""
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw))
      state.ui.print(renderInputBoundaryClose(state, answer))
      resolve(answer.trim())
    }
    function onData(data) {
      const delta = mouseScrollDelta(data)
      if (!delta || !state.lastInput || !state.lastOutput) return
      scrollConversation(state, delta)
      redraw()
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === "c") {
        setMouseTracking(false)
        state.ui.write("")
        state.ui.dim("[Twillight] bye")
        process.exit(0)
      }
      const keyMouseDelta = text?.startsWith("\x1b") ? mouseScrollDelta(Buffer.from(text, "latin1")) : 0
      if (keyMouseDelta && state.lastInput && state.lastOutput) {
        scrollConversation(state, keyMouseDelta)
        redraw()
        return
      }
      if (isApprovalPending(state)) {
        if (key.name === "left" || key.name === "right" || key.name === "tab") {
          approvalChoice = approvalChoice === "approve" ? "reject" : "approve"
          value = approvalChoice === "approve" ? "/approve" : "/reject"
          state.currentInput = value
          redraw()
          return
        }
        if (key.name === "return") return done(approvalChoice === "approve" ? "/approve" : "/reject")
        if (["a", "y"].includes(String(text || "").toLowerCase())) return done("/approve")
        if (["r", "n"].includes(String(text || "").toLowerCase())) return done("/reject")
      }
      if (key.name === "return") return done(value)
      if (key.name === "backspace") {
        if (!value) return
        value = value.slice(0, -1)
        state.currentInput = value
        redraw()
        return
      }
      if (key.name === "up") {
        if (state.lastInput && state.lastOutput) {
          scrollConversation(state, 3)
          redraw()
        }
        return
      }
      if (key.name === "down") {
        if (state.lastInput && state.lastOutput) {
          scrollConversation(state, -3)
          redraw()
        }
        return
      }
      if (key.name === "pageup") {
        if (state.lastInput && state.lastOutput) {
          scrollConversation(state, 10)
          redraw()
        }
        return
      }
      if (key.name === "pagedown") {
        if (state.lastInput && state.lastOutput) {
          scrollConversation(state, -10)
          redraw()
        }
        return
      }
      if (key.name === "home") {
        if (state.lastInput && state.lastOutput) {
          scrollConversation(state, 9999)
          redraw()
        }
        return
      }
      if (key.name === "end") {
        if (state.lastInput && state.lastOutput) {
          state.scrollOffset = 0
          redraw()
        }
        return
      }
      if (key.name === "left" || key.name === "right" || key.name === "escape") return
      if (text?.startsWith("\x1b")) return
      if (text && !key.ctrl && !key.meta) {
        const redrawNeeded = shouldRedrawInputPrompt(state, value, text)
        value += text
        state.currentInput = value
        if (redrawNeeded) redraw()
        else state.ui.print(text)
      }
    }
    process.stdin.on("data", onData)
    process.stdin.on("keypress", onKey)
    process.stdout.on?.("resize", onResize)
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isApprovalPending(state) {
  const task = state.activeTask
  return task?.status === "awaiting_approval" || Boolean(state.pendingImplementationPlan)
}

function setMouseTracking(enabled) {
  if (!process.stdout.isTTY) return
  const mode = enabled ? "h" : "l"
  const modes = ["1000", "1002", "1003", "1006", "1015", "1007"]
  process.stdout.write(modes.map((item) => `\x1b[?${item}${mode}`).join(""))
}

export function mouseScrollDelta(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || "")
  const text = buffer.toString("latin1")
  let delta = 0

  // SGR mouse mode: ESC [ < button ; x ; y M
  for (const match of text.matchAll(/\x1b\[<(\d+);\d+;\d+M/g)) {
    const button = Number(match[1])
    if ((button & 64) !== 64) continue
    delta += (button & 1) === 1 ? -3 : 3
  }

  // URXVT mouse mode: ESC [ button ; x ; y M
  for (const match of text.matchAll(/\x1b\[(\d+);\d+;\d+M/g)) {
    const button = Number(match[1]) - 32
    if ((button & 64) !== 64) continue
    delta += (button & 1) === 1 ? -3 : 3
  }

  // X10 mouse mode: ESC [ M <button+32> <x+32> <y+32>
  for (let index = 0; index < buffer.length - 5; index += 1) {
    if (buffer[index] !== 0x1b || buffer[index + 1] !== 0x5b || buffer[index + 2] !== 0x4d) continue
    const button = buffer[index + 3] - 32
    if ((button & 64) !== 64) continue
    delta += (button & 1) === 1 ? -3 : 3
  }

  return delta
}

async function openCommandPalette(state) {
  if (!process.stdin.isTTY) return "/cmd"
  state.commandMenu = createCommandMenu()
  let selected = 0
  renderCommandPalette(state, selected)
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve) => {
    function done(value) {
      process.stdin.off("keypress", onKey)
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw))
      state.ui.print("\x1b[0m")
      restoreSessionView(state)
      resolve(value)
    }
    function onKey(_text, key = {}) {
      if (key.ctrl && key.name === "c") {
        state.ui.write("")
        state.ui.dim("[Twillight] bye")
        process.exit(0)
      }
      if (key.name === "escape") return done(null)
      if (key.name === "up" || key.name === "k") {
        selected = (selected - 1 + state.commandMenu.length) % state.commandMenu.length
        renderCommandPalette(state, selected)
        return
      }
      if (key.name === "down" || key.name === "j") {
        selected = (selected + 1) % state.commandMenu.length
        renderCommandPalette(state, selected)
        return
      }
      if (key.name === "return") return done(state.commandMenu[selected]?.command || null)
    }
    process.stdin.on("keypress", onKey)
  })
}

function restoreSessionView(state) {
  if (state.lastInput && state.lastOutput) {
    renderChatTurn(state, state.lastInput, state.lastOutput)
  } else {
    renderDashboard(state)
  }
}

async function handleInput(state, input) {
  if (!input) return true
  if (isApprovalPending(state)) {
    const normalized = input.trim().toLowerCase()
    if (["yes", "y", "accept", "approve", "ok", "okay", "run", "do it", "continue"].includes(normalized)) input = "/approve"
    if (["no", "n", "reject", "cancel", "stop", "nope"].includes(normalized)) input = "/reject"
  }
  if (input === "/exit" || input === "/quit") return false
  if (input === "/approve" && state.pendingImplementationPlan) return approveImplementationPlan(state)
  if (input === "/reject" && state.pendingImplementationPlan) return rejectImplementationPlan(state)
  if (state.pendingImplementationPlan && !input.startsWith("/")) {
    state.pendingImplementationPlan = { input, plan: implementationPlan(input) }
    renderChatTurn(state, input, state.pendingImplementationPlan.plan)
    keepActivePromptVisible(state)
    return true
  }
  if (input === "/help") return help(state)
  if (input === "/dashboard") return renderDashboard(state)
  if (input === "/status") return status(state)
  if (input === "/ui") return uiStatus(state)
  if (input === "/palette") return renderPalette(state)
  if (input === "/env") return envStatus(state)
  if (input === "/components") return renderComponentShowcase(state.ui, state)
  if (input === "/mcp" || input === "/mp") return mcpStatus(state)
  if (input === "/tools" || input === "/tools-ui") return toolsStatus(state)
  if (input.startsWith("/tool ")) return setTool(state, input.slice(6).trim())
  if (input === "/tool") return toolsStatus(state)
  if (input.startsWith("/tool-preset ")) return setToolPreset(state, input.slice(13).trim())
  if (input.startsWith("/do ")) return runSelectedCommand(state, input.slice(4).trim())
  if (input === "/do") return usageBox(state, "/do", "Use /do <number> after opening /cmd.")
  if (input === "/clear") {
    state.messages = []
    state.turns = 0
    state.tokens = 0
    state.reasoningTokens = 0
    state.ui.dim("[Twillight] memory cleared")
    return true
  }
  if (input === "/model") return modelStatus(state)
  if (input.startsWith("/model ")) {
    const value = input.slice(7).trim()
    if (/^\d+$/.test(value)) return safeSlash(state, `/use ${value}`)
    if (!isLikelyModelId(value)) {
      state.ui.box("model", [
        state.ui.row("error", "not a valid model id"),
        state.ui.row("hint", "run /models, then /use <number>"),
      ])
      return true
    }
    state.previousModel = state.config.model
    state.config.model = value
    state.provider = createProvider(state.config, state.root, state.ui)
    state.ui.write(`${rgb(theme.accent, "[Twillight]")} model ${rgb(theme.good, state.config.model)}`)
    return true
  }
  if (input === "/plan-mode") return setAgentMode(state, "plan")
  if (input === "/build-mode") return setAgentMode(state, "build")
  if (input === "/read-only") return setPermission(state, "read-only")
  if (input === "/workspace") return setPermission(state, "workspace")
  if (input === "/standard") return setPermission(state, "standard")
  if (input === "/full-access") return setPermission(state, "full-access")
  if (input === "/image") return usageBox(state, "/image", "Use /image C:\\path\\shot.png or paste an image path into chat.")
  if (input.startsWith("/image ")) return attachImage(state, input.slice(7).trim())
  if (input === "/config" || input === "/settings") return configBox(state)
  if (input === "/doctor") return doctorStatus(state)
  if (input === "/keys") return keysStatus(state)
  if (input === "/providers") return providersStatus(state)
  if (input === "/skills") return skillsStatus(state)
  if (input === "/pet") return petStatus(state)
  if (input.startsWith("/pet ")) return setPet(state, input.slice(5).trim())
  if (["/dragom", "/dragn", "/dragoon"].includes(input)) return setPet(state, "dragon")
  if (input === "/dragon") return setPet(state, "dragon")
  if (input === "/key" || input.startsWith("/key ")) return saveKeyPrompt(state, input.slice(4).trim(), false)
  if (input.startsWith("/key-add ")) return saveKeyPrompt(state, input.slice(9).trim(), true)
  if (input === "/provider") return providersStatus(state)
  if (input.startsWith("/provider ")) return setProvider(state, input.slice(10).trim())
  if (input === "/openrouter") return setProvider(state, "openrouter")
  if (input === "/cloudflare" || input === "/workers-ai") return setProvider(state, "cloudflare")
  if (input === "/groq") return setProvider(state, "groq")
  if (input === "/huggingface" || input === "/hf") return setProvider(state, "huggingface")
  if (input === "/cerebras") return setProvider(state, "cerebras")
  if (input === "/sambanova") return setProvider(state, "sambanova")
  if (input === "/github-models") return setProvider(state, "github")
  if (input === "/ollama") return setProvider(state, "ollama")
  if (input === "/openai") return setProvider(state, "openai")
  if (input === "/uncensored") return setPresetModel(state, state.config.uncensoredModel || "cognitivecomputations/dolphin-mistral-24b-venice-edition:free")
  if (input === "/copy" || input.startsWith("/copy ")) return copyCodeBlock(state, input.slice(5).trim())
  if (input === "/permissions") return state.ui.box("permissions", [state.ui.row("mode", state.config.permissionMode)])
  if (input === "/permission") return state.ui.box("permissions", [state.ui.row("mode", state.config.permissionMode), state.ui.row("use", "/read-only /workspace /standard /full-access")])
  if (input.startsWith("/permission ")) {
    return setPermission(state, input.slice(12).trim())
  }
  const usage = bareSlashUsage(input)
  if (usage) return usageBox(state, input, usage)
  if (input.startsWith("/")) return safeSlash(state, input)
  input = attachPastedImages(state, input)
  await safeChatOrAction(state, input)
  return true
}

async function runSelectedCommand(state, value) {
  const index = Number(value) - 1
  if (!Number.isInteger(index) || index < 0) throw new Error("Use /do <number> after opening /cmd.")
  if (!state.commandMenu?.length) state.commandMenu = createCommandMenu()
  const item = state.commandMenu[index]
  if (!item) throw new Error("That command number is not available. Open /cmd and choose a listed number.")
  state.ui.box("command", [state.ui.row("selected", item.label || item.command), state.ui.row("runs", item.command)])
  return handleInput(state, item.command)
}

function toolsStatus(state) {
  const enabled = state.enabledTools?.length ? new Set(state.enabledTools) : null
  state.ui.box("tools", [
    state.ui.row("preset", enabled ? "custom" : "all"),
    state.ui.row("selector", "/tools-ui"),
    state.ui.row("usage", "/tool on <name>  /tool off <name>"),
    state.ui.row("presets", "/tool-preset all|read|safe|edit|code|autonomous"),
    ...state.registry.tools.map((tool) => state.ui.row(enabled?.has(tool.name) || !enabled ? "on" : "off", `${tool.name} · ${tool.permission}`)),
  ])
  return true
}

function setTool(state, value) {
  const [mode, ...rest] = value.split(/\s+/)
  const name = rest.join(" ").trim()
  if (!["on", "off"].includes(mode) || !name) throw new Error("Use /tool on <name> or /tool off <name>.")
  if (!state.registry.tools.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`)
  const current = new Set(state.enabledTools?.length ? state.enabledTools : state.registry.tools.map((tool) => tool.name))
  if (mode === "on") current.add(name)
  else current.delete(name)
  state.enabledTools = [...current]
  return toolsStatus(state)
}

function setToolPreset(state, value) {
  const all = state.registry.tools.map((tool) => tool.name)
  const presets = {
    all,
    read: ["list_directory", "read_file", "path_info", "search_text", "git_status", "git_diff"],
    safe: ["list_directory", "read_file", "path_info", "search_text", "git_status", "git_diff"],
    edit: ["list_directory", "read_file", "path_info", "search_text", "write_file", "append_file", "make_directory", "copy_path", "git_status", "git_diff"],
    code: all.filter((name) => name !== "delete_path"),
    autonomous: all,
  }
  const selected = presets[value]
  if (!selected) throw new Error("Use /tool-preset all, read, safe, edit, code, or autonomous.")
  state.enabledTools = value === "all" ? [] : selected
  return toolsStatus(state)
}

function setPresetModel(state, model) {
  state.previousModel = state.config.model
  state.config.model = model
  state.config.provider = "openrouter"
  state.provider = createProvider(state.config, state.root, state.ui)
  state.ui.box("model", [
    state.ui.row("selected", model),
    state.ui.row("source", "OpenRouter Venice Uncensored free"),
  ])
  return true
}

async function setProvider(state, value) {
  const provider = normalizeProviderName(value)
  if (!provider) throw new Error(`Use /provider ${providerNames().join("|")}.`)
  const info = providerInfo(provider)
  state.config.provider = provider
  state.config.model = info.defaultModel || state.config.model
  state.provider = createProvider(state.config, state.root, state.ui)
  state.freeModels = []
  state.ui.box("provider", [
    state.ui.row("selected", info.title),
    state.ui.row("model", state.config.model),
    state.ui.row("key env", apiKeyEnvName(provider) || "none"),
    state.ui.row("key list env", apiKeysEnvName(provider) || "none"),
    state.ui.row("keys", String(savedApiKeyCount(state.root, provider))),
    state.ui.row("free", info.freeFriendly ? "yes" : "no"),
    state.ui.row("hint", provider === "cloudflare" ? "set TWILLIGHT_CLOUDFLARE_GATEWAY_URL for another Worker URL" : info.noAuth || hasSavedApiKey(state.root, provider) ? "/models to list available models" : `/key ${provider} to save once`),
  ])
  if (!info.noAuth && !hasSavedApiKey(state.root, provider)) await saveKeyPrompt(state, provider, false)
  return true
}

export function isLikelyModelId(value) {
  return /^@?[a-z0-9_.-]+(?:\/[a-z0-9_.:-]+)+$/i.test(value)
}

function modelStatus(state) {
  state.ui.box("model", [
    state.ui.row("current", state.config.model),
    state.ui.row("provider", providerInfo(state.config.provider).title),
    state.ui.row("choose", "/models then /use <number>"),
    state.ui.row("exact", "/model provider/model:id"),
    state.ui.row("cloudflare", "/model @cf/moonshotai/kimi-k2.7-code"),
  ])
  return true
}

function bareSlashUsage(input) {
  const usage = {
    "/read": "Use /read <path>.",
    "/write": "Use /write <path> -- <content>.",
    "/append": "Use /append <path> -- <content>.",
    "/mkdir": "Use /mkdir <path>.",
    "/rm": "Use /rm <path>.",
    "/run": "Use /run <command>.",
    "/use": "Run /models first, then /use <number>.",
    "/tool-preset": "Use /tool-preset all|read|safe|edit|code|autonomous.",
  }
  return usage[input] || ""
}

function usageBox(state, command, message) {
  state.ui.box("usage", [
    state.ui.row("command", command),
    state.ui.row("how", message),
  ])
  return true
}

function copyCodeBlock(state, value) {
  const index = Number(value || "1") - 1
  const block = state.codeBlocks?.[index]
  if (!block) {
    state.ui.box("copy", [
      state.ui.row("result", "no code block found"),
      state.ui.row("hint", "ask for code, then run /copy 1"),
    ])
    return true
  }
  const result = copyText(block.content)
  state.ui.box("copy", [
    state.ui.row("block", String(block.index)),
    state.ui.row("lang", block.lang || "text"),
    state.ui.row("status", result.ok ? "copied to clipboard" : result.error),
  ])
  return true
}

function copyText(text) {
  if (process.platform === "win32") {
    const result = spawnSync("clip.exe", { input: text, encoding: "utf8" })
    return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr || "clip.exe failed" }
  }
  const pbcopy = spawnSync("pbcopy", { input: text, encoding: "utf8" })
  if (pbcopy.status === 0) return { ok: true }
  const xclip = spawnSync("xclip", ["-selection", "clipboard"], { input: text, encoding: "utf8" })
  if (xclip.status === 0) return { ok: true }
  return { ok: false, error: "no clipboard command available" }
}

async function safeSlash(state, input) {
  try {
    return (await runSlash(state, input)) || unknown(state, input)
  } catch (error) {
    showTwillight(state, input, friendlyError(error))
    return true
  }
}

async function safeRunTask(state, input) {
  try {
    await runTask(state, input)
  } catch (error) {
    showTwillight(state, input, friendlyError(error))
  }
}

async function safeChatOrAction(state, input) {
  try {
    if (await routeLocal(state, input)) return
    const casual = casualResponse(input)
    if (casual) {
      state.messages.push({ role: "user", content: input }, { role: "assistant", content: casual })
      state.turns += 1
      renderChatTurn(state, input, casual)
      keepActivePromptVisible(state)
      return
    }
    if (needsImplementationPlan(input)) {
      state.pendingImplementationPlan = { input, plan: implementationPlan(input) }
      renderChatTurn(state, input, state.pendingImplementationPlan.plan)
      keepActivePromptVisible(state)
      return
    }
    await chat(state, input)
  } catch (error) {
    if (/not a valid model id|invalid model/i.test(error.message || String(error)) && state.previousModel) {
      state.config.model = state.previousModel
      state.provider = createProvider(state.config, state.root, state.ui)
      showTwillight(state, input, `${friendlyError(error)}\n\nRestored model: ${state.config.model}`)
      return
    }
    showTwillight(state, input, friendlyError(error))
  }
}

async function approveImplementationPlan(state) {
  const pending = state.pendingImplementationPlan
  state.pendingImplementationPlan = null
  if (!pending) return true
  await chat(state, pending.input)
  return true
}

function rejectImplementationPlan(state) {
  const pending = state.pendingImplementationPlan
  state.pendingImplementationPlan = null
  renderChatTurn(state, pending?.input || "plan", "Plan rejected. Send a revised request and I’ll re-plan it cleanly.")
  keepActivePromptVisible(state)
  return true
}

function needsImplementationPlan(input) {
  const text = String(input || "").toLowerCase()
  if (text.length < 80) return false
  return /\b(full|entire|complete|from scratch|system|workflow|pipeline|app|website|dashboard|advanced|production|publish|release)\b/.test(text)
}

function implementationPlan(input) {
  return [
    "## Implementation Plan",
    "",
    `Goal: ${input}`,
    "",
    "1. Inspect the current project structure and relevant files.",
    "2. Identify the smallest safe design and files to change.",
    "3. Apply code/docs changes in focused steps.",
    "4. Run syntax checks, tests, audit/pack checks when package files changed.",
    "5. Summarize changes, risks, and next commands.",
    "",
    "Reply `accept` to run it, `reject` to stop, or send revisions and I’ll update the plan.",
  ].join("\n")
}

function casualResponse(input) {
  const text = String(input || "").trim().toLowerCase()
  const compact = text.replace(/[^a-z]/g, "")
  if (/^(hi|hello|hey|yo|wsp|sup|what'?s up|wassup|whats up)(\s+(man|bro|dude|mate|adhi|there))*[!.? ]*$/.test(text)) {
    return "Hey, I'm here. What are we building or fixing?"
  }
  if (/^whatcan(you)?d[op]/.test(compact) || /^what(can|could)(you)?do$/.test(compact)) {
    return [
      "I can inspect and edit files, create scripts, run safe commands, debug errors, review diffs, manage models/providers, attach images, and use local tools in this folder.",
      "",
      "For simple tasks I act directly. For bigger builds I show a plan first, then execute step by step after you accept.",
    ].join("\n")
  }
  if (/^(yes|yeah|yep|ok|okay|no|nah|nope|sure|cool|nice|fine)[!.? ]*$/.test(text)) {
    return "Got it. Send me the actual thing you want me to build, fix, inspect, or run."
  }
  return ""
}

function status(state) {
  state.ui.box("session", [
    state.ui.row("id", state.id),
    state.ui.row("elapsed", elapsed(state.started)),
    state.ui.row("turns", String(state.turns)),
    state.ui.row("provider", titleCase(state.provider.provider)),
    state.ui.row("cwd", truncate(state.cwd, 23)),
    state.ui.row("model", truncate(state.config.model, 23)),
    state.ui.row("mode", state.config.agentMode),
    state.ui.row("ui", state.uiEngine.available ? `opentui-${state.uiEngine.note}` : "ansi"),
    state.ui.row("tokens", String(state.tokens)),
    state.ui.row("reason", String(state.reasoningTokens)),
    state.ui.row("perm", state.config.permissionMode),
  ])
  return true
}

function help(state) {
  renderChatTurn(state, "/help", helpText())
  return true
}

function helpText() {
  return [
    "# Twillight help",
    "",
    "**Creator:** Adhi · Discord `itz.adhi` · GitHub `itzadhi`",
    "",
    "## Core",
    "- `/cmd` command dropdown",
    "- `/models` list free OpenRouter models",
    "- `/providers` list free-friendly providers",
    "- `/uncensored` switch to Venice Uncensored Dolphin Mistral 24B free",
    "- `/use <number>` switch by model list number",
    "- `/model provider/model:id` switch by exact model id",
    "- `/provider openrouter|cloudflare|groq|huggingface|cerebras|sambanova|github|ollama|openai` switch provider",
    "- `/key [provider]` save one API key once",
    "- `/key-add [provider]` add another key for rotation",
    "- `/keys` show saved key counts",
    "",
    "## Agent workflow",
    "- `/plan-mode` plan only",
    "- `/build-mode` autonomous build mode",
    "- `/actions` current workflow",
    "- `/approve` or Enter approve pending workflow",
    "- `/reject` reject pending workflow",
    "- `/tasks` saved workflows",
    "",
    "## Tools",
    "- `/files`, `/read`, `/write`, `/append`, `/mkdir`, `/rm`, `/run`",
    "- `/tools` select autonomous tool access",
    "- `/skills` show built-in Twillight skills",
    "- `/mcp` show Twillight MCP server command",
    "- `/doctor` diagnose global install, PATH, and developer identity",
    "- `/tool-preset all|read|safe|edit|code|autonomous`",
    "- `/image C:\\path\\shot.png` attach image",
    "- `/copy 1` copy latest code block",
    "",
    "## Safety",
    "- `/read-only`, `/workspace`, `/standard`, `/full-access`",
    "- `/undo` undo last tracked file action",
    "- `/rollback` restore latest checkpoint",
    "- `/memory` show project memory",
    "- `/remember <note>` save project note",
    "",
    "## Git",
    "- `/git-status` show repository status",
    "- `/git-diff` show repository diff",
    "",
    "Twillight keeps this help inside the same session view.",
  ].join("\n")
}

function mcpStatus(state) {
  state.ui.box("mcp", [
    state.ui.row("server", "twillight-mcp"),
    state.ui.row("command", "npm run mcp"),
    state.ui.row("direct", "node src/mcp/server.mjs"),
    state.ui.row("tools", String(state.registry.tools.length)),
    state.ui.row("mode", "stdio JSON-RPC"),
  ])
  return true
}

function providersStatus(state) {
  state.ui.box("providers", providerNames().map((name) => {
    const info = providerInfo(name)
    const key = info.noAuth ? "no key" : `${savedApiKeyCount(state.root, name)} key(s)`
    return state.ui.row(name, `${info.title} · ${info.freeFriendly ? "free-friendly" : "paid"} · ${key} · ${info.defaultModel}`)
  }))
  return true
}

function skillsStatus(state) {
  state.ui.box("skills", skillList().flatMap((skill) => [
    state.ui.row(skill.id, skill.title),
    state.ui.row("does", skill.description),
    state.ui.row("uses", skill.commands.join(", ")),
  ]))
  return true
}

function petStatus(state) {
  const pet = currentPet(state)
  state.ui.box("pet", [
    state.ui.row("name", pet.name),
    state.ui.row("mood", pet.mood),
    state.ui.row("dev", state.isProjectDeveloper ? "yes" : "no"),
    state.ui.row("hint", state.isProjectDeveloper ? "/dragon unlocks the developer dragon" : "set TWILLIGHT_CREATOR=itzadhi or run inside itzadhi/twillight"),
  ])
  return true
}

function doctorStatus(state) {
  const globalPrefix = runCapture("npm", ["prefix", "-g"])
  const whereTwillight = process.platform === "win32" ? runCapture("where.exe", ["twillight"]) : runCapture("which", ["twillight"])
  const prefix = globalPrefix.stdout.trim()
  const pathText = process.env.Path || process.env.PATH || ""
  const segments = pathText.split(process.platform === "win32" ? ";" : ":").map((item) => item.trim().toLowerCase())
  const pathHasPrefix = prefix ? segments.includes(prefix.toLowerCase()) : false
  state.ui.box("doctor", [
    state.ui.row("bin", "twillight, twilight"),
    state.ui.row("npm global", prefix || globalPrefix.error || "unknown"),
    state.ui.row("on PATH", pathHasPrefix ? "yes" : "no or old terminal"),
    state.ui.row("where", whereTwillight.stdout.trim().split(/\r?\n/)[0] || whereTwillight.error || "not found"),
    state.ui.row("dev", state.isProjectDeveloper ? "yes" : "no"),
    state.ui.row("dev env", "set TWILLIGHT_CREATOR=itzadhi"),
    state.ui.row("fix", "open a new terminal after npm install -g twillight"),
  ])
  return true
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" })
  return {
    code: result.status,
    stdout: result.stdout || "",
    error: result.error?.message || result.stderr || "",
  }
}

function setPet(state, value) {
  if (value === "dragon" && !state.isProjectDeveloper) {
    return showTwillight(state, "/dragon", "Developer dragon is locked. Run inside the itzadhi/twillight repo or set TWILLIGHT_CREATOR=itzadhi.")
  }
  state.config.pet = value
  return petStatus(state)
}

function currentPet(state) {
  if (state.config.pet === "dragon") return { name: "Lavender Dragon", mood: state.processing ? "guarding the build" : "watching the workspace" }
  return { name: "Twillight Sprite", mood: state.processing ? "thinking with you" : "ready" }
}

function showTwillight(state, input, message) {
  renderChatTurn(state, input || "system", message)
  keepActivePromptVisible(state)
  return true
}

function keepActivePromptVisible(state) {
  if (state.inputActive && !state.exiting) state.ui.print(renderInputPrompt(state, state.currentInput || ""))
}

function refreshActiveView(state) {
  if (state.exiting) return
  if (state.lastInput && state.lastOutput) renderChatTurn(state, state.lastInput, state.lastOutput)
  else renderDashboard(state)
  keepActivePromptVisible(state)
}

function friendlyError(error) {
  const raw = String(error?.message || error || "Unknown error")
  if (/429|too many requests/i.test(raw)) {
    return [
      "Provider is rate-limiting this model right now.",
      "",
      "Try one of these:",
      "- wait a little and send again",
      "- switch model with `/models`",
      "- add another key with `/key-add openrouter`",
      "",
      `Details: ${raw}`,
    ].join("\n")
  }
  if (/unknown command/i.test(raw)) return raw
  return raw
}

function uiStatus(state) {
  state.ui.box("ui", [
    state.ui.row("engine", state.uiEngine.available ? "OpenTUI" : "ANSI"),
    state.ui.row("mode", state.uiEngine.mode || "ansi"),
    state.ui.row("native", state.uiEngine.nativeRenderer ? "yes" : "no"),
    state.ui.row("node", process.version),
    state.ui.row("exports", state.uiEngine.exports?.join(", ") || "none"),
    state.ui.row("reason", state.uiEngine.reason || "ready"),
  ])
  return true
}

function envStatus(state) {
  const config = state.uiEngine.env || {}
  state.ui.box("opentui env", summarizeOpenTuiEnv(config).map((line) => state.ui.row("env", line)))
  return true
}

function setAgentMode(state, mode) {
  state.config.agentMode = mode
  state.ui.box("mode", [state.ui.row("agent", mode)])
  status(state)
  return true
}

function setPermission(state, mode) {
  if (!["read-only", "workspace", "standard", "full-access"].includes(mode)) {
    showTwillight(state, `/permission ${mode}`, `Unknown permission mode: ${mode}`)
    return true
  }
  state.config.permissionMode = mode
  state.ui.box("permissions", [state.ui.row("mode", mode)])
  status(state)
  return true
}

function keysStatus(state) {
  state.ui.box("keys", [
    state.ui.row("file", credentialPath(state.root)),
    ...providerNames().flatMap((provider) => [
      state.ui.row(provider, `${savedApiKeyCount(state.root, provider)} saved/available`),
      state.ui.row("env", apiKeyEnvName(provider) ? `${apiKeyEnvName(provider)} or ${apiKeysEnvName(provider)}` : "no key required"),
    ]),
  ])
  return true
}

async function saveKeyPrompt(state, requestedProvider = "", append = false) {
  if (!process.stdin.isTTY) throw new Error("/key requires interactive terminal input.")
  const provider = normalizeProviderName(requestedProvider) || state.provider.provider
  const envName = apiKeyEnvName(provider)
  if (!envName) return showTwillight(state, `/key ${provider}`, `${providerInfo(provider).title} does not need an API key.`)
  const key = await promptSecret(`${envName}: `)
  saveApiKey(state.root, provider, key, { append })
  if (provider === state.provider.provider) state.provider = createProvider(state.config, state.root, state.ui)
  state.ui.box("key", [
    state.ui.row("provider", provider),
    state.ui.row("status", append ? "added" : "saved"),
    state.ui.row("keys", String(savedApiKeyCount(state.root, provider))),
    state.ui.row("file", credentialPath(state.root)),
  ])
  return true
}

async function ensureInteractiveKey(state) {
  if (!process.stdin.isTTY) return
  if (hasSavedApiKey(state.root, state.provider.provider)) return
  await saveKeyPrompt(state)
}

async function attachImage(state, value) {
  const [pathPart, ...promptParts] = value.split(" -- ")
  const imagePath = pathPart.trim().replace(/^["']|["']$/g, "")
  const ext = imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg") ? "jpeg" : "png"
  const data = readFileSync(imagePath).toString("base64")
  state.pendingImage = `data:image/${ext};base64,${data}`
  state.ui.box("image", [state.ui.row("path", imagePath), state.ui.row("status", "attached")])
  if (promptParts.join(" -- ").trim()) await safeRunTask(state, promptParts.join(" -- ").trim())
  return true
}

function attachPastedImages(state, input) {
  const text = String(input || "")
  const dataUrl = text.match(/data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+/)
  if (dataUrl) {
    state.pendingImage = dataUrl[0]
    return text.replace(dataUrl[0], "").trim() || "Describe this image."
  }
  const paths = [...text.matchAll(/(?:"([^"]+\.(?:png|jpe?g|webp))"|'([^']+\.(?:png|jpe?g|webp))'|((?:[A-Za-z]:\\|file:\/\/\/)[^\s]+\.(?:png|jpe?g|webp)))/gi)]
    .map((match) => match[1] || match[2] || match[3])
  const imagePath = paths.find((path) => existsSync(path.replace(/^file:\/\/\//i, "").replace(/\//g, "\\")))
  if (!imagePath) return text
  const localPath = imagePath.replace(/^file:\/\/\//i, "").replace(/\//g, "\\")
  const ext = localPath.toLowerCase().endsWith(".jpg") || localPath.toLowerCase().endsWith(".jpeg") ? "jpeg" : localPath.toLowerCase().endsWith(".webp") ? "webp" : "png"
  state.pendingImage = `data:image/${ext};base64,${readFileSync(localPath).toString("base64")}`
  state.ui.box("image", [state.ui.row("attached", localPath), state.ui.row("mode", "pasted path")])
  return paths.reduce((value, path) => value.replace(path, ""), text).trim() || "Describe this image."
}

function configBox(state) {
  state.ui.box("config", Object.entries(state.config).map(([key, value]) => state.ui.row(key, value)))
  return true
}

function unknown(state, input) {
  const suggestion = closestCommand(input)
  return showTwillight(state, input, suggestion
    ? `Unknown command: ${input}\n\nDid you mean \`${suggestion}\`?`
    : `Unknown command: ${input}\n\nPress ctrl+p or use \`/cmd\` for commands.`)
}

export function closestCommand(input) {
  const value = String(input || "").trim().toLowerCase()
  const head = value.split(/\s+/)[0]
  const aliases = {
    "/cmds": "/cmd",
    "/commands": "/cmd",
    "/comands": "/cmd",
    "/command": "/cmd",
    "/dragom": "/dragon",
    "/dragn": "/dragon",
    "/dragoon": "/dragon",
    "/model": "/models",
    "/mp": "/mcp",
  }
  if (aliases[value] || aliases[head]) return aliases[value] || aliases[head]
  const commands = [
    "/actions", "/approve", "/build-mode", "/cerebras", "/changes", "/clear", "/cloudflare", "/cmd", "/components", "/config",
    "/copy", "/diff", "/doctor", "/dragon", "/env", "/exit", "/files", "/full-access", "/git-diff", "/git-status",
    "/groq", "/help", "/huggingface", "/image", "/key", "/key-add", "/keys", "/mcp", "/memory", "/mkdir",
    "/model", "/models", "/ollama", "/openai", "/openrouter", "/palette", "/permission", "/permissions", "/provider",
    "/pet", "/plan-mode", "/providers", "/read", "/read-only", "/reject", "/remember", "/rollback", "/run",
    "/sambanova", "/skills", "/standard", "/status", "/tasks", "/tool", "/tool-preset", "/tools", "/ui",
    "/uncensored", "/undo", "/use", "/workspace", "/write",
  ]
  if (commands.includes(head)) return ""
  let best = { command: "", distance: Infinity }
  for (const command of commands) {
    const distance = editDistance(head, command)
    if (distance < best.distance) best = { command, distance }
  }
  const tolerance = Math.max(1, Math.floor((best.command.length || 1) * 0.25))
  return best.distance <= tolerance ? best.command : ""
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    let last = i - 1
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      last = old
    }
  }
  return previous[b.length]
}

function elapsed(started) {
  const seconds = Math.floor((Date.now() - started) / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function listSessions(ui, store) {
  ui.box("sessions", store.list().map((session) => ui.row(session.id, session.task || session.createdAt)))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) await main()
