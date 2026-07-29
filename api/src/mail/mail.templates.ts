import { InvitationEmailData, PRODUCT_NAME } from './mail.types';

/**
 * Provider-agnostic invitation email. Every provider sends exactly this content —
 * only the transport differs — so switching MAIL_PROVIDER cannot change what the
 * invitee receives.
 */
export function invitationSubject(d: InvitationEmailData): string {
  return `You're invited to ${d.companyName} on ${PRODUCT_NAME}`;
}

export function invitationHtml(d: InvitationEmailData): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px;padding:28px;">
      <h1 style="margin:0 0 12px;font-size:20px;color:#2563eb;">You're invited to ${escapeHtml(d.companyName)}</h1>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">
        ${escapeHtml(d.inviterName)} invited you to join
        <strong>${escapeHtml(d.companyName)}</strong> on ${PRODUCT_NAME} as
        <strong>${escapeHtml(roleLabel(d.role))}</strong>.
      </p>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.5;">
        Click below to set your password and activate your account.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${d.acceptUrl}"
           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:15px;">
          Accept invitation
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
        This invitation expires on <strong>${fmtDate(d.expiresAt)}</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7280;">
        If the button doesn't work, paste this link into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(d.acceptUrl)}</span>
      </p>
      <p style="margin:0;font-size:13px;color:#6b7280;">
        If you weren't expecting this, you can ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #e3e6ea;margin:20px 0 12px;" />
      <p style="margin:0;font-size:12px;color:#9ca3af;">${PRODUCT_NAME}</p>
    </div>
  </body>
</html>`;
}

export function invitationText(d: InvitationEmailData): string {
  return [
    `You're invited to ${d.companyName}`,
    '',
    `${d.inviterName} invited you to join ${d.companyName} on ${PRODUCT_NAME} as ${roleLabel(d.role)}.`,
    '',
    'Set your password and activate your account:',
    d.acceptUrl,
    '',
    `This invitation expires on ${fmtDate(d.expiresAt)}.`,
    '',
    "If you weren't expecting this, you can ignore this email.",
    '',
    `— ${PRODUCT_NAME}`,
  ].join('\n');
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function roleLabel(role: string): string {
  return role === 'COMPANY_ADMIN' ? 'Company Admin' : 'Store User';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
