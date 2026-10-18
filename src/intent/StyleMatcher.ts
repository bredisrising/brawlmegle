import type { StrikeStyle } from './intents';

/**
 * Tells strike styles apart by comparing against a player's own examples (from calibration), instead of
 * hand-written rules. Nearest neighbours over a short feature vector: microseconds, no added latency.
 * Features are mirrored by side, so a right hook example also helps recognise left hooks.
 */
export type Template = { style: StrikeStyle; features: number[] };

export class StyleMatcher {
  readonly templates: Template[] = [];

  add(style: StrikeStyle, features: number[]) {
    this.templates.push({ style, features: [...features] });
  }

  get size() {
    return this.templates.length;
  }

  /** Needs at least two styles with two examples each to choose between; otherwise the rules decide. */
  classify(features: number[]): { style: StrikeStyle; distance: number } | null {
    const counts = new Map<StrikeStyle, number>();
    for (const t of this.templates) counts.set(t.style, (counts.get(t.style) ?? 0) + 1);
    if ([...counts.values()].filter((n) => n >= 2).length < 2) return null;
    const near = this.templates
      .map((t) => ({ style: t.style, d: Math.hypot(...t.features.map((v, i) => v - features[i])) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3);
    // Distance-weighted vote among the 3 closest examples.
    const votes = new Map<StrikeStyle, number>();
    for (const n of near) votes.set(n.style, (votes.get(n.style) ?? 0) + 1 / (n.d + 1e-3));
    const style = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { style, distance: near[0].d };
  }

  /** Closest example distance for each style the player has examples of. */
  nearestByStyle(features: number[]): Map<StrikeStyle, number> {
    const best = new Map<StrikeStyle, number>();
    for (const t of this.templates) {
      const d = Math.hypot(...t.features.map((v, i) => v - features[i]));
      if (d < (best.get(t.style) ?? Infinity)) best.set(t.style, d);
    }
    return best;
  }

  /**
   * The style to use: the rules' answer unless the player's own examples clearly say otherwise
   * (the matched style's closest example is much closer than any example of the rules' style).
   */
  decide(features: number[], ruleStyle: StrikeStyle): StrikeStyle {
    const match = this.classify(features);
    if (!match || match.style === ruleStyle) return ruleStyle;
    // A couple of examples are too few to overrule the rules: one sloppy example would flip every strike like it.
    if (this.templates.filter((t) => t.style === match.style).length < 3) return ruleStyle;
    // No examples of what the rules say: nothing to compare against, so the rules stand.
    const ruleDistance = this.nearestByStyle(features).get(ruleStyle);
    if (ruleDistance === undefined) return ruleStyle;
    return match.distance < 0.7 * ruleDistance ? match.style : ruleStyle;
  }

  toJSON(): Template[] {
    return this.templates;
  }

  static fromJSON(templates: Template[]): StyleMatcher {
    const m = new StyleMatcher();
    for (const t of templates) m.add(t.style, t.features);
    return m;
  }
}
