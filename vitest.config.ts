import { configDefaults, defineConfig } from 'vitest/config';

// Logic tests only (no React/Tailwind plugins). Agents' git worktrees live under .claude/; skip them.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '.claude/**'] },
});
