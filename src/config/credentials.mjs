import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import readline from "node:readline/promises"
import { Writable } from "node:stream"
import { providerInfo, providerNames } from "../providers/catalog.mjs"
import { bg, clean, clipVisible, rgb, theme } from "../utils/terminal.mjs"

export function credentialPath(root) {
  return join(userConfigDir(), "credentials.json")
}

export function projectCredentialPath(root) {
  return join(root, ".ai", "credentials.json")
}

export function readCredentials(root) {
  const file = credentialPath(root)
  const projectFile = projectCredentialPath(root)
  const projectCredentials = normalizeCredentials(readCredentialFile(projectFile))
  const userCredentials = normalizeCredentials(readCredentialFile(file))
  return { ...projectCredentials, ...userCredentials }
}

export function writeCredentials(root, credentials) {
  const file = credentialPath(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(normalizeCredentials(credentials), null, 2)}\n`)
}

function readCredentialFile(file) {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return {}
  }
}

function userConfigDir() {
  if (process.env.TWILLIGHT_CONFIG_DIR) return process.env.TWILLIGHT_CONFIG_DIR
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Twillight")
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "twillight")
}

export async function getApiKey(root, provider, ui) {
  const keys = await getApiKeys(root, provider, ui)
  return keys[0]
}

export async function getApiKeys(root, provider, ui) {
  const envName = apiKeyEnvName(provider)
  const fromEnv = readEnvKeys(provider)
  if (fromEnv.length) return fromEnv
  const credentials = readCredentials(root)
  const saved = savedKeys(credentials, provider)
  if (saved.length) return saved
  if (!envName || providerInfo(provider).noAuth) return [""]
  if (!process.stdin.isTTY) throw new Error(`${envName} is missing. Run twillight interactively once to save it.`)
  const value = await promptSecret(`${envName}: `, { ui, provider })
  if (!value) throw new Error(`${envName} was not provided.`)
  saveApiKey(root, provider, value)
  ui.dim(`[Twillight] saved ${envName} to ${credentialPath(root)}`)
  return [value]
}

export function apiKeyEnvName(provider) {
  return providerInfo(provider).keyEnv
}

export function apiKeysEnvName(provider) {
  return providerInfo(provider).keysEnv
}

export function saveApiKey(root, provider, value, options = {}) {
  const envName = apiKeyEnvName(provider)
  if (!envName) throw new Error(`${provider} does not need an API key.`)
  const key = String(value || "").trim()
  if (!isUsableKey(key)) throw new Error(`${envName} was not provided.`)
  const current = readCredentials(root)
  const existing = options.append ? savedKeys(current, provider) : []
  const keys = uniqueKeys([...existing, key])
  writeCredentials(root, { ...current, [envName]: keys[0], [apiKeysEnvName(provider)]: keys })
}

export function hasSavedApiKey(root, provider) {
  if (providerInfo(provider).noAuth) return true
  return Boolean(readEnvKeys(provider).length || savedKeys(readCredentials(root), provider).length)
}

export function savedApiKeyCount(root, provider) {
  return uniqueKeys([...readEnvKeys(provider), ...savedKeys(readCredentials(root), provider)]).length
}

export function maskKey(value) {
  const key = String(value || "").trim()
  if (!key) return "none"
  if (key.length <= 10) return `${key.slice(0, 2)}...${key.slice(-2)}`
  return `${key.slice(0, 7)}...${key.slice(-4)}`
}

function readEnvKeys(provider) {
  const values = []
  for (const name of [apiKeysEnvName(provider), ...credentialAliases(apiKeyEnvName(provider))].filter(Boolean)) {
    const value = process.env[name]
    values.push(...splitKeys(value))
  }
  return uniqueKeys(values)
}

function savedKeys(credentials, provider) {
  const values = []
  const listEnv = apiKeysEnvName(provider)
  if (listEnv) values.push(...splitKeys(credentials[listEnv]))
  for (const name of credentialAliases(apiKeyEnvName(provider)).filter(Boolean)) values.push(...splitKeys(credentials[name]))
  return uniqueKeys(values)
}

function normalizeCredentials(credentials) {
  const result = { ...credentials }
  for (const provider of providerNames()) {
    const canonical = apiKeyEnvName(provider)
    if (!canonical) continue
    const keys = savedKeys(credentials, provider)
    if (keys.length) {
      result[canonical] = keys[0]
      result[apiKeysEnvName(provider)] = keys
    }
    for (const alias of credentialAliases(canonical)) {
      if (alias !== canonical) delete result[alias]
    }
  }
  return result
}

function credentialAliases(canonical) {
  if (canonical === "TWILLIGHT_CLOUDFLARE_GATEWAY_KEY") return [
    "TWILLIGHT_CLOUDFLARE_GATEWAY_KEY",
    "TWILLIGHT_CLOUDFLARE_KEY",
    "TWILLIGHT_WORKER_TOKEN",
    "CLOUDFLARE_GATEWAY_KEY",
    "CLOUDFLARE_WORKER_TOKEN",
    "cloudflareGatewayKey",
  ]
  if (canonical === "OPENAI_API_KEY") return ["OPENAI_API_KEY", "OPENAI_KEY", "openaiApiKey", "openai_api_key"]
  if (canonical === "GROQ_API_KEY") return ["GROQ_API_KEY", "GROQ_KEY", "GROQ_TOKEN", "GROQ_API_TOKEN", "groqApiKey", "groq_api_key"]
  if (canonical === "HUGGINGFACE_API_KEY") return ["HUGGINGFACE_API_KEY", "HF_TOKEN", "HF_API_KEY", "HUGGINGFACE_TOKEN", "huggingfaceApiKey"]
  if (canonical === "CEREBRAS_API_KEY") return ["CEREBRAS_API_KEY", "CEREBRAS_KEY", "CEREBRAS_TOKEN", "cerebrasApiKey"]
  if (canonical === "SAMBANOVA_API_KEY") return ["SAMBANOVA_API_KEY", "SAMBANOVA_KEY", "SAMBANOVA_TOKEN", "sambanovaApiKey"]
  if (canonical === "GITHUB_TOKEN") return ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_MODELS_TOKEN", "githubToken"]
  return ["OPENROUTER_API_KEY", "OPENROUTER_KEY", "OPENROUTER_TOKEN", "OPENROUTER_API_TOKEN", "openrouterApiKey", "openrouter_api_key"]
}

function isUsableKey(value) {
  const key = String(value || "").trim()
  return Boolean(key && key !== "your_new_key_here" && !/^<[^>]+>$/.test(key))
}

function splitKeys(value) {
  if (Array.isArray(value)) return value.flatMap(splitKeys)
  return String(value || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(isUsableKey)
}

function uniqueKeys(keys) {
  return [...new Set(keys.map((key) => String(key || "").trim()).filter(isUsableKey))]
}

export async function promptSecret(prompt, options = {}) {
  if (options.ui && process.stdin.isTTY && process.stdout.isTTY) return promptSecretTui(prompt, options)
  const output = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString()
      if (text.includes(prompt)) process.stdout.write(prompt)
      callback()
    },
  })
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
  const answer = await rl.question(prompt).then((value) => value.trim())
  rl.close()
  process.stdout.write("\n")
  return answer
}

export function secretInputFromChunk(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "")
  const cleaned = text
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  return cleaned.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
}

async function promptSecretTui(prompt, options = {}) {
  const provider = options.provider || ""
  let value = ""
  function paint() {
    const rows = secretPromptRows({ prompt, provider, value })
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
    for (const row of rows) process.stdout.write(`${row}\n`)
  }
  const wasRaw = process.stdin.isRaw
  if (process.stdin.setRawMode) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdout.write("\x1b[?2004h")
  paint()
  return new Promise((resolve, reject) => {
    function cleanup() {
      process.stdin.off("data", onData)
      process.stdout.off?.("resize", onResize)
      process.stdout.write("\x1b[?2004l")
      if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRaw))
    }
    function finish() {
      cleanup()
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
      resolve(value.trim())
    }
    function onResize() {
      paint()
    }
    function onData(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "")
      if (text === "\u0003") {
        cleanup()
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
        reject(new Error("Key entry cancelled."))
        return
      }
      if (text === "\u001b") {
        cleanup()
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H")
        reject(new Error("Key entry cancelled."))
        return
      }
      if (text === "\u007f" || text === "\b" || text === "\x1b[3~") {
        value = value.slice(0, -1)
        paint()
        return
      }
      const lineBreak = text.search(/[\r\n]/)
      const inputChunk = lineBreak >= 0 ? text.slice(0, lineBreak) : text
      const pasted = secretInputFromChunk(inputChunk)
      if (pasted) value += pasted
      if (lineBreak >= 0) return finish()
      if (!pasted) return
      paint()
    }
    process.stdin.on("data", onData)
    process.stdout.on?.("resize", onResize)
  })
}

function secretPromptRows({ prompt, provider, value }) {
  const termWidth = Math.max(60, Number(process.stdout.columns || 100))
  const termHeight = Math.max(18, Number(process.stdout.rows || 30))
  const width = Math.max(56, Math.min(termWidth - 8, 92))
  const inner = width - 2
  const body = width - 4
  const envName = clean(prompt).replace(/:\s*$/, "")
  const info = providerInfo(provider)
  const providerTitle = info.title || provider || "Provider"
  const masked = secretMask(value, Math.max(20, body - envName.length - 13))
  const rows = [
    center(rgb(theme.accent, "Twillight Key Vault"), termWidth),
    center(rgb(theme.muted, "save once, use everywhere"), termWidth),
    "",
    center(rgb(theme.line, `╭${" key setup ".padEnd(inner, "─")}╮`), termWidth),
    center(secretRow(`${rgb(theme.text, providerTitle)} ${rgb(theme.border, "·")} ${rgb(theme.muted, provider || "provider")}`, inner), termWidth),
    center(secretRow(rgb(theme.muted, "Your key is masked locally and written to the Twillight vault."), inner), termWidth),
    center(secretRow("", inner), termWidth),
    center(secretRow(fieldLine(envName, masked, body, Boolean(value)), inner), termWidth),
    center(secretRow(statusLine(value, body), inner), termWidth),
    center(secretRow("", inner), termWidth),
    center(secretRow(`${rgb(theme.thought, "Enter")} ${rgb(theme.muted, "save")}   ${rgb(theme.thought, "Paste")} ${rgb(theme.muted, "works")}   ${rgb(theme.thought, "Backspace")} ${rgb(theme.muted, "edit")}   ${rgb(theme.thought, "Esc/Ctrl+C")} ${rgb(theme.muted, "cancel")}`, inner), termWidth),
    center(rgb(theme.line, `╰${"─".repeat(inner)}╯`), termWidth),
  ]
  const top = Math.max(1, Math.floor((termHeight - rows.length) / 2))
  return [...Array.from({ length: top }, () => ""), ...rows]
}

function secretRow(value, width) {
  const clipped = clipVisible(value, width)
  return `${rgb(theme.line, "│")}${clipped}${" ".repeat(Math.max(0, width - clean(clipped).length))}${rgb(theme.line, "│")}`
}

function fieldLine(label, value, width, active) {
  const labelText = `${label} `
  const available = Math.max(10, width - labelText.length - 2)
  const clipped = clipVisible(value, available)
  const fill = " ".repeat(Math.max(0, available - clean(clipped).length))
  return `${rgb(theme.muted, labelText)}${bg(theme.input, ` ${rgb(active ? theme.text : theme.muted, clipped)}${fill} `)}`
}

function statusLine(value, width) {
  const status = value
    ? `${rgb(theme.good, "ready")} ${rgb(theme.muted, `${value.length} chars captured`)}`
    : `${rgb(theme.muted, "waiting for paste or typing")}`
  return clipVisible(status, width)
}

function secretMask(value, max) {
  if (!value) return "paste or type key"
  const visible = Math.max(6, Math.min(max - 9, value.length))
  return `${"*".repeat(visible)} ${value.length} chars`
}

function center(value, width) {
  const plain = clean(value)
  return `${" ".repeat(Math.max(0, Math.floor((width - plain.length) / 2)))}${value}`
}
