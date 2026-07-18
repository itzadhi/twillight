export const petCatalog = Object.freeze({
  sprite: {
    title: "Twillight Companion",
    aliases: ["sprite", "default", "pet", "companion", "buddy", "dragon", "dragom", "dragn", "dragoon", "dev-dragon"],
    role: "session companion",
    trait: "Watches provider state, queued work, tool health, and the next useful action.",
    idle: "companion steady",
    busy: "companion working",
    mood: "lavender focus",
    art: [
      "        .-.",
      "     __/o o\\__",
      "    /  \\_^_/  \\",
      "   |  /|___|\\  |",
      "    \\_\\_____/__/",
      "      /_/ \\_\\",
      "   lavender companion",
    ],
    sidebarArt: [
      " .-.",
      "(o o)",
      "/|_|\\",
      "/   \\",
    ],
    helps: [
      "keeps provider and model state visible",
      "spots stalled workflows and update problems",
      "stays available in every project without special unlocks",
    ],
  },
})

export function petNames() {
  return Object.keys(petCatalog)
}

export function normalizePetName(value) {
  const text = String(value || "").trim().toLowerCase()
  for (const [name, pet] of Object.entries(petCatalog)) {
    if (name === text || pet.aliases.includes(text)) return name
  }
  return ""
}

export function petInfo(value) {
  return petCatalog[normalizePetName(value)] || petCatalog.sprite
}

export function petAccess(value, isDeveloper = false) {
  const name = normalizePetName(value) || "sprite"
  const pet = petInfo(name)
  return {
    name,
    pet,
    allowed: true,
    activeName: name,
    activePet: pet,
  }
}

export function petSidebarLine(value, options = {}) {
  const access = petAccess(value, options.isDeveloper)
  return options.processing ? access.pet.busy : access.pet.idle
}
