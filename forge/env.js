// Loads the repo root .env (then forge/.env) before anything reads process.env. Imported first by server.js.
for (const file of ["../.env", ".env"]) {
  try {
    process.loadEnvFile(new URL(file, import.meta.url));
  } catch {}
}
