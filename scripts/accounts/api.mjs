// The Cloudflare API and gh, as the account scripts (setup-secrets, infra-adopt) call them, with the
// tokens from .env.
import { execFileSync } from 'node:child_process';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function cf(method, path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.success === false) {
    const messages = (json.errors ?? []).map((error) => `${error.code}: ${error.message}`).join('; ');
    throw new ApiError(`Cloudflare ${method} ${path} failed (${response.status}) ${messages}`, response.status);
  }
  return json.result;
}

// A Cloudflare GET that answers null for a 404.
export async function cfFind(path) {
  try {
    return await cf('GET', path);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// Runs gh with GH_TOKEN from .env. Secret values go through stdin, never argv.
export function gh(args, input) {
  try {
    return execFileSync('gh', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    throw new ApiError(`gh ${args.slice(0, 3).join(' ')} failed: ${String(error.stderr).trim()}`, error.status);
  }
}

export const ghApi = (method, path, body) => {
  const output = gh(
    ['api', '-X', method, path, ...(body ? ['--input', '-'] : [])],
    body ? JSON.stringify(body) : undefined,
  );
  return output.trim() ? JSON.parse(output) : null;
};

// A gh api GET that answers null for a 404.
export function ghFind(path) {
  try {
    return ghApi('GET', path);
  } catch (error) {
    if (/HTTP 404|Not Found/.test(error.message)) return null;
    throw error;
  }
}
