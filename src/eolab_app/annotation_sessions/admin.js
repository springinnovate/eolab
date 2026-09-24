/** @typedef {{id: string, name: string, joinCode: string, deletedAt: string|null, contributorCount: number, polygonCount: number}} AdminSharedLayer */

const status = document.querySelector('#status');
const rows = document.querySelector('#layers');
const refresh = document.querySelector('#refresh');
const confirmation = document.querySelector('#confirm-delete');
document.querySelector('#cancel-delete').addEventListener('click', () => confirmation.close('cancel'));
document.querySelector('#accept-delete').addEventListener('click', () => confirmation.close('delete'));

/**
 * Call the administrator API without storing credentials in JavaScript.
 * @param {string} path API path.
 * @param {string} [method='GET'] HTTP method.
 * @returns {Promise<AdminSharedLayer[]|null>} Layer list or empty mutation result.
 * @throws {Error} When authentication, storage or transport fails.
 */
async function request(path, method = 'GET') {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-EOLab-Admin': '1' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}

/**
 * Prevent overlapping list refreshes and administrative changes on this page.
 * @param {boolean} busy Whether a request is pending.
 * @returns {void}
 */
function setBusy(busy) {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

/**
 * Display a current list using text nodes so layer names cannot become markup.
 * @returns {Promise<void>}
 * @throws {Error} If the list cannot be fetched; existing rows remain visible.
 */
async function loadLayers() {
  const layers = await request('/api/admin/shared-layers');
  rows.replaceChildren(...layers.map(layer => {
    const row = document.createElement('tr');
    row.dataset.layerId = layer.id;
    row.classList.toggle('deleted', !!layer.deletedAt);
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = layer.name;
    const identifier = document.createElement('small');
    identifier.textContent = layer.id;
    name.append(identifier);
    row.append(name);
    for (const text of [layer.contributorCount, layer.polygonCount]) {
      const cell = document.createElement('td');
      cell.textContent = String(text);
      row.append(cell);
    }
    const codeCell = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = layer.joinCode;
    codeCell.append(code);
    row.append(codeCell);
    const state = document.createElement('td');
    state.textContent = layer.deletedAt ? 'Deleted' : 'Active';
    if (layer.deletedAt) state.title = new Date(layer.deletedAt).toLocaleString();
    row.append(state);
    const actions = document.createElement('td');
    if (!layer.deletedAt) {
      const copy = document.createElement('button');
      copy.textContent = 'Copy code';
      copy.setAttribute('aria-label', `Copy share code for ${layer.name}`);
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(layer.joinCode);
          status.textContent = `Share code copied for ${layer.name}.`;
        } catch {
          status.textContent = 'Copy was unavailable. Select the share code in the table to copy it.';
        }
      });
      actions.append(copy);
    }
    const change = document.createElement('button');
    change.textContent = layer.deletedAt ? 'Undo delete' : 'Delete';
    change.classList.toggle('delete', !layer.deletedAt);
    change.setAttribute('aria-label', `${change.textContent}: ${layer.name}`);
    change.addEventListener('click', () => changeDeletion(layer));
    actions.append(change);
    row.append(actions);
    return row;
  }));
  status.textContent = layers.length ? `${layers.length} shared layers.` : 'No shared layers on this site.';
}

/**
 * Delete or restore a layer and refresh the authoritative list.
 * @param {AdminSharedLayer} layer Layer represented by the clicked row.
 * @returns {Promise<void>} Errors are displayed on the page.
 */
async function changeDeletion(layer) {
  if (!layer.deletedAt && !await confirmDeletion(layer.name)) return;
  setBusy(true);
  status.textContent = layer.deletedAt ? 'Restoring layer…' : 'Deleting layer…';
  try {
    const path = `/api/admin/shared-layers/${layer.id}`;
    await request(layer.deletedAt ? `${path}/restore` : path, layer.deletedAt ? 'POST' : 'DELETE');
    await loadLayers();
    status.textContent = layer.deletedAt ? `Restored ${layer.name}.` : `Deleted ${layer.name}. Undo is available in its row.`;
    rows.querySelector(`[data-layer-id="${layer.id}"] button`)?.focus();
  } catch (error) {
    status.textContent = `${error.message} Refresh the list to check the current state.`;
  } finally {
    setBusy(false);
  }
}

/**
 * Ask for confirmation with Cancel focused first; Escape also cancels.
 * @param {string} name Display name of the layer to delete.
 * @returns {Promise<boolean>} True only when Delete layer is clicked.
 */
function confirmDeletion(name) {
  document.querySelector('#confirm-description').textContent = `Contributors will lose access to “${name}”.`;
  confirmation.returnValue = 'cancel';
  return new Promise(resolve => {
    confirmation.addEventListener('close', () => resolve(confirmation.returnValue === 'delete'), { once: true });
    confirmation.showModal();
  });
}

/**
 * Refresh the list and report failures without removing the last successful snapshot.
 * @returns {Promise<void>}
 */
async function refreshLayers() {
  setBusy(true);
  status.textContent = 'Loading shared layers…';
  try {
    await loadLayers();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

refresh.addEventListener('click', refreshLayers);
refreshLayers();
