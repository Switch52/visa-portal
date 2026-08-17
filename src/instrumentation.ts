/**
 * Runs once, before the server accepts its first request.
 *
 * Its whole job is to refuse to start when configuration is missing, instead of
 * starting happily and failing later on whichever request first needs it.
 *
 * That distinction cost an afternoon: a container with no MONGODB_URI served the
 * login page perfectly, answered its health check, and looked deployed — then
 * returned a bare 500 the moment someone asked for a sign-in code. The error was
 * a thrown string deep in a server action, which reaches the browser as "page
 * couldn't load" and points at nothing.
 *
 * Crashing on boot is louder and cheaper. The orchestrator restarts, the reason is
 * the first line of the log, and nobody signs in against a broken deployment.
 */

// Read at runtime, never baked into the image, so one image runs anywhere.
const REQUIRED = {
  MONGODB_URI: 'the Atlas connection string',
  AUTH_SECRET: 'peppers session and OTP hashes — `openssl rand -base64 32`',
} as const;

const RECOMMENDED = {
  MONGODB_DB: 'defaults to visa_portal',
  APP_URL: 'the public URL that notification emails link to',
} as const;

export function register(): void {
  // Only the Node.js server runtime has the environment; the edge runtime is
  // compiled separately and would report false alarms.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const missing = Object.entries(REQUIRED).filter(([name]) => !process.env[name]?.trim());

  if (missing.length > 0) {
    const lines = missing.map(([name, why]) => `  - ${name}: ${why}`).join('\n');
    throw new Error(
      `Refusing to start: ${missing.length} required environment variable(s) missing.\n${lines}\n\n` +
        'These are supplied at run time — docker compose reads them from a .env file\n' +
        'beside docker-compose.yml, and a managed host from its own environment panel.\n' +
        'They are deliberately never build arguments: a value passed with --build-arg is\n' +
        'written into the image and stays readable with `docker history`.',
    );
  }

  // Not fatal: the app works without these, just not the way anyone wants.
  for (const [name, why] of Object.entries(RECOMMENDED)) {
    if (!process.env[name]?.trim()) console.warn(`[config] ${name} is not set — ${why}`);
  }

  if (!process.env.RESEND_API_KEY?.trim()) {
    console.warn(
      '[config] RESEND_API_KEY is not set — sign-in codes will be printed to this log ' +
        'instead of emailed, so only someone who can read it can sign in.',
    );
  }
}
