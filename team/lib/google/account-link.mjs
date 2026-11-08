/**
 * Sign in with Google — the account-linking decision.
 *
 * A pure function. It takes a verified Google identity plus whatever the product
 * already knows about that email, and returns WHAT TO DO. No database, no session,
 * no framework — every product wires its own storage to the decision.
 *
 * This is deliberately separate from the OAuth code because it is the part that
 * causes support pain when improvised. The rules:
 *
 *   1. Google email matches an existing account → LINK and log in. Their existing
 *      password keeps working; the two are alternate doors to one account, never
 *      two accounts.
 *   2. No match → create the account exactly as normal signup would, flagged as
 *      google-provided, with no password set.
 *   3. Only ever match on a VERIFIED Google email (enforced upstream in
 *      verifyIdToken, re-asserted here so this stays safe if called directly).
 *   4. A linked account may later set a password through the normal reset flow.
 *      Never the reverse silently.
 *
 * The security reasoning behind rule 1, which is the tempting one to get wrong:
 * matching on email is only safe BECAUSE Google has verified the address. Without
 * that check, anyone could create a Google account claiming an address they do not
 * control and walk straight into someone else's account.
 */

/** @typedef {'link'|'login'|'create'|'refuse'} LinkAction */

/**
 * @param identity  verified identity from verifyIdToken()
 * @param existing  what the product found for this email, or null. Shape:
 *                  { id, email, googleSub?, hasPassword?, disabled? }
 * @returns {{action: LinkAction, reason: string, accountId: string|null,
 *            setGoogleSub: string|null, markEmailVerified: boolean}}
 */
export function decideAccountLink(identity, existing) {
  if (!identity || !identity.email || !identity.googleSub) {
    return refuse('Google identity was incomplete');
  }
  if (identity.emailVerified !== true) {
    // Belt and braces: verifyIdToken already refuses these.
    return refuse('Google has not verified this email address');
  }

  const email = String(identity.email).trim().toLowerCase();

  if (!existing) {
    return {
      action: 'create',
      reason: 'No account for this address — create one, google-provided, no password',
      accountId: null,
      setGoogleSub: identity.googleSub,
      markEmailVerified: true,
    };
  }

  if (existing.disabled) {
    return refuse('That account is disabled');
  }

  if (String(existing.email || '').trim().toLowerCase() !== email) {
    // The caller looked up the wrong record — refuse rather than link across accounts.
    return refuse('Account lookup did not match the Google email');
  }

  if (existing.googleSub) {
    if (existing.googleSub !== identity.googleSub) {
      // Same address, different Google account. Real cause: an address moved between
      // Google Workspace tenants. Refusing is right — silently rebinding would hand
      // the account to whoever holds the address now.
      return refuse('This address is already linked to a different Google account');
    }
    return {
      action: 'login',
      reason: 'Already linked to this Google account',
      accountId: existing.id,
      setGoogleSub: null,
      markEmailVerified: true,
    };
  }

  return {
    action: 'link',
    reason: 'Existing account with this verified address — link Google to it and log in',
    accountId: existing.id,
    setGoogleSub: identity.googleSub,
    markEmailVerified: true,
  };
}

function refuse(reason) {
  return { action: 'refuse', reason, accountId: null, setGoogleSub: null, markEmailVerified: false };
}

/** What the user is told. Never leak whether an address is registered. */
export function refusalMessage() {
  return 'We could not sign you in with Google. Try again, or use your email and password.';
}
