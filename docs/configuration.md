# Configuration

Configuration is layered in this order:

1. Built-in defaults
2. Project `.ai\config.yaml`
3. Environment variables
4. CLI flags

Later layers override earlier layers.

## Project Config

Create `.ai\config.yaml` in a project:

```yaml
provider: openrouter
model: cohere/north-mini-code:free
permissionMode: standard
agentMode: build
streaming: true
maxTokens: 2048
requestTimeoutMs: 120000
```

## Environment Variables

```text
TWILLIGHT_PROVIDER
TWILLIGHT_MODEL
TWILLIGHT_STREAM
TWILLIGHT_ACTIONS
TWILLIGHT_STATUS
TWILLIGHT_COMPACT
TWILLIGHT_WORKSPACE
TWILLIGHT_PERMISSION
TWILLIGHT_COMMAND_ALLOWLIST
TWILLIGHT_ENABLED_TOOLS
TWILLIGHT_DEV
TWILLIGHT_CREATOR
TWILLIGHT_UNCENSORED_MODEL
TWILLIGHT_FALLBACK_MODELS
TWILLIGHT_CLOUDFLARE_GATEWAY_URL
TWILLIGHT_WORKER_TOKEN
TWILLIGHT_CLOUDFLARE_GATEWAY_KEY
TWILLIGHT_CLOUDFLARE_GATEWAY_KEYS
TWILLIGHT_UPDATE_CHECK
TWILLIGHT_AUTO_UPDATE
TWILLIGHT_UPDATE_INTERVAL_HOURS
TWILLIGHT_UPDATE_REGISTRY_URL
TWILLIGHT_MAX_TOKENS
TWILLIGHT_REQUEST_TIMEOUT_MS
TWILLIGHT_QUEUE_DELAY_MS
```

## API Keys

Supported providers:

```text
OPENROUTER_API_KEY
OPENROUTER_API_KEYS
GROQ_API_KEY
GROQ_API_KEYS
HUGGINGFACE_API_KEY
HUGGINGFACE_API_KEYS
CEREBRAS_API_KEY
CEREBRAS_API_KEYS
SAMBANOVA_API_KEY
SAMBANOVA_API_KEYS
GITHUB_TOKEN
GITHUB_TOKENS
OPENAI_API_KEY
OPENAI_API_KEYS
TWILLIGHT_CLOUDFLARE_GATEWAY_KEY
TWILLIGHT_CLOUDFLARE_GATEWAY_KEYS
TWILLIGHT_WORKER_TOKEN
```

Multiple keys can be separated by commas, semicolons, or new lines.

Ollama is local and does not need an API key.

Cloudflare Workers AI uses `TWILLIGHT_CLOUDFLARE_GATEWAY_URL` and does not require a client key when your Worker gateway is public. If your Worker is private, use `/key cloudflare`, `TWILLIGHT_CLOUDFLARE_GATEWAY_KEY`, or the shorter `TWILLIGHT_WORKER_TOKEN` alias.

You can also set it inside Twillight and save it to the project:

```text
/provider cloudflare https://your-worker-url
/gateway https://your-worker-url
```

If the gateway domain has a Cloudflare browser challenge, Twillight will show that directly. Disable the challenge for the Worker API route or use an unchallenged `workers.dev` URL.

## Developer Identity

Twillight detects the `itzadhi/Twillight` repository and creator flags for diagnostics, release checks, and local contributor context. The terminal companion is intentionally a single built-in pet so every install behaves the same.

```cmd
set TWILLIGHT_CREATOR=itzadhi
```

or:

```cmd
set TWILLIGHT_DEV=1
```

Run `/doctor` to see the detected developer identity reason, current companion, npm global path, and command shim health.

## Defaults

Default provider:

```text
openrouter
```

Default model:

```text
cohere/north-mini-code:free
```

Fallback models are tried when a model returns empty content or retryable provider errors.

## Updates

Twillight checks npm for newer releases during interactive startup. If a newer release exists, it shows a confirm/skip modal and installs with:

```text
npm install -g twillight@latest
```

Use `/update` to force a check, or `/update-install` to check and install. Set `TWILLIGHT_UPDATE_CHECK=0` to disable startup checks, or `TWILLIGHT_AUTO_UPDATE=1` to install automatically after detection.
