import { dirname, join, win32 as pathWin32 } from "node:path"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { modes } from "../security/permissions.mjs"
import { isInsidePath, normalizePath } from "../security/path-policy.mjs"

export const workflowStates = Object.freeze({
  IDLE: "idle",
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting_approval",
  EXECUTING: "executing",
  VERIFYING: "verifying",
  COMPLETED: "completed",
  FAILED: "failed",
  REJECTED: "rejected",
})

export function createTaskStore(root) {
  const dir = join(root, ".ai", "tasks")
  mkdirSync(dir, { recursive: true })
  return {
    dir,
    create(task) {
      const record = {
        id: randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: task.status || workflowStates.PLANNING,
        objective: task.objective,
        risk: task.risk || "low",
        permissionMode: task.permissionMode,
        steps: task.steps || [],
        results: [],
        timeline: task.timeline || [],
        checkpointId: task.checkpointId || "",
        summary: task.summary || "",
        error: "",
      }
      this.save(record)
      return record
    },
    save(task) {
      mkdirSync(dir, { recursive: true })
      task.updatedAt = new Date().toISOString()
      writeFileSync(join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`)
      writeFileSync(join(dir, "latest"), task.id)
      return task
    },
    list() {
      if (!existsSync(dir)) return []
      return readDirJson(dir)
    },
    load(id = "latest") {
      const actual = id === "latest" && existsSync(join(dir, "latest")) ? readFileSync(join(dir, "latest"), "utf8").trim() : id
      return JSON.parse(readFileSync(join(dir, `${actual}.json`), "utf8"))
    },
  }
}

export function planLocalWorkflow(state, input) {
  const steps = parseLocalSteps(state, input)
  if (!steps.length) return null
  const risk = maxRisk(steps.map((step) => classifyRisk(state, step)))
  return {
    objective: input.trim(),
    risk,
    permissionMode: state.config.permissionMode,
    steps: steps.map((step, index) => ({ id: String(index + 1), status: "pending", ...step, risk: classifyRisk(state, step) })),
  }
}

export function parseLocalSteps(state, input) {
  const text = stripCasualPrefix(input.trim())
  const combined = parseFolderAndPythonFileRequest(state, text)
  if (combined.length) return combined
  const directPythonFile = parsePythonFileRequest(state, text)
  if (directPythonFile) return [directPythonFile]
  const step = parseLocalStep(state, text)
  return step ? [step] : []
}

export function needsApproval(state, workflow) {
  if (state.config.agentMode === "plan") return true
  if (state.config.permissionMode === "full-access") return false
  if (workflow.risk === "high") return true
  if (workflow.steps.some((step) => step.tool === "delete_path")) return true
  if (workflow.steps.some((step) => isOutsideWorkspace(state, step))) return true
  return false
}

export function parseLocalStep(state, input) {
  const text = stripCasualPrefix(input.trim())
  const folder = parseFolderRequest(state, text)
  if (folder) return { tool: "make_directory", label: `Create directory ${folder}`, input: { path: folder } }

  const move = parseMoveOrCopyRequest(text, "move")
  if (move) return { tool: "move_path", label: `Move ${move.from} to ${move.to}`, input: move }

  const copy = parseMoveOrCopyRequest(text, "copy")
  if (copy) return { tool: "copy_path", label: `Copy ${copy.from} to ${copy.to}`, input: copy }

  const write = text.match(/\b(?:create|write)\s+(?:a\s+)?(?:file\s+)?(?:at\s+|to\s+|named\s+)?(.+?)\s+(?:with|content|containing)\s+(.+)/i)
  if (write) return { tool: "write_file", label: `Write file ${write[1].trim()}`, input: { path: write[1].trim(), content: write[2].trim() } }

  const defaultCodeWrite = parseDefaultCodeFileRequest(text)
  if (defaultCodeWrite) return defaultCodeWrite

  const codeWrite = parseGenericCodeFileRequest(text)
  if (codeWrite) return codeWrite

  const read = text.match(/\b(?:read|show|open)\s+(?:file\s+)?(.+\.[a-z0-9]+)\b/i)
  if (read) return { tool: "read_file", label: `Read file ${read[1].trim()}`, input: { path: read[1].trim() } }

  const list = text.match(/\b(?:list|show)\s+(?:files|folders|directory)\s*(?:in|at)?\s*(.*)$/i)
  if (list) return { tool: "list_directory", label: "List directory", input: { path: list[1].trim() || state.cwd } }

  const run = text.match(/\b(?:run|execute)\s+(?:command\s+)?(.+)/i)
  if (run) return { tool: "run_command", label: `Run command ${run[1].trim()}`, input: { command: run[1].trim() } }

  const remove = text.match(/\b(?:delete|remove)\s+(?:file|folder|directory|path)?\s*(.+)/i)
  if (remove) return { tool: "delete_path", label: `Delete ${remove[1].trim()}`, input: { path: remove[1].trim(), confirm: true } }

  return null
}

function parseMoveOrCopyRequest(text, action) {
  const verb = action === "move" ? "(?:move|rename)" : "(?:copy|duplicate)"
  const match = text.match(new RegExp(`\\b${verb}\\s+(.+?)\\s+(?:file\\s+)?(?:to|into|inside|under)\\s+(.+)$`, "i"))
  if (!match) return null
  const from = cleanPathFragment(match[1])
  const destination = cleanDestination(match[2])
  if (!from || !destination) return null
  const to = looksLikeDirectoryDestination(destination) ? pathWin32.join(destination, pathWin32.basename(from)) : destination
  return { from, to }
}

function cleanPathFragment(value) {
  return String(value || "").trim().replace(/\s+file$/i, "").replace(/^["'`]+|["'`]+$/g, "")
}

function cleanDestination(value) {
  return cleanPathFragment(value).replace(/\s+(?:folder|directory)$/i, "")
}

function looksLikeDirectoryDestination(value) {
  return !/\.[a-z0-9]{1,12}$/i.test(pathWin32.basename(value))
}

function stripCasualPrefix(text) {
  return text.replace(/^\s*(?:hi|hello|hey|yo|bro|twillight)[,\s]+/i, "").trim()
}

function parsePythonFileRequest(state, text) {
  const match = text.match(/\b(?:create|make|write|add)\s+(?:a\s+)?(?:python\s+)?file\s+(?:name|named|called)?\s*([A-Za-z0-9_. -]+\.py)\b/i)
  if (!match) return null
  const fileName = match[1].trim()
  const content = pythonContentFromPrompt(text)
  return { tool: "write_file", label: `Write ${fileName}`, input: { path: fileName, content } }
}

function parseFolderAndPythonFileRequest(state, text) {
  const folder = parseFolderRequest(state, text)
  if (!folder) return []
  const fileMatch = text.match(/\b(?:into|in|under|inside|as)\s+(?:one\s+)?([A-Za-z0-9_. -]+\.py)\b/i)
  if (!fileMatch && !/\bpython\s+file\b/i.test(text)) return []
  const fileName = fileMatch?.[1]?.trim() || "basis.py"
  const target = pathWin32.join(folder, fileName)
  const content = pythonContentFromPrompt(text)
  return [
    { tool: "make_directory", label: `Create directory ${folder}`, input: { path: folder } },
    { tool: "write_file", label: `Write ${target}`, input: { path: target, content } },
  ]
}

function parseGenericCodeFileRequest(text) {
  const match = text.match(/\b(?:create|make|write|add)\s+(?:a\s+)?(?:(python|javascript|typescript|html|css|json|markdown|text)\s+)?(?:code\s+)?(?:file|script|module)\s+(?:name|named|called)?\s*([A-Za-z0-9_. -]+\.[A-Za-z0-9]{1,12})\b/i)
  if (!match) return null
  const fileName = cleanPathFragment(match[2])
  if (!fileName) return null
  const content = contentFromFilePrompt(fileName, text)
  return { tool: "write_file", label: `Write ${fileName}`, input: { path: fileName, content } }
}

function parseDefaultCodeFileRequest(text) {
  if (!/\b(?:create|make|write|add)\b/i.test(text) || !/\b(?:file|page)\b/i.test(text)) return null
  if (/\bhtml\b/i.test(text)) {
    const fileName = /\bhello\s+world\b/i.test(text) ? "hello.html" : "index.html"
    return { tool: "write_file", label: `Write ${fileName}`, input: { path: fileName, content: contentFromFilePrompt(fileName, text) } }
  }
  if (/\bcss\b/i.test(text)) {
    return { tool: "write_file", label: "Write style.css", input: { path: "style.css", content: contentFromFilePrompt("style.css", text) } }
  }
  if (/\b(?:javascript|js)\b/i.test(text)) {
    return { tool: "write_file", label: "Write script.js", input: { path: "script.js", content: contentFromFilePrompt("script.js", text) } }
  }
  return null
}

function contentFromFilePrompt(fileName, text) {
  if (/\.py$/i.test(fileName)) return pythonContentFromPrompt(text)
  if (/\.js$/i.test(fileName)) return `// Generated by Twillight\n// Request: ${text}\n\nfunction main() {\n  console.log("Twillight file ready")\n}\n\nmain()\n`
  if (/\.ts$/i.test(fileName)) return `// Generated by Twillight\n// Request: ${text}\n\nexport function main(): string {\n  return "Twillight file ready"\n}\n`
  if (/\.html?$/i.test(fileName)) {
    const title = /\bhello\s+world\b/i.test(text) ? "Hello World" : "Twillight"
    const body = /\bhello\s+world\b/i.test(text) ? "Hello World" : "Twillight file ready"
    return `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${title}</title>\n</head>\n<body>\n  <main>\n    <h1>${body}</h1>\n  </main>\n</body>\n</html>\n`
  }
  if (/\.css$/i.test(fileName)) return `/* Generated by Twillight */\n:root {\n  color-scheme: dark;\n}\n`
  if (/\.json$/i.test(fileName)) return "{\n  \"generatedBy\": \"Twillight\"\n}\n"
  if (/\.md$/i.test(fileName)) return `# Twillight\n\nGenerated from: ${text}\n`
  return `Generated by Twillight\nRequest: ${text}\n`
}

function pythonContentFromPrompt(text) {
  const lower = text.toLowerCase()
  if (lower.includes("filehandling") || lower.includes("file handling") || /\bfile\b.*\boperation/.test(lower) || /\bevery\w*\s+operation/.test(lower)) {
    return [
      '"""Class 12 CBSE Python file handling practice functions."""',
      "",
      "from pathlib import Path",
      "",
      "",
      "def write_text_file(path, text):",
      "    Path(path).write_text(text, encoding='utf-8')",
      "",
      "",
      "def read_text_file(path):",
      "    return Path(path).read_text(encoding='utf-8')",
      "",
      "",
      "def append_text_file(path, text):",
      "    with open(path, 'a', encoding='utf-8') as file:",
      "        file.write(text)",
      "",
      "",
      "def count_lines(path):",
      "    with open(path, 'r', encoding='utf-8') as file:",
      "        return sum(1 for _ in file)",
      "",
      "",
      "def count_words(path):",
      "    return len(read_text_file(path).split())",
      "",
      "",
      "def copy_file(source, destination):",
      "    Path(destination).write_text(read_text_file(source), encoding='utf-8')",
      "",
      "",
      "def read_binary_file(path):",
      "    return Path(path).read_bytes()",
      "",
      "",
      "def write_binary_file(path, data):",
      "    Path(path).write_bytes(data)",
      "",
      "",
      "if __name__ == '__main__':",
      "    sample = 'sample.txt'",
      "    write_text_file(sample, 'Hello CBSE Python\\nFile handling is useful.\\n')",
      "    append_text_file(sample, 'Practice makes it easier.\\n')",
      "    print(read_text_file(sample))",
      "    print('Lines:', count_lines(sample))",
      "    print('Words:', count_words(sample))",
      "",
    ].join("\n")
  }
  return `# Generated by Twillight\n# Request: ${text}\n\n`
}

function classifyRisk(state, step) {
  if (step.tool === "read_file" || step.tool === "list_directory") return "low"
  if (step.tool === "delete_path" || step.tool === "run_command") return "high"
  if (isOutsideWorkspace(state, step)) return "medium"
  return "low"
}

function maxRisk(risks) {
  if (risks.includes("high")) return "high"
  if (risks.includes("medium")) return "medium"
  return "low"
}

function isOutsideWorkspace(state, step) {
  const value = step.input?.path || step.input?.from || step.input?.to
  if (!value) return false
  try {
    const target = normalizePath(state, value)
    return !isInsidePath(state.root, target)
  } catch {
    return true
  }
}

function parseFolderRequest(state, text) {
  const inThenName = text.match(/\b(?:create|make|add|new)\s+(?:a\s+)?(?:folder|directory)\s+(?:in|inside|at|on)\s+(.+?)\s+(?:name|named|called)\s+([^\s"'`]+)\b/i)
  if (inThenName) return joinLocation(state, inThenName[1], inThenName[2])
  const nameThenIn = text.match(/\b(?:create|make|add|new)\s+(?:a\s+)?(?:folder|directory)\s+(?:name|named|called)?\s*([^\s"'`]+)\s+(?:in|inside|at|on)\s+(.+?)\s*$/i)
  if (nameThenIn) return joinLocation(state, nameThenIn[2], nameThenIn[1])
  const simpleName = text.match(/\b(?:create|make|add|new)\s+(?:a\s+)?(?:folder|directory)\s+(?:name|named|called)\s+([^\s"'`]+)\b/i)
  if (simpleName) return simpleName[1]
  return ""
}

function joinLocation(state, location, name) {
  return pathWin32.join(resolveLocation(state, location), name.trim())
}

function resolveLocation(state, value) {
  const key = value.trim().toLowerCase()
  const home = process.env.USERPROFILE || process.env.HOME || dirname(state.root)
  if (["desktop", "the desktop", "my desktop"].includes(key)) return pathWin32.join(home, "Desktop")
  if (["home", "user", "profile", "user profile"].includes(key)) return home
  if (["documents", "my documents"].includes(key)) return pathWin32.join(home, "Documents")
  if (["downloads", "my downloads"].includes(key)) return pathWin32.join(home, "Downloads")
  return value.trim()
}

function readDirJson(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function permissionRank(mode) {
  return modes.indexOf(mode)
}
