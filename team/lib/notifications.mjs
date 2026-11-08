import { getDb } from './db.mjs';
import { sendMail } from './mail.mjs';
import { appendWorkspaceEvent } from './hosted.mjs';

const configuredDelay = Number(process.env.REVIEW_NOTIFY_DELAY_MS);
const COALESCE_MS = Number.isFinite(configuredDelay) && configuredDelay >= 0
  ? configuredDelay
  : 15 * 60 * 1000;
const pending = new Map();
let mailSender = sendMail;

export function queueProjectReviewNotification({ projectId, deckId, baseUrl, delayMs = COALESCE_MS, db = getDb() }) {
  let item = pending.get(projectId);
  if (!item) {
    item = { projectId, deckIds: new Set(), baseUrl, db, timer: null };
    pending.set(projectId, item);
  }
  item.deckIds.add(deckId);
  item.baseUrl = baseUrl;
  if (!item.timer) {
    item.timer = setTimeout(() => flushProjectReviewNotifications(projectId).catch((error) => {
      console.error('[review-notify]', error.message);
    }), delayMs);
    item.timer.unref();
  }
  return { projectId, queuedDecks: item.deckIds.size };
}

export async function flushProjectReviewNotifications(projectId) {
  const item = pending.get(projectId);
  if (!item) return { sent: 0, deckIds: [] };
  pending.delete(projectId);
  if (item.timer) clearTimeout(item.timer);
  const db = item.db;
  const project = db.prepare(`SELECT p.name,p.workspace_id,w.name AS workspace_name FROM projects p JOIN workspaces w ON w.id=p.workspace_id WHERE p.id=?`).get(projectId);
  if (!project) return { sent: 0, deckIds: [] };
  const recipients = db.prepare(`
    SELECT DISTINCT a.email FROM project_roles pr
    JOIN accounts a ON a.id=pr.account_id
    JOIN workspace_members wm ON wm.workspace_id=? AND wm.account_id=pr.account_id
    WHERE pr.project_id=? AND pr.role='reviewer' AND wm.notify_email=1
  `).all(project.workspace_id, projectId);
  const deckIds = [...item.deckIds];
  const names = db.prepare(`SELECT name FROM hosted_decks WHERE id=?`);
  const deckNames = deckIds.map((id) => names.get(id)?.name).filter(Boolean);
  let sent = 0;
  for (const recipient of recipients) {
    const result = await mailSender({
      to: recipient.email,
      subject: `${deckNames.length === 1 ? deckNames[0] : `${deckNames.length} new decks`} ready in ${project.name}`,
      text: `${deckNames.join('\n')}\n\nReview: ${item.baseUrl}/review`,
    });
    if (result && result.ok) sent++;
  }
  appendWorkspaceEvent({
    workspaceId: project.workspace_id, projectId, type: 'reviewers.notified',
    payload: { projectId, deckIds, recipientCount: sent }, db,
  });
  return { sent, deckIds };
}

export function _setMailSenderForTests(sender) { mailSender = sender || sendMail; }
export function _clearNotificationsForTests() {
  for (const item of pending.values()) if (item.timer) clearTimeout(item.timer);
  pending.clear();
  mailSender = sendMail;
}
