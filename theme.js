// Seasonal art direction. Swap SEASON for a new edition (e.g. spring27) without
// touching views: colors become CSS variables, copy and producer styling come from here.
//
// Producer art: add files under web/public/assets/producers/<id>/ and fill an asset
// slot below, e.g. portrait: { src: "/assets/producers/daniska/portrait.webp",
// width: 1200, height: 1600, alt: "Daniska in a charcoal puffer jacket" }.
// Slots left null fall back to the typographic portrait; never point at missing files.

export const winter26 = Object.freeze({
  id: "winter26",
  label: "Winter 26",
  title: "Winter After Dark",
  tokens: {
    "--bg": "#090b0f",
    "--bg-2": "#0e1117",
    "--bg-3": "#131721",
    "--surface": "rgba(19, 23, 31, 0.62)",
    "--surface-strong": "rgba(24, 29, 39, 0.86)",
    "--line": "rgba(206, 214, 230, 0.09)",
    "--line-strong": "rgba(206, 214, 230, 0.2)",
    "--text": "#e7eaf0",
    "--muted": "#8d95a7",
    "--faint": "#5b6376",
    "--silver": "#c8ced8",
    "--ice": "#a8c4dc",
    "--violet": "#a29dca",
    "--warn": "#cfae6e",
    "--fail": "#cf8585",
    "--haze": "rgba(120, 140, 170, 0.07)",
  },
  producers: {
    daniska: {
      world: "Rap · Drill · Trap · Hip-Hop",
      mood: "Underground, controlled, urban",
      accent: "#c3c9d3",
      tint: "#121722",
      glow: "rgba(195, 201, 211, 0.16)",
      styling: ["Oversized charcoal puffer", "Heavyweight hoodie", "Silver Cuban chain"],
      setting: "Night city · cold concrete · distant lights",
      assets: { portrait: null, fullBody: null, seasonalPortrait: null },
    },
    eliska: {
      world: "Pop · Dream Pop · Synthpop · Electropop",
      mood: "Dreamy, fashion-forward, soft",
      accent: "#cdd6ec",
      tint: "#161a26",
      glow: "rgba(184, 178, 220, 0.18)",
      styling: ["Frost-white cropped jacket", "Layered silver necklaces", "Ear cuff"],
      setting: "Frosted glass · diffused light · pearl and lavender",
      assets: { portrait: null, fullBody: null, seasonalPortrait: null },
    },
    kristal: {
      world: "House · Deep House · Melodic · Electronic",
      mood: "Nightlife, architectural, mysterious",
      accent: "#8fbcc0",
      tint: "#0f1a1d",
      glow: "rgba(110, 170, 176, 0.16)",
      styling: ["Long graphite coat", "Chrome statement ring", "Minimal chain"],
      setting: "Dark club · petrol and chrome · architectural haze",
      assets: { portrait: null, fullBody: null, seasonalPortrait: null },
    },
  },
});

export const SEASON = winter26;

export function applySeason(season = SEASON) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(season.tokens)) root.style.setProperty(token, value);
  root.dataset.season = season.id;
}

export function producerTheme(producerId, season = SEASON) {
  return season.producers[producerId] ?? {
    world: "",
    mood: "",
    accent: "var(--silver)",
    tint: "var(--bg-2)",
    glow: "rgba(200, 206, 216, 0.12)",
    styling: [],
    setting: "",
    assets: {},
  };
}

// Returns the first asset slot that is actually set, in the caller's preference order.
export function producerAsset(producerId, preference = ["seasonalPortrait", "fullBody", "portrait"]) {
  const assets = producerTheme(producerId).assets ?? {};
  for (const variant of preference) {
    if (assets[variant]?.src) return { variant, ...assets[variant] };
  }
  return null;
}
