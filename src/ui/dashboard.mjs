import { bg, clean, clipVisible, rgb, theme, truncate } from "../utils/terminal.mjs"
import { providerInfo } from "../providers/catalog.mjs"
import { petAccess, petSidebarLine } from "../pets/catalog.mjs"
import { isAllToolsEnabled } from "../tools/registry.mjs"

export function renderDashboard(state) {
  const ui = state.ui
  const width = frameWidth()
  ui.clear()
  blank(ui, startTop())
  for (const line of wordmark(width)) ui.write(center(rgb(theme.accent, line), width))
  ui.write("")
  ui.write(center(`${rgb(theme.muted, "autonomous terminal coding client")} ${rgb(theme.border, "·")} ${rgb(theme.text, state.config.agentMode)}`, width))
  ui.write("")
  ui.write(center(statusLine(state, 64), width))
  ui.write("")
  ui.write(center(`${rgb(theme.text, "tab")} ${rgb(theme.muted, "models")}   ${rgb(theme.text, "ctrl+p")} ${rgb(theme.muted, "commands")}   ${rgb(theme.text, "/cmd")} ${rgb(theme.muted, "dropdown")}`, width))
  ui.write("")
  ui.write(center(`${rgb(theme.thought, "Tip")} ${rgb(theme.muted, "ask naturally, or run /cmd for actions and switches")}`, width))
  return true
}

export function renderInputPrompt(state, value = "") {
  const prefix = state.turns === 0 && !state.lastInput ? "Ask" : "Twillight"
  const startup = state.turns === 0 && !state.lastInput
  const sideWidth = sidebarWidth()
  const promptWidth = sideWidth && !startup ? inputWidth() : centeredInputWidth()
  const offset = sideWidth && !startup ? "" : centerOffset(promptWidth)
  const inner = promptWidth - 2
  const title = ` message ${"─".repeat(Math.max(0, inner - 9))}`
  const prompt = ` ${prefix} › ${clean(value)}`
  const visible = clipInputTail(prompt, inner)
  const fill = " ".repeat(Math.max(0, inner - clean(visible).length))
  const promptLines = [
    "",
    `${offset}${rgb(theme.line, `╭${title}╮`)}`,
    `${offset}${rgb(theme.accent, "▌")}${bg(theme.input, `${rgb(theme.muted, visible.slice(0, Math.min(visible.length, prefix.length + 4)))}${rgb(theme.text, visible.slice(prefix.length + 4))}${fill}`)}${rgb(theme.line, "│")}`,
    `${offset}${rgb(theme.line, `╰${"─".repeat(inner)}╯`)}`,
  ]
  if (startup || !sideWidth) return withInputCursor(promptLines, fill.length + 1, 1).join("\n")
  const lines = [
    "",
    withPromptRail([promptLines[1]])[0],
    withPromptRail([promptLines[2]])[0],
    withPromptRail([promptLines[3]])[0],
  ]
  return withInputCursor(lines, fill.length + 1 + promptRailExtra(), 1).join("\n")
}

export function shouldRedrawInputPrompt(state, value = "", nextText = "") {
  const prefix = state.turns === 0 && !state.lastInput ? "Ask" : "Twillight"
  const startup = state.turns === 0 && !state.lastInput
  const sideWidth = sidebarWidth()
  const promptWidth = sideWidth && !startup ? inputWidth() : centeredInputWidth()
  const inner = promptWidth - 2
  const current = ` ${prefix} › ${clean(value)}`
  const next = ` ${prefix} › ${clean(value)}${clean(nextText)}`
  return clean(nextText).length !== 1 || current.length >= inner - 2 || next.length >= inner - 1
}

function clipInputTail(value, width) {
  const text = clean(value)
  if (text.length <= width) return text
  return `…${text.slice(Math.max(0, text.length - width + 1))}`
}

export function renderInputBoundaryClose(state, value = "") {
  return "\x1b[1B\n"
}

export function renderSubmittedInput(state, input) {
  state.lastInput = input
  renderMessageTurn(state, input, "Working...")
  return true
}

export function renderChatTurn(state, input, output) {
  if (state.lastInput !== input || state.lastOutput !== output) state.scrollOffset = 0
  state.lastInput = input
  state.lastOutput = output
  state.codeBlocks = extractCodeBlocks(output)
  renderMessageTurn(state, input, output)
  return true
}

export function renderCommandPalette(state, selected = 0, query = "/", filteredRows = null) {
  const rows = filteredRows || (state.commandMenu?.length ? state.commandMenu : defaultCommands())
  const width = frameWidth()
  const maxRows = Math.min(12, Math.max(6, termRows() - 14))
  const clampedSelected = Math.max(0, Math.min(selected, Math.max(0, rows.length - 1)))
  const scrollStart = Math.max(0, Math.min(clampedSelected - maxRows + 1, Math.max(0, rows.length - maxRows)))
  const visibleRows = rows.slice(scrollStart, scrollStart + maxRows)
  const menuWidth = Math.min(74, width - 10)
  const bodyWidth = menuWidth - 4
  state.ui.clear()
  blank(state.ui, Math.max(2, Math.floor((termRows() - visibleRows.length - 10) / 2)))
  state.ui.write(center(`${rgb(theme.muted, "commands")} ${rgb(theme.border, "select with")} ${rgb(theme.text, "enter")} ${rgb(theme.border, "· filter by typing · esc closes")}`, width))
  state.ui.write(center(`${rgb(theme.border, "▌")}${bg(theme.input, ` ${rgb(theme.text, clean(query || "/"))}${" ".repeat(Math.max(0, menuWidth - clean(query || "/").length - 2))}`)}${rgb(theme.border, "▐")}`, width))
  state.ui.write(center(`${rgb(theme.line, "╭")}${rgb(theme.line, " dropdown ".padEnd(menuWidth - 2, "─"))}${rgb(theme.line, "╮")}`, width))
  for (const [index, item] of visibleRows.entries()) {
    const absoluteIndex = scrollStart + index
    const command = item.command.padEnd(14)
    const description = item.description || item.label
    const raw = `${command}${description}`
    const text = clipVisible(raw, bodyWidth)
    const fill = " ".repeat(Math.max(0, bodyWidth - clean(text).length))
    const row = absoluteIndex === clampedSelected
      ? bg(theme.select, rgb(theme.bg, `${text}${fill}`))
      : bg(theme.input, `${rgb(theme.text, command)}${rgb(theme.muted, description)}${fill}`)
    const marker = absoluteIndex === clampedSelected ? "▌" : " "
    state.ui.write(center(`${rgb(theme.line, "│")}${rgb(theme.border, marker)}${row}${rgb(theme.border, " ")}${rgb(theme.line, "│")}`, width))
  }
  if (!visibleRows.length) {
    const text = rgb(theme.muted, "No matching command. Press esc or keep typing.")
    state.ui.write(center(`${rgb(theme.line, "│")} ${text}${" ".repeat(Math.max(0, bodyWidth - clean(text).length + 1))}${rgb(theme.line, "│")}`, width))
  }
  state.ui.write(center(`${rgb(theme.line, "├")}${rgb(theme.line, "─".repeat(menuWidth - 2))}${rgb(theme.line, "┤")}`, width))
  if (rows.length > visibleRows.length) {
    const more = [
      scrollStart > 0 ? "↑ more" : "      ",
      scrollStart + visibleRows.length < rows.length ? "↓ more" : "      ",
    ].join("  ")
    state.ui.write(center(`${rgb(theme.line, "│")} ${rgb(theme.muted, more)}${" ".repeat(Math.max(0, menuWidth - clean(more).length - 4))} ${rgb(theme.line, "│")}`, width))
    state.ui.write(center(`${rgb(theme.line, "├")}${rgb(theme.line, "─".repeat(menuWidth - 2))}${rgb(theme.line, "┤")}`, width))
  }
  state.ui.write(center(`${rgb(theme.line, "│")}${statusLine(state, menuWidth - 2)}${rgb(theme.line, "│")}`, width))
  state.ui.write(center(`${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(menuWidth - 2))}${rgb(theme.line, "╯")}`, width))
  return true
}

export function renderUpdatePrompt(state, info, selected = 1) {
  const width = frameWidth()
  const modalWidth = Math.min(66, width - 12)
  const inner = modalWidth - 4
  const buttons = [
    selected === 0 ? bg(theme.select, rgb(theme.bg, " Skip ")) : rgb(theme.muted, " Skip "),
    selected === 1 ? bg(theme.select, rgb(theme.bg, " Install ")) : rgb(theme.text, " Install "),
  ]
  state.ui.clear()
  blank(state.ui, Math.max(2, Math.floor((termRows() - 12) / 2)))
  state.ui.write(center(`${rgb(theme.line, "╭")}${rgb(theme.line, " update available ".padEnd(modalWidth - 2, "─"))}${rgb(theme.line, "╮")}`, width))
  state.ui.write(center(modalLine(`${rgb(theme.text, "Twillight")} ${rgb(theme.muted, info.current)} ${rgb(theme.border, "→")} ${rgb(theme.accent, info.latest)}`, inner), width))
  state.ui.write(center(modalLine("", inner), width))
  state.ui.write(center(modalLine(rgb(theme.muted, "A newer npm release is available. Install it globally now?"), inner), width))
  state.ui.write(center(modalLine(rgb(theme.border, info.command || "npm install -g twillight@latest"), inner), width))
  state.ui.write(center(modalLine("", inner), width))
  const action = `${buttons[0]}  ${buttons[1]}   ${rgb(theme.muted, "esc closes")}`
  state.ui.write(center(modalLine(action, inner, "right"), width))
  state.ui.write(center(`${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(modalWidth - 2))}${rgb(theme.line, "╯")}`, width))
}

export function renderDiffPreview(state, title = "Diff") {
  state.ui.clear()
  state.ui.box(title, diffRows())
  return true
}

export function renderPalette(state) {
  state.ui.clear()
  state.ui.box("palette", Object.entries(theme).map(([name, color]) => `${name.padEnd(8)} ${color.join(",")}`))
  return true
}

function renderMessageTurn(state, input, output) {
  const width = frameWidth()
  const sideWidth = sidebarWidth(width)
  const mainWidth = sideWidth ? width - sideWidth - layoutOverhead() : width
  const answer = String(output || "")
  const thinking = answer === "Working..."
  const frameHeight = Math.max(14, termRows() - 5)
  const left = fixedConversation(state, input, answer, thinking, mainWidth, frameHeight)
  state.ui.clear()
  if (sideWidth) {
    const rail = sideRail(state, sideWidth, frameHeight)
    state.ui.columns([left, divider(Math.max(left.length, rail.length)), rail], columnGap())
  } else {
    left.forEach((line) => state.ui.write(line))
  }
}

function fixedConversation(state, input, answer, thinking, width, height) {
  const inner = Math.max(24, width - 2)
  const bodyHeight = Math.max(8, height - 4)
  const content = [
    ...inputBlock(input, width - 1),
    "",
    ...thoughtBlock(thinking),
    "",
  ]
  if (thinking || String(answer || "").trim()) {
    content.push(...replyBlock(answer, width), "")
  }
  content.push(footerLine(state, inner))
  const scrollMax = Math.max(0, content.length - bodyHeight)
  state.scrollOffset = Math.min(Math.max(0, state.scrollOffset || 0), scrollMax)
  const start = scrollMax ? scrollMax - state.scrollOffset : 0
  const clipped = content.slice(start, start + bodyHeight)
  if (scrollMax && start > 0) clipped[0] = scrollNotice(start, "earlier")
  if (scrollMax && start + bodyHeight < content.length) clipped[bodyHeight - 1] = scrollNotice(content.length - start - bodyHeight, "later")
  while (clipped.length < bodyHeight) clipped.push("")
  const scroll = scrollColumn(bodyHeight, scrollMax, state.scrollOffset || 0)
  return [
    `${rgb(theme.line, "╭")}${rgb(theme.line, " conversation ".padEnd(inner, "─"))}${rgb(theme.line, "╮")}`,
    ...clipped.map((line, index) => frameLine(line, inner, scroll[index])),
    `${rgb(theme.line, "├")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "┤")}`,
    frameLine(statusText(state, inner), inner),
    `${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╯")}`,
  ]
}

function inputBlock(input, width) {
  const inner = Math.max(20, width - 4)
  const rows = wrapPlain(input, inner - 3)
  return [
    `${rgb(theme.line, "╭")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╮")}`,
    ...rows.map((row, index) => {
      const rail = index === 0 ? rgb(theme.accent, "▌") : rgb(theme.border, " ")
      return `${rail}${rgb(theme.line, "│")}${bg(theme.input, ` ${row}${" ".repeat(Math.max(0, inner - clean(row).length - 2))}`)}${rgb(theme.line, "│")}`
    }),
    `${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╯")}`,
  ]
}

function thoughtBlock(thinking) {
  const stateText = thinking ? "Thinking..." : "Ready"
  const time = thinking ? "live" : "done"
  return [
    `${rgb(theme.thought, stateText)} ${rgb(theme.muted, time)}`,
    rgb(theme.muted, thinking ? "Twillight is routing the request and preparing the response." : "Response complete. Continue below or press ctrl+p for commands."),
  ]
}

function answerBlock(answer, width) {
  return formatMarkdown(answer, Math.max(28, width - 6))
}

function replyBlock(answer, width) {
  const inner = Math.max(24, width - 6)
  const body = answerBlock(answer, width)
  return [
    `${rgb(theme.line, "╭")}${rgb(theme.line, " Twillight ".padEnd(inner, "─"))}${rgb(theme.line, "╮")}`,
    ...body.map((line) => frameLine(line, inner)),
    `${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╯")}`,
  ]
}

function sideRail(state, width, height = termRows() - 2) {
  const elapsedText = elapsed(state.started)
  const activeTask = state.activeTask
  const taskState = activeTask?.status || (state.processing ? "running" : "idle")
  const progress = workflowProgress(activeTask)
  const tools = isAllToolsEnabled(state.enabledTools) ? "all enabled" : `${state.enabledTools.length} selected`
  const actions = activeTask?.status === "awaiting_approval"
    ? [shortcut("Enter", "approve"), shortcut("r / n", "reject")]
    : [shortcut("Enter", "send"), shortcut("Wheel", "scroll"), shortcut("Paste", "image path"), shortcut("Ctrl+C", "exit")]
  const sections = [
    headerLine(`Session ${state.id}`),
    "",
    ...petPanelLines(state, width),
    "",
    label("Status"),
    kv("api", state.processing ? rgb(theme.thought, "busy") : rgb(theme.good, "idle")),
    kv("task", taskState),
    kv("step", progress),
    kv("queue", String(state.inputQueue?.length || 0)),
    kv("time", elapsedText),
    "",
    label("Context"),
    kv("tokens", tokenText(state)),
    kv("reason", String(state.reasoningTokens || 0)),
    kv("turns", String(state.turns || 0)),
    "",
    label("Provider"),
    kv("name", titleProvider(state.provider?.provider || state.config.provider)),
    kv("model", truncate(state.config.model, width - 10)),
    "",
    label("Workflow"),
    kv("mode", state.config.agentMode),
    kv("perm", state.config.permissionMode),
    kv("tools", tools),
    kv("cwd", truncate(shortCwd(state.cwd || "."), width - 10)),
    "",
    label("Activity"),
    kv("changes", String(state.changes?.length || 0)),
    kv("commands", String(state.commands?.length || 0)),
    kv("blocks", String(state.codeBlocks?.length || 0)),
    ...(activeTask?.summary ? [kv("summary", truncate(activeTask.summary, width - 10))] : []),
    "",
    label("Controls"),
    ...actions,
  ]
  return railBox(sections, width, height)
}

function footerLine(state, width) {
  const text = `${rgb(theme.accent, "□")}  ${rgb(theme.text, "Build")} ${rgb(theme.border, "·")} ${rgb(theme.muted, state.config.model)} ${rgb(theme.border, "·")} ${rgb(theme.muted, `${state.turns}s`)}` 
  return clipVisible(text, width)
}

function statusText(state, width) {
  const provider = titleProvider(state.provider?.provider || state.config.provider)
  const right = `${rgb(theme.muted, tokenText(state))}   ${rgb(theme.text, "ctrl+p")} ${rgb(theme.muted, "commands")}`
  const contentWidth = Math.max(1, width - 1)
  const prefix = `${rgb(theme.text, "Build")} ${rgb(theme.muted, `· ${provider}`)} ${rgb(theme.border, "·")} `
  const modelWidth = Math.max(8, contentWidth - clean(prefix).length - clean(right).length - 2)
  const left = `${prefix}${rgb(theme.text, truncate(state.config.model, modelWidth))}`
  const gap = " ".repeat(Math.max(1, contentWidth - clean(left).length - clean(right).length))
  return `${left}${gap}${right}`
}

function railBox(lines, width, height) {
  const inner = Math.max(8, width - 2)
  const bodyHeight = Math.max(1, height - 2)
  const body = lines.slice(0, bodyHeight)
  while (body.length < bodyHeight) body.push("")
  return [
    `${rgb(theme.line, "╭")}${rgb(theme.line, " sidebar ".padEnd(inner, "─"))}${rgb(theme.line, "╮")}`,
    ...body.map((line) => {
      const content = clipVisible(line, inner - 2)
      return `${rgb(theme.line, "│")}${bg(theme.rail, ` ${content}${" ".repeat(Math.max(0, inner - 2 - clean(content).length))} `)}${rgb(theme.line, "│")}`
    }),
    `${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╯")}`,
  ]
}

function headerLine(value) {
  return rgb(theme.text, value)
}

function label(value) {
  return rgb(theme.accent, value)
}

function kv(key, value) {
  const left = rgb(theme.muted, `${key.padEnd(7)} `)
  return `${left}${typeof value === "string" ? rgb(theme.text, value) : value}`
}

function shortcut(command, description) {
  return `${rgb(theme.text, command.padEnd(10))}${rgb(theme.muted, description)}`
}

function titleProvider(provider) {
  return providerInfo(provider).title
}

function petLine(state) {
  return petSidebarLine(state.config.pet, { isDeveloper: state.isProjectDeveloper, processing: state.processing })
}

function petPanelLines(state, width) {
  const access = petAccess(state.config.pet, state.isProjectDeveloper)
  const pet = access.activePet
  const mood = petLine(state)
  const artWidth = Math.max(6, width - 4)
  const art = (pet.sidebarArt || pet.art || [])
    .slice(0, Math.max(2, width < 24 ? 3 : 5))
    .map((line) => rgb(theme.muted, truncate(line, artWidth)))
  const trait = pet.mood || pet.role
  return [
    label("Companion"),
    kv("name", truncate(pet.title, width - 10)),
    kv("mood", truncate(mood, width - 10)),
    ...art,
    kv("spark", truncate(trait, width - 10)),
  ]
}

function shortCwd(value) {
  return String(value || ".").replace(/\\/g, "/").split("/").filter(Boolean).pop() || value
}

function workflowProgress(task) {
  if (!task?.steps?.length) return "idle"
  const done = task.steps.filter((step) => step.status === "done" || step.status === "skipped").length
  const running = task.steps.find((step) => step.status === "running")
  const current = running ? ` · ${truncate(running.label || running.id, 12)}` : ""
  return `${done}/${task.steps.length}${current}`
}

function withPromptRail(lines) {
  const width = frameWidth()
  const sideWidth = sidebarWidth(width)
  if (!sideWidth) return lines
  const rail = blankRail(sideWidth)
  return lines.map((line) => {
    const padded = `${line}${" ".repeat(Math.max(0, inputWidth() - clean(line).length))}`
    return `${padded} ${rgb(theme.line, "│")} ${rail}`
  })
}

function withInputCursor(lines, cursorBack, cursorUp = 0) {
  const output = [...lines]
  output[output.length - 1] = `${output[output.length - 1]}${cursorUp ? `\x1b[${cursorUp}A` : ""}\x1b[${Math.max(1, cursorBack)}D`
  return output
}

function blankRail(width) {
  return bg(theme.rail, " ".repeat(Math.max(0, width)))
}

function scrollNotice(count, direction = "hidden") {
  const arrow = direction === "earlier" ? "↑" : direction === "later" ? "↓" : "…"
  const hint = direction === "earlier" ? "scroll up" : direction === "later" ? "scroll down" : "scroll"
  return `${rgb(theme.muted, `${arrow} ${count} ${direction} lines`)} ${rgb(theme.border, hint)}`
}

function scrollColumn(height, max, offset) {
  if (!max) return Array.from({ length: height }, () => "│")
  const track = Array.from({ length: height }, () => "│")
  track[0] = offset >= max ? "▲" : "△"
  track[height - 1] = offset <= 0 ? "▼" : "▽"
  const usable = Math.max(1, height - 2)
  const thumb = 1 + Math.round((max - offset) / max * (usable - 1))
  track[thumb] = "█"
  return track
}

export function scrollConversation(state, delta) {
  state.scrollOffset = Math.max(0, (state.scrollOffset || 0) + delta)
  return true
}

function frameLine(line, inner, scroll = "│") {
  const contentWidth = Math.max(1, inner)
  const clipped = clipVisible(line, contentWidth)
  return `${rgb(theme.line, "│")}${clipped}${" ".repeat(Math.max(0, contentWidth - clean(clipped).length))}${rgb(theme.line, scroll)}`
}

function statusLine(state, width) {
  const provider = titleProvider(state.provider?.provider || state.config.provider)
  const left = `${rgb(theme.text, "Build")} ${rgb(theme.border, "·")} ${rgb(theme.text, provider)} ${rgb(theme.border, "·")} ${rgb(theme.muted, truncate(state.config.model, 24))}`
  const right = `${rgb(theme.muted, tokenText(state))}`
  return bg(theme.input, ` ${left}${" ".repeat(Math.max(2, width - clean(left).length - clean(right).length - 2))}${right} `)
}

function wordmark(width = frameWidth()) {
  if (width < 90) {
    return [
      "████████╗██╗    ██╗██╗██╗     ██╗     ██╗ ██████╗ ██╗  ██╗████████╗",
      "╚══██╔══╝██║    ██║██║██║     ██║     ██║██╔════╝ ██║  ██║╚══██╔══╝",
      "   ██║   ██║ █╗ ██║██║██║     ██║     ██║██║  ███╗███████║   ██║   ",
      "   ██║   ██║███╗██║██║██║     ██║     ██║██║   ██║██╔══██║   ██║   ",
      "   ██║   ╚███╔███╔╝██║███████╗███████╗██║╚██████╔╝██║  ██║   ██║   ",
    ].map((line) => line.slice(0, Math.max(10, width - 2)))
  }
  return [
    "▄▄▄█████▓ █     █░ ██▓ ██▓     ██▓     ██▓  ▄████  ██░ ██ ▄▄▄█████▓",
    "▓  ██▒ ▓▒▓█░ █ ░█░▓██▒▓██▒    ▓██▒    ▓██▒ ██▒ ▀█▒▓██░ ██▒▓  ██▒ ▓▒",
    "▒ ▓██░ ▒░▒█░ █ ░█ ▒██▒▒██░    ▒██░    ▒██▒▒██░▄▄▄░▒██▀▀██░▒ ▓██░ ▒░",
    "░ ▓██▓ ░ ░█░ █ ░█ ░██░▒██░    ▒██░    ░██░░▓█  ██▓░▓█ ░██ ░ ▓██▓ ░ ",
    "  ▒██▒ ░ ░░██▒██▓ ░██░░██████▒░██████▒░██░░▒▓███▀▒░▓█▒░██▓  ▒██▒ ░ ",
    "  ▒ ░░   ░ ▓░▒ ▒  ░▓  ░ ▒░▓  ░░ ▒░▓  ░░▓   ░▒   ▒  ▒ ░░▒░▒  ▒ ░░   ",
    "    ░      ▒ ░ ░   ▒ ░░ ░ ▒  ░░ ░ ▒  ░ ▒ ░  ░   ░  ▒ ░▒░ ░    ░    ",
    "  ░        ░   ░   ▒ ░  ░ ░     ░ ░    ▒ ░░ ░   ░  ░  ░░ ░  ░      ",
    "             ░     ░      ░  ░    ░  ░ ░        ░  ░  ░  ░         ",
  ]
}

function diffRows() {
  return [
    rgb(theme.muted, "--- before"),
    rgb(theme.muted, "+++ after"),
    rgb(theme.thought, "@@ preview @@"),
    rgb(theme.bad, "-old"),
    rgb(theme.text, "+new"),
  ]
}

function defaultCommands() {
  return [
    { command: "/doctor", description: "Diagnose install and identity" },
    { command: "/models", description: "Choose free OpenRouter model" },
    { command: "/providers", description: "Show providers" },
    { command: "/provider cloudflare", description: "Use Workers AI gateway" },
    { command: "/model @cf/moonshotai/kimi-k2.7-code", description: "Use Cloudflare Kimi code" },
    { command: "/skills", description: "Show skills" },
    { command: "/ai-sdk", description: "Vercel AI SDK skills" },
    { command: "/pet", description: "Show pet" },
    { command: "/copy 1", description: "Copy latest code block" },
    { command: "/tools", description: "Select autonomous tools" },
    { command: "/tool-preset autonomous", description: "Enable all tools" },
    { command: "/uncensored", description: "Use uncensored free model" },
    { command: "/diff", description: "Open diff viewer" },
    { command: "/files", description: "Browse workspace files" },
    { command: "/full-access", description: "Enable full local actions" },
    { command: "/help", description: "Show command help" },
    { command: "/exit", description: "Exit Twillight" },
  ]
}

function tokenText(state) {
  const total = Number(state.tokens || 0)
  const percent = total ? Math.min(99, Math.round(total / 2000)) : 0
  return `${(total / 1000).toFixed(total ? 1 : 0)}K (${percent}%)`
}

function elapsed(started = Date.now()) {
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function wrapPlain(value, width) {
  return wrapTextHard(value, width)
}

function wrapTextHard(value, width) {
  const max = Math.max(1, Number(width) || 1)
  const words = clean(value).split(/\s+/)
  const lines = []
  let line = ""
  for (const word of words) {
    if (!word) continue
    const pieces = word.length > max ? chunkPlain(word, max) : [word]
    for (const piece of pieces) {
      const next = line ? `${line} ${piece}` : piece
      if (next.length > max) {
        if (line) lines.push(line)
        line = piece
      } else {
        line = next
      }
      if (line.length >= max) {
        lines.push(line)
        line = ""
      }
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : [""]
}

function formatMarkdown(value, width) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n")
  const output = []
  let code = null
  let codeIndex = 0
  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*```([\w.+-]*)\s*$/)
    if (fence) {
      if (code) {
        codeIndex += 1
        output.push(...codeBlock(code.lang, code.lines, width, codeIndex))
        code = null
      } else {
        code = { lang: fence[1] || "text", lines: [] }
      }
      continue
    }
    if (code) {
      code.lines.push(rawLine)
      continue
    }
    output.push(...formatMarkdownLine(rawLine, width))
  }
  if (code) {
    codeIndex += 1
    output.push(...codeBlock(code.lang, code.lines, width, codeIndex))
  }
  return output.length ? output : [""]
}

export function extractCodeBlocks(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n")
  const blocks = []
  let code = null
  for (const rawLine of lines) {
    const fence = rawLine.match(/^\s*```([\w.+-]*)\s*$/)
    if (fence) {
      if (code) {
        blocks.push({ index: blocks.length + 1, lang: code.lang, content: code.lines.join("\n") })
        code = null
      } else {
        code = { lang: fence[1] || "text", lines: [] }
      }
      continue
    }
    if (code) code.lines.push(rawLine)
  }
  if (code) blocks.push({ index: blocks.length + 1, lang: code.lang, content: code.lines.join("\n") })
  return blocks
}

function formatMarkdownLine(line, width) {
  if (!line.trim()) return [""]
  const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/)
  if (heading) return wrapStyled(formatInline(heading[2]), width, "").map((row) => rgb(theme.accent, row))

  const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
  if (bullet) {
    const marker = `${rgb(theme.accent, "•")} `
    return wrapStyled(formatInline(bullet[1]), width - 2, "  ").map((row, index) => `${index === 0 ? marker : "  "}${row}`)
  }

  const numbered = line.match(/^\s*(\d+)[.)]\s+(.+)$/)
  if (numbered) {
    const markerText = `${numbered[1]}. `
    const marker = rgb(theme.accent, markerText)
    return wrapStyled(formatInline(numbered[2]), width - markerText.length, " ".repeat(markerText.length)).map((row, index) => `${index === 0 ? marker : " ".repeat(markerText.length)}${row}`)
  }

  const quote = line.match(/^\s*>\s?(.*)$/)
  if (quote) return wrapStyled(formatInline(quote[1]), width - 2, "  ").map((row) => `${rgb(theme.line, "│")} ${rgb(theme.muted, clean(row))}`)

  return wrapStyled(formatInline(line), width, "")
}

function formatInline(value) {
  const parts = []
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/g
  let cursor = 0
  for (const match of String(value).matchAll(pattern)) {
    if (match.index > cursor) parts.push(rgb(theme.text, value.slice(cursor, match.index)))
    const token = match[0]
    if (token.startsWith("`")) {
      parts.push(bg(theme.panel, rgb(theme.accent, ` ${token.slice(1, -1)} `)))
    } else {
      parts.push(rgb(theme.accent, token.slice(2, -2)))
    }
    cursor = match.index + token.length
  }
  if (cursor < String(value).length) parts.push(rgb(theme.text, String(value).slice(cursor)))
  return parts.join("")
}

function wrapStyled(value, width, indent) {
  const plain = clean(value)
  if (plain.length <= width) return [value]
  return wrapTextHard(plain, width).map((line, index) => `${index ? indent : ""}${rgb(theme.text, line)}`)
}

function codeBlock(lang, lines, width, index = 1) {
  const inner = Math.max(24, width - 2)
  const title = ` code ${lang || "text"} ${"─".repeat(Math.max(0, inner - clean(lang || "text").length - 7))}`
  const action = ` copy /copy ${index} `
  const output = [
    `${rgb(theme.line, `╭${title}╮`)}`,
    `${rgb(theme.line, "│")}${bg(theme.rail, `${rgb(theme.accent, action)}${rgb(theme.muted, "copies this block")}${" ".repeat(Math.max(0, inner - clean(action).length - 17))}`)}${rgb(theme.line, "│")}`,
    `${rgb(theme.line, "├")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "┤")}`,
  ]
  const body = lines.length ? lines : [""]
  for (const line of body) {
    const chunks = chunkPlain(line, inner - 2)
    for (const chunk of chunks) {
      output.push(`${rgb(theme.line, "│")}${bg(theme.input, ` ${rgb(theme.text, chunk)}${" ".repeat(Math.max(0, inner - clean(chunk).length - 1))}`)}${rgb(theme.line, "│")}`)
    }
  }
  output.push(`${rgb(theme.line, "╰")}${rgb(theme.line, "─".repeat(inner))}${rgb(theme.line, "╯")}`)
  return output
}

function chunkPlain(value, width) {
  const text = clean(value)
  if (!text) return [""]
  const chunks = []
  for (let index = 0; index < text.length; index += width) chunks.push(text.slice(index, index + width))
  return chunks
}

function modalLine(value, width, align = "left") {
  const clipped = clipVisible(value, width)
  const pad = Math.max(0, width - clean(clipped).length)
  const leftPad = align === "right" ? pad : 0
  const rightPad = align === "right" ? 0 : pad
  return `${rgb(theme.line, "│")} ${" ".repeat(leftPad)}${clipped}${" ".repeat(rightPad)} ${rgb(theme.line, "│")}`
}

function center(value, width = frameWidth()) {
  const plain = clean(value)
  return `${" ".repeat(Math.max(0, Math.floor((width - plain.length) / 2)))}${value}`
}

function divider(height) {
  return Array.from({ length: height }, () => rgb(theme.line, "│"))
}

function blank(ui, count) {
  for (let index = 0; index < count; index += 1) ui.write("")
}

function frameWidth() {
  return Math.max(50, (process.stdout.columns || 110) - 1)
}

function inputWidth() {
  const width = frameWidth()
  const sideWidth = sidebarWidth(width)
  return Math.max(44, sideWidth ? width - sideWidth - layoutOverhead() : width - 4)
}

function sidebarWidth(width = frameWidth()) {
  if (width < 96) return 0
  return Math.min(30, Math.max(22, Math.floor(width * 0.18)))
}

function centeredInputWidth() {
  return Math.max(36, Math.min(84, frameWidth() - 8))
}

function promptRailExtra() {
  return sidebarWidth() + layoutOverhead()
}

function layoutOverhead() {
  return 1 + columnGap() * 2
}

function columnGap() {
  return 1
}

function centerOffset(width) {
  return " ".repeat(Math.max(0, Math.floor((frameWidth() - width) / 2)))
}

function termRows() {
  return Math.max(14, process.stdout.rows || 32)
}

function startTop() {
  return Math.max(1, Math.floor(termRows() * 0.2))
}
