/** @typedef {{id: string, name: string, joinCode: string, deletedAt: string|null, contributorCount: number, polygonCount: number}} AdminSharedLayer */
/** @typedef {{slug: string, title: string, deletedAt: string|null, hasEditLink: boolean}} AdminPublishedMap */

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
 * @returns {Promise<AdminSharedLayer[]|AdminPublishedMap[]|{editToken:string}|null>}
 * Admin list, newly issued edit token, or empty mutation result.
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
 * @param {string} name Display name of the map or layer to delete.
 * @param {'layer'|'map'} [kind='layer'] Record type for the confirmation message.
 * @returns {Promise<boolean>} True only when the deletion button is clicked.
 */
function confirmDeletion(name, kind = 'layer') {
  document.querySelector('#confirm-title').textContent = kind === 'map' ? 'Delete published map?' : 'Delete shared layer?';
  document.querySelector('#accept-delete').textContent = kind === 'map' ? 'Delete map' : 'Delete layer';
  document.querySelector('#confirm-description').textContent = kind === 'map'
    ? `The published link for “${name}” will become unavailable. Its shared layers and polygons will not be deleted.`
    : `Contributors will lose access to “${name}”.`;
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

const mapEditLinkDialog = document.querySelector('#map-edit-link-dialog');
const mapEditLinkValue = document.querySelector('#map-edit-link-value');
const mapEditLinkStatus = document.querySelector('#map-edit-link-status');
document.querySelector('#copy-map-edit-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(mapEditLinkValue.value);
    mapEditLinkStatus.textContent = 'Private edit link copied.';
  } catch {
    mapEditLinkValue.focus();
    mapEditLinkValue.select();
    mapEditLinkStatus.textContent = 'Copy the selected link.';
  }
});
mapEditLinkDialog.addEventListener('close', () => {
  mapEditLinkValue.value = '';
  mapEditLinkStatus.textContent = '';
  const slug = mapEditLinkDialog.dataset.mapSlug;
  document.querySelector(`[data-map-slug="${slug}"] .published-map-actions button`)?.focus();
});

/**
 * List published maps and their available administration actions.
 * @returns {Promise<boolean>} Whether the list loaded; failures keep the previous rows.
 */
async function loadPublishedMaps() {
  const message = document.querySelector('#maps-status');
  const button = document.querySelector('#refresh-maps');
  button.disabled = true;
  try {
    const maps = await request('/api/admin/saved-maps');
    document.querySelector('#maps').replaceChildren(...maps.map(map => {
      const row = document.createElement('tr');
      row.dataset.mapSlug = map.slug;
      row.classList.toggle('deleted', !!map.deletedAt);
      const title = document.createElement('th');
      title.scope = 'row';
      title.textContent = map.title;
      const path = `/maps/${encodeURIComponent(map.slug)}`;
      const url = document.createElement('td');
      url.textContent = path;
      const actionCell = document.createElement('td');
      const actions = document.createElement('div');
      actions.className = 'published-map-actions';
      actionCell.append(actions);
      for (const [label, href] of map.deletedAt ? [] : [['Open', path], ['Edit', `/admin-eolab/maps/${encodeURIComponent(map.slug)}/edit`]]) {
        const link = document.createElement('a');
        link.textContent = label;
        link.href = href;
        link.setAttribute('aria-label', `${label}: ${map.title}`);
        actions.append(link);
      }
      if (!map.deletedAt) {
        const issue = document.createElement('button');
        issue.textContent = map.hasEditLink ? 'Replace private edit link' : 'Create private edit link';
        issue.setAttribute('aria-label', `${issue.textContent}: ${map.title}`);
        issue.addEventListener('click', () => changeMapEditLink(map, 'issue'));
        actions.append(issue);
      }
      if (map.hasEditLink) {
        const revoke = document.createElement('button');
        revoke.textContent = 'Revoke private edit link';
        revoke.setAttribute('aria-label', `${revoke.textContent}: ${map.title}`);
        revoke.addEventListener('click', () => changeMapEditLink(map, 'revoke'));
        actions.append(revoke);
      }
      const state = document.createElement('td');
      state.textContent = map.deletedAt ? 'Deleted' : 'Active';
      if (map.deletedAt) state.title = new Date(map.deletedAt).toLocaleString();
      const change = document.createElement('button');
      change.textContent = map.deletedAt ? 'Undo delete' : 'Delete';
      change.classList.toggle('delete', !map.deletedAt);
      change.setAttribute('aria-label', `${change.textContent}: ${map.title}`);
      change.addEventListener('click', () => changeMapDeletion(map));
      actions.append(change);
      row.append(title, url, state, actionCell);
      return row;
    }));
    message.textContent = maps.length ? `${maps.length} published maps.` : 'No published maps on this site.';
    return true;
  } catch (error) {
    message.textContent = error.message;
    return false;
  } finally {
    button.disabled = false;
  }
}

/**
 * Issue a new edit link or disable the existing link for a selected map.
 * @param {AdminPublishedMap} map Map represented by the clicked row.
 * @param {'issue'|'revoke'} action Create or replace the link, or disable it.
 * @returns {Promise<void>} Completion after showing the new link or revocation status.
 */
async function changeMapEditLink(map, action) {
  if (map.hasEditLink) {
    const verb = action === 'revoke' ? 'Revoke' : 'Replace';
    if (!window.confirm(`${verb} the private edit link for “${map.title}”? The current edit link will stop working.`)) return;
  }
  setBusy(true);
  const message = document.querySelector('#maps-status');
  message.textContent = 'Updating private edit link…';
  try {
    const slug = encodeURIComponent(map.slug);
    const result = await request(`/api/admin/saved-maps/${slug}/edit-link`, action === 'issue' ? 'POST' : 'DELETE');
    if (result) {
      document.querySelector('#map-edit-link-title').textContent = `Private edit link for ${map.title}`;
      mapEditLinkValue.value = new URL(`/maps/${slug}/edit#${result.editToken}`, window.location.origin).href;
      mapEditLinkDialog.dataset.mapSlug = slug;
      mapEditLinkDialog.showModal();
      mapEditLinkValue.select();
    }
    if (await loadPublishedMaps()) {
      message.textContent = result ? 'Created a new private edit link.' : 'Private edit link revoked.';
    }
  } catch (error) {
    message.textContent = `${error.message} Refresh the list to check the current state.`;
  } finally {
    setBusy(false);
    if (!mapEditLinkDialog.open) {
      document.querySelector(`[data-map-slug="${map.slug}"] .published-map-actions button`)?.focus();
    }
  }
}

/**
 * Delete or restore a published map without changing its referenced shared layers.
 * @param {AdminPublishedMap} map Map represented by the clicked row.
 * @returns {Promise<void>} Errors are displayed without retrying the mutation.
 */
async function changeMapDeletion(map) {
  if (!map.deletedAt && !await confirmDeletion(map.title, 'map')) return;
  setBusy(true);
  const message = document.querySelector('#maps-status');
  message.textContent = map.deletedAt ? 'Restoring map…' : 'Deleting map…';
  try {
    const path = `/api/admin/saved-maps/${encodeURIComponent(map.slug)}`;
    await request(map.deletedAt ? `${path}/restore` : path, map.deletedAt ? 'POST' : 'DELETE');
    if (await loadPublishedMaps()) {
      message.textContent = map.deletedAt ? `Restored ${map.title}.` : `Deleted ${map.title}. Undo is available in its row.`;
    }
  } catch (error) {
    message.textContent = `${error.message} Refresh the list to check the current state.`;
  } finally {
    setBusy(false);
    document.querySelector(`[data-map-slug="${map.slug}"] button`)?.focus();
  }
}

document.querySelector('#refresh-maps').addEventListener('click', loadPublishedMaps);
loadPublishedMaps();
