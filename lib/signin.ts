// Is this URL still part of a sign-in flow? Used to decide when a wait_for_user handoff is over:
// the agent takes the tab back once it settles on a page that is not a sign-in step.
//
// Cox Automotive (VinSolutions) for reference: vinsolutions.signin.coxautoinc.com ->
// mycoxautomotive.coxautoinc.com -> signin.coxautoinc.com/authorize -> signin.coxautoinc.com
// (Bridge ID: username, Next, password, then often a 2FA code) -> OAuth callback -> the app.

/** A hostname label that marks an identity provider: signin.coxautoinc.com, accounts.google.com, login.microsoftonline.com. */
const IDP_HOST = /(^|\.)(accounts|login|logon|auth|sso|signin|identity|id)\./i;
/** Path words for login, SSO, 2FA and challenge steps. */
const SIGNIN_PATH = /log[-_]?in|log[-_]?on|sign[-_]?in|auth|sso|oauth|saml|mfa|2fa|otp|verify|challenge|password|callback/i;

export function looksLikeSignIn(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (IDP_HOST.test(u.hostname) || SIGNIN_PATH.test(u.pathname)) return true;
  // OAuth / OIDC / SAML redirects carrying a code or token are still mid sign-in.
  const q = u.searchParams;
  return (q.has('code') && q.has('state')) || q.has('id_token') || q.has('SAMLResponse');
}
