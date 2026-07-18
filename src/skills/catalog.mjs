export const skills = Object.freeze([
  {
    id: "project-map",
    title: "Project Map",
    description: "Inspect files, package metadata, and architecture before coding.",
    commands: ["/files", "/read", "/git-status"],
  },
  {
    id: "plan-first-build",
    title: "Plan First Build",
    description: "Create an implementation plan, wait for accept/revise/reject, then execute.",
    commands: ["/plan-mode", "/approve", "/reject", "/build-mode"],
  },
  {
    id: "safe-edit",
    title: "Safe Edit",
    description: "Checkpoint, edit files, show diff, validate, and allow rollback.",
    commands: ["/changes", "/diff", "/undo", "/rollback"],
  },
  {
    id: "npm-release",
    title: "npm Release",
    description: "Run tests, audit, pack dry-run, and publish the Twillight package.",
    commands: ["npm test", "npm audit", "npm pack --dry-run", "npm publish"],
  },
  {
    id: "mcp-tools",
    title: "MCP Tools",
    description: "Expose Twillight tools to MCP clients through stdio JSON-RPC.",
    commands: ["twillight-mcp", "/mcp"],
  },
  {
    id: "vercel-ai-sdk",
    title: "Vercel AI SDK",
    description: "Add provider-normalized streaming, tool calls, and structured generation to web or Node projects.",
    commands: ["npm i ai", "/ai-sdk"],
  },
  {
    id: "vercel-sandbox",
    title: "Vercel Sandbox",
    description: "Run generated code in an isolated project sandbox for larger autonomous build tasks.",
    commands: ["npm i @vercel/sandbox", "/ai-sdk"],
  },
  {
    id: "vercel-workflows",
    title: "Vercel Workflows",
    description: "Use resumable long-running agent workflows when a task should survive timeouts or retries.",
    commands: ["npm i workflow", "/ai-sdk"],
  },
  {
    id: "ai-elements",
    title: "AI Elements",
    description: "Scaffold reusable AI-native UI components for chat, tool calls, messages, and streaming apps.",
    commands: ["npx ai-elements", "/ai-sdk"],
  },
])

export function skillList() {
  return skills
}

export function getSkill(id) {
  return skills.find((skill) => skill.id === id)
}
