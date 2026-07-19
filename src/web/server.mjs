#!/usr/bin/env node
import { createServer } from "node:http"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { loadConfig } from "../config/loader.mjs"
import { defaults } from "../config/defaults.mjs"
import { normalizeProviderName, providerInfo, providerNames } from "../providers/catalog.mjs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const publicDir = join(__dirname, "public")
const SESSION_COOKIE = "tw_session"
const STATE_COOKIE = "tw_oauth_state"
const MAX_BODY_BYTES = 64 * 1024
const CONFIG_KEYS = [
  "provider",
  "model",
  "permissionMode",
  "agentMode",
  "enabledTools",
  "cloudflareGatewayUrl",
  "updateCheck",
  "autoUpdate",
  "pet",
]

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

export function createWebServer(options = {}) {
  const env = options.env || process.env
  const cwd = options.cwd || process.cwd()
  const sessionSecret = env.TWILLIGHT_WEB_SESSION_SECRET || randomBytes(32).toString("hex")
  return createServer((request, response) => {
    handleRequest(request, response, { cwd, env, sessionSecret }).catch((error) => {
      sendJson(response, 500, { ok: false, error: "web_server_error", message: error.message })
    })
  })
}

export function discordAuthEnabled(env = process.env) {
  return Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && discordRedirectUri(env))
}

export function discordRedirectUri(env = process.env) {
  return env.DISCORD_REDIRECT_URI || env.TWILLIGHT_WEB_DISCORD_REDIRECT_URI || ""
}

export function createDiscordAuthUrl(env = process.env, state = randomBytes(16).toString("hex")) {
  const redirectUri = discordRedirectUri(env)
  if (!env.DISCORD_CLIENT_ID || !redirectUri) return ""
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify email",
    state,
    prompt: "consent",
  })
  return `https://discord.com/oauth2/authorize?${params}`
}

export function publicConfig(config = loadConfig([])) {
  const provider = normalizeProviderName(config.provider) || defaults.provider
  const info = providerInfo(provider)
  return {
    provider,
    providerTitle: info.title,
    model: String(config.model || info.defaultModel),
    permissionMode: String(config.permissionMode || defaults.permissionMode),
    agentMode: String(config.agentMode || defaults.agentMode),
    enabledTools: String(config.enabledTools || defaults.enabledTools),
    cloudflareGatewayUrl: String(config.cloudflareGatewayUrl || defaults.cloudflareGatewayUrl),
    updateCheck: Boolean(config.updateCheck),
    autoUpdate: Boolean(config.autoUpdate),
    pet: String(config.pet || defaults.pet),
  }
}

export function providerOptions() {
  return providerNames().map((name) => {
    const info = providerInfo(name)
    return {
      name,
      title: info.title,
      defaultModel: info.defaultModel,
      fallbackModels: info.fallbackModels,
      freeFriendly: Boolean(info.freeFriendly),
      noAuth: Boolean(info.noAuth),
      keyEnv: info.keyEnv || "",
      note: info.noCardNote || "",
    }
  })
}

async function handleRequest(request, response, context) {
  setBaseHeaders(response)
  if (request.method === "OPTIONS") {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`)
  if (url.pathname === "/health") return sendJson(response, 200, { ok: true, name: "Twillight Web" })
  if (url.pathname === "/api/status") return sendJson(response, 200, await statusPayload(request, context))
  if (url.pathname === "/api/config" && request.method === "GET") return sendJson(response, 200, { ok: true, config: publicConfig(loadConfig([])) })
  if (url.pathname === "/api/config" && request.method === "POST") return updateConfig(request, response, context)
  if (url.pathname === "/auth/discord") return beginDiscordAuth(request, response, context)
  if (url.pathname === "/auth/discord/callback") return completeDiscordAuth(url, request, response, context)
  if (url.pathname === "/auth/logout") return logout(response)
  return serveStatic(url.pathname, response)
}

async function statusPayload(request, context) {
  const session = readSession(request, context)
  const authEnabled = discordAuthEnabled(context.env)
  const config = publicConfig(loadConfig([]))
  return {
    ok: true,
    name: "Twillight Web",
    cwd: context.cwd,
    platform: process.platform,
    node: process.version,
    auth: {
      enabled: authEnabled,
      loggedIn: Boolean(session),
      user: session?.user || null,
      discordLoginUrl: authEnabled ? "/auth/discord" : "",
      requiredEnv: authEnabled ? [] : ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI"],
    },
    config,
    providers: providerOptions(),
    commands: ["twillight", "twillight-web", "npm run web"],
  }
}

async function updateConfig(request, response, context) {
  const authorized = isLocalRequest(request) || readSession(request, context)
  if (!authorized) return sendJson(response, 401, { ok: false, error: "auth_required" })
  const body = await readJsonBody(request)
  const next = validateConfigInput(body)
  await writeProjectConfig(context.cwd, next)
  return sendJson(response, 200, { ok: true, config: publicConfig(loadConfig([])), saved: join(context.cwd, ".ai", "config.yaml") })
}

function validateConfigInput(body) {
  const result = {}
  const provider = normalizeProviderName(body.provider)
  if (provider) {
    result.provider = provider
    if (!body.model) result.model = providerInfo(provider).defaultModel
  }
  if (body.model !== undefined) {
    const model = String(body.model).trim()
    if (!model || model.length > 160 || /[\r\n]/.test(model)) throw new Error("Invalid model")
    result.model = model
  }
  if (body.permissionMode !== undefined) {
    const value = String(body.permissionMode)
    if (!["read-only", "workspace", "standard", "full-access"].includes(value)) throw new Error("Invalid permission mode")
    result.permissionMode = value
  }
  if (body.agentMode !== undefined) {
    const value = String(body.agentMode)
    if (!["plan", "build"].includes(value)) throw new Error("Invalid agent mode")
    result.agentMode = value
  }
  if (body.enabledTools !== undefined) {
    const value = String(body.enabledTools).trim()
    if (!value || value.length > 400 || /[\r\n]/.test(value)) throw new Error("Invalid tools value")
    result.enabledTools = value
  }
  if (body.cloudflareGatewayUrl !== undefined) {
    const value = String(body.cloudflareGatewayUrl).trim()
    if (value && !/^https?:\/\/[^\s]+$/i.test(value)) throw new Error("Gateway URL must start with http:// or https://")
    result.cloudflareGatewayUrl = value
  }
  if (body.updateCheck !== undefined) result.updateCheck = Boolean(body.updateCheck)
  if (body.autoUpdate !== undefined) result.autoUpdate = Boolean(body.autoUpdate)
  if (body.pet !== undefined) {
    const value = String(body.pet).trim().toLowerCase()
    if (!["sprite", "none"].includes(value)) throw new Error("Invalid pet")
    result.pet = value
  }
  return result
}

async function writeProjectConfig(cwd, updates) {
  const dir = join(cwd, ".ai")
  const file = join(dir, "config.yaml")
  await mkdir(dir, { recursive: true })
  const current = existsSync(file) ? await readFile(file, "utf8") : ""
  const parsed = parseSimpleYaml(current)
  const merged = { ...parsed, ...updates }
  const lines = [
    "# Twillight project config. Secrets stay in the key vault or environment.",
    ...CONFIG_KEYS.filter((key) => merged[key] !== undefined && merged[key] !== "").map((key) => `${key}: ${yamlValue(merged[key])}`),
    "",
  ]
  await writeFile(file, lines.join("\n"), "utf8")
}

function parseSimpleYaml(text) {
  const entries = []
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes(":")) continue
    const index = trimmed.indexOf(":")
    entries.push([trimmed.slice(0, index).trim(), trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "")])
  }
  return Object.fromEntries(entries)
}

function yamlValue(value) {
  if (typeof value === "boolean") return value ? "true" : "false"
  const text = String(value)
  if (/^[A-Za-z0-9_./:@-]+$/.test(text)) return text
  return JSON.stringify(text)
}

async function beginDiscordAuth(request, response, context) {
  if (!discordAuthEnabled(context.env)) {
    return sendJson(response, 400, { ok: false, error: "discord_not_configured", requiredEnv: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI"] })
  }
  const state = randomBytes(24).toString("hex")
  response.setHeader("Set-Cookie", cookie(STATE_COOKIE, signValue(state, context.sessionSecret), { maxAge: 600 }))
  response.writeHead(302, { Location: createDiscordAuthUrl(context.env, state) })
  response.end()
}

async function completeDiscordAuth(url, request, response, context) {
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  const signedState = parseCookies(request.headers.cookie || "")[STATE_COOKIE]
  if (!code || !state || !verifySignedValue(signedState, state, context.sessionSecret)) {
    return sendJson(response, 400, { ok: false, error: "invalid_oauth_state" })
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: context.env.DISCORD_CLIENT_ID,
      client_secret: context.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: discordRedirectUri(context.env),
    }),
  })
  if (!tokenResponse.ok) return sendJson(response, 502, { ok: false, error: "discord_token_failed" })
  const token = await tokenResponse.json()
  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
  })
  if (!userResponse.ok) return sendJson(response, 502, { ok: false, error: "discord_user_failed" })
  const user = await userResponse.json()
  const session = signValue(JSON.stringify({ user: publicDiscordUser(user), at: Date.now() }), context.sessionSecret)
  response.setHeader("Set-Cookie", [
    cookie(SESSION_COOKIE, session, { maxAge: 60 * 60 * 24 * 14 }),
    cookie(STATE_COOKIE, "", { maxAge: 0 }),
  ])
  response.writeHead(302, { Location: "/" })
  response.end()
}

function publicDiscordUser(user) {
  return {
    id: String(user.id || ""),
    username: String(user.username || ""),
    globalName: String(user.global_name || user.username || ""),
    avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : "",
  }
}

function readSession(request, context) {
  const signed = parseCookies(request.headers.cookie || "")[SESSION_COOKIE]
  const value = unsignValue(signed, context.sessionSecret)
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    if (Date.now() - Number(parsed.at || 0) > 60 * 60 * 24 * 14 * 1000) return null
    return parsed
  } catch {
    return null
  }
}

function logout(response) {
  response.writeHead(302, { Location: "/", "Set-Cookie": cookie(SESSION_COOKIE, "", { maxAge: 0 }) })
  response.end()
}

async function serveStatic(pathname, response) {
  const target = pathname === "/" ? "index.html" : pathname.slice(1)
  const safeTarget = target.split("/").map((part) => basename(part)).join(sep)
  const file = resolve(publicDir, safeTarget)
  if (!file.startsWith(resolve(publicDir) + sep) && file !== join(publicDir, "index.html")) {
    return sendJson(response, 404, { ok: false, error: "not_found" })
  }
  try {
    const data = await readFile(file)
    response.writeHead(200, { "content-type": mimeTypes[extname(file)] || "application/octet-stream" })
    response.end(data)
  } catch {
    sendJson(response, 404, { ok: false, error: "not_found" })
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function setBaseHeaders(response) {
  response.setHeader("x-content-type-options", "nosniff")
  response.setHeader("referrer-policy", "no-referrer")
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  response.end(JSON.stringify(body))
}

function parseCookies(header) {
  return Object.fromEntries(
    String(header || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=")
        return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))]
      }),
  )
}

function cookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"]
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Number(options.maxAge)}`)
  return parts.join("; ")
}

function signValue(value, secret) {
  const signature = createHmac("sha256", secret).update(value).digest("base64url")
  return `${Buffer.from(value).toString("base64url")}.${signature}`
}

function unsignValue(signed, secret) {
  if (!signed || !signed.includes(".")) return ""
  const [encoded, signature] = signed.split(".")
  const value = Buffer.from(encoded, "base64url").toString("utf8")
  return verifySignature(value, signature, secret) ? value : ""
}

function verifySignedValue(signed, expected, secret) {
  return unsignValue(signed, secret) === expected
}

function verifySignature(value, signature, secret) {
  const expected = createHmac("sha256", secret).update(value).digest("base64url")
  const left = Buffer.from(signature || "")
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isLocalRequest(request) {
  const host = String(request.headers.host || "").split(":")[0]
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
}

function main() {
  const port = Number(process.env.TWILLIGHT_WEB_PORT || process.env.PORT || 4177)
  const host = process.env.TWILLIGHT_WEB_HOST || "127.0.0.1"
  const server = createWebServer()
  server.listen(port, host, () => {
    console.log(`[Twillight Web] http://${host}:${port}`)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
