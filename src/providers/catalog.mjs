export const providerCatalog = Object.freeze({
  openrouter: {
    title: "OpenRouter",
    aliases: ["openrouter", "router", "or"],
    keyEnv: "OPENROUTER_API_KEY",
    keysEnv: "OPENROUTER_API_KEYS",
    defaultModel: "cohere/north-mini-code:free",
    fallbackModels: [
      "cohere/north-mini-code:free",
      "qwen/qwen3-coder:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemma-4-26b-a4b-it:free",
      "openai/gpt-oss-20b:free",
    ],
    freeFriendly: true,
    noCardNote: "Free models are available with an API key; billing setup is not required for many free routes.",
    chat: "https://openrouter.ai/api/v1/chat/completions",
    models: "https://openrouter.ai/api/v1/models",
  },
  cloudflare: {
    title: "Cloudflare Workers AI",
    aliases: ["cloudflare", "workers", "workers-ai", "worker", "cf", "cf-ai", "gateway"],
    keyEnv: "TWILLIGHT_CLOUDFLARE_GATEWAY_KEY",
    keysEnv: "TWILLIGHT_CLOUDFLARE_GATEWAY_KEYS",
    defaultModel: "@cf/moonshotai/kimi-k2.7-code",
    fallbackModels: [
      "@cf/moonshotai/kimi-k2.7-code",
      "@cf/zai/glm-4.7-flash",
      "@cf/openai/gpt-oss-20b",
      "@cf/meta/llama-3.1-8b-instruct-fast",
    ],
    freeFriendly: true,
    noCardNote: "Uses your own Cloudflare Worker AI gateway. No client API key is required when the Worker is public; private gateways can use TWILLIGHT_CLOUDFLARE_GATEWAY_KEY.",
    chat: "https://ai.itzadhi.in",
    models: "https://ai.itzadhi.in",
    noAuth: true,
  },
  groq: {
    title: "Groq",
    aliases: ["groq"],
    keyEnv: "GROQ_API_KEY",
    keysEnv: "GROQ_API_KEYS",
    defaultModel: "llama-3.1-8b-instant",
    fallbackModels: ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"],
    freeFriendly: true,
    noCardNote: "Free developer tier with API key.",
    chat: "https://api.groq.com/openai/v1/chat/completions",
    models: "https://api.groq.com/openai/v1/models",
  },
  huggingface: {
    title: "Hugging Face",
    aliases: ["huggingface", "hf"],
    keyEnv: "HUGGINGFACE_API_KEY",
    keysEnv: "HUGGINGFACE_API_KEYS",
    defaultModel: "openai/gpt-oss-20b",
    fallbackModels: ["openai/gpt-oss-20b", "meta-llama/Llama-3.1-8B-Instruct"],
    freeFriendly: true,
    noCardNote: "Hugging Face token-based access; free serverless/router usage depends on model availability.",
    chat: "https://router.huggingface.co/v1/chat/completions",
    models: "https://router.huggingface.co/v1/models",
  },
  cerebras: {
    title: "Cerebras",
    aliases: ["cerebras", "cs"],
    keyEnv: "CEREBRAS_API_KEY",
    keysEnv: "CEREBRAS_API_KEYS",
    defaultModel: "llama3.1-8b",
    fallbackModels: ["llama3.1-8b"],
    freeFriendly: true,
    noCardNote: "API-key access with free developer quota when available.",
    chat: "https://api.cerebras.ai/v1/chat/completions",
    models: "https://api.cerebras.ai/v1/models",
  },
  sambanova: {
    title: "SambaNova",
    aliases: ["sambanova", "samba", "sn"],
    keyEnv: "SAMBANOVA_API_KEY",
    keysEnv: "SAMBANOVA_API_KEYS",
    defaultModel: "Meta-Llama-3.1-8B-Instruct",
    fallbackModels: ["Meta-Llama-3.1-8B-Instruct"],
    freeFriendly: true,
    noCardNote: "API-key access with free developer quota when available.",
    chat: "https://api.sambanova.ai/v1/chat/completions",
    models: "https://api.sambanova.ai/v1/models",
  },
  github: {
    title: "GitHub Models",
    aliases: ["github", "github-models", "gh"],
    keyEnv: "GITHUB_TOKEN",
    keysEnv: "GITHUB_TOKENS",
    defaultModel: "openai/gpt-4.1-mini",
    fallbackModels: ["openai/gpt-4.1-mini"],
    freeFriendly: true,
    noCardNote: "Uses a GitHub token; free model access depends on GitHub account limits.",
    chat: "https://models.github.ai/inference/chat/completions",
    models: "https://models.github.ai/inference/models",
  },
  ollama: {
    title: "Ollama",
    aliases: ["ollama", "local"],
    keyEnv: "",
    keysEnv: "",
    defaultModel: "llama3.2",
    fallbackModels: ["llama3.2"],
    freeFriendly: true,
    noCardNote: "Local provider. No API key, no card. Requires Ollama running locally.",
    chat: "http://localhost:11434/v1/chat/completions",
    models: "http://localhost:11434/v1/models",
    noAuth: true,
  },
  openai: {
    title: "OpenAI",
    aliases: ["openai", "oa"],
    keyEnv: "OPENAI_API_KEY",
    keysEnv: "OPENAI_API_KEYS",
    defaultModel: "gpt-4o-mini",
    fallbackModels: ["gpt-4o-mini"],
    freeFriendly: false,
    noCardNote: "Paid/provider-billing model. Included for compatibility.",
    chat: "https://api.openai.com/v1/chat/completions",
    models: "https://api.openai.com/v1/models",
  },
})

export function providerNames() {
  return Object.keys(providerCatalog)
}

export function providerInfo(provider) {
  return providerCatalog[normalizeProviderName(provider)] || providerCatalog.openrouter
}

export function normalizeProviderName(value) {
  const text = String(value || "").trim().toLowerCase()
  for (const [name, info] of Object.entries(providerCatalog)) {
    if (name === text || info.aliases.includes(text)) return name
  }
  return ""
}
