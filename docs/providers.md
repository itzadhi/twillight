# Providers

Twillight supports OpenAI-compatible providers and keeps provider metadata centralized.

## Free-Friendly Providers

These are useful when you want API-key-only access or local usage without a credit/debit card flow where available:

```text
openrouter
cloudflare
groq
huggingface
cerebras
sambanova
github
ollama
```

Cloudflare uses your deployed Workers AI gateway. Ollama is fully local and does not need a key.

## Cloudflare Workers AI Gateway

Default gateway:

```text
https://ai.itzadhi.in
```

Use it:

```text
/provider cloudflare
/provider cloudflare https://your-worker-url
/gateway https://your-worker-url
/models
/model @cf/moonshotai/kimi-k2.7-code
```

For a different Worker URL:

```cmd
set TWILLIGHT_PROVIDER=cloudflare
set TWILLIGHT_CLOUDFLARE_GATEWAY_URL=https://your-worker.example.workers.dev
set TWILLIGHT_MODEL=@cf/moonshotai/kimi-k2.7-code
twillight
```

When you set a root gateway URL, Twillight automatically calls `/v1/chat/completions` for chat and `/models` for model listing. You can also pass either exact endpoint and Twillight will derive the other one.

The Worker route must be API-accessible. If Cloudflare returns a browser challenge page, add a WAF skip rule for the Worker route or disable managed challenges for that hostname/path.

Important: a browser can pass Cloudflare's JavaScript challenge, but Twillight is a Node CLI and cannot. If Twillight reports a Cloudflare browser challenge, the model is not the problem. Fix the route protection or point Twillight to an unchallenged Worker URL:

```text
/gateway https://your-worker-name.your-subdomain.workers.dev
```

Private gateways are supported too. If your Worker intentionally requires a shared token, save it once:

```text
/key cloudflare
```

or set:

```cmd
set TWILLIGHT_WORKER_TOKEN=your_gateway_token
set TWILLIGHT_CLOUDFLARE_GATEWAY_KEY=your_gateway_token
```

Both names are treated as the same Cloudflare gateway token. Twillight redacts them in logs and sends the token as `Authorization: Bearer`, `X-Twillight-Gateway-Key`, and `X-API-Key`.

## Paid/Compatibility Provider

```text
openai
```

## Commands

```text
/providers
/providers list
/provider
/provider list
/provider openrouter
/provider cloudflare
/provider cloudflare https://your-worker-url @cf/moonshotai/kimi-k2.7-code
/provider cloudflare ai.itzadhi.in
/provider groq
/provider huggingface
/provider cerebras
/provider sambanova
/provider github
/provider ollama
/provider openai
/gateway https://your-worker-url
/models
/use 1
/key groq
/key-add openrouter
```

## Environment Variables

```text
OPENROUTER_API_KEY / OPENROUTER_API_KEYS
GROQ_API_KEY / GROQ_API_KEYS
HUGGINGFACE_API_KEY / HUGGINGFACE_API_KEYS
CEREBRAS_API_KEY / CEREBRAS_API_KEYS
SAMBANOVA_API_KEY / SAMBANOVA_API_KEYS
GITHUB_TOKEN / GITHUB_TOKENS
OPENAI_API_KEY / OPENAI_API_KEYS
TWILLIGHT_CLOUDFLARE_GATEWAY_URL
TWILLIGHT_WORKER_TOKEN
TWILLIGHT_CLOUDFLARE_GATEWAY_KEY / TWILLIGHT_CLOUDFLARE_GATEWAY_KEYS
```

Multiple keys can be separated by commas, semicolons, or new lines.
