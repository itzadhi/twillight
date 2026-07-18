# Skills

Twillight includes a small built-in skills registry.

Show skills:

```text
/skills
```

Current skills:

```text
project-map
plan-first-build
safe-edit
npm-release
mcp-tools
vercel-ai-sdk
vercel-sandbox
vercel-workflows
ai-elements
```

Skills are not separate plugins yet. They are built-in workflow profiles that describe what Twillight should do and which commands/tools are involved.

## Plan First

Large build requests trigger an implementation plan first. You can:

```text
accept
reject
```

or send a revised instruction.

Small actions such as creating folders, moving files, and reading files still execute directly.

## Pets

Pets are lightweight session companions. They are visual, but they also expose a useful state line in the sidebar and explain what they are helping with.

Show the active companion, traits, and state:

```text
/pet
```

Switch back to the default companion:

```text
/pet sprite
```

Twillight keeps one companion for every install. Old dragon spellings are compatibility aliases that route back to `/pet`.

## Vercel AI Skills

Show optional Vercel integrations:

```text
/ai-sdk
```

Twillight lists the project-level commands without installing them into the CLI by default:

```text
npm i ai
npm i @vercel/sandbox
npm i workflow
npx ai-elements
```
