const state = {
  providers: [],
  config: {},
}

const $ = (selector) => document.querySelector(selector)

async function loadStatus() {
  const response = await fetch("/api/status")
  const data = await response.json()
  if (!data.ok) throw new Error(data.message || "Unable to load status")
  state.providers = data.providers
  state.config = data.config
  renderStatus(data)
  renderProviderSelect()
  fillForm(data.config)
  renderProviderDetail()
}

function renderStatus(data) {
  $("#auth-pill").textContent = data.auth.loggedIn
    ? `Discord: ${data.auth.user.globalName || data.auth.user.username}`
    : data.auth.enabled
      ? "Discord ready"
      : "Local setup mode"
  $("#strip-provider").textContent = data.config.providerTitle
  $("#strip-model").textContent = data.config.model
  $("#strip-cwd").textContent = data.cwd
  $("#auth-card").innerHTML = data.auth.loggedIn
    ? `<strong>${escapeHtml(data.auth.user.globalName || data.auth.user.username)}</strong><span class="ok">Authenticated with Discord</span><a class="button-link" href="/auth/logout">Logout</a>`
    : data.auth.enabled
      ? `<span class="warn">Discord OAuth is configured.</span><span>Login to manage this workspace from the browser.</span>`
      : `<span class="warn">Discord OAuth is not configured yet.</span><span>Set the environment variables below, then restart <code>twillight-web</code>.</span>`
}

function renderProviderSelect() {
  const select = $("#provider-select")
  select.innerHTML = state.providers.map((provider) => {
    const selected = provider.name === state.config.provider ? "selected" : ""
    return `<option value="${provider.name}" ${selected}>${escapeHtml(provider.title)}</option>`
  }).join("")
}

function fillForm(config) {
  $("#provider-select").value = config.provider
  $("#model-input").value = config.model
  $("#gateway-input").value = config.cloudflareGatewayUrl
  $("#tools-input").value = config.enabledTools
  setRadio("agentMode", config.agentMode)
  setRadio("permissionMode", config.permissionMode)
  document.querySelector("[name='updateCheck']").checked = Boolean(config.updateCheck)
  document.querySelector("[name='autoUpdate']").checked = Boolean(config.autoUpdate)
}

function renderProviderDetail() {
  const provider = state.providers.find((item) => item.name === $("#provider-select").value) || state.providers[0]
  if (!provider) return
  $("#provider-detail").innerHTML = `
    <div class="provider-card">
      <strong>${escapeHtml(provider.title)}</strong>
      <span>${provider.freeFriendly ? '<span class="ok">Free-friendly</span>' : '<span class="warn">Paid provider</span>'} ${provider.noAuth ? "No key required" : `Key: <code>${escapeHtml(provider.keyEnv)}</code>`}</span>
      <span>${escapeHtml(provider.note || "")}</span>
      <div>${provider.fallbackModels.map((model) => `<button class="model-chip" type="button" data-model="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join("")}</div>
    </div>
  `
}

function setRadio(name, value) {
  const input = document.querySelector(`[name='${name}'][value='${value}']`)
  if (input) input.checked = true
}

function formPayload(form) {
  const data = new FormData(form)
  return {
    provider: data.get("provider"),
    model: data.get("model"),
    cloudflareGatewayUrl: data.get("cloudflareGatewayUrl"),
    enabledTools: data.get("enabledTools"),
    agentMode: data.get("agentMode"),
    permissionMode: data.get("permissionMode"),
    updateCheck: Boolean(data.get("updateCheck")),
    autoUpdate: Boolean(data.get("autoUpdate")),
    pet: "sprite",
  }
}

async function saveConfig(event) {
  event.preventDefault()
  const saveState = $("#save-state")
  saveState.textContent = "Saving..."
  const response = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(formPayload(event.currentTarget)),
  })
  const data = await response.json()
  if (!data.ok) {
    saveState.innerHTML = `<span class="danger">${escapeHtml(data.message || data.error || "Save failed")}</span>`
    return
  }
  state.config = data.config
  saveState.innerHTML = `<span class="ok">Saved</span> ${escapeHtml(data.saved)}`
  fillForm(data.config)
  renderProviderDetail()
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char])
}

$("#config-form").addEventListener("submit", saveConfig)
$("#provider-select").addEventListener("change", () => {
  const provider = state.providers.find((item) => item.name === $("#provider-select").value)
  if (provider) $("#model-input").value = provider.defaultModel
  renderProviderDetail()
})
$("#use-default").addEventListener("click", () => {
  const provider = state.providers.find((item) => item.name === $("#provider-select").value)
  if (provider) $("#model-input").value = provider.defaultModel
})
$("#provider-detail").addEventListener("click", (event) => {
  const button = event.target.closest("[data-model]")
  if (button) $("#model-input").value = button.dataset.model
})

loadStatus().catch((error) => {
  document.body.innerHTML = `<main class="shell"><section class="panel"><h1>Twillight Web failed</h1><p>${escapeHtml(error.message)}</p></section></main>`
})
