import { describe, expect, it } from 'vitest';
import { looksLikeSignIn } from '../lib/signin';

describe('looksLikeSignIn', () => {
  it('treats every step of the Cox Automotive (VinSolutions) sign-in as sign-in', () => {
    for (const url of [
      'https://vinsolutions.signin.coxautoinc.com/',
      'https://vinsolutions.signin.coxautoinc.com/solutionlauncher',
      'https://signin.coxautoinc.com/authorize/?state=s&client_id=c&redirect_uri=r&response_type=code',
      'https://signin.coxautoinc.com/?solutionID=VIN_prod&clientId=abc',
      'https://mycoxautomotive.coxautoinc.com/callback?code=abc&state=xyz',
    ]) {
      expect(looksLikeSignIn(url), url).toBe(true);
    }
  });

  it('knows common identity providers and login, 2FA and callback paths', () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://id.atlassian.com/login',
      'https://example.okta.com/app/sso/saml',
      'https://app.example.com/login',
      'https://app.example.com/users/sign_in',
      'https://app.example.com/2fa',
      'https://app.example.com/auth/callback',
      'https://app.example.com/?id_token=x',
    ]) {
      expect(looksLikeSignIn(url), url).toBe(true);
    }
  });

  it('lets an app page end the handoff', () => {
    for (const url of [
      'https://mycoxautomotive.coxautoinc.com/',
      'https://app.example.com/dashboard',
      'https://app.example.com/leads?status=open',
      'https://vid.example.com/',
    ]) {
      expect(looksLikeSignIn(url), url).toBe(false);
    }
  });
});
