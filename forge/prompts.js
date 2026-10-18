// Forge prompts. FORGE_STYLE picks the look of the model sheet (and the card that follows it):
//   detailed (default)  a modern 3D fighting-game character (Street Fighter 6 / Tekken 8 stylization): heroic
//                       proportions, saturated colors, crisp sculpted detail. Tripo rebuilds whatever the sheet shows,
//                       so a sharp, bold sheet is what gives a sharp, lively model (research/forge-quality.md)
//   goldsrc             the team's original Half-Life 1 / GoldSrc low-poly look
// The likeness, build and costume ideas come from the brief either way.

export const STYLES = ["detailed", "goldsrc"];
export const STYLE = STYLES.includes(process.env.FORGE_STYLE) ? process.env.FORGE_STYLE : "detailed";

export const BRIEF_PROMPT = `You're casting a 3D fighting game like Street Fighter 6. These photos show one person from the front, left and right.
Return only JSON with exactly these keys:
{
  "name": a playful 2-3 word fighter name, never about their body,
  "face": the key facial features to preserve in a likeness, as one comma-separated phrase (skin tone, face shape, hair, eyebrows, eyes, facial hair, glasses),
  "outfit": what they're wearing in the photos, as one comma-separated phrase (each garment with its color, plus shoes and accessories if visible),
  "distinctive": the 3 most distinctive things about how they look, as short phrases,
  "build": the street-brawler build that suits them best, one of "tall skinny", "athletic", "slow wrestler", "fast boxer",
  "archetype": the fighting style their look and vibe suggest, 2-4 words (like "street boxer", "kung fu master", "luchador", "capoeira dancer", "judo champ"),
  "signature": 3 signature costume details that turn their real outfit into a fighting-game costume, as short phrases with colors, built from what they actually wear (like "rolled-up sleeves", "red taped hand wraps", "a knotted headband", "a wide gold cloth belt", "fingerless leather gloves", "a jacket tied at the waist"); at least one adds a bold accent color that suits their palette; never weapons or held objects,
  "prop": one signature prop that fits their style,
  "palette": 3 hex colors taken from their outfit,
  "scout_report": one fighting-game scouting line, nothing about their body or face
}`;

const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string").join(", ") : typeof value === "string" ? value : "");

/** Full-body A-pose for the image-to-3D step. Takes the scan frames as references. */
export function sheetPrompt(brief, style = STYLE) {
  const build = brief.build ?? "athletic";
  if (style === "goldsrc") {
    return `Transform the person in the reference photos into an original Half-Life 1 (1998) character, faithfully recreating GoldSrc engine low-poly 3D graphics.

Likeness & Head: Preserve key facial features: ${brief.face}. Preserve facial likeness, but you may exaggerate it a little, like a PS2 game.
3D Art Style: Authentic late-90s PC game aesthetic using low-polygon geometry, sharp faceted edges, flat lighting, chunky retro 3D models, and pixelated 256-color palette hand-painted textures. Avoid modern shaders, smooth curves, photorealism, and high-resolution rendering.
Outfit: Match the outfit to the one in the photos, then fill in the rest of the outfit with your imagination.
Fighting-Game Archetype Exaggeration: Stylize the body proportions into a ${build} street-brawler build. Don't make them too short, and keep them somewhat proportional.
Pose & View: Full-body front-facing symmetrical A-pose against a solid neutral gray background. Head facing straight forward with arms angled 30–45 degrees outward, fists clenched, and feet shoulder-width apart. Entire character visible from head to soles with no UI, text, props or background objects.`;
  }
  const outfit = list(brief.outfit);
  const signature = list(brief.signature);
  const distinctive = list(brief.distinctive);
  const archetype = typeof brief.archetype === "string" && brief.archetype ? brief.archetype : "street fighter";
  // The 3D rebuild softens everything, so the sheet asks for more detail and contrast than the model should end up with.
  return `Turn the person in the reference photos into a playable character in a modern 3D fighting game like Street Fighter 6 or Tekken 8, shown as a clean front-view character model sheet that a 3D artist will rebuild as a game model.

Likeness: the fighter must be instantly recognizable as this person. Keep ${brief.face}. Keep their face shape, exact hairstyle and hair color, facial hair, skin tone and glasses (if any).${distinctive ? ` Keep what makes them distinctive: ${distinctive}.` : ""}
Fighter design: a ${archetype} with a ${build} build, clearly exaggerated like a fighting-game hero, more stylized than realistic (but not chibi): wide shoulders, a V-shaped torso and tapered waist, a strong neck, powerful forearms, oversized fists, a strong jaw and brow, and a slightly larger head than real. A confident, fierce look with the mouth closed. Full of attitude and life, never generic.
Costume: their real outfit${outfit ? ` (${outfit})` : ""} reworked into a signature fighting-game costume in the same main colors, pushed punchier and more saturated${signature ? `, with ${signature}` : ""}. Bold color blocking, vivid accent colors and a strong, readable silhouette. Shoes or wraps on the feet.
Style and detail: a stylized 3D CG character render like Street Fighter 6 key art, with even more detail and contrast than the game: sculpted, exaggerated anatomy and deep fabric folds; painted ambient occlusion in every fold, seam and crease; painted highlights on the cheekbones, nose, brow, knuckles and hair locks; hard, clean edges between materials (skin, hair, cloth, leather, tape, metal), each with its own clearly different texture (woven cloth, stitched leather, sculpted hair strands); a sharp, well-defined face with clear eyes, brows and lips. Razor-sharp focus everywhere, no blur, no grain. It must look like a rendered 3D game model: not a photo, not a flat 2D illustration, no outlines, not low-poly.
Pose: a neutral, symmetrical A-pose facing the camera head-on. Arms straight and angled about 40 degrees down and away from the body, with a clear gap between each arm and the torso; hands in loose fists. Legs straight, feet shoulder-width apart and flat, toes pointing forward. Head level, eyes looking into the camera.
Camera and light: the whole body from the top of the head to the soles of the feet, centered and filling about 90% of the image height. Straight-on view from chest height with a long lens (almost orthographic, no perspective distortion). Bright, even studio light from the front so every part is clearly lit; the forms read through the painted shading, not through cast shadows. No rim light, no shadow on the floor.
Background: plain flat light gray. Nothing else in the image: no floor, no props or weapons, no text, logos, labels or UI, no extra views or characters.`;
}

/** VS card art. Takes the model sheet as its reference so the character stays consistent. */
export function cardPrompt(brief, style = STYLE) {
  if (style === "goldsrc") {
    return `The exact same character as the reference image: same face, proportions, outfit and low-poly GoldSrc style.
Dynamic fighting stance, slightly low camera angle, cocky expression, holding ${brief.prop}.
Late-90s PC game render: low-polygon geometry, flat lighting, pixelated hand-painted textures.
Plain dark background, no text.`;
  }
  return `The exact same character as the reference image: same face, hair, proportions, costume, colors and stylized 3D fighting-game style.
Dynamic fighting stance, slightly low camera angle, cocky expression, holding ${brief.prop}.
Street Fighter 6 style character select render: crisp sculpted detail, saturated colors, dramatic key light with a colored rim light.
Plain dark background, no text.`;
}

/**
 * The back of the model sheet, for Tripo's multiview step (front + back). Takes the sheet as its only reference,
 * so pose, framing and costume line up with the front.
 */
export function backPrompt() {
  return `The exact same character as the reference image, seen from directly behind: a back view for a 3D character model sheet.
Keep everything identical: costume, colors, hair, body proportions, stylized 3D game render style, and the same symmetrical A-pose with the arms angled about 40 degrees away from the body and the hands in loose fists, legs straight, feet shoulder-width apart.
Same camera height, lens and framing as the reference: the whole body from the top of the head to the soles of the feet, centered, the same size in the frame. The character faces away from the camera, so we see the back of the head, the back of the costume and the heels; no face is visible.
Soft, even, shadowless studio light. Plain flat light gray background, nothing else: no floor shadow, no props, no text, no extra views.`;
}
