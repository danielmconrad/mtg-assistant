// Verifies the Cloudflare Access assertion on browser routes. Access already stops anyone who isn't
// allowlisted before the request reaches the Worker; checking its signed JWT here as well means a
// misconfigured or deleted Access application fails closed instead of open.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isAllowedEmail, isLoopbackHost } from '../config.mjs';

const jwksByTeam = new Map();

function jwksFor(teamDomain) {
  if (!jwksByTeam.has(teamDomain)) {
    jwksByTeam.set(teamDomain, createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`)));
  }
  return jwksByTeam.get(teamDomain);
}

// Returns { email } for an allowlisted Access identity, or { problem } explaining the refusal.
export async function verifyAccess(request, config) {
  if (config.devAccessEmail && isLoopbackHost(new URL(request.url).hostname)) {
    return isAllowedEmail(config, config.devAccessEmail)
      ? { email: config.devAccessEmail }
      : { problem: 'DEV_ACCESS_EMAIL is not in ALLOWED_EMAILS' };
  }
  if (!config.accessTeamDomain || !config.accessAud) return { problem: 'Access is not configured' };
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion) return { problem: 'missing Access assertion' };
  try {
    const { payload } = await jwtVerify(assertion, jwksFor(config.accessTeamDomain), {
      issuer: `https://${config.accessTeamDomain}`,
      audience: config.accessAud,
      algorithms: ['RS256'],
    });
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!isAllowedEmail(config, email)) return { problem: 'Access identity is not allowlisted' };
    return { email };
  } catch (error) {
    return { problem: `invalid Access assertion (${error.code ?? error.name})` };
  }
}
