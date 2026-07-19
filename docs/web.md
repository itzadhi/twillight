# Twillight Web

Twillight Web is the browser control panel for the same local Twillight workspace. It is intentionally small and Node-only, so it can run anywhere the CLI runs.

## Start

```bat
twillight-web
```

or from the repository:

```bat
npm run web
```

Open:

```text
http://127.0.0.1:4177
```

Set a custom port:

```bat
set TWILLIGHT_WEB_PORT=4180
twillight-web
```

## Discord Auth

The web app supports Discord OAuth. Create a Discord application, add a redirect URL, then start Twillight Web with:

```bat
set DISCORD_CLIENT_ID=your_client_id
set DISCORD_CLIENT_SECRET=your_client_secret
set DISCORD_REDIRECT_URI=http://127.0.0.1:4177/auth/discord/callback
set TWILLIGHT_WEB_SESSION_SECRET=use_a_long_random_secret
twillight-web
```

When Discord auth is configured, browser config writes require a signed Discord session. Local loopback requests are allowed for first-time setup.

## Config

The website edits the same project file as the CLI:

```text
.ai/config.yaml
```

It can configure:

- provider
- model
- Cloudflare gateway URL
- agent mode
- permission profile
- enabled tools
- update checks

Secrets are not displayed or saved by the website. Keep API keys in the Twillight key vault or environment variables.

## Security

- API responses are `no-store`.
- Discord sessions are signed HttpOnly cookies.
- Static file serving blocks path traversal.
- POST bodies are limited.
- The web app never returns API keys or worker tokens.
