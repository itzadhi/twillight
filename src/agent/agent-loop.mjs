import { createPlan } from "./planner.mjs"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { validationCommands } from "./validator.mjs"
import { needsApproval, planLocalWorkflow, workflowStates } from "./workflow.mjs"
import { unifiedDiff } from "../utils/terminal.mjs"
import { renderChatTurn, renderCommandPalette, renderInputPrompt } from "../ui/dashboard.mjs"

export async function runTask(state, task) {
  loadProjectMemory(state)
  state.plan = createPlan(task, state)
  if (state.config.agentMode === "plan") return finish(state, "Planned")
  if (await routeLocal(state, task)) return finish(state, "Completed")
  return chat(state, task)
}

export async function askModel(state, task) {
  const userContent = state.pendingImage
    ? [
        { type: "text", text: task },
        { type: "image_url", image_url: { url: state.pendingImage } },
      ]
    : task
  const messages = [
    { role: "system", content: systemPrompt(state) },
    ...state.messages,
    { role: "user", content: userContent },
  ]
  const response = await chatWithFallbacks(state, messages, {
    onToken(token) {
      // Keep streaming enabled for usage/reasoning data, but render the final
      // answer through the workbench instead of dumping raw text under it.
    },
  })
  state.lastProviderDebug = response.debug || {}
  state.ui.debug?.(`provider response provider=${state.provider.provider} model=${state.config.model} empty=${!String(response.content || "").trim()} debug=${JSON.stringify(state.lastProviderDebug).slice(0, 600)}`)
  const content = polishAssistantText(String(response.content || "").trim() || emptyResponseMessage(state))
  state.messages.push({ role: "user", content: task }, { role: "assistant", content })
  state.pendingImage = ""
  state.tokens += Number(response.usage.total_tokens ?? response.usage.totalTokens ?? 0)
  state.reasoningTokens += Number(response.usage.reasoning_tokens ?? response.usage.reasoningTokens ?? 0)
  state.turns += 1
  return content
}

export function polishAssistantText(value) {
  let text = String(value || "").trim()
  if (!text) return text
  const whitespace = (text.match(/\s/g) || []).length
  const camelJams = (text.match(/[a-z][A-Z]/g) || []).length
  const punctuationJams = (text.match(/[.!?;:][A-Za-z0-9"']/g) || []).length
  const knownJams = /(Theuser|Thesystem|Ishould|Thislooks|Theyprobably|Inmanycontexts|Themodel|However|Butwe|Wecould|Orewould|Idon|Whatcan|Whatwould|yourmodelname)/.test(text)
  const looksCompressed =
    text.length > 80 && whitespace < text.length / 28 && (camelJams + punctuationJams) > 3
    || text.length > 40 && knownJams && whitespace < text.length / 12
  if (!looksCompressed) return text
  text = text
    .replace(/\bTheuserasks/g, "The user asks")
    .replace(/\bThesystemsays/g, "The system says")
    .replace(/\bThislookslike/g, "This looks like")
    .replace(/\bTheyprobably/g, "They probably")
    .replace(/\bIshouldanswer/g, "I should answer")
    .replace(/\bTheuser/g, "The user")
    .replace(/\bThesystem/g, "The system")
    .replace(/\bIshould/g, "I should")
    .replace(/\bThislooks/g, "This looks")
    .replace(/\bTheyprobably/g, "They probably")
    .replace(/\bInmanycontexts/g, "In many contexts")
    .replace(/\bThemodel/g, "The model")
    .replace(/\bHowever/g, " However")
    .replace(/\bButwe/g, " But we")
    .replace(/\bWecould/g, " We could")
    .replace(/\bOrewould/g, " Or would")
    .replace(/\bIdon/g, "I don")
    .replace(/\bWhatcan/g, "What can")
    .replace(/\bWhatwould/g, "What would")
    .replace(/\byourmodelname/g, "your model name")
    .replace(/\bmodelname/g, "model name")
    .replace(/([.!?;:])(?=[A-Za-z0-9"'])/g, "$1 ")
    .replace(/([a-z])(?=[A-Z][a-z])/g, "$1 ")
    .replace(/([a-zA-Z])(?=\d)/g, "$1 ")
    .replace(/(\d)(?=[A-Za-z])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
  return text
}

async function chatWithFallbacks(state, messages, callbacks) {
  const originalModel = state.config.model
  const candidates = uniqueModels([originalModel, ...fallbackModels(state)])
  let lastResponse = null
  for (const model of candidates) {
    state.config.model = model
    state.provider = state.createProvider ? state.createProvider() : state.provider
    let response
    try {
      response = await state.provider.chat(messages, callbacks)
    } catch (error) {
      lastResponse = { content: "", usage: {}, debug: { attemptedModel: model, originalModel, error: error.message || String(error), status: error.status || 0 } }
      state.ui.debug?.(`model attempt failed model=${model} status=${error.status || 0} error=${error.message || String(error)}`)
      if ([401, 402, 403, 429].includes(Number(error.status || 0))) continue
      throw error
    }
    response.debug = { ...(response.debug || {}), attemptedModel: model, originalModel }
    if (String(response.content || "").trim()) {
      if (model !== originalModel) {
        response.content = `Switched model to ${model} because ${originalModel} returned empty.\n\n${response.content}`
        response.debug.fallbackUsed = true
      }
      return response
    }
    lastResponse = response
    const finish = String(response.debug?.finishReason || "").toLowerCase()
    state.ui.debug?.(`empty model attempt model=${model} finish=${finish || "unknown"}`)
    if (["content_filter", "safety"].includes(finish)) break
  }
  state.config.model = originalModel
  state.provider = state.createProvider ? state.createProvider() : state.provider
  return lastResponse || { content: "", usage: {}, debug: { attemptedModel: originalModel } }
}

function fallbackModels(state) {
  return String(state.config.fallbackModels || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function uniqueModels(models) {
  return [...new Set(models.filter(Boolean))]
}

function emptyResponseMessage(state) {
  const retry = state.lastProviderDebug?.retryAfterEmptyStream ? " I retried without streaming too." : ""
  const finish = state.lastProviderDebug?.finishReason ? ` Finish: ${state.lastProviderDebug.finishReason}.` : ""
  const attempted = state.lastProviderDebug?.attemptedModel ? ` Last tried: ${state.lastProviderDebug.attemptedModel}.` : ""
  return `The selected models returned empty messages.${retry}${finish}${attempted} Open /models and choose another free model.`
}

function systemPrompt(state) {
  return [
    "You are Twillight, an autonomous terminal AI coding client made by Adhi.",
    "Creator identity: Adhi, Discord username itz.adhi, GitHub username itzadhi.",
    "You are not a generic chatbot. You are a senior-grade coding system with a warm, friend-like terminal personality: sharp, calm, honest, and useful.",
    "Understand casual human wording, slang, incomplete sentences, and typos. Infer the engineering intent from normal words, then act.",
    "You help as a full coding partner: inspect projects, map architecture, plan work, edit files, run commands, debug failures, review diffs, validate behavior, and summarize the result.",
    `Current mode: ${state.config.agentMode}. Current permission level: ${state.config.permissionMode}. Workspace: ${state.cwd}.`,
    `Enabled tools: ${state.enabledTools?.length ? state.enabledTools.join(", ") : "all available Twillight tools"}.`,
    `Project memory: ${JSON.stringify(state.projectMemory || {})}`,
    "When the user asks for local filesystem or command actions, assume Twillight can use local tools through its autonomous workflow. Do not say you cannot access the machine unless the workflow is blocked by permissions or missing information.",
    "For coding tasks, follow this full-scale pipeline internally: clarify intent from context, inspect relevant files, identify constraints, choose the smallest robust design, apply changes, validate with syntax/tests/smoke checks, track changed files, and report what changed plus any risk.",
    "Prefer autonomous action in build mode. Prefer careful explanation and no edits in plan mode. Respect permission mode.",
    "Be concise in chat, but be complete in work. Avoid filler, disclaimers, and generic lists. Ask a question only when making a reasonable assumption would be risky.",
    "If you provide code, make it ready to use. If you explain, keep it terminal-friendly and structured.",
  ].join("\n")
}

export async function chat(state, task) {
  loadProjectMemory(state)
  renderChatTurn(state, task, "Working...")
  keepPromptVisible(state)
  const answer = await askModel(state, task)
  renderChatTurn(state, task, answer, { placeholder: "" })
  keepPromptVisible(state)
  return answer
}

function keepPromptVisible(state) {
  if (state.inputActive && !state.exiting) state.ui.print(renderInputPrompt(state, state.currentInput || ""))
}

async function runModelWorkflow(state, objective) {
  const task = createWorkflowRecord(state, objective, "model")
  state.activeTask = task
  createCheckpoint(state, task)
  task.checkpointId = state.checkpoint?.id || ""
  transitionTask(state, task, workflowStates.PLANNING, "Built task plan")
  updateWorkflowStep(state, task, "understand", "done", "Understood request")
  updateWorkflowStep(state, task, "inspect", "running", "Inspecting session context")
  showWorkflow(state, task)
  updateWorkflowStep(state, task, "inspect", "done", "Session context ready")
  updateWorkflowStep(state, task, "reason", "running", "Calling configured model")
  transitionTask(state, task, workflowStates.EXECUTING, "Model request started")
  renderChatTurn(state, objective, "Working...")
  keepPromptVisible(state)
  const answer = await askModel(state, objective)
  updateWorkflowStep(state, task, "reason", "done", "Model response received")
  updateWorkflowStep(state, task, "apply", state.changes.length ? "done" : "skipped", state.changes.length ? "Tracked file changes" : "No local edits needed")
  updateWorkflowStep(state, task, "verify", "running", "Checking whether validation is needed")
  transitionTask(state, task, workflowStates.VERIFYING, "Verification started")
  renderChatTurn(state, objective, answer, { placeholder: "" })
  if (state.changes.length) validate(state)
  updateWorkflowStep(state, task, "verify", "done", "Verification complete")
  updateWorkflowStep(state, task, "summarize", "done", "Response rendered")
  task.summary = summarizeTask(state, task)
  transitionTask(state, task, workflowStates.COMPLETED, "Completed")
  updateProjectMemory(state, task)
  return answer
}

function createWorkflowRecord(state, objective, kind) {
  const workflow = {
    objective: String(objective || "Interactive assistance").trim(),
    risk: kind === "local" ? "medium" : "low",
    permissionMode: state.config.permissionMode,
    status: workflowStates.PLANNING,
    steps: workflowSteps(kind),
    timeline: [],
  }
  return state.taskStore?.create(workflow) || { id: "memory", ...workflow, results: [], error: "" }
}

function workflowSteps(kind) {
  const labels = kind === "local"
    ? [
        ["understand", "Understand task"],
        ["inspect", "Inspect project and permissions"],
        ["checkpoint", "Create checkpoint"],
        ["execute", "Execute local actions"],
        ["verify", "Run validation checks"],
        ["summarize", "Summarize changes"],
      ]
    : [
        ["understand", "Understand request"],
        ["inspect", "Inspect session and project memory"],
        ["reason", "Use configured model"],
        ["apply", "Apply local changes if needed"],
        ["verify", "Validate result"],
        ["summarize", "Summarize outcome"],
      ]
  return labels.map(([id, label]) => ({ id, label, status: "pending" }))
}

function transitionTask(state, task, status, note) {
  task.status = status
  if (note) task.timeline.push({ at: new Date().toISOString(), status, note })
  state.taskStore?.save(task)
  showWorkflow(state, task)
}

function updateWorkflowStep(state, task, id, status, note = "") {
  const step = task.steps.find((item) => item.id === id)
  if (step) step.status = status
  if (note) task.timeline.push({ at: new Date().toISOString(), status, note })
  state.taskStore?.save(task)
  showWorkflow(state, task)
}

export async function routeLocal(state, input) {
  if (input.trim().startsWith("/")) return runSlash(state, input.trim())
  const workflow = planLocalWorkflow(state, input)
  if (!workflow) return false
  const task = state.taskStore?.create(workflow) || { id: "memory", ...workflow, status: workflowStates.PLANNING, results: [] }
  state.activeTask = task
  createCheckpoint(state, task)
  task.checkpointId = state.checkpoint?.id || ""
  task.timeline = task.timeline || []
  task.timeline.push({ at: new Date().toISOString(), status: workflowStates.PLANNING, note: "Local workflow planned" })
  showWorkflow(state, task)
  if (needsApproval(state, task)) {
    task.status = workflowStates.AWAITING_APPROVAL
    task.timeline.push({ at: new Date().toISOString(), status: task.status, note: "Waiting for approval" })
    state.taskStore?.save(task)
    renderWorkflowFrame(state, task, "Waiting for approval. Press Enter to approve, or type reject.")
    return true
  }
  return executeWorkflow(state, task)
}

export async function runSlash(state, input) {
  if (input === "/workflow" || input === "/plan") {
    state.ui.box("workflow", createPlan(state.plan?.objective || "Interactive assistance", state).steps.map((step, index) => state.ui.row(String(index + 1), step)))
    return true
  }
  if (input === "/pwd") return showResult(state, "workspace", { cwd: state.cwd })
  if (input.startsWith("/cd ")) {
    state.cwd = state.registry.run(state, "path_info", { path: input.slice(4) }).path
    return showResult(state, "workspace", { cwd: state.cwd })
  }
  if (input === "/ls" || input.startsWith("/ls ")) return showResult(state, "list", state.registry.run(state, "list_directory", { path: input.slice(3).trim() || state.cwd }))
  if (input.startsWith("/read ")) return showResult(state, "read", state.registry.run(state, "read_file", { path: input.slice(6) }))
  if (input.startsWith("/write ")) return writeLike(state, input.slice(7), false)
  if (input.startsWith("/append ")) return writeLike(state, input.slice(8), true)
  if (input.startsWith("/mkdir ")) return showResult(state, "action", state.registry.run(state, "make_directory", { path: input.slice(7) }))
  if (input.startsWith("/rm ")) return showResult(state, "action", state.registry.run(state, "delete_path", { path: input.slice(4), confirm: true }))
  if (input.startsWith("/run ")) {
    const command = input.slice(5)
    state.ui.box("running", [state.ui.row("command", command), state.ui.row("why", "user requested direct command")])
    return showResult(state, "shell", state.registry.run(state, "run_command", { command }))
  }
  if (input === "/files") return showResult(state, "files", state.registry.run(state, "list_directory", { path: state.cwd }))
  if (input === "/changes") return showResult(state, "changes", { changes: state.changes, commands: state.commands })
  if (input === "/cmd" || input === "/cmds" || input === "/commands") return showCommandMenu(state)
  if (input.startsWith("/do ")) return runMenuCommand(state, input.slice(4).trim())
  if (input === "/actions") return showActions(state)
  if (input === "/tasks") return showTasks(state)
  if (input === "/approve") return approveTask(state)
  if (input === "/reject" || input === "/cancel") return rejectTask(state)
  if (input === "/undo") return undo(state)
  if (input === "/rollback") return rollback(state)
  if (input === "/memory") return showMemory(state)
  if (input.startsWith("/remember ")) return remember(state, input.slice(10).trim())
  if (input === "/models") return showModels(state)
  if (input.startsWith("/use ")) return useModel(state, input.slice(5).trim())
  if (input === "/diff") return showChangeDiffs(state)
  if (input === "/git" || input === "/git-status") return showResult(state, "git status", state.registry.run(state, "git_status", {}))
  if (input === "/git-diff" || input === "/git diff") return showResult(state, "git diff", state.registry.run(state, "git_diff", {}))
  return false
}

export function executeWorkflow(state, task) {
  task.status = workflowStates.EXECUTING
  task.timeline = task.timeline || []
  task.timeline.push({ at: new Date().toISOString(), status: task.status, note: "Executing local workflow" })
  state.taskStore?.save(task)
  renderWorkflowFrame(state, task, "Starting local action.")
  for (const step of task.steps) {
    try {
      step.status = "running"
      task.timeline.push({ at: new Date().toISOString(), status: "running", note: step.label })
      state.taskStore?.save(task)
      renderWorkflowFrame(state, task, `Running ${step.tool}.`)
      const result = state.registry.run(state, step.tool, step.input)
      step.status = "done"
      task.results.push({ step: step.id, tool: step.tool, result })
      task.timeline.push({ at: new Date().toISOString(), status: "done", note: step.label })
      renderWorkflowFrame(state, task, "Action complete.")
    } catch (error) {
      step.status = "failed"
      task.status = workflowStates.FAILED
      task.error = error.message || String(error)
      task.timeline.push({ at: new Date().toISOString(), status: "failed", note: task.error })
      state.taskStore?.save(task)
      renderWorkflowFrame(state, task, task.error)
      return true
    }
  }
  task.status = workflowStates.VERIFYING
  task.timeline.push({ at: new Date().toISOString(), status: task.status, note: "Running verification" })
  state.taskStore?.save(task)
  if (shouldValidateWorkflow(task)) validate(state, task)
  task.status = workflowStates.COMPLETED
  task.summary = summarizeTask(state, task)
  task.timeline.push({ at: new Date().toISOString(), status: task.status, note: "Completed" })
  state.taskStore?.save(task)
  updateProjectMemory(state, task)
  renderWorkflowFrame(state, task, "Done.")
  return true
}

function showWorkflow(state, task) {
  renderWorkflowFrame(state, task)
  return true
}

function approveTask(state) {
  const task = state.activeTask || loadLatestTask(state)
  if (!task) return showResult(state, "approval", { result: "no task to approve" })
  if (task.status !== workflowStates.AWAITING_APPROVAL && task.status !== workflowStates.PLANNING) {
    return showResult(state, "approval", { task: task.id, result: `not awaiting approval (${task.status})` })
  }
  state.activeTask = task
  return executeWorkflow(state, task)
}

function rejectTask(state) {
  const task = state.activeTask || loadLatestTask(state)
  if (!task) return showResult(state, "approval", { result: "no task to reject" })
  task.status = workflowStates.REJECTED
  task.error = "Rejected by user"
  state.taskStore?.save(task)
  state.activeTask = null
  return showResult(state, "approval", { task: task.id, result: "rejected" })
}

function showActions(state) {
  const task = state.activeTask || loadLatestTask(state)
  if (!task) return showResult(state, "actions", { result: "no active task" })
  return showWorkflow(state, task)
}

function showTasks(state) {
  const tasks = state.taskStore?.list() || []
  state.ui.box("tasks", tasks.slice(0, 20).map((task) => state.ui.row(task.id, `${task.status} ${task.risk} ${task.objective}`)))
  return true
}

function showProgress(state, title, steps, task = state.activeTask) {
  const done = steps.filter((step) => step.status === "done").length
  const total = steps.length
  state.ui.box("progress", [
    state.ui.row("task", task?.id || "chat"),
    state.ui.row("risk", task?.risk || "low"),
    state.ui.row("state", task?.status || "planning"),
    state.ui.row("progress", `${done}/${total}`),
    ...steps.map((step) => state.ui.row(marker(step.status), step.label)),
  ])
}

function renderWorkflowFrame(state, task, note = "") {
  if (isSimpleWorkflow(task)) {
    const result = task.results?.at(-1)?.result
    const title = task.status === workflowStates.COMPLETED ? "Done" : task.status === workflowStates.FAILED ? "Failed" : "Working"
    const body = [
      `## ${title}`,
      "",
      simpleWorkflowSentence(task, result, note),
    ].filter(Boolean)
    if (task.error) body.push("", `Error: ${task.error}`)
    renderChatTurn(state, task.objective, body.join("\n"))
    keepPromptVisible(state)
    return
  }
  const lines = [
    `## ${task.status === workflowStates.COMPLETED ? "Done" : "Working"}`,
    "",
    `Task: ${task.objective}`,
    `State: ${task.status}`,
    `Risk: ${task.risk}`,
    `Progress: ${workflowDone(task)}/${task.steps?.length || 0}`,
    "",
    ...(task.steps || []).map((step) => `${marker(step.status)} ${step.label || step.tool || step.id}`),
  ]
  if (task.results?.length) {
    lines.push("", "### Results")
    for (const result of task.results.slice(-4)) {
      lines.push(`- ${result.tool}: ${compactResult(result.result)}`)
    }
  }
  if (task.commands?.length) {
    lines.push("", "### Checks")
    for (const command of task.commands.slice(-3)) lines.push(`- ${command.command}: exit ${command.code}`)
  }
  if (task.error) lines.push("", `Error: ${task.error}`)
  if (note) lines.push("", note)
  renderChatTurn(state, task.objective, lines.join("\n"))
  keepPromptVisible(state)
}

function isSimpleWorkflow(task) {
  return task?.steps?.length <= 2 && ["low", "medium"].includes(task.risk)
}

function simpleWorkflowSentence(task, result, note) {
  if (task.status === workflowStates.AWAITING_APPROVAL) return "This needs approval. Press Enter to approve, or type reject."
  if (task.status === workflowStates.EXECUTING || task.status === workflowStates.VERIFYING) return note || "Doing it now."
  if (task.status === workflowStates.COMPLETED) {
    if (result?.path && result?.result) return `${capitalize(result.result)}: ${result.path}`
    if (result?.path) return `Done: ${result.path}`
    return task.summary || "Done."
  }
  return note || task.summary || "Ready."
}

function capitalize(value) {
  const text = String(value || "")
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`
}

function workflowDone(task) {
  return task.steps?.filter((step) => step.status === "done" || step.status === "skipped").length || 0
}

function compactResult(result) {
  if (!result || typeof result !== "object") return String(result ?? "ok")
  if (result.path && result.result) return `${result.result} ${result.path}`
  if (result.path && result.bytes !== undefined) return `${result.path} (${result.bytes} bytes)`
  if (result.command) return `${result.command} exit ${result.code}`
  return JSON.stringify(result).slice(0, 140)
}

function shouldValidateWorkflow(task) {
  return task.steps?.some((step) => ["write_file", "append_file", "delete_path", "run_command"].includes(step.tool))
}

function marker(status) {
  if (status === "done") return "✓"
  if (status === "running") return "→"
  if (status === "skipped") return "-"
  if (status === "failed") return "!"
  return "○"
}

function showCommandTransparency(state, step) {
  const details = step.tool === "run_command"
    ? [state.ui.row("command", step.input.command), state.ui.row("why", step.label)]
    : [state.ui.row("tool", step.tool), state.ui.row("why", step.label), state.ui.row("input", JSON.stringify(step.input).slice(0, 180))]
  state.ui.box("running", details)
}

function showCommandMenu(state) {
  state.commandMenu = createCommandMenu()
  renderCommandPalette(state)
  return true
}

export function createCommandMenu() {
  return [
    { label: "Doctor", command: "/doctor", description: "Diagnose install, PATH, and developer identity" },
    { label: "Show files", command: "/files", description: "Open file list" },
    { label: "Show changes", command: "/changes", description: "Inspect session changes" },
    { label: "Copy code block", command: "/copy 1", description: "Copy latest code block" },
    { label: "Tool selector", command: "/tools", description: "Choose autonomous tools" },
    { label: "Autonomous tools", command: "/tool-preset autonomous", description: "Enable every local tool" },
    { label: "MCP server", command: "/mcp", description: "Show Twillight MCP stdio command" },
    { label: "Providers", command: "/providers", description: "Show provider catalog" },
    { label: "Provider", command: "/provider openrouter", description: "Switch provider" },
    { label: "Keys", command: "/keys", description: "Show saved key counts" },
    { label: "Add key", command: "/key-add openrouter", description: "Add key for rotation" },
    { label: "Skills", command: "/skills", description: "Show built-in skills" },
    { label: "Pet", command: "/pet", description: "Show pet status" },
    { label: "Developer dragon", command: "/dragon", description: "Unlock dragon for project dev" },
    { label: "Uncensored free model", command: "/uncensored", description: "Use Venice uncensored free" },
    { label: "Open diff viewer", command: "/diff", description: "Open diff viewer" },
    { label: "Git status", command: "/git-status", description: "Show repository changes" },
    { label: "Rollback checkpoint", command: "/rollback", description: "Restore latest checkpoint" },
    { label: "Project memory", command: "/memory", description: "Show remembered repo notes" },
    { label: "Choose model", command: "/models", description: "Load free OpenRouter models" },
    { label: "Switch mode", command: "/plan-mode", description: "Plan without edits" },
    { label: "Build mode", command: "/build-mode", description: "Autonomous build mode" },
    { label: "Full access", command: "/full-access", description: "Allow broader local actions" },
    { label: "Palette", command: "/palette", description: "Show current palette" },
    { label: "Help", command: "/help", description: "Help" },
  ]
}

async function runMenuCommand(state, value) {
  const index = Number(value) - 1
  const item = state.commandMenu?.[index]
  if (!item) throw new Error("Run /cmd first, then choose with /do <number>.")
  state.ui.box("command", [state.ui.row("selected", item.label), state.ui.row("runs", item.command)])
  return runSlash(state, item.command)
}

function showChangeDiffs(state) {
  const textChanges = state.changes.filter((change) => "before" in change && "after" in change)
  if (!textChanges.length) return showResult(state, "diff", { result: "no tracked file text changes" })
  for (const change of textChanges) {
    state.ui.diff(`${change.type} ${change.path}`, unifiedDiff(change.before ?? "", change.after ?? "", change.path))
  }
  return true
}

function loadLatestTask(state) {
  try {
    return state.taskStore?.load("latest")
  } catch {
    return null
  }
}

async function showModels(state) {
  const stopThinking = state.ui.spinner("loading models")
  const models = await state.provider.models().finally(stopThinking)
  state.freeModels = models
  const lines = [
    "## Free models",
    "",
    ...models.slice(0, 40).map((model, index) => `${index + 1}. \`${model.id}\`${model.context ? ` (${model.context})` : ""}`),
    "",
    "Use `/use <number>` to switch, for example `/use 1`.",
  ]
  renderChatTurn(state, "/models", lines.join("\n"))
  keepPromptVisible(state)
  return true
}

function useModel(state, value) {
  const index = Number(value) - 1
  const selected = state.freeModels?.[index]
  if (!Number.isInteger(index) || index < 0) throw new Error("Use a model number from /models, for example /use 1.")
  if (!selected) throw new Error("Run /models first, then choose a listed number with /use <number>.")
  state.previousModel = state.config.model
  state.config.model = selected.id
  state.provider = state.createProvider()
  showResult(state, "model", { selected: selected.id })
  return true
}

function writeLike(state, value, append) {
  const index = value.indexOf(" -- ")
  if (index === -1) throw new Error(`Use: /${append ? "append" : "write"} path -- content`)
  return showResult(state, "action", state.registry.run(state, append ? "append_file" : "write_file", { path: value.slice(0, index), content: value.slice(index + 4) }))
}

function validate(state, task = null) {
  for (const command of validationCommands(state.root)) {
    const result = state.registry.run(state, "run_command", { command })
    if (task) {
      task.commands = task.commands || []
      task.commands.push({ command, code: result.code })
      task.results.push({ step: "verify", tool: "validate", result })
      state.taskStore?.save(task)
      renderWorkflowFrame(state, task, `Validated with ${command}.`)
    } else {
      state.ui.box("running", [state.ui.row("command", command), state.ui.row("why", "validate changed project")])
      showResult(state, "validate", result)
    }
  }
}

function showResult(state, title, result) {
  const lines = Array.isArray(result)
    ? result.map((item) => state.ui.row(item.type || "item", item.name || JSON.stringify(item)))
    : Object.entries(result).flatMap(([key, value]) => typeof value === "string" ? [state.ui.row(key, value.slice(0, 4000))] : [state.ui.row(key, JSON.stringify(value).slice(0, 4000))])
  state.ui.box(title, lines.length ? lines : [state.ui.row("result", "ok")])
  if (result.stdout) state.ui.write(result.stdout.trimEnd())
  if (result.stderr) state.ui.error(result.stderr.trimEnd())
  return true
}

function finish(state, status) {
  state.ui.box(status, [
    state.ui.row("changes", String(state.changes.length)),
    state.ui.row("commands", String(state.commands.length)),
    state.ui.row("tokens", String(state.tokens)),
  ])
  return status
}

function summarizeTask(state, task) {
  const done = task.steps?.filter((step) => step.status === "done").length || 0
  const total = task.steps?.length || 0
  return `${task.status}: ${done}/${total} steps, ${state.changes.length} changes, ${state.commands.length} commands`
}

function undo(state) {
  const backup = state.backups.pop()
  if (!backup) return showResult(state, "undo", { result: "nothing to undo" })
  if (!backup.existed) {
    state.registry.run(state, "delete_path", { path: backup.path, confirm: true })
    return showResult(state, "undo", { result: "removed created file", path: backup.path })
  }
  if (backup.content !== null) {
    state.registry.run(state, "write_file", { path: backup.path, content: backup.content })
    return showResult(state, "undo", { result: "restored", path: backup.path })
  }
  return showResult(state, "undo", { result: "cannot restore deleted directory", path: backup.path })
}

function createCheckpoint(state, task) {
  state.checkpoint = {
    id: `${Date.now().toString(36)}-${task.id}`,
    task: task.id,
    changes: state.changes.length,
    commands: state.commands.length,
    backups: state.backups.length,
    createdAt: new Date().toISOString(),
  }
  return state.checkpoint
}

function rollback(state) {
  const checkpoint = state.checkpoint
  if (!checkpoint) return showResult(state, "rollback", { result: "no checkpoint in this session" })
  while (state.backups.length > checkpoint.backups) {
    const backup = state.backups.pop()
    restoreBackup(state, backup)
  }
  state.changes = state.changes.slice(0, checkpoint.changes)
  state.commands = state.commands.slice(0, checkpoint.commands)
  return showResult(state, "rollback", { result: "restored checkpoint", checkpoint: checkpoint.id })
}

function restoreBackup(state, backup) {
  if (!backup) return
  if (!backup.existed) {
    rmSync(backup.path, { recursive: true, force: true })
    return
  }
  if (backup.content !== null) {
    mkdirSync(dirname(backup.path), { recursive: true })
    writeFileSync(backup.path, backup.content)
  }
}

function memoryPath(state) {
  return join(state.root, ".ai", "memory.json")
}

function loadProjectMemory(state) {
  if (state.projectMemory) return state.projectMemory
  try {
    state.projectMemory = existsSync(memoryPath(state)) ? JSON.parse(readFileSync(memoryPath(state), "utf8")) : { notes: [], commands: [], conventions: [] }
  } catch {
    state.projectMemory = { notes: [], commands: [], conventions: [] }
  }
  return state.projectMemory
}

function saveProjectMemory(state) {
  mkdirSync(dirname(memoryPath(state)), { recursive: true })
  writeFileSync(memoryPath(state), `${JSON.stringify(loadProjectMemory(state), null, 2)}\n`)
}

function updateProjectMemory(state, task) {
  const memory = loadProjectMemory(state)
  memory.lastTask = task.objective
  memory.updatedAt = new Date().toISOString()
  for (const command of state.commands.slice(-5)) {
    if (!memory.commands.some((item) => item.command === command.command)) memory.commands.push(command)
  }
  saveProjectMemory(state)
}

function showMemory(state) {
  const memory = loadProjectMemory(state)
  return showResult(state, "memory", memory)
}

function remember(state, note) {
  if (!note) return showMemory(state)
  const memory = loadProjectMemory(state)
  memory.notes.push({ note, at: new Date().toISOString() })
  saveProjectMemory(state)
  return showResult(state, "memory", { remembered: note })
}
