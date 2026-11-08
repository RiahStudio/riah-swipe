const root = document.getElementById('projects');
const live = document.getElementById('live');
const streams = new Map();
let refreshTimer = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const bytes = (value) => value >= 1024 ** 3
  ? `${(value / 1024 ** 3).toFixed(1)} GB`
  : `${(value / 1024 ** 2).toFixed(1)} MB`;

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => load().catch(showError), 120);
}

function connect(workspaces) {
  const liveIds = new Set(workspaces.map((workspace) => workspace.id));
  for (const [id, stream] of streams) if (!liveIds.has(id)) { stream.close(); streams.delete(id); }
  for (const workspace of workspaces) {
    if (streams.has(workspace.id)) continue;
    const stream = new EventSource(`./api/workspaces/${encodeURIComponent(workspace.id)}/events`);
    for (const type of ['deck.published', 'verdict', 'verdict.undo', 'deck.done']) stream.addEventListener(type, scheduleRefresh);
    stream.onopen = () => { live.textContent = 'Live'; };
    stream.onerror = () => { live.textContent = 'Reconnecting…'; };
    streams.set(workspace.id, stream);
  }
}

function render(data) {
  if (!data.workspaces.length) { root.innerHTML = '<p class="empty">No projects yet.</p>'; return; }
  root.innerHTML = data.workspaces.map((workspace) => `
    <section class="workspace" data-workspace-id="${esc(workspace.id)}">
      <div class="workspace-head">
        <div><h2>${esc(workspace.name)}</h2><div class="usage">${bytes(workspace.bytesUsed)} of ${bytes(workspace.quotaBytes)} live media</div></div>
        <label class="notify"><input type="checkbox" data-notify ${workspace.notifyEmail ? 'checked' : ''}> Email me on new decks</label>
      </div>
      ${workspace.projects.map((project) => `
        <article class="project">
          <div class="project-head"><h3>${esc(project.name)}</h3><span class="usage">Media clears ${project.purgeDays} days after review</span></div>
          <div class="deck-list">
            ${project.decks.length ? project.decks.map((deck) => `
              <div class="deck">
                <div><div class="deck-name">${esc(deck.name)} <span class="status status-${esc(deck.status)}">${esc(deck.status)}</span></div><div class="deck-meta">${esc(deck.sourceId)}${deck.mediaExpired ? ' · Media expired after review' : ''}</div></div>
                <div class="count">${deck.verdictCount} / ${deck.cardCount} verdicts</div>
              </div>`).join('') : '<p class="empty">No decks yet.</p>'}
          </div>
        </article>`).join('')}
    </section>`).join('');
  root.querySelectorAll('[data-notify]').forEach((input) => input.addEventListener('change', async () => {
    const workspaceId = input.closest('[data-workspace-id]').dataset.workspaceId;
    const response = await fetch(`./api/workspaces/${encodeURIComponent(workspaceId)}/me`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifyEmail: input.checked }),
    });
    if (!response.ok) { input.checked = !input.checked; showError(); }
  }));
}

async function load() {
  const response = await fetch('./api/projects', { cache: 'no-store' });
  if (response.status === 401) { location.href = './login'; return; }
  if (!response.ok) throw new Error('status unavailable');
  const data = await response.json();
  render(data);
  connect(data.workspaces);
}

function showError() { live.textContent = 'Reconnecting…'; }

document.getElementById('logout').addEventListener('click', async (event) => {
  event.preventDefault();
  await fetch('./api/logout', { method: 'POST' });
  location.href = './';
});

load().catch(showError);
