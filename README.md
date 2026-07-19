# Twillight

Twillight is a secure autonomous command-line AI agent for development work. It can chat, inspect a workspace, plan tasks, read and write files, run commands, keep sessions, undo tracked edits, and validate changes.

Made by Adhi.

Creator:

- Discord: `itz.adhi`
- GitHub: `itzadhi`

## Documentation

- [Getting Started](docs/getting-started.md)
- [Commands](docs/commands.md)
- [Configuration](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [MCP Server](docs/mcp.md)
- [npm Publishing](docs/npm-publishing.md)
- [Providers](docs/providers.md)
- [Skills](docs/skills.md)
- [Web Dashboard](docs/web.md)

## Run

```bat
twillight
```

or:

```bat
run.bat
```

One-command task mode:

```bat
twillight "create a folder in V:\ name testpy"
twillight "explain this project"
```

Natural local actions also work in chat:

```text
create a folder name test in desktop
create file notes.txt with hello
list files in desktop
run command node -v
```

## Web Dashboard

Run the local browser control panel from any project folder:

```bat
twillight-web
```

Open `http://127.0.0.1:4177` to configure provider, model, permissions, tools, Cloudflare gateway, and Discord OAuth access. See [Web Dashboard](docs/web.md).

## Provider Setup

Default provider/model:

```text
OpenRouter / cohere/north-mini-code:free
```

Free-friendly providers:

```text
OpenRouter, Cloudflare Workers AI, Groq, Hugging Face, Cerebras, SambaNova, GitHub Models, Ollama
```

Use:

```text
/providers
/providers list
/provider
/provider list
/provider cloudflare
/provider cloudflare https://your-worker-url
/provider cloudflare https://your-worker-url @cf/moonshotai/kimi-k2.7-code
/provider cloudflare ai.itzadhi.in
/gateway https://your-worker-url
/provider groq
/provider ollama
```

Cloudflare Worker gateway:

```bat
set TWILLIGHT_PROVIDER=cloudflare
set TWILLIGHT_CLOUDFLARE_GATEWAY_URL=https://ai.itzadhi.in
set TWILLIGHT_MODEL=@cf/moonshotai/kimi-k2.7-code
twillight
```

Inside Twillight you can do the same without restarting:

```text
/provider cloudflare https://your-worker-url
/model @cf/moonshotai/kimi-k2.7-code
```

If the browser can open your Worker but Twillight says Cloudflare is blocking it with a browser challenge, the Worker route is protected by a WAF/Managed Challenge rule. Use a plain `workers.dev` API route or add a Cloudflare skip rule for the Worker API path.

For a root gateway such as `https://ai.itzadhi.in`, Twillight automatically uses `/v1/chat/completions` for chat and `/models` for the model list.

If your Worker is private and returns `401 Unauthorized`, save the gateway token once:

```text
/key cloudflare
```

Twillight sends that token as `Authorization: Bearer`, `X-Twillight-Gateway-Key`, and `X-API-Key` to your Worker. Environment aliases also work:

```bat
set TWILLIGHT_WORKER_TOKEN=<your_gateway_token>
set TWILLIGHT_CLOUDFLARE_GATEWAY_KEY=<your_gateway_token>
```

If Cloudflare returns a browser challenge page, Twillight now hides the HTML dump and shows a short gateway/WAF fix message instead.

Set your key locally:

```bat
set OPENROUTER_API_KEY=your_key_here
twillight
```

If no key is found, Twillight asks once in interactive mode and saves it to your user config:

```text
%APPDATA%\Twillight\credentials.json
```

Project-local `.ai\credentials.json` is still read for compatibility, but new keys are saved globally so every project can reuse them. The key file should stay private.

Switch provider/model:

```bat
set TWILLIGHT_PROVIDER=openai
set OPENAI_API_KEY=your_key_here
set TWILLIGHT_MODEL=gpt-4o-mini
twillight
```

## npm Package

Twillight is prepared as an npm CLI package named `twillight`. npm package names are lowercase, while the brand and GitHub repository use `Twillight`.

Local install/test:

```bat
npm install
npm test
npm pack --dry-run
npm link
twillight
```

Publish when logged in to npm:

```bat
npm publish --access public
```

After publish, install and run from any project folder:

```bat
npm install -g twillight
cd C:\path\to\project
twillight
```

On Windows, open a new terminal after global install so `%APPDATA%\npm` refreshes in PATH. The package also installs the `twilight` alias, and `/doctor` diagnoses the detected npm global path from inside Twillight.

The folder you launch `twillight` from becomes the active workspace sandbox. Sessions, tasks, memory, and logs are stored under that project’s `.ai` folder.

## Commands

```text
/help
/ui
/plan
/files
/read README.md
/write notes.txt -- hello
/append notes.txt -- more
/mkdir V:\testpy
/rm V:\testpy
/run npm test
/cmd
/do 3
/update
/update-install
/diff
/models
/provider cloudflare https://your-worker-url
/gateway https://your-worker-url
/use 2
/plan-mode
/build-mode
/read-only
/workspace
/standard
/full-access
/image C:\path\image.png -- describe this image
/changes
/undo
/status
/config
/permissions
/permission read-only
/permission workspace
/permission standard
/permission full-access
/model cohere/north-mini-code:free
/providers
/skills
/pet
/pet sprite
/ai-sdk
/ai-elements
/vercel-sandbox
/vercel-workflows
/doctor
/clear
/exit
```

The top of the terminal shows quick-access button labels such as:

```text
[/models] [/use 1] [/plan-mode] [/build-mode] [/read-only] [/full-access]
[/files] [/read] [/write] [/run] [/image] [/status] [/changes] [/undo]
```

Type the label shown inside brackets to activate it. Model calls show a `Twillight thinking...` animation while waiting.

`/pet` shows the single Twillight companion, its trait, and what it is helping with. Old dragon spellings are kept only as compatibility aliases and route back to `/pet`. `/doctor` reports companion state plus npm/PATH health.

Vercel AI commands are first-class slash commands and appear in the command dropdown:

```text
/ai-sdk             overview and core `npm i ai`
/ai-elements        `npx ai-elements`
/vercel-sandbox     `npm i @vercel/sandbox`
/vercel-workflows   `npm i workflow`
```

These are project skills, not default Twillight dependencies, so the CLI stays fast and light.

## OpenTUI On Node 20

Twillight installs `@opentui/core` with npm and uses its OpenTUI component concepts for the terminal controls. On Node 20, Twillight runs `opentui-node20`, a virtual OpenTUI-compatible renderer with buttons, command dropdowns, and diff panels.

```text
/ui    show the active OpenTUI mode
/cmd   open the command dropdown
/do 3  run a dropdown command
/update check npm and prompt to install the latest global release
/diff  show tracked file-change diffs
/env   show OpenTUI environment variables and current values
/components show every virtual OpenTUI component Twillight implements
```

Native OpenTUI rendering requires newer Node experimental FFI, so Twillight does not try to start that renderer on Node 20. This keeps `run.bat` working with your current Node version.

Twillight reads the OpenTUI environment variables documented by OpenTUI, including `OTUI_SHOW_STATS`, `OTUI_USE_ALTERNATE_SCREEN`, `OPENTUI_NOTIFICATIONS`, `OPENTUI_FORCE_UNICODE`, `OPENTUI_FORCE_WCWIDTH`, `OPENTUI_GRAPHICS`, and the FFI/debug flags. In Node 20 mode these configure Twillight's virtual renderer and status panels.

## Permissions

Modes:

```text
read-only   inspect only
workspace   edit files inside the workspace
standard    workspace edits plus normal development commands
full-access broader system actions, still blocked for dangerous commands unless explicit
```

Dangerous commands such as force pushes, disk formatting, registry edits, and hard resets are blocked outside `full-access`.

## Project Layout

```text
src/cli        terminal UI and command handling
src/agent      planning, routing, validation, summaries
src/tools      filesystem, search, shell, git tools
src/providers  OpenRouter/OpenAI-compatible provider
src/security   permissions, path policy, command policy, secret redaction
src/config     defaults and config loading
src/storage    local sessions
tests          lightweight runtime tests
```

## Validate

```bat
npm test
```

Logs are written to `.ai\logs\twillight-*.log`. Sessions are stored in `.ai\sessions`.
