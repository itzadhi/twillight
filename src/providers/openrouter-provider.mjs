import { getApiKeys, maskKey } from "../config/credentials.mjs"
import { normalizeProviderName, providerInfo } from "./catalog.mjs"

export function createProvider(config, root, ui) {
  const provider = normalizeProviderName(config.provider) || "openrouter"
  const info = providerInfo(provider)
  let cachedApiKeys = []
  async function apiKeys() {
    if (cachedApiKeys.length) return cachedApiKeys
    cachedApiKeys = await getApiKeys(root, provider, ui)
    return cachedApiKeys
  }
  const endpoint = provider === "cloudflare"
    ? cloudflareEndpoints(config, info)
    : { chat: info.chat, models: info.models }
  return {
    provider,
    model: config.model,
    async models() {
      if (provider === "cloudflare") return withKeys(await apiKeys(), (key) => cloudflareModels(endpoint.models, config, info, key))
      return withKeys(await apiKeys(), async (key) => {
        const response = await fetch(endpoint.models, {
          headers: { Accept: "application/json", ...authHeaders(provider, key), ...providerHeaders(provider) },
          signal: AbortSignal.timeout(Number(config.requestTimeoutMs || 120000)),
        })
        const data = await readProviderJson(response, key, { provider, endpoint: endpoint.models })
        return normalizeModels(provider, data)
      })
    },
    async chat(messages, callbacks = {}) {
      if (provider === "cloudflare") return withKeys(await apiKeys(), (key) => cloudflareChat(endpoint.chat, config, messages, key))
      return withKeys(await apiKeys(), async (key) => {
        const body = {
          model: config.model,
          messages,
          temperature: config.temperature,
          stream: config.streaming,
          max_tokens: Number(config.maxTokens || 2048),
          ...(config.streaming ? { stream_options: { include_usage: true } } : {}),
        }
        const response = await fetch(endpoint.chat, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...authHeaders(provider, key),
            ...providerHeaders(provider),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Number(config.requestTimeoutMs || 120000)),
        })
        if (!response.ok) throw await providerHttpError(response, key, { provider, endpoint: endpoint.chat, model: config.model })
        if (config.streaming) {
          const streamed = await stream(response, callbacks)
          if (streamed.content) return streamed
          ui.debug?.(`empty streaming response provider=${provider} model=${config.model} finish=${streamed.debug.finishReason || "unknown"} chunks=${streamed.debug.chunks} keys=${streamed.debug.keys.join(",") || "none"}`)
          return retryWithoutStreaming(endpoint.chat, key, provider, config, { ...body, stream: false, stream_options: undefined }, streamed.debug)
        }
        const data = await readProviderJson(response, key, { provider, endpoint: endpoint.chat, model: config.model })
        const jsonError = providerJsonError(data, { provider, model: config.model })
        if (jsonError) throw jsonError
        return responseFromJson(data, { source: "json" })
      })
    },
  }
}

function cloudflareEndpoints(config, info) {
  const base = config.cloudflareGatewayUrl || process.env.TWILLIGHT_CLOUDFLARE_GATEWAY_URL || info.chat
  return {
    chat: cloudflareEndpoint(base, "chat"),
    models: cloudflareEndpoint(base, "models"),
  }
}

export function cloudflareEndpoint(base, kind) {
  const raw = String(base || "").trim().replace(/\/+$/, "")
  if (!raw) return raw
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/, "")
    if (kind === "chat" && /\/(?:v1\/chat\/completions|chat)$/i.test(path)) return raw
    if (kind === "models" && /\/(?:v1\/models|models)$/i.test(path)) return raw
    if (kind === "chat" && /\/(?:v1\/models|models)$/i.test(path)) return raw.replace(/\/(?:v1\/models|models)$/i, "/v1/chat/completions")
    if (kind === "models" && /\/(?:v1\/chat\/completions|chat)$/i.test(path)) return raw.replace(/\/(?:v1\/chat\/completions|chat)$/i, "/models")
    return `${raw}/${kind === "chat" ? "v1/chat/completions" : "models"}`
  } catch {
    return raw
  }
}

async function cloudflareModels(url, config, info, key = "") {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", ...authHeaders("cloudflare", key), ...providerHeaders("cloudflare") },
      signal: AbortSignal.timeout(Number(config.requestTimeoutMs || 120000)),
    })
    const data = await readProviderJson(response, key, { provider: "cloudflare", endpoint: url })
    const models = normalizeModels("cloudflare", data)
    return models.length ? models : fallbackModelRows(info, "catalog")
  } catch (error) {
    if (error.providerBlocked || error.nonJsonProvider) return fallbackModelRows(info, error.providerBlocked ? "gateway blocked" : "metadata unavailable")
    if ([401, 403].includes(Number(error.status || 0))) return fallbackModelRows(info, "gateway unauthorized")
    throw error
  }
}

function fallbackModelRows(info, context) {
  return (info.fallbackModels || []).map((id) => ({ id, context }))
}

async function cloudflareChat(url, config, messages, key = "") {
  const body = {
    model: config.model,
    messages,
    temperature: config.temperature,
    max_tokens: Number(config.maxTokens || 2048),
    maxTokens: Number(config.maxTokens || 2048),
    stream: false,
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...authHeaders("cloudflare", key), ...providerHeaders("cloudflare") },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(config.requestTimeoutMs || 120000)),
  })
  const data = await readProviderJson(response, key, { provider: "cloudflare", endpoint: url, model: config.model })
  const jsonError = providerJsonError(data, { provider: "cloudflare", model: config.model })
  if (jsonError) throw jsonError
  return responseFromJson(data, { source: "cloudflare-worker" })
}

async function retryWithoutStreaming(url, key, provider, config, body, previousDebug) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(provider, key),
      ...providerHeaders(provider),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(config.requestTimeoutMs || 120000)),
  })
  const data = await readProviderJson(response, key, { provider, endpoint: url, model: config.model })
  const jsonError = providerJsonError(data, { provider, model: config.model })
  if (jsonError) throw jsonError
  const result = responseFromJson(data, { source: "retry-json", previous: previousDebug })
  result.debug = { ...result.debug, retryAfterEmptyStream: true }
  return result
}

async function withKeys(keys, request) {
  let lastError
  for (const key of keys) {
    try {
      return await request(key)
    } catch (error) {
      lastError = error
      if (!isRetryableKeyError(error)) throw error
    }
  }
  throw lastError
}

function authHeaders(provider, key) {
  if (providerInfo(provider).noAuth) {
    if (provider === "cloudflare" && key) return { Authorization: `Bearer ${key}`, "X-Twillight-Gateway-Key": key, "X-API-Key": key }
    return {}
  }
  return key ? { Authorization: `Bearer ${key}` } : {}
}

function providerHeaders(provider) {
  if (provider === "openrouter") return { "HTTP-Referer": "http://localhost", "X-Title": "Twillight" }
  if (provider === "github") return { "api-version": "2024-05-01-preview" }
  return {}
}

function isRetryableKeyError(error) {
  return [401, 402, 403, 429].includes(Number(error?.status || 0))
}

function normalizeModels(provider, data) {
  if (provider === "cloudflare") {
    return (data.models || data.data || []).map((model) => ({
      id: typeof model === "string" ? model : model.id,
      context: typeof model === "string" ? "" : model.context || model.context_length || model.contextLength || "",
    })).filter((model) => model.id)
  }
  const models = data.data || []
  if (provider === "openrouter") {
    return models
      .filter((model) => model.id?.endsWith(":free") || model.pricing?.prompt === "0" && model.pricing?.completion === "0")
      .map((model) => ({
        id: model.id,
        context: model.context_length || model.contextLength || "",
      }))
  }
  return models.map((model) => ({
    id: model.id,
    context: model.context_length || model.contextLength || "",
  }))
}

async function readProviderJson(response, key, context = {}) {
  const text = await response.text()
  if (!response.ok) throw providerHttpErrorFromText(response, text, key, context)
  try {
    return JSON.parse(text)
  } catch {
    throw providerNonJsonError(response, text, context)
  }
}

export async function providerHttpError(response, key, context = {}) {
  const text = await response.text()
  return providerHttpErrorFromText(response, text, key, context)
}

function providerHttpErrorFromText(response, text, key, context = {}) {
  const provider = normalizeProviderName(context.provider) || "openrouter"
  const info = providerInfo(provider)
  const status = Number(response.status || 0)
  let message = providerErrorFromText(response, text, context)
  if (provider === "cloudflare" && [401, 403].includes(status) && !isCloudflareChallengeText(text)) {
    message = `${message}. ${key ? "The saved Cloudflare gateway token was rejected." : "This Cloudflare gateway requires a token."} Use /key cloudflare to save it, or make the Worker route public.`
  } else if (!info.noAuth && [401, 403].includes(status)) {
    const keyHint = provider === "groq" ? " Groq keys usually start with gsk_." : ""
    message = `${message}. ${info.title} rejected the saved API key.${keyHint} Use /key ${provider} to replace it, or /key-add ${provider} to add another key.`
  }
  const error = new Error(`${message}${key ? ` [key ${maskKey(key)}]` : ""}`)
  error.status = response.status
  error.retryModels = isRetryableProviderFailure(response.status, message)
  if ((provider === "cloudflare" || !info.noAuth) && [401, 403].includes(status)) {
    error.nonRetryable = true
    error.retryModels = false
    error.authFailed = true
  }
  if (isCloudflareChallengeText(text)) {
    error.providerBlocked = true
    error.nonRetryable = true
    error.retryModels = false
  }
  return error
}

function providerNonJsonError(response, text, context = {}) {
  const challenge = isCloudflareChallengeText(text)
  const provider = normalizeProviderName(context.provider) || "openrouter"
  const label = providerInfo(provider).title
  const error = new Error(challenge
    ? cloudflareChallengeMessage(response, context)
    : `${response.status || 200} ${response.statusText || "OK"}: ${label} returned non-JSON from ${context.endpoint || "provider endpoint"}.`)
  error.status = response.status || 200
  error.nonJsonProvider = true
  error.providerBlocked = challenge
  error.nonRetryable = challenge
  error.retryModels = false
  return error
}

function providerErrorFromText(response, text, context = {}) {
  if (isCloudflareChallengeText(text)) return cloudflareChallengeMessage(response, context)
  try {
    const data = JSON.parse(text)
    return `${response.status} ${response.statusText}: ${extractProviderErrorMessage(data) || text}`
  } catch {
    return `${response.status} ${response.statusText}: ${text.slice(0, 1000)}`
  }
}

function cloudflareChallengeMessage(response, context = {}) {
  const endpoint = context.endpoint || "the Cloudflare Worker gateway"
  return [
    `${response.status} ${response.statusText}: Cloudflare is blocking Twillight with a browser challenge at ${endpoint}.`,
    "The CLI cannot solve the JavaScript challenge, so this is a gateway/WAF config issue, not a model issue.",
    "Fix: disable Managed Challenge/Bot Fight for this Worker API route, or use an unchallenged workers.dev/API URL with `/provider cloudflare <url>`.",
  ].join(" ")
}

export function isCloudflareChallengeText(text) {
  return /<title>\s*Just a moment|cf_chl_|challenge-platform|Enable JavaScript and cookies/i.test(String(text || ""))
}

function providerJsonError(data, context = {}) {
  const message = extractProviderErrorMessage(data)
  if (!message) return null
  const provider = normalizeProviderName(context.provider) || "openrouter"
  const error = new Error(`${providerInfo(provider).title} error: ${message}`)
  error.status = Number(data.status || data.statusCode || data.code || 0)
  error.retryModels = isRetryableProviderFailure(error.status, message)
  return error
}

function extractProviderErrorMessage(data) {
  if (!data || typeof data !== "object") return ""
  if (data.ok === false || data.success === false || data.error || data.errors?.length) {
    return normalizeProviderContent(data.error?.message)
      || normalizeProviderContent(data.error)
      || normalizeProviderContent(data.message)
      || normalizeProviderContent(data.errors)
      || normalizeProviderContent(data.messages)
      || "provider returned an error"
  }
  return ""
}

function isRetryableProviderFailure(status, message) {
  const code = Number(status || 0)
  if ([408, 409, 410, 422, 423, 424, 429, 500, 502, 503, 504].includes(code)) return true
  return /\b(model|route|capacity|overloaded|temporar|timeout|timed out|rate|too many|deprecated|deprecat|unavailable|unsupported|not found)\b/i.test(String(message || ""))
}

async function stream(response, callbacks) {
  const decoder = new TextDecoder()
  let buffer = ""
  let content = ""
  let usage = {}
  const debug = { source: "stream", chunks: 0, finishReason: "", keys: [] }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue
      let data
      try {
        data = JSON.parse(payload)
      } catch {
        continue
      }
      debug.chunks += 1
      debug.keys = mergeKeys(debug.keys, Object.keys(data))
      const choice = data.choices?.[0]
      if (choice?.finish_reason) debug.finishReason = choice.finish_reason
      const delta = normalizeProviderContent(choice?.delta?.content)
        || normalizeProviderContent(choice?.delta?.reasoning_content)
        || normalizeProviderContent(choice?.delta?.reasoning)
        || normalizeProviderContent(choice?.message?.content)
        || normalizeProviderContent(choice?.message?.reasoning_content)
        || normalizeProviderContent(choice?.message?.reasoning)
        || normalizeProviderContent(choice?.text)
      if (delta) {
        content += delta
        callbacks.onToken?.(delta)
      }
      if (data.usage) usage = data.usage
    }
  }
  return { content: content.trim(), usage, debug }
}

export function responseFromJson(data, debug = {}) {
  const choice = data.choices?.[0] || {}
  const direct =
    normalizeProviderContent(data)
    || normalizeProviderContent(data.response)
    || normalizeProviderContent(data.content)
    || normalizeProviderContent(data.message)
    || normalizeProviderContent(data.output)
    || normalizeProviderContent(data.output_text)
    || normalizeProviderContent(data.result)
    || normalizeProviderContent(data.result?.response)
    || normalizeProviderContent(data.result?.content)
    || normalizeProviderContent(data.result?.message)
    || normalizeProviderContent(data.tasks?.at?.(-1)?.response)
    || normalizeProviderContent(data.tasks?.at?.(-1)?.result)
  return {
    content:
      direct
      || normalizeProviderContent(choice.message?.content)
      || normalizeProviderContent(choice.message?.reasoning_content)
      || normalizeProviderContent(choice.message?.reasoning)
      || normalizeProviderContent(choice.text)
      || "",
    usage: data.usage || {},
    debug: {
      ...debug,
      finishReason: choice.finish_reason || choice.finishReason || "",
      dataKeys: Object.keys(data || {}),
      choiceKeys: Object.keys(choice),
      messageKeys: choice.message ? Object.keys(choice.message) : [],
    },
  }
}

export function normalizeProviderContent(value) {
  if (typeof value === "string") return value.trim()
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return normalizeProviderContent(value.response)
      || normalizeProviderContent(value.content)
      || normalizeProviderContent(value.text)
      || normalizeProviderContent(value.output)
      || normalizeProviderContent(value.output_text)
      || normalizeProviderContent(value.message)
      || normalizeProviderContent(value.result)
  }
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => {
      if (typeof item === "string") return item
      if (typeof item?.text === "string") return item.text
      if (typeof item?.content === "string") return item.content
      if (typeof item?.response === "string") return item.response
      if (typeof item?.output_text === "string") return item.output_text
      if (typeof item?.message === "string") return item.message
      if (typeof item?.message?.content === "string") return item.message.content
      return normalizeProviderContent(item)
    })
    .join("")
    .trim()
}

function mergeKeys(current, next) {
  const set = new Set(current)
  for (const key of next) set.add(key)
  return [...set]
}
