// server/lib/mail.mjs
// Mail adapter. With RESEND_API_KEY set, sends through Resend; without it,
// prints to the server log (dev). Never logs message bodies in production —
// reset links in logs are a credential leak.

let lastDevMail = null;

/**
 * @param {{ to: string, subject: string, text: string, html?: string }} opts
 */
export async function sendMail({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Riah Swipe <noreply@example.com>';
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      // Never echo codes/tokens in production paths.
      console.warn(`[mail] no provider configured — could not send "${subject}" to ${to}`);
      return { ok: false, error: 'mail_not_configured' };
    }
    lastDevMail = { to, subject, text, html, at: Date.now() };
    console.log(`[mail:dev] to=${to} subject=${subject}\n${text}\n`);
    return { ok: true, dev: true };
  }
  try {
    const payload = { from, to, subject, text };
    if (html) payload.html = html;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[mail] Resend HTTP ${res.status}${detail ? ` — ${detail.slice(0, 120)}` : ''}`);
      return { ok: false, error: `mail HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Build a simple branded HTML email (password reset, new-deck notices). */
export function brandedMailHtml({ heading, bodyHtml, ctaLabel, ctaUrl, footNote }) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeHeading = esc(heading);
  const safeCta = esc(ctaLabel);
  const safeUrl = String(ctaUrl || '').replace(/"/g, '&quot;');
  const ctaBlock = ctaUrl
    ? `<p style="margin:28px 0 8px"><a href="${safeUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;padding:12px 22px;border-radius:6px">${safeCta || 'Continue'}</a></p>
       <p style="margin:0 0 24px;font-size:12px;line-height:1.5;color:#888;word-break:break-all">${safeUrl}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#111">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden">
        <tr><td style="padding:28px 28px 8px;font-family:Georgia,'Instrument Serif',serif;font-size:22px;font-style:italic;color:#111">
          Riah <span style="font-style:normal;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:18px;font-weight:600">Swipe</span>
        </td></tr>
        <tr><td style="padding:8px 28px 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:20px;font-weight:600;color:#111">${safeHeading}</td></tr>
        <tr><td style="padding:16px 28px 28px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#333">
          ${bodyHtml || ''}
          ${ctaBlock}
          ${footNote ? `<p style="margin:0;font-size:12px;line-height:1.5;color:#888">${footNote}</p>` : ''}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:11px;color:#a1a1aa">Riah Swipe · sent by your team server</p>
    </td></tr>
  </table>
</body></html>`;
}

/** Test-only: last dev/no-provider mail body (includes codes). Null in production use. */
export function _lastDevMailForTests() { return lastDevMail; }
export function _clearDevMailForTests() { lastDevMail = null; }
