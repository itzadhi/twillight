import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
import { normalizePetName, petAccess, petNames } from "../pets/catalog.mjs"
import { skillList } from "../skills/catalog.mjs"
import { createSessionStore } from "../storage/sessions.mjs"
import { ALL_TOOLS, createRegistry, enabledToolNames, isAllToolsEnabled, normalizeEnabledTools } from "../tools/registry.mjs"
import { renderCommandPalette, renderChatTurn, renderDashboard, renderInputBoundaryClose, renderInputPrompt, renderPalette, renderUpdatePrompt, scrollConversation, shouldRedrawInputPrompt } from "../ui/dashboard.mjs"
import { detectOpenTui } from "../ui/opentui-adapter.mjs"
import { summarizeOpenTuiEnv } from "../ui/opentui-env.mjs"
import { renderComponentShowcase } from "../ui/virtual-components.mjs"
import { bg, createRenderer, rgb, theme, titleCase, truncate } from "../utils/terminal.mjs"
import { checkForUpdate, installGlobalUpdate, npmCommandSpec, packageMetadata, rememberUpdateInstall, rememberUpdateSkip } from "../update/checker.mjs"

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

  const session = store.create(sessionTaskLabel(task))
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

  await maybePromptUpdate(state)
  await ensureInteractiveKey(state)
  await interactive(state, store, session)
  ui.destroy()
}

function createState(root, config, ui, session) {
  const registry = createRegistry()
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
    saveConfig() {
      persistProjectConfig(this)
    },
    registry,
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
    enabledTools: normalizeEnabledTools(config.enabledTools, registry.tools),
    inputQueue: [],
    pendingImplementationPlan: null,
    processing: false,
    exiting: false,
    shuttingDown: false,
    inputActive: false,
    currentInput: "",
    queueScheduled: false,
    plan: createPlan(session.task || "Interactive assistance", { config }),
    started: Date.now(),
    turns: 0,
    tokens: 0,
    reasoningTokens: 0,
    ...developerIdentity(root, config),
  }
}

function sessionTaskLabel(task) {
  const value = String(task || "").trim()
  if (!value) return "interactive"
  const normalized = normalizeSlashInput(value)
  if (normalized === "/key" || normalized.startsWith("/key ")) return "key setup"
  if (normalized === "/key-add" || normalized.startsWith("/key-add ")) return "key setup"
  return value
}

function isProjectDeveloperWorkspace(root, config = {}) {
  return developerIdentity(root, config).isProjectDeveloper
}

function developerIdentity(root, config = {}) {
  const id = String(config.developerId || "").trim().toLowerCase()
  if (config.developerMode) return { isProjectDeveloper: true, developerReason: "TWILLIGHT_DEV=1" }
  if (["itzadhi", "itz.adhi", "adhi"].includes(id)) {
    return { isProjectDeveloper: true, developerReason: `TWILLIGHT_CREATOR=${config.developerId}` }
  }
  if (existsSync(join(root, "src", "cli", "index.mjs")) && existsSync(join(root, "package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
      if (pkg.name === "twillight") return { isProjectDeveloper: true, developerReason: "local twillight package" }
    } catch {
      return { isProjectDeveloper: true, developerReason: "local twillight source tree" }
    }
  }
  try {
    if (/github\.com[:/]itzadhi\/twillight(?:\.git)?/i.test(readFileSync(join(root, ".git", "config"), "utf8"))) {
      return { isProjectDeveloper: true, developerReason: "itzadhi/Twillight git remote" }
    }
  } catch {
    // no git config is fine
  }
  return { isProjectDeveloper: false, developerReason: "not in Twillight dev repo" }
}

function persistProjectConfig(state) {
  const dir = join(state.root, ".ai")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "config.yaml")
  const lines = [
    `provider: ${state.config.provider}`,
    `model: ${state.config.model}`,
    `permissionMode: ${state.config.permissionMode}`,
    `agentMode: ${state.config.agentMode}`,
    `streaming: ${state.config.streaming ? "true" : "false"}`,
    `pet: ${state.config.pet || "sprite"}`,
  ]
  lines.push(`enabledTools: ${isAllToolsEnabled(state.enabledTools) ? ALL_TOOLS : state.enabledTools.join(",")}`)
  if (state.config.cloudflareGatewayUrl) lines.push(`cloudflareGatewayUrl: ${state.config.cloudflareGatewayUrl}`)
  writeFileSync(file, `${lines.join("\n")}\n`)
  state.ui.debug?.(`saved config ${file}`)
}

async function interactive(state, store, session) {
  if (!process.stdin.isTTY) {
    for (const line of (await readStdin()).split(/\r?\n/)) {
      if (!(await handleInput(state, line.trim()))) break
    }
    store.save({ ...session, messages: state.messages, changes: state.changes, commands: state.commands, plan: state.plan })
    await shutdown(state, { animate: false })
    return
  }
  process.on("SIGINT", () => {
    void shutdown(state, { exit: true })
  })
  setMouseTracking(true)
  while (!state.exiting) {
    const input = await readPromptInput(state).catch(() => "")
    const nextInput = ["/cmd", "/cmds", "/commands"].includes(input) ? await openCommandPalette(state) : input
    if (nextInput === null) continue
    if (!String(nextInput || "").trim()) {
      refreshActiveView(state)
      continue
    }
    if (!enqueueInput(state, store, session, nextInput)) break
    if (requiresExclusiveInput(nextInput)) {
      while ((state.queueScheduled || state.processing) && !state.exiting) await sleep(50)
    }
  }
  while (state.processing) await sleep(50)
  await shutdown(state)
}

function requiresExclusiveInput(input) {
  const value = String(input || "").trim().toLowerCase()
  return value === "/key" || value.startsWith("/key ") || value.startsWith("/key-add ")
    || value === "/provider" || value.startsWith("/provider ")
    || value === "/providers" || value.startsWith("/providers ")
    || value === "/update" || value === "/update-install"
    || ["/cf", "/cloudflare", "/cerebras", "/github", "/github-models", "/groq", "/hf", "/huggingface", "/ollama", "/openai", "/openrouter", "/sambanova", "/worker", "/workers", "/workers-ai"].includes(value)
}

async function maybePromptUpdate(state) {
  if (!process.stdin.isTTY || state.config.updateCheck === false) return
  try {
    const info = await checkForUpdate(state)
    if (!info?.available) return
    if (state.config.autoUpdate) {
      await installUpdate(state, info)
      return
    }
    const choice = await promptUpdateChoice(state, info)
    if (choice === "install") await installUpdate(state, info)
    else rememberUpdateSkip(state.root, info)
  } catch (error) {
    state.ui.debug?.(`update check skipped: ${error.message || error}`)
  } finally {
    restoreSessionView(state)
  }
}

async function promptUpdateChoice(state, info) {
  let selected = 1
  renderUpdatePrompt(state, info, selected)
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve) => {
    function done(value) {
      process.stdin.off("keypress", onKey)
      process.stdout.off?.("resize", onResize)
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw))
      resolve(value)
    }
    function onResize() {
      renderUpdatePrompt(state, info, selected)
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === "c") {
        void shutdown(state, { exit: true })
        return
      }
      if (key.name === "escape") return done("skip")
      if (key.name === "left" || key.name === "right" || key.name === "tab") {
        selected = selected === 1 ? 0 : 1
        renderUpdatePrompt(state, info, selected)
        return
      }
      if (key.name === "return") return done(selected === 1 ? "install" : "skip")
      const value = String(text || "").toLowerCase()
      if (value === "y" || value === "i") return done("install")
      if (value === "n" || value === "s") return done("skip")
    }
    process.stdout.on?.("resize", onResize)
    process.stdin.on("keypress", onKey)
  })
}

async function installUpdate(state, info) {
  showTwillight(state, "/update", `Installing Twillight ${info.latest} globally...\n\n\`${info.command}\``)
  const result = installGlobalUpdate(info)
  if (result.code === 0) {
    rememberUpdateInstall(state.root, info)
    showTwillight(state, "/update", [
      `Installed Twillight ${info.latest} globally.`,
      result.strategy ? `Used: \`${result.strategy}\`.` : "",
      "",
      "Open a new terminal if Windows keeps the old command shim cached.",
      "",
      result.stdout.trim().split(/\r?\n/).slice(-4).join("\n"),
    ].join("\n").trim())
    return true
  }
  showTwillight(state, "/update", [
    "Update install failed.",
    "",
    `Command: \`${result.command}\``,
    result.strategy ? `Last try: \`${result.strategy}\`` : "",
    `Exit: ${result.code}`,
    "",
    (result.stderr || result.stdout || "No output.").trim(),
  ].join("\n"))
  return true
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
        void shutdown(state, { exit: true })
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
      if (key.ctrl && key.name === "p") return done("/cmd")
      if (key.name === "tab") return done("/models")
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

async function shutdown(state, options = {}) {
  if (state.shuttingDown) return
  state.shuttingDown = true
  state.exiting = true
  setMouseTracking(false)
  if (options.animate === false || !process.stdout.isTTY) {
    state.ui.dim("[Twillight] bye")
    if (options.exit) process.exit(0)
    return
  }
  await renderClosingAnimation(state)
  if (options.exit) process.exit(0)
}

async function renderClosingAnimation(state) {
  const width = Math.max(60, Math.min(Number(process.stdout.columns || 90), 110))
  const lines = [
    ["saving session", "messages, memory, and tool state are tucked away"],
    ["closing tools", "local workspace handles released"],
    ["cooling model", `${providerInfo(state.config.provider).title} · ${state.config.model}`],
    ["fading out", "Twillight is leaving the terminal clean"],
  ]
  for (let index = 0; index < lines.length; index += 1) {
    state.ui.clear()
    state.ui.write("\n".repeat(Math.max(1, Math.floor((Number(process.stdout.rows || 24) - 10) / 2))))
    state.ui.write(centerLine(rgb(theme.accent, "T W I L L I G H T"), width))
    state.ui.write("")
    state.ui.write(centerLine(`${rgb(theme.text, "shutdown")} ${rgb(theme.border, "·")} ${rgb(theme.muted, lines[index][0])}`, width))
    state.ui.write("")
    state.ui.write(centerLine(progressBar(index + 1, lines.length, 36), width))
    state.ui.write("")
    state.ui.write(centerLine(rgb(theme.muted, lines[index][1]), width))
    await sleep(120)
  }
  state.ui.clear()
  state.ui.write("\n".repeat(Math.max(1, Math.floor((Number(process.stdout.rows || 24) - 8) / 2))))
  state.ui.write(centerLine(rgb(theme.accent, "╭────────────────────────────╮"), width))
  state.ui.write(centerLine(`${rgb(theme.accent, "│")} ${rgb(theme.text, "Twillight closed gracefully")} ${rgb(theme.accent, "│")}`, width))
  state.ui.write(centerLine(`${rgb(theme.accent, "│")} ${rgb(theme.muted, "see you in the next build")} ${rgb(theme.accent, "│")}`, width))
  state.ui.write(centerLine(rgb(theme.accent, "╰────────────────────────────╯"), width))
  await sleep(180)
  state.ui.write("")
}

function progressBar(step, total, width) {
  const done = Math.max(0, Math.min(width, Math.round((step / total) * width)))
  return `${rgb(theme.accent, "▌")}${bg(theme.input, `${rgb(theme.accent, "█".repeat(done))}${rgb(theme.border, "░".repeat(width - done))}`)}${rgb(theme.accent, "▐")}`
}

function centerLine(line, width) {
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length
  return `${" ".repeat(Math.max(0, Math.floor((width - visible) / 2)))}${line}`
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
  const menu = createCommandMenu()
  state.commandMenu = menu
  return openDropdownPalette(state, menu, "/")
}

async function openProviderPalette(state) {
  if (!process.stdin.isTTY) return null
  return openDropdownPalette(state, providerMenuRows(state), "/")
}

async function openDropdownPalette(state, menu, initialQuery = "/") {
  let query = initialQuery
  let selected = 0
  let rows = filterCommandMenu(menu, query)
  renderCommandPalette(state, selected, query, rows)
  emitKeypressEvents(process.stdin)
  const wasRaw = process.stdin.isRaw
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve) => {
    function refresh() {
      rows = filterCommandMenu(menu, query)
      selected = rows.length ? Math.max(0, Math.min(selected, rows.length - 1)) : 0
      renderCommandPalette(state, selected, query, rows)
    }
    function done(value) {
      process.stdin.off("keypress", onKey)
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw))
      state.ui.print("\x1b[0m")
      restoreSessionView(state)
      resolve(value)
    }
    function onKey(_text, key = {}) {
      if (key.ctrl && key.name === "c") {
        void shutdown(state, { exit: true })
      }
      if (key.name === "escape") return done(null)
      if (key.ctrl && key.name === "p") return done(null)
      if (key.name === "tab") {
        selected = rows.length ? (selected + 1) % rows.length : 0
        refresh()
        return
      }
      if (key.name === "up" || key.name === "k") {
        selected = rows.length ? (selected - 1 + rows.length) % rows.length : 0
        refresh()
        return
      }
      if (key.name === "down" || key.name === "j") {
        selected = rows.length ? (selected + 1) % rows.length : 0
        refresh()
        return
      }
      if (key.name === "backspace") {
        query = query.length > 1 ? query.slice(0, -1) : "/"
        selected = 0
        refresh()
        return
      }
      if (key.name === "return") return done(rows[selected]?.command || (query.trim().startsWith("/") ? query.trim() : null))
      if (String(_text || "") && !_text.startsWith("\x1b") && !key.ctrl && !key.meta) {
        query += _text
        selected = 0
        refresh()
      }
    }
    process.stdin.on("keypress", onKey)
  })
}

function filterCommandMenu(items, query) {
  const needle = String(query || "").replace(/^\//, "").trim().toLowerCase()
  if (!needle) return items
  return items.filter((item) => {
    const haystack = `${item.command} ${item.label || ""} ${item.description || ""}`.toLowerCase()
    return haystack.includes(needle)
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
  input = normalizeSlashInput(input)
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
      showTwillight(state, `/model ${value}`, "That is not a valid model id.\n\nRun `/models`, then `/use <number>`.")
      return true
    }
    state.previousModel = state.config.model
    const inferredProvider = inferProviderFromModel(value, state.config.provider)
    if (inferredProvider && inferredProvider !== state.config.provider) state.config.provider = inferredProvider
    state.config.model = value
    state.provider = createProvider(state.config, state.root, state.ui)
    state.saveConfig?.()
    showTwillight(state, `/model ${state.config.model}`, [
      "Model switched.",
      "",
      `- selected: \`${state.config.model}\``,
      `- provider: **${providerInfo(state.config.provider).title}**`,
      "- saved: `.ai/config.yaml`",
    ].join("\n"))
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
  if (input === "/update" || input === "/update-check" || input === "/upgrade" || input === "/updates") return updateStatus(state, true)
  if (input === "/update-install") return updateInstallCommand(state)
  if (input === "/keys") return keysStatus(state)
  if (input === "/providers" || input === "/providers list" || input === "/providers status" || input === "/providers catalog") return providersStatus(state)
  if (input.startsWith("/providers ")) {
    const providerValue = input.slice(11).trim()
    if (["list", "status", "catalog"].includes(providerValue.toLowerCase())) return providersStatus(state)
    return setProvider(state, providerValue)
  }
  if (input === "/skills") return skillsStatus(state)
  if (input === "/ai-sdk" || input === "/vercel-ai" || input === "/vercel") return vercelAiStatus(state)
  if (input === "/pet") return petStatus(state)
  if (input.startsWith("/pet ")) return setPet(state, input.slice(5).trim())
  if (["/dragon", "/dragom", "/dragn", "/dragoon"].includes(input)) return setPet(state, "sprite")
  if (input === "/key" || input.startsWith("/key ")) return saveKeyPrompt(state, input.slice(4).trim(), false)
  if (input.startsWith("/key-add ")) return saveKeyPrompt(state, input.slice(9).trim(), true)
  if (input === "/provider") return chooseProvider(state)
  if (input === "/provider list" || input === "/provider status" || input === "/provider catalog") return providersStatus(state)
  if (input.startsWith("/provider ")) return setProvider(state, input.slice(10).trim())
  if (input === "/openrouter") return setProvider(state, "openrouter")
  if (input === "/cloudflare" || input === "/workers-ai" || input === "/worker" || input === "/workers" || input === "/cf") return setProvider(state, "cloudflare")
  if (input.startsWith("/cloudflare ")) return setProvider(state, `cloudflare ${input.slice(12).trim()}`)
  if (input === "/gateway") return cloudflareGatewayStatus(state)
  if (input.startsWith("/gateway ")) return setCloudflareGateway(state, input.slice(9).trim())
  if (input.startsWith("/worker ")) return setCloudflareGateway(state, input.slice(8).trim())
  if (input === "/groq") return setProvider(state, "groq")
  if (input === "/huggingface" || input === "/hf") return setProvider(state, "huggingface")
  if (input === "/cerebras") return setProvider(state, "cerebras")
  if (input === "/sambanova") return setProvider(state, "sambanova")
  if (input === "/github-models" || input === "/github") return setProvider(state, "github")
  if (input === "/ollama") return setProvider(state, "ollama")
  if (input === "/openai") return setProvider(state, "openai")
  if (input === "/uncensored") return setPresetModel(state, state.config.uncensoredModel || "cognitivecomputations/dolphin-mistral-24b-venice-edition:free")
  if (input === "/copy" || input.startsWith("/copy ")) return copyCodeBlock(state, input.slice(5).trim())
  if (input === "/permissions") return showTwillight(state, "/permissions", `Permission mode: \`${state.config.permissionMode}\``)
  if (input === "/permission") return showTwillight(state, "/permission", `Permission mode: \`${state.config.permissionMode}\`\n\nUse \`/read-only\`, \`/workspace\`, \`/standard\`, or \`/full-access\`.`)
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
  showTwillight(state, `/do ${value}`, `Running **${item.label || item.command}**\n\n\`${item.command}\``)
  return handleInput(state, item.command)
}

function toolsStatus(state) {
  const allEnabled = isAllToolsEnabled(state.enabledTools)
  const enabled = allEnabled ? null : new Set(state.enabledTools)
  return showTwillight(state, "/tools", [
    "## Tools",
    "",
    `- preset: \`${allEnabled ? "all" : "custom"}\``,
    `- enabled: \`${enabledToolNames(state).length}/${state.registry.tools.length}\``,
    "- usage: `/tool on <name>` or `/tool off <name>`",
    "- presets: `/tool-preset all|read|safe|edit|code|autonomous`",
    "",
    ...state.registry.tools.map((tool) => `- ${enabled?.has(tool.name) || !enabled ? "on" : "off"}: \`${tool.name}\` (${tool.permission})`),
  ].join("\n"))
}

function setTool(state, value) {
  const [mode, ...rest] = value.split(/\s+/)
  const name = rest.join(" ").trim()
  if (!["on", "off"].includes(mode) || !name) throw new Error("Use /tool on <name> or /tool off <name>.")
  if (!state.registry.tools.some((tool) => tool.name === name)) throw new Error(`Unknown tool: ${name}`)
  const current = new Set(isAllToolsEnabled(state.enabledTools) ? state.registry.tools.map((tool) => tool.name) : state.enabledTools)
  if (mode === "on") current.add(name)
  else current.delete(name)
  state.enabledTools = normalizeEnabledTools([...current], state.registry.tools)
  state.saveConfig?.()
  return toolsStatus(state)
}

function setToolPreset(state, value) {
  const all = state.registry.tools.map((tool) => tool.name)
  const presets = {
    all,
    read: ["list_directory", "list_tree", "read_file", "read_json", "path_info", "paths_info", "find_files", "search_text", "command_exists", "git_status", "git_diff", "git_branch", "git_recent_commits"],
    safe: ["list_directory", "list_tree", "read_file", "read_json", "path_info", "paths_info", "find_files", "search_text", "command_exists", "git_status", "git_diff", "git_branch", "git_recent_commits"],
    edit: ["list_directory", "list_tree", "read_file", "read_json", "path_info", "paths_info", "find_files", "search_text", "write_file", "write_json", "append_file", "make_directory", "copy_path", "command_exists", "git_status", "git_diff", "git_branch", "git_recent_commits"],
    code: all.filter((name) => name !== "delete_path"),
    autonomous: all,
  }
  const selected = presets[value]
  if (!selected) throw new Error("Use /tool-preset all, read, safe, edit, code, or autonomous.")
  state.enabledTools = value === "all" || value === "autonomous" ? [ALL_TOOLS] : normalizeEnabledTools(selected, state.registry.tools)
  state.saveConfig?.()
  return toolsStatus(state)
}

function setPresetModel(state, model) {
  state.previousModel = state.config.model
  state.config.model = model
  state.config.provider = "openrouter"
  state.provider = createProvider(state.config, state.root, state.ui)
  state.saveConfig?.()
  return showTwillight(state, "/uncensored", [
    "Model switched.",
    "",
    `- selected: \`${model}\``,
    "- source: OpenRouter Venice Uncensored free",
    "- saved: `.ai/config.yaml`",
  ].join("\n"))
}

async function chooseProvider(state) {
  if (!process.stdin.isTTY) return providersStatus(state)
  const selected = await openProviderPalette(state)
  if (!selected) {
    restoreSessionView(state)
    return true
  }
  return setProvider(state, selected.replace(/^\/provider\s+/i, ""))
}

async function setProvider(state, value) {
  const request = parseProviderRequest(value)
  const provider = request.provider
  if (!provider) {
    return showTwillight(state, `/provider ${value || ""}`.trim(), [
      `Unknown provider: ${value || "(missing)"}`,
      "",
      `Use \`/provider\` to choose, or \`/provider ${providerNames().join("|")}\`.`,
    ].join("\n"))
  }
  const info = providerInfo(provider)
  const previousProvider = normalizeProviderName(state.config.provider)
  state.config.provider = provider
  if (request.model) {
    const inferredProvider = inferProviderFromModel(request.model, provider)
    if (inferredProvider && inferredProvider !== provider) {
      return showTwillight(state, `/provider ${value}`.trim(), [
        `That model looks like it belongs to ${providerInfo(inferredProvider).title}, not ${info.title}.`,
        "",
        `Use \`/provider ${inferredProvider} ${request.model}\` or choose a ${info.title} model with \`/models\`.`,
      ].join("\n"))
    }
    state.config.model = request.model
  } else if (previousProvider !== provider || !state.config.model || !providerSupportsModel(provider, state.config.model)) {
    state.config.model = info.defaultModel || state.config.model
  }
  if (provider === "cloudflare") {
    if (request.gatewayUrl) state.config.cloudflareGatewayUrl = normalizeUrlInput(request.gatewayUrl)
  }
  state.provider = createProvider(state.config, state.root, state.ui)
  state.freeModels = []
  state.saveConfig?.()
  showTwillight(state, `/provider ${provider}`, providerSummary(state, provider))
  if (!info.noAuth && !hasSavedApiKey(state.root, provider)) await saveKeyPrompt(state, provider, false)
  return true
}

export function parseProviderRequest(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean)
  const first = parts.shift() || ""
  let provider = normalizeProviderName(first)
  let gatewayUrl = ""
  let model = ""
  if (!provider && isUrlLike(first)) {
    provider = "cloudflare"
    gatewayUrl = first
  } else if (!provider && isLikelyModelId(first)) {
    model = first
    provider = inferProviderFromModel(first, "")
  }
  for (const part of parts) {
    if (isUrlLike(part)) gatewayUrl = part
    else if (isLikelyModelId(part)) model = part
  }
  return { provider, gatewayUrl, model }
}

function providerSummary(state, provider) {
  const info = providerInfo(provider)
  const keyLine = info.noAuth
    ? provider === "cloudflare" && savedApiKeyCount(state.root, provider) ? `${savedApiKeyCount(state.root, provider)} saved token(s)` : "not required"
    : hasSavedApiKey(state.root, provider) ? `${savedApiKeyCount(state.root, provider)} saved/available` : `missing; use /key ${provider}`
  return [
    `Provider switched to **${info.title}**.`,
    "",
    `- provider: \`${provider}\``,
    `- model: \`${state.config.model}\``,
    `- keys: ${keyLine}`,
    ...(provider === "cloudflare" ? [`- gateway: \`${state.config.cloudflareGatewayUrl || providerInfo("cloudflare").chat}\``] : []),
    `- saved: \`.ai/config.yaml\``,
    "",
    "Use `/models` to load models, `/provider` to switch again, or `/providers list` to view the catalog.",
  ].join("\n")
}

function providerMenuRows(state) {
  const current = normalizeProviderName(state.config.provider)
  return providerNames().map((name) => {
    const info = providerInfo(name)
    const count = savedApiKeyCount(state.root, name)
    const key = info.noAuth ? count ? `${count} token(s)` : "no key" : count ? `${count} key(s)` : "needs key"
    const marker = current === name ? "current" : info.freeFriendly ? "free" : "paid"
    const gateway = name === "cloudflare" ? ` · ${truncate(state.config.cloudflareGatewayUrl || info.chat, 28)}` : ""
    return {
      label: info.title,
      command: `/provider ${name}`,
      description: `${marker} · ${key} · ${info.defaultModel}${gateway}`,
    }
  })
}

function cloudflareGatewayStatus(state) {
  return showTwillight(state, "/gateway", [
    "## Cloudflare Gateway",
    "",
    `- url: \`${state.config.cloudflareGatewayUrl || providerInfo("cloudflare").chat}\``,
    "- set: `/gateway https://your-worker.workers.dev`",
    "- provider: `/provider cloudflare`",
    "- model: `/model @cf/moonshotai/kimi-k2.7-code`",
  ].join("\n"))
}

function setCloudflareGateway(state, value) {
  const url = normalizeUrlInput(value)
  if (!isHttpUrl(url)) throw new Error("Use /gateway https://your-worker-url")
  state.config.provider = "cloudflare"
  state.config.cloudflareGatewayUrl = url
  state.config.model = state.config.model?.startsWith("@cf/") ? state.config.model : providerInfo("cloudflare").defaultModel
  state.provider = createProvider(state.config, state.root, state.ui)
  state.freeModels = []
  state.saveConfig?.()
  return showTwillight(state, `/gateway ${state.config.cloudflareGatewayUrl}`, [
    "Cloudflare gateway saved.",
    "",
    `- url: \`${state.config.cloudflareGatewayUrl}\``,
    `- provider: **${providerInfo(state.config.provider).title}**`,
    `- model: \`${state.config.model}\``,
    "- saved: `.ai/config.yaml`",
  ].join("\n"))
}

function normalizeUrlInput(value) {
  const raw = String(value || "").trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "")
  if (raw && !/^https?:\/\//i.test(raw) && isUrlLike(raw)) return `https://${raw}`
  return raw
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim())
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname)
  } catch {
    return false
  }
}

function isUrlLike(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "")
  return isHttpUrl(text) || /^[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(text)
}

export function isLikelyModelId(value) {
  const text = String(value || "").trim()
  return !/^\d+$/.test(text) && /^@?[a-z0-9][a-z0-9_.:-]*(?:\/[a-z0-9_.:-]+)*$/i.test(text)
}

function inferProviderFromModel(model, currentProvider = "") {
  const value = String(model || "").trim().toLowerCase()
  if (value.startsWith("@cf/")) return "cloudflare"
  if (value.endsWith(":free")) return "openrouter"
  return normalizeProviderName(currentProvider) || ""
}

function providerSupportsModel(provider, model) {
  const selected = normalizeProviderName(provider)
  const inferred = inferProviderFromModel(model, "")
  return !inferred || inferred === selected
}

function modelStatus(state) {
  return showTwillight(state, "/model", [
    "## Model",
    "",
    `- current: \`${state.config.model}\``,
    `- provider: **${providerInfo(state.config.provider).title}**`,
    "- choose: `/models` then `/use <number>`",
    "- exact: `/model provider/model:id`",
    "- cloudflare: `/model @cf/moonshotai/kimi-k2.7-code`",
  ].join("\n"))
}

function bareSlashUsage(input) {
  const usage = {
    "/read": "Use /read <path>.",
    "/write": "Use /write <path> -- <content>.",
    "/append": "Use /append <path> -- <content>.",
    "/mkdir": "Use /mkdir <path>.",
    "/rm": "Use /rm <path>.",
    "/run": "Use /run <command>.",
    "/gateway": "Use /gateway https://your-worker-url.",
    "/use": "Run /models first, then /use <number>.",
    "/tool-preset": "Use /tool-preset all|read|safe|edit|code|autonomous.",
  }
  return usage[input] || ""
}

function usageBox(state, command, message) {
  return showTwillight(state, command, `Usage: ${message}`)
}

function copyCodeBlock(state, value) {
  const index = Number(value || "1") - 1
  const block = state.codeBlocks?.[index]
  if (!block) {
    return showTwillight(state, "/copy", "No code block found yet.\n\nAsk for code, then run `/copy 1`.")
  }
  const result = copyText(block.content)
  return showTwillight(state, `/copy ${block.index}`, [
    result.ok ? "Copied code block to clipboard." : "Copy failed.",
    "",
    `- block: ${block.index}`,
    `- lang: \`${block.lang || "text"}\``,
    `- status: ${result.ok ? "ok" : result.error}`,
  ].join("\n"))
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
    await handleInput(state, input)
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
  if (/\bwhat\s+can\s+(you\s+)?do\b/.test(text) || /^whatcan(you)?d[op]/.test(compact) || /whatcan(you)?do/.test(compact)) {
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
  return showTwillight(state, "/status", [
    "## Session",
    "",
    `- id: \`${state.id}\``,
    `- elapsed: \`${elapsed(state.started)}\``,
    `- turns: ${state.turns}`,
    `- provider: **${titleCase(state.provider.provider)}**`,
    `- cwd: \`${state.cwd}\``,
    `- model: \`${state.config.model}\``,
    `- mode: \`${state.config.agentMode}\``,
    `- ui: \`${state.uiEngine.available ? `opentui-${state.uiEngine.note}` : "ansi"}\``,
    `- tokens: ${state.tokens}`,
    `- reasoning: ${state.reasoningTokens}`,
    `- permission: \`${state.config.permissionMode}\``,
  ].join("\n"))
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
    "- `/gateway https://your-worker-url` set Cloudflare Worker AI gateway",
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
    "- `/ai-sdk` show Vercel AI SDK, Sandbox, Workflows, and AI Elements setup",
    "- `/mcp` show Twillight MCP server command",
    "- `/doctor` diagnose global install, PATH, and developer identity",
    "- `/update` check npm for a newer Twillight release",
    "- `/update-install` install the latest Twillight globally with npm",
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
  return showTwillight(state, "/mcp", [
    "## MCP",
    "",
    "- server: `twillight-mcp`",
    "- command: `npm run mcp`",
    "- direct: `node src/mcp/server.mjs`",
    `- tools: ${state.registry.tools.length}`,
    "- mode: stdio JSON-RPC",
  ].join("\n"))
}

function providersStatus(state) {
  const lines = [
    "Provider catalog",
    "",
    ...providerNames().map((name, index) => {
      const info = providerInfo(name)
      const selected = normalizeProviderName(state.config.provider) === name ? "selected" : info.freeFriendly ? "free-friendly" : "paid"
      const key = info.noAuth ? "no key required" : savedApiKeyCount(state.root, name) ? `${savedApiKeyCount(state.root, name)} key(s)` : `needs /key ${name}`
      return `${index + 1}. **${info.title}** \`${name}\` - ${selected}, ${key}, default \`${info.defaultModel}\``
    }),
    "",
    "Use `/provider` for the dropdown, or `/provider <name>` to switch directly.",
  ]
  return showTwillight(state, "/providers list", lines.join("\n"))
}

function skillsStatus(state) {
  return showTwillight(state, "/skills", [
    "## Skills",
    "",
    ...skillList().flatMap((skill) => [
      `### ${skill.title}`,
      `- id: \`${skill.id}\``,
      `- does: ${skill.description}`,
      `- uses: ${skill.commands.map((item) => `\`${item}\``).join(", ")}`,
      "",
    ]),
  ].join("\n").trim())
}

function petStatus(state, inputLabel = "/pet") {
  const access = petAccess(state.config.pet, state.isProjectDeveloper)
  const active = access.activePet
  const lines = [
    "## Pet",
    "",
    "```text",
    ...active.art,
    "```",
    "",
    `- active: **${active.title}** \`${access.activeName}\``,
    `- state: ${state.processing ? active.busy : active.idle}`,
    `- role: ${active.role}`,
    `- trait: ${active.trait}`,
    `- dev identity: ${state.isProjectDeveloper ? `yes (${state.developerReason})` : `no (${state.developerReason})`}`,
    "",
    "### Helps With",
    ...active.helps.map((item) => `- ${item}`),
    "",
    "### Switch",
    `- available: ${petNames().map((name) => `\`${name}\``).join(", ")}`,
    "- use `/pet` or `/pet sprite`",
  ]
  return showTwillight(state, inputLabel, lines.join("\n"))
}

function vercelAiStatus(state) {
  return showTwillight(state, "/ai-sdk", [
    "## Vercel AI SDK Skills",
    "",
    "Twillight keeps these as project skills so the CLI stays light. Run them only in projects that need them.",
    "",
    "- Core AI SDK: `npm i ai`",
    "- Vercel Sandbox: `npm i @vercel/sandbox`",
    "- Vercel Workflows: `npm i workflow`",
    "- AI Elements: `npx ai-elements`",
    "",
    "What Twillight uses them for:",
    "- provider-normalized streaming and tool calls",
    "- generated-code sandboxing for bigger agent tasks",
    "- resumable long-running workflows",
    "- reusable AI UI elements for web apps",
    "",
    "Use `/skills` to see the registered Twillight skill cards.",
  ].join("\n"))
}

function doctorStatus(state) {
  const pkg = packageMetadata(state.appRoot)
  const globalPrefix = runCapture(npmCommandSpec(["prefix", "-g"]))
  const whereTwillight = process.platform === "win32" ? runCapture("where.exe", ["twillight"]) : runCapture("which", ["twillight"])
  const whereTwilight = process.platform === "win32" ? runCapture("where.exe", ["twilight"]) : runCapture("which", ["twilight"])
  const prefix = globalPrefix.stdout.trim()
  const pathText = process.env.Path || process.env.PATH || ""
  const segments = pathText.split(process.platform === "win32" ? ";" : ":").map(normalizePathSegment).filter(Boolean)
  const pathHasPrefix = prefix ? segments.includes(normalizePathSegment(prefix)) : false
  const twillightBin = firstLine(whereTwillight.stdout) || whereTwillight.error || "not found"
  const twilightBin = firstLine(whereTwilight.stdout) || whereTwilight.error || "not found"
  const pet = petAccess(state.config.pet, state.isProjectDeveloper)
  const issues = []
  if (!pathHasPrefix) issues.push(`npm global prefix is not on PATH: \`${prefix || "unknown"}\``)
  if (/not found/i.test(twillightBin)) issues.push("`twillight` command shim was not found")
  if (!pet.activeName) issues.push("companion failed to load")
  const lines = [
    "## Doctor",
    "",
    `- package: \`${pkg.name || "twillight"}@${pkg.version || "unknown"}\``,
    `- platform: \`${state.config.platform || process.platform}\``,
    `- workspace: \`${state.root}\``,
    `- npm: \`${globalPrefix.command}\``,
    `- npm global: \`${prefix || globalPrefix.error || "unknown"}\``,
    `- PATH: ${pathHasPrefix ? "ok" : "missing npm global prefix or old terminal"}`,
    `- twillight bin: \`${twillightBin}\``,
    `- twilight alias: \`${twilightBin}\``,
    "",
    "### Provider",
    `- provider: **${providerInfo(state.provider?.provider || state.config.provider).title}**`,
    `- model: \`${state.config.model}\``,
    "",
    "### Pet",
    `- configured: \`${state.config.pet || "sprite"}\``,
    `- active: **${pet.activePet.title}**`,
    `- state: ${state.processing ? pet.activePet.busy : pet.activePet.idle}`,
    `- developer: ${state.isProjectDeveloper ? "yes" : "no"} (${state.developerReason})`,
    "",
    "### Result",
    issues.length ? issues.map((issue) => `- ${issue}`) : ["- no local install/companion issues detected"],
    "",
    "### Fixes",
    pathHasPrefix ? "- PATH looks ok" : "- open a new terminal after install, or add npm global prefix to PATH",
    /not found/i.test(twillightBin) ? "- run `npm install -g twillight@latest`" : "- `twillight` command shim found",
    "- companion loaded as the single supported pet",
  ].flat()
  return showTwillight(state, "/doctor", lines.join("\n"))
}

async function updateStatus(state, force = false) {
  const stop = state.ui.spinner("checking updates")
  let info
  try {
    info = await checkForUpdate(state, { force })
  } finally {
    stop()
  }
  if (info.available) {
    if (process.stdin.isTTY) {
      const choice = await promptUpdateChoice(state, info)
      if (choice === "install") return installUpdate(state, info)
      rememberUpdateSkip(state.root, info)
    }
    return showTwillight(state, "/update", [
      "Update available.",
      "",
      `- current: \`${info.current}\``,
      `- latest: \`${info.latest}\``,
      "- install: `/update-install`",
      `- command: \`${info.command}\``,
    ].join("\n"))
  }
  return showTwillight(state, "/update", [
    "Twillight is up to date.",
    "",
    `- current: \`${info.current || "unknown"}\``,
    `- latest: \`${info.latest || "unknown"}\``,
    `- status: ${info.reason === "cached" ? "already checked recently" : "up to date"}`,
  ].join("\n"))
}

async function updateInstallCommand(state) {
  const stop = state.ui.spinner("checking latest")
  let info
  try {
    info = await checkForUpdate(state, { force: true })
  } finally {
    stop()
  }
  if (!info.available) {
    return showTwillight(state, "/update-install", [
      "Already on latest.",
      "",
      `- current: \`${info.current || "unknown"}\``,
      `- latest: \`${info.latest || "unknown"}\``,
    ].join("\n"))
  }
  return installUpdate(state, info)
}

function runCapture(command, args = []) {
  const spec = typeof command === "object"
    ? { command: command.command, args: command.args || [], display: command.display || command.command }
    : { command, args, display: `${command} ${(args || []).join(" ")}`.trim() }
  const result = spawnSync(spec.command, spec.args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 })
  return {
    command: spec.display,
    code: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    error: result.error?.message || result.stderr || "",
  }
}

function firstLine(value) {
  return String(value || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || ""
}

function normalizePathSegment(value) {
  return String(value || "")
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/[\\/]+$/g, "")
    .toLowerCase()
}

function setPet(state, value) {
  const name = normalizePetName(value)
  if (!name) {
    return showTwillight(state, `/pet ${value || ""}`.trim(), [
      `Unknown pet: ${value || "(missing)"}`,
      "",
      `Available pets: ${petNames().map((pet) => `\`${pet}\``).join(", ")}`,
    ].join("\n"))
  }
  state.config.pet = name
  state.saveConfig?.()
  return petStatus(state, `/pet ${name}`)
}

function currentPet(state) {
  const access = petAccess(state.config.pet, state.isProjectDeveloper)
  return {
    name: access.activePet.title,
    mood: state.processing ? access.activePet.busy : access.activePet.idle,
    trait: access.activePet.trait,
  }
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
  if (/cloudflare.*browser challenge|cli cannot solve the javascript challenge|gateway\/waf config|<title>\s*Just a moment|cf_chl_|challenge-platform|enable javascript and cookies/i.test(raw)) {
    return [
      "Cloudflare is challenging the Worker URL, so Twillight is receiving an HTML page instead of AI JSON.",
      "",
      "Fix one of these:",
      "- In Cloudflare, skip Managed Challenge/Bot Fight/WAF challenge for the Worker API route.",
      "- Use an unchallenged workers.dev/API URL with `/gateway https://your-worker.workers.dev`.",
      "- If the Worker is private, save its token with `/key cloudflare`.",
      "",
      "Details: Cloudflare browser challenge blocked the CLI request.",
    ].join("\n")
  }
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
  if (/<!doctype html|<html[\s>]/i.test(raw)) {
    return [
      "The provider returned an HTML page instead of AI JSON.",
      "",
      "This usually means the endpoint URL is a web page, login page, or protected gateway instead of a clean API route.",
      "",
      "Open `/provider`, `/gateway`, or `/models` after fixing the provider URL.",
    ].join("\n")
  }
  if (/unknown command/i.test(raw)) return raw
  return raw
}

function uiStatus(state) {
  return showTwillight(state, "/ui", [
    "## UI",
    "",
    `- engine: ${state.uiEngine.available ? "OpenTUI" : "ANSI"}`,
    `- mode: \`${state.uiEngine.mode || "ansi"}\``,
    `- native: ${state.uiEngine.nativeRenderer ? "yes" : "no"}`,
    `- node: \`${process.version}\``,
    `- exports: ${state.uiEngine.exports?.join(", ") || "none"}`,
    `- reason: ${state.uiEngine.reason || "ready"}`,
  ].join("\n"))
}

function envStatus(state) {
  const config = state.uiEngine.env || {}
  return showTwillight(state, "/env", ["## OpenTUI Env", "", ...summarizeOpenTuiEnv(config).map((line) => `- ${line}`)].join("\n"))
}

function setAgentMode(state, mode) {
  state.config.agentMode = mode
  state.saveConfig?.()
  return showTwillight(state, `/${mode}-mode`, `Agent mode switched to \`${mode}\`.`)
}

function setPermission(state, mode) {
  if (!["read-only", "workspace", "standard", "full-access"].includes(mode)) {
    showTwillight(state, `/permission ${mode}`, `Unknown permission mode: ${mode}`)
    return true
  }
  state.config.permissionMode = mode
  state.saveConfig?.()
  return showTwillight(state, `/permission ${mode}`, `Permission mode switched to \`${mode}\`.`)
}

function keysStatus(state) {
  return showTwillight(state, "/keys", [
    "## Keys",
    "",
    `- file: \`${credentialPath(state.root)}\``,
    "",
    ...providerNames().map((provider) => {
      const env = apiKeyEnvName(provider) ? `${apiKeyEnvName(provider)} or ${apiKeysEnvName(provider)}` : "no key required"
      return `- ${provider}: ${savedApiKeyCount(state.root, provider)} saved/available (${env})`
    }),
  ].join("\n"))
}

async function saveKeyPrompt(state, requestedProvider = "", append = false) {
  if (!process.stdin.isTTY) throw new Error("/key requires interactive terminal input.")
  const explicitProvider = normalizeProviderName(String(requestedProvider || "").trim().split(/\s+/)[0])
  const provider = explicitProvider || state.provider.provider
  const envName = apiKeyEnvName(provider)
  if (!envName) return showTwillight(state, `/key ${provider}`, `${providerInfo(provider).title} does not need an API key.`)
  const key = await promptSecret(`${envName}: `, { ui: state.ui, provider })
  saveApiKey(state.root, provider, key, { append })
  let switched = false
  if (explicitProvider) {
    state.config.provider = provider
    if (!providerSupportsModel(provider, state.config.model)) state.config.model = providerInfo(provider).defaultModel || state.config.model
    state.provider = createProvider(state.config, state.root, state.ui)
    state.freeModels = []
    state.saveConfig?.()
    switched = true
  } else if (provider === state.provider.provider) {
    state.provider = createProvider(state.config, state.root, state.ui)
  }
  return showTwillight(state, `/key ${provider}`, [
    "Key saved.",
    "",
    `- provider: \`${provider}\``,
    ...(switched ? [`- active: switched to **${providerInfo(provider).title}**`] : []),
    `- model: \`${state.config.model}\``,
    `- status: ${append ? "added" : "saved"}`,
    `- keys: ${savedApiKeyCount(state.root, provider)}`,
    `- file: \`${credentialPath(state.root)}\``,
  ].join("\n"))
}

async function ensureInteractiveKey(state) {
  if (!process.stdin.isTTY) return
  if (providerInfo(state.provider.provider).noAuth) return
  if (hasSavedApiKey(state.root, state.provider.provider)) return
  await saveKeyPrompt(state)
}

async function attachImage(state, value) {
  const [pathPart, ...promptParts] = value.split(" -- ")
  const imagePath = pathPart.trim().replace(/^["']|["']$/g, "")
  const ext = imagePath.toLowerCase().endsWith(".jpg") || imagePath.toLowerCase().endsWith(".jpeg") ? "jpeg" : "png"
  const data = readFileSync(imagePath).toString("base64")
  state.pendingImage = `data:image/${ext};base64,${data}`
  showTwillight(state, "/image", `Image attached.\n\n- path: \`${imagePath}\``)
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
  showTwillight(state, "image", `Image attached from pasted path.\n\n- path: \`${localPath}\``)
  return paths.reduce((value, path) => value.replace(path, ""), text).trim() || "Describe this image."
}

function configBox(state) {
  return showTwillight(state, "/config", [
    "## Config",
    "",
    ...Object.entries(state.config).map(([key, value]) => `- ${key}: \`${String(value)}\``),
  ].join("\n"))
}

function unknown(state, input) {
  const suggestion = closestCommand(input)
  return showTwillight(state, input, suggestion
    ? `Unknown command: ${input}\n\nDid you mean \`${suggestion}\`?`
    : `Unknown command: ${input}\n\nPress ctrl+p or use \`/cmd\` for commands.`)
}

export function normalizeSlashInput(input) {
  const raw = String(input || "").trim()
  if (!raw.startsWith("/")) return raw
  const [head = "", ...rest] = raw.split(/\s+/)
  const alias = slashAlias(raw) || slashAlias(head)
  if (alias) return alias.includes(" ") ? alias : [alias, ...rest].join(" ").trim()
  if (knownSlashHeads().includes(head.toLowerCase())) return raw
  const corrected = closestCommand(raw) || closestCommand(head)
  if (!corrected) return raw
  if (corrected.includes(" ")) return corrected
  return [corrected, ...rest].join(" ").trim()
}

function slashAlias(input) {
  const value = String(input || "").trim().toLowerCase()
  return slashAliases()[value] || ""
}

function slashAliases() {
  return {
    "/cmds": "/cmd",
    "/commands": "/cmd",
    "/comands": "/cmd",
    "/command": "/cmd",
    "/dragon": "/pet",
    "/dragom": "/pet",
    "/dragn": "/pet",
    "/dragoon": "/pet",
    "/vercelai": "/ai-sdk",
    "/vercel-ai-sdk": "/ai-sdk",
    "/providr": "/provider",
    "/provder": "/provider",
    "/providerss": "/providers",
    "/providerrs": "/providers",
    "/providerz": "/providers",
    "/providerlist": "/providers list",
    "/provider-list": "/providers list",
    "/workr": "/worker",
    "/gate": "/gateway",
    "/mp": "/mcp",
    "/upgrade": "/update",
    "/updates": "/update",
    "/updat": "/update",
  }
}

function knownSlashHeads() {
  return [
    "/actions", "/ai-sdk", "/approve", "/append", "/build-mode", "/cerebras", "/changes", "/clear", "/cloudflare", "/cmd", "/cmds", "/commands",
    "/components", "/config", "/copy", "/dashboard", "/diff", "/do", "/doctor", "/env", "/exit", "/files", "/full-access",
    "/gateway", "/git", "/git-diff", "/git-status", "/groq", "/help", "/hf", "/huggingface", "/image", "/key", "/key-add", "/keys",
    "/mcp", "/memory", "/mkdir", "/model", "/models", "/ollama", "/openai", "/openrouter", "/palette", "/permission", "/permissions",
    "/pet", "/plan-mode", "/provider", "/providers", "/pwd", "/read", "/read-only", "/reject", "/remember", "/rm", "/rollback",
    "/run", "/sambanova", "/settings", "/skills", "/standard", "/status", "/tasks", "/tool", "/tool-preset", "/tools", "/tools-ui",
    "/ui", "/uncensored", "/undo", "/update", "/update-check", "/update-install", "/updates", "/upgrade", "/use", "/vercel", "/vercel-ai", "/worker", "/workers",
    "/workers-ai", "/workspace", "/write",
  ]
}

export function closestCommand(input) {
  const value = String(input || "").trim().toLowerCase()
  const head = value.split(/\s+/)[0]
  const alias = slashAlias(value) || slashAlias(head)
  if (alias) return alias
  const commands = [
    "/actions", "/ai-sdk", "/approve", "/build-mode", "/cerebras", "/changes", "/clear", "/cloudflare", "/cmd", "/components", "/config",
    "/copy", "/diff", "/doctor", "/env", "/exit", "/files", "/full-access", "/git-diff", "/git-status",
    "/gateway", "/groq", "/help", "/huggingface", "/image", "/key", "/key-add", "/keys", "/mcp", "/memory", "/mkdir",
    "/model", "/models", "/ollama", "/openai", "/openrouter", "/palette", "/permission", "/permissions", "/provider",
    "/pet", "/plan-mode", "/providers", "/read", "/read-only", "/reject", "/remember", "/rollback", "/run",
    "/sambanova", "/skills", "/standard", "/status", "/tasks", "/tool", "/tool-preset", "/tools", "/ui", "/vercel", "/vercel-ai",
    "/uncensored", "/undo", "/update", "/update-check", "/update-install", "/use", "/workspace", "/write",
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
