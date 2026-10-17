// Forge prompts. The model sheet uses the team's GoldSrc-style prompt, with the likeness and build filled in
// from the brief. Tune freely: the look isn't decided yet.

export const BRIEF_PROMPT = `You're casting a fighting game. These photos show one person from the front, left and right.
Return only JSON with exactly these keys:
{
  "name": a playful 2-3 word fighter name, never about their body,
  "face": the key facial features to preserve in a likeness, as one comma-separated phrase (skin tone, hair, eyebrows, eyes, facial hair, glasses, expression),
  "distinctive": the 3 most distinctive things about how they look, as short phrases,
  "build": the street-brawler build that suits them best, one of "tall skinny", "athletic", "slow wrestler", "fast boxer",
  "prop": one signature prop that fits their style,
  "palette": 3 hex colors taken from their outfit,
  "scout_report": one fighting-game scouting line, nothing about their body or face
}`;

/** Full-body A-pose for the image-to-3D step. Takes the scan frames as references. */
export function sheetPrompt(brief) {
  return `Transform the person in the reference photos into an original Half-Life 1 (1998) character, faithfully recreating GoldSrc engine low-poly 3D graphics.

Likeness & Head: Preserve key facial features: ${brief.face}. Preserve facial likeness, but you may exaggerate it a little, like a PS2 game.
3D Art Style: Authentic late-90s PC game aesthetic using low-polygon geometry, sharp faceted edges, flat lighting, chunky retro 3D models, and pixelated 256-color palette hand-painted textures. Avoid modern shaders, smooth curves, photorealism, and high-resolution rendering.
Outfit: Match the outfit to the one in the photos, then fill in the rest of the outfit with your imagination.
Fighting-Game Archetype Exaggeration: Stylize the body proportions into a ${brief.build ?? "athletic"} street-brawler build. Don't make them too short, and keep them somewhat proportional.
Pose & View: Full-body front-facing symmetrical A-pose against a solid neutral gray background. Head facing straight forward with arms angled 30–45 degrees outward, fists clenched, and feet shoulder-width apart. Entire character visible from head to soles with no UI, text, props or background objects.`;
}

/** VS card art. Takes the model sheet as its reference so the character stays consistent. */
export function cardPrompt(brief) {
  return `The exact same character as the reference image: same face, proportions, outfit and low-poly GoldSrc style.
Dynamic fighting stance, slightly low camera angle, cocky expression, holding ${brief.prop}.
Late-90s PC game render: low-polygon geometry, flat lighting, pixelated hand-painted textures.
Plain dark background, no text.`;
}
