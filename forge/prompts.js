// Forge prompts, v1 from SPEC.md. Tune freely: the look isn't decided yet.

export const BRIEF_PROMPT = `You're casting a fighting game. These photos show one person from the front, left and right.
Return only JSON with exactly these keys:
{
  "name": a playful 2-3 word fighter name, never about their body,
  "distinctive": the 3 most distinctive things about how they look (hair, eyebrows, jaw, glasses, beard, build, outfit), as short phrases,
  "archetype": one of "brawler", "speedster", "tank", "showboat",
  "outfit_upgrade": one sentence turning their outfit up to 11, still something you can fight in (no capes, cloaks or long coats),
  "prop": one signature prop that fits their style,
  "palette": 3 hex colors taken from their outfit,
  "scout_report": one fighting-game scouting line, nothing about their body or face
}`;

const ARCHETYPES = {
  brawler: "brawler: massive forearms and fists, short legs",
  speedster: "speedster: lanky, extra-long limbs",
  tank: "tank: wide as a fridge, huge hands",
  showboat: "showboat: giant hair, flashy outfit",
};

/** Full-body A-pose for the image-to-3D step. Takes the scan frames as references. */
export function sheetPrompt(brief) {
  const features = [].concat(brief.distinctive ?? []).join("; ");
  return `Turn the person in these photos into a playable fighter from a 2003 PS2 fighting game: cartoonish and caricatured (think Ready 2 Rumble Boxing or Rockstar's Bully), not realistic.
Push these features 2-3x so their friends would recognize them instantly: ${features}.
Body type: ${ARCHETYPES[brief.archetype] ?? brief.archetype}. Keep their real hairstyle, skin tone, facial hair, glasses and outfit, upgraded like this: ${brief.outfit_upgrade}. Head about 1.3x normal size.

Layout: a 3D model reference sheet. One full-body view, head to feet, facing the camera.
A-pose with arms 45 degrees out from the body, legs slightly apart, closed fists.
Neutral expression. No props, no capes, no long coats. Plain light gray background,
even lighting, no shadows, no text.`;
}

/** VS card art. Takes the model sheet as its reference so the character stays consistent. */
export function cardPrompt(brief) {
  return `The exact same character as the reference image: same face, proportions, outfit and exaggerations.
Dynamic fighting stance, slightly low camera angle, cocky expression, holding ${brief.prop}.
PS2-era 3D game render: low-poly, low-res textures, hard rim light.
Plain dark background, no text.`;
}
