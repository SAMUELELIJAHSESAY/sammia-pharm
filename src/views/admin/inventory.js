import {
  getProductsPage,
  getInventorySummary,
  getProductCategories,
  getProductStockLogs,
  updateProduct,
  deleteProduct,
  getBranches,
  getPharmacySettings,
  getInventoryCachePage,
  resolveOfflineInventoryConflict
} from '../../database.js';
import {
  makeOfflineScope,
  cacheInventoryBootstrap,
  getCachedInventoryBootstrap,
  mergeCachedPOSProducts,
  replaceCachedPOSProducts,
  getCachedPOSProductsByIds,
  queryCachedInventoryProducts,
  queueOfflineInventoryOperation,
  getInventoryConflicts,
  acceptServerInventoryConflict,
  retryInventoryConflictWithLocalChanges,
  countCachedProducts
} from '../../offline-db.js';
import { getOfflineSyncSnapshot, requestOfflineSync } from '../../offline-sync.js';
import { formatCurrency, formatDate, formatDateTime, showToast, showConfirm, isExpired, isExpiringSoon, debounce } from '../../utils.js';
import { createModal } from '../../components/modal.js';

let allProducts = []; // Current visible page only.
let branches = [];
let selectedBranchId = null;
let currentFilterType = null;
let currentSearchTerm = '';
let containerRef = null;
let inventoryOfflineScope = null;
let inventoryOfflineMode = false;
let inventoryUser = null;
const inventoryCachePriming = new Set();
let inventorySyncHandler = null;
let inventoryRefreshAfterSync = false;
let inventoryDataRequestSequence = 0;

const inventoryState = {
  page: 1,
  pageSize: 30,
  totalCount: 0,
  search: '',
  category: '',
  filterType: '',
  sortType: '',
  categories: [],
  summary: {
    totalProducts: 0,
    lowStockCount: 0,
    expiredCount: 0,
    expiringSoonCount: 0
  }
};

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeFilterType(value) {
  return value === 'expiring' ? 'expiring-30' : (value || '');
}

function getInventoryQueryOptions() {
  return {
    branchId: selectedBranchId,
    page: inventoryState.page,
    pageSize: inventoryState.pageSize,
    search: inventoryState.search,
    category: inventoryState.category,
    filterType: inventoryState.filterType,
    sortType: inventoryState.sortType
  };
}

function getInventoryScope(user, branchId = selectedBranchId) {
  return makeOfflineScope(user?.id, user?.profile?.pharmacy_id, branchId);
}

async function primeInventoryBranchCache(user, branchId) {
  if (!navigator.onLine || !user?.id || !branchId || inventoryCachePriming.has(branchId)) return;
  inventoryCachePriming.add(branchId);
  const scope = getInventoryScope(user, branchId);
  try {
    const rows = [];
    const pageSize = 250;
    let page = 1;
    let total = Infinity;
    while (rows.length < total && navigator.onLine) {
      const result = await getInventoryCachePage(user.profile.pharmacy_id, branchId, { page, pageSize });
      rows.push(...(result.products || []));
      total = Number(result.count || 0);
      if (!result.products?.length || rows.length >= total) break;
      page += 1;
    }
    if (navigator.onLine) {
      await replaceCachedPOSProducts(scope, rows);
      window.dispatchEvent(new CustomEvent('sammia:offline-cache-updated', { detail: { scope, products: rows.length, inventory: true } }));
    }
  } catch (error) {
    console.warn('Inventory offline cache refresh failed:', error?.message || error);
  } finally {
    inventoryCachePriming.delete(branchId);
  }
}

async function primeInventoryWorkspaceCache(user, branchList = []) {
  if (!navigator.onLine) return;
  for (const branch of branchList) {
    if (!navigator.onLine) break;
    await primeInventoryBranchCache(user, branch.id);
  }
}

async function loadCachedInventory(user, { queryOptions = getInventoryQueryOptions(), commitGuard = () => true } = {}) {
  const scope = getInventoryScope(user);
  const cached = await queryCachedInventoryProducts(scope, queryOptions);
  if (!commitGuard()) return { stale: true };

  inventoryOfflineScope = scope;
  inventoryState.summary = cached.summary;
  inventoryState.categories = cached.categories;
  inventoryState.totalCount = cached.count;
  allProducts = cached.products;
  inventoryOfflineMode = true;

  const totalPages = Math.max(1, Math.ceil(inventoryState.totalCount / inventoryState.pageSize));
  if (inventoryState.page > totalPages) {
    inventoryState.page = totalPages;
    const correctedOptions = { ...queryOptions, page: totalPages };
    const corrected = await queryCachedInventoryProducts(scope, correctedOptions);
    if (!commitGuard()) return { stale: true };
    inventoryState.totalCount = corrected.count;
    allProducts = corrected.products;
  }
  return cached;
}

async function fetchInventoryData(user, { refreshMeta = false, preferCache = false, commitGuard = () => true } = {}) {
  const pharmacyId = user.profile.pharmacy_id;
  const queryOptions = { ...getInventoryQueryOptions() };
  const requestScope = getInventoryScope(user, queryOptions.branchId);

  if (preferCache || !navigator.onLine) {
    return loadCachedInventory(user, { queryOptions, commitGuard });
  }

  try {
    const pagePromise = getProductsPage(pharmacyId, queryOptions);
    let pageResult;
    let nextSummary = inventoryState.summary;
    let nextCategories = inventoryState.categories;

    if (refreshMeta) {
      const [result, summary, categories] = await Promise.all([
        pagePromise,
        getInventorySummary(pharmacyId, queryOptions.branchId),
        getProductCategories(pharmacyId, queryOptions.branchId)
      ]);
      pageResult = result;
      nextSummary = summary;
      nextCategories = categories;
    } else {
      pageResult = await pagePromise;
    }

    if (!commitGuard()) return { stale: true };

    await mergeCachedPOSProducts(requestScope, pageResult.products || []);
    if (!commitGuard()) return { stale: true };

    const cachedVisible = await getCachedPOSProductsByIds(requestScope, (pageResult.products || []).map((product) => product.id));
    if (!commitGuard()) return { stale: true };

    const cachedById = new Map(cachedVisible.map((product) => [product.id, product]));
    inventoryOfflineScope = requestScope;
    inventoryState.summary = nextSummary;
    inventoryState.categories = nextCategories;
    inventoryState.totalCount = pageResult.count;
    allProducts = (pageResult.products || []).map((product) => cachedById.get(product.id) || product);
    inventoryOfflineMode = false;

    const totalPages = Math.max(1, Math.ceil(inventoryState.totalCount / inventoryState.pageSize));
    if (inventoryState.page > totalPages) {
      inventoryState.page = totalPages;
      const correctedOptions = { ...queryOptions, page: totalPages };
      const corrected = await getProductsPage(pharmacyId, correctedOptions);
      if (!commitGuard()) return { stale: true };
      await mergeCachedPOSProducts(requestScope, corrected.products || []);
      if (!commitGuard()) return { stale: true };
      const correctedCached = await getCachedPOSProductsByIds(requestScope, (corrected.products || []).map((product) => product.id));
      if (!commitGuard()) return { stale: true };
      const correctedById = new Map(correctedCached.map((product) => [product.id, product]));
      inventoryState.totalCount = corrected.count;
      allProducts = (corrected.products || []).map((product) => correctedById.get(product.id) || product);
    }

    if (refreshMeta && commitGuard()) primeInventoryBranchCache(user, queryOptions.branchId).catch(() => {});
    return pageResult;
  } catch (error) {
    if (!commitGuard()) return { stale: true };
    const bootstrap = await getCachedInventoryBootstrap(user.id, pharmacyId).catch(() => null);
    if (!bootstrap) throw error;
    return loadCachedInventory(user, { queryOptions, commitGuard });
  }
}

async function refreshInventory(container, user, branchList, options = {}) {
  const { refreshMeta = false, focusSearch = false, preferCache = false } = options;
  const requestId = ++inventoryDataRequestSequence;
  const requestKey = JSON.stringify(getInventoryQueryOptions());
  const commitGuard = () => requestId === inventoryDataRequestSequence
    && JSON.stringify(getInventoryQueryOptions()) === requestKey;

  try {
    const result = await fetchInventoryData(user, { refreshMeta, preferCache, commitGuard });
    if (result?.stale || !commitGuard()) return;

    renderView(container, allProducts, user, branchList);
    updateInventoryConnectivityUI(user).catch(() => {});
    if (focusSearch) {
      const input = document.getElementById('product-search');
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  } catch (err) {
    if (!commitGuard()) return;
    showToast(`Failed to load inventory: ${err.message}`, 'error');
  }
}

export async function renderInventory(container, user, filterType = null, initialSearch = '', initialBranchId = null) {
  currentFilterType = normalizeFilterType(filterType);
  currentSearchTerm = String(initialSearch || '').trim();
  inventoryUser = user;

  if (!user) {
    container.innerHTML = `<div class="alert alert-warning">User not authenticated. Please refresh the page.</div>`;
    return;
  }

  const pharmacyId = user.profile?.pharmacy_id;
  if (!pharmacyId) {
    container.innerHTML = `<div class="alert alert-warning">No pharmacy linked to your account.</div>`;
    return;
  }

  try {
    const cachedBootstrap = await getCachedInventoryBootstrap(user.id, pharmacyId).catch(() => null);
    let settings = cachedBootstrap?.settings || window.pharmacySettings || null;
    let branchRows = cachedBootstrap?.branches || [];

    if (navigator.onLine) {
      try {
        [settings, branchRows] = await Promise.all([
          getPharmacySettings(pharmacyId),
          getBranches(pharmacyId)
        ]);
        window.pharmacySettings = settings || { currency_symbol: 'Le', currency_code: 'NLE' };
        await cacheInventoryBootstrap({ userId: user.id, pharmacyId, branches: branchRows, settings: window.pharmacySettings });
      } catch (error) {
        if (!cachedBootstrap) throw error;
        inventoryOfflineMode = true;
      }
    } else if (!cachedBootstrap) {
      throw new Error('Inventory is not prepared for offline use on this device yet. Connect to the internet and open Inventory once.');
    }

    if (!window.pharmacySettings?.currency_symbol) {
      window.pharmacySettings = settings || { currency_symbol: 'Le', currency_code: 'NLE' };
    }

    branches = branchRows || [];
    selectedBranchId = initialBranchId && branches.some((branch) => branch.id === initialBranchId)
      ? initialBranchId
      : (branches.length > 0 ? branches[0].id : null);

    if (!selectedBranchId) {
      container.innerHTML = `<div class="alert alert-warning">No branch is available for inventory management.</div>`;
      return;
    }

    inventoryOfflineScope = getInventoryScope(user, selectedBranchId);
    inventoryState.page = 1;
    inventoryState.pageSize = 30;
    inventoryState.search = currentSearchTerm;
    inventoryState.category = '';
    inventoryState.filterType = currentFilterType;
    inventoryState.sortType = '';

    await fetchInventoryData(user, { refreshMeta: true, preferCache: !navigator.onLine });
    renderView(container, allProducts, user, branches);
    bindInventorySyncEvents(user);
    updateInventoryConnectivityUI(user).catch(() => {});
    if (navigator.onLine) primeInventoryWorkspaceCache(user, branches).catch(() => {});
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">Failed to load inventory: ${escapeHtml(err.message)}</div>`;
  }
}

function bindInventorySyncEvents(user) {
  if (inventorySyncHandler) {
    window.removeEventListener('sammia:offline-sync-status', inventorySyncHandler);
    window.removeEventListener('sammia:offline-queue-changed', inventorySyncHandler);
    window.removeEventListener('sammia:offline-cache-updated', inventorySyncHandler);
  }

  inventorySyncHandler = async (event) => {
    await updateInventoryConnectivityUI(user).catch(() => {});
    const detail = event?.detail || {};
    const shouldRefreshFromServer = detail.type === 'online'
      || (detail.type === 'sync_finished' && (Number(detail.syncedInventory || 0) > 0 || Number(detail.inventoryConflictCount || 0) > 0));
    if (shouldRefreshFromServer && navigator.onLine && containerRef && !inventoryRefreshAfterSync) {
      inventoryRefreshAfterSync = true;
      window.setTimeout(async () => {
        try {
          await refreshInventory(containerRef, user, branches, { refreshMeta: true });
        } finally {
          inventoryRefreshAfterSync = false;
        }
      }, 250);
    }
  };

  window.addEventListener('sammia:offline-sync-status', inventorySyncHandler);
  window.addEventListener('sammia:offline-queue-changed', inventorySyncHandler);
  window.addEventListener('sammia:offline-cache-updated', inventorySyncHandler);
}

async function updateInventoryConnectivityUI(user = inventoryUser) {
  if (!user?.id || !inventoryOfflineScope) return;
  const snapshot = await getOfflineSyncSnapshot({ scope: inventoryOfflineScope }).catch(() => ({
    online: navigator.onLine,
    syncing: false,
    inventoryPendingCount: 0,
    inventoryConflictCount: 0
  }));
  const effectivelyOffline = !snapshot.online || inventoryOfflineMode;
  const pending = Number(snapshot.inventoryPendingCount || 0);
  const conflicts = Number(snapshot.inventoryConflictCount || 0);
  const chip = document.getElementById('inventory-sync-status');
  const banner = document.getElementById('inventory-offline-banner');
  const conflictBtn = document.getElementById('inventory-conflicts-btn');
  const bannerSync = document.getElementById('inventory-banner-sync');

  if (chip) {
    chip.className = 'inventory-sync-chip';
    if (conflicts > 0) {
      chip.classList.add('conflict');
      chip.textContent = `⚠ ${conflicts} conflict${conflicts === 1 ? '' : 's'}`;
    } else if (effectivelyOffline) {
      chip.classList.add('offline');
      chip.textContent = `● Offline${pending ? ` · ${pending} waiting` : ''}`;
    } else if (snapshot.syncing) {
      chip.classList.add('syncing');
      chip.textContent = `↻ Syncing${pending ? ` ${pending}` : ''}…`;
    } else if (pending > 0) {
      chip.classList.add('pending');
      chip.textContent = `↻ ${pending} change${pending === 1 ? '' : 's'} waiting`;
    } else {
      chip.classList.add('synced');
      chip.textContent = '✓ Inventory synced';
    }
  }

  if (banner) {
    banner.style.display = effectivelyOffline ? 'flex' : 'none';
    const span = banner.querySelector('span');
    if (span) span.textContent = pending
      ? `${pending} inventory change${pending === 1 ? '' : 's'} ${pending === 1 ? 'is' : 'are'} safely stored on this device and will synchronize when internet returns.`
      : 'Cached inventory is available on this device. New changes will synchronize when internet returns.';
  }
  if (bannerSync) bannerSync.disabled = !snapshot.online || snapshot.syncing || pending === 0;
  if (conflictBtn) conflictBtn.classList.toggle('hidden', conflicts === 0);

  document.querySelectorAll('[data-online-only="true"]').forEach((button) => {
    button.disabled = effectivelyOffline;
    button.title = effectivelyOffline ? 'This bulk/server-history action requires internet.' : '';
  });
}

function inventoryOperationLabel(operation) {
  if (operation.operation_type === 'create_product') return `New product · ${operation.payload?.name || 'Product'}`;
  if (operation.operation_type === 'update_product') return `Product details update`;
  if (operation.operation_type === 'stock_delta') {
    const delta = Number(operation.stock_delta_units || 0);
    return `${operation.change_type === 'restock' ? 'Restock' : 'Stock adjustment'} · ${delta > 0 ? '+' : ''}${delta} base units`;
  }
  return operation.operation_type || 'Inventory change';
}

async function showInventorySyncCenter(user) {
  const [snapshot, cachedCount] = await Promise.all([
    getOfflineSyncSnapshot({ scope: inventoryOfflineScope }),
    countCachedProducts(inventoryOfflineScope).catch(() => 0)
  ]);
  const pendingRows = (snapshot.pendingInventory || []).map((operation) => `
    <div class="inventory-sync-list-row">
      <div><strong>${escapeHtml(inventoryOperationLabel(operation))}</strong><span>${formatDateTime(operation.created_at)}</span></div>
      <span class="badge badge-warning">Waiting</span>
    </div>
  `).join('');

  const { overlay, closeModal } = createModal({
    id: 'inventory-sync-center',
    title: 'Inventory Sync Center',
    size: 'modal-lg',
    body: `
      <div class="inventory-sync-overview">
        <div><span>Connection</span><strong>${snapshot.online ? '● Online' : '● Offline'}</strong></div>
        <div><span>Waiting to sync</span><strong>${snapshot.inventoryPendingCount || 0}</strong></div>
        <div><span>Cached products</span><strong>${cachedCount.toLocaleString()}</strong></div>
        <div><span>Conflicts</span><strong>${snapshot.inventoryConflictCount || 0}</strong></div>
      </div>
      <div class="text-xs text-muted" style="margin:0.75rem 0 1rem;">Last synchronization: ${snapshot.lastSyncAt ? formatDateTime(snapshot.lastSyncAt) : 'Not yet on this device'}</div>
      ${pendingRows ? `<div class="inventory-sync-list">${pendingRows}</div>` : `<div class="empty-state" style="padding:1.4rem"><div class="empty-state-title">No inventory changes waiting</div><div class="empty-state-desc">This branch is synchronized with the server.</div></div>`}
    `,
    footer: `
      <button type="button" class="btn btn-ghost" id="inventory-sync-close">Close</button>
      ${snapshot.inventoryConflictCount ? '<button type="button" class="btn btn-warning" id="inventory-sync-review">Review Conflicts</button>' : ''}
      <button type="button" class="btn btn-primary" id="inventory-sync-now" ${snapshot.online && snapshot.inventoryPendingCount ? '' : 'disabled'}>Sync Now</button>
    `
  });
  overlay.querySelector('#inventory-sync-close')?.addEventListener('click', closeModal);
  overlay.querySelector('#inventory-sync-review')?.addEventListener('click', () => {
    closeModal();
    showInventoryConflictCenter(user, async (options = {}) => refreshInventory(containerRef, user, branches, { refreshMeta: true, ...options }));
  });
  overlay.querySelector('#inventory-sync-now')?.addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    event.currentTarget.textContent = 'Syncing…';
    const result = await requestOfflineSync({ reason: 'inventory_sync_center' });
    closeModal();
    if (result.migrationRequired) showToast('Offline Inventory migration must be applied in Supabase before queued changes can sync.', 'warning');
    else showToast(result.syncedInventory ? `${result.syncedInventory} inventory change${result.syncedInventory === 1 ? '' : 's'} synchronized` : 'Inventory is already synchronized');
    await updateInventoryConnectivityUI(user);
  });
}

function renderConflictDetails(conflict) {
  if (conflict.conflict_type === 'stock') {
    const details = conflict.operation || {};
    return `
      <div class="text-sm text-muted">${escapeHtml(conflict.message || 'Stock changed while this device was offline.')}</div>
      <div class="text-xs text-muted" style="margin-top:0.5rem;">Queued change: ${Number(details.stock_delta_units || 0) > 0 ? '+' : ''}${Number(details.stock_delta_units || 0).toLocaleString()} base units</div>
    `;
  }
  const patch = conflict.operation?.payload || {};
  const server = conflict.server_product || {};
  const rows = Object.entries(patch).filter(([key]) => !['pharmacy_id'].includes(key)).map(([key, value]) => `
    <tr><td>${escapeHtml(key.replaceAll('_', ' '))}</td><td>${escapeHtml(value ?? '—')}</td><td>${escapeHtml(server[key] ?? '—')}</td></tr>
  `).join('');
  return `
    <div class="text-sm text-muted" style="margin-bottom:0.6rem;">${escapeHtml(conflict.message || 'Product details changed on the server.')}</div>
    <div class="table-container"><table><thead><tr><th>Field</th><th>Your offline value</th><th>Server value</th></tr></thead><tbody>${rows || '<tr><td colspan="3">No changed fields available.</td></tr>'}</tbody></table></div>
  `;
}

async function showInventoryConflictCenter(user, updateView) {
  const conflicts = await getInventoryConflicts({ scope: inventoryOfflineScope });
  const { overlay, closeModal } = createModal({
    id: 'inventory-conflict-center',
    title: `Offline Inventory Conflicts${conflicts.length ? ` (${conflicts.length})` : ''}`,
    size: 'modal-xl',
    body: conflicts.length ? `
      <div class="inventory-conflict-list">
        ${conflicts.map((conflict) => `
          <div class="inventory-conflict-card" data-conflict="${conflict.local_conflict_id}">
            <div class="inventory-conflict-heading"><div><strong>${escapeHtml(conflict.product_name || 'Product')}</strong><span>${conflict.conflict_type === 'stock' ? 'Stock reconciliation' : 'Product details conflict'}</span></div><span class="badge badge-warning">Needs review</span></div>
            ${renderConflictDetails(conflict)}
            <div class="inventory-conflict-actions">
              ${conflict.conflict_type === 'metadata' ? `<button type="button" class="btn btn-ghost btn-sm" data-conflict-action="server" data-id="${conflict.local_conflict_id}">Keep Server Value</button><button type="button" class="btn btn-primary btn-sm" data-conflict-action="local" data-id="${conflict.local_conflict_id}">Use My Offline Changes</button>` : `<button type="button" class="btn btn-primary btn-sm" data-conflict-action="ack" data-id="${conflict.local_conflict_id}">Acknowledge Reconciliation</button>`}
            </div>
          </div>
        `).join('')}
      </div>
    ` : `<div class="empty-state"><div class="empty-state-title">No conflicts</div><div class="empty-state-desc">All offline inventory changes have been reconciled.</div></div>`,
    footer: `<button type="button" class="btn btn-ghost" id="inventory-conflicts-close">Close</button>`
  });
  overlay.querySelector('#inventory-conflicts-close')?.addEventListener('click', closeModal);

  overlay.querySelectorAll('[data-conflict-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!navigator.onLine) return showToast('Reconnect to the internet before resolving a synchronization conflict.', 'warning');
      const localId = button.dataset.id;
      const conflict = conflicts.find((item) => item.local_conflict_id === localId);
      if (!conflict) return;
      button.disabled = true;
      try {
        if (button.dataset.conflictAction === 'local') {
          await retryInventoryConflictWithLocalChanges(localId);
          await requestOfflineSync({ reason: 'inventory_conflict_use_local' });
          showToast('Your offline changes were reapplied to the latest server version');
        } else {
          if (conflict.server_conflict_id) {
            await resolveOfflineInventoryConflict(conflict.server_conflict_id, button.dataset.conflictAction === 'ack' ? 'acknowledged' : 'keep_server');
          }
          await acceptServerInventoryConflict(localId);
          showToast(conflict.conflict_type === 'stock' ? 'Stock reconciliation acknowledged' : 'Server product values kept');
        }
        closeModal();
        await updateView({ preferCache: !navigator.onLine });
        await updateInventoryConnectivityUI(user);
      } catch (error) {
        button.disabled = false;
        showToast(error.message, 'error');
      }
    });
  });
}

function renderView(container, products, user, branchList) {
  containerRef = container;
  const summary = inventoryState.summary;
  const branchName = selectedBranchId
    ? branchList.find((branch) => branch.id === selectedBranchId)?.name || 'Branch'
    : 'All Branches';
  const totalPages = Math.max(1, Math.ceil(inventoryState.totalCount / inventoryState.pageSize));
  const fromItem = inventoryState.totalCount === 0 ? 0 : ((inventoryState.page - 1) * inventoryState.pageSize) + 1;
  const toItem = Math.min(inventoryState.page * inventoryState.pageSize, inventoryState.totalCount);

  container.innerHTML = `
    <div class="animate-in">
      <div class="page-header">
        <div>
          <div class="page-title">Inventory</div>
          <div class="page-subtitle">Manage products, stock, expiry and movement history without loading the entire catalogue at once.</div>
        </div>
        <div class="flex gap-2 inventory-header-actions">
          <button type="button" class="inventory-sync-chip" id="inventory-sync-status" title="Open Inventory Sync Center">Checking sync…</button>
          <button type="button" class="btn btn-ghost inventory-conflicts-btn hidden" id="inventory-conflicts-btn">⚠ Review Conflicts</button>
          <button class="btn btn-ghost" id="stock-log-btn" data-online-only="true">Stock History</button>
          <button class="btn btn-ghost" id="download-template-btn">⬇️ Download Template</button>
          <button class="btn btn-ghost" id="import-csv-btn" data-online-only="true">📥 Import CSV/Excel</button>
          <button class="btn btn-ghost" id="add-multiple-btn" data-online-only="true">➕ Add Multiple</button>
          <button class="btn btn-primary" id="add-product-btn">+ Add Product</button>
        </div>
      </div>

      <div class="inventory-offline-banner" id="inventory-offline-banner" style="display:none">
        <div><strong>Offline Inventory</strong><span>Changes are saved safely on this device and will synchronize automatically when internet returns.</span></div>
        <button type="button" class="btn btn-sm btn-ghost" id="inventory-banner-sync">Sync Now</button>
      </div>

      <input type="file" id="csv-import-input" accept=".csv,.xlsx,.xls" style="display:none;" />
      <div id="import-progress" style="display:none;margin-bottom:1rem;padding:1rem;background:var(--info-light);border-radius:var(--radius);">
        <div class="text-sm font-semibold">Importing products...</div>
        <div id="import-status" class="text-xs text-muted" style="margin-top:0.5rem;"></div>
      </div>

      <div class="card inventory-branch-card">
        <div class="inventory-branch-row">
          <div class="form-group" style="margin:0;min-width:240px;">
            <label class="form-label">Select Branch</label>
            <select class="form-select" id="branch-selector">
              ${branchList.map((branch) => `<option value="${branch.id}" ${selectedBranchId === branch.id ? 'selected' : ''}>${escapeHtml(branch.name)}</option>`).join('')}
            </select>
          </div>
          <div class="inventory-branch-context">
            <span class="text-xs text-muted">Currently viewing</span>
            <strong>${escapeHtml(branchName)}</strong>
          </div>
        </div>
      </div>

      <div class="stats-grid inventory-stats-grid">
        <button type="button" class="stat-card stat-card-clickable inventory-summary-filter" data-filter="">
          <div class="stat-card-header"><span class="stat-card-label">Total Products</span><div class="stat-card-icon teal">&#128230;</div></div>
          <div class="stat-card-value">${summary.totalProducts}</div>
          <div class="stat-card-subtitle">Active in this branch</div>
        </button>
        <button type="button" class="stat-card stat-card-clickable inventory-summary-filter" data-filter="low-stock">
          <div class="stat-card-header"><span class="stat-card-label">Low Stock</span><div class="stat-card-icon amber">&#9888;</div></div>
          <div class="stat-card-value">${summary.lowStockCount}</div>
          <div class="stat-card-subtitle">Needs restocking</div>
        </button>
        <button type="button" class="stat-card stat-card-clickable inventory-summary-filter" data-filter="expired">
          <div class="stat-card-header"><span class="stat-card-label">Expired</span><div class="stat-card-icon red">&#128683;</div></div>
          <div class="stat-card-value">${summary.expiredCount}</div>
          <div class="stat-card-subtitle">Remove from sale</div>
        </button>
        <button type="button" class="stat-card stat-card-clickable inventory-summary-filter" data-filter="expiring-30">
          <div class="stat-card-header"><span class="stat-card-label">Expiring ≤ 30 Days</span><div class="stat-card-icon amber">⌛</div></div>
          <div class="stat-card-value">${summary.expiringSoonCount}</div>
          <div class="stat-card-subtitle">Review soon</div>
        </button>
      </div>

      <div class="card inventory-products-card">
        <div class="card-header inventory-card-header">
          <div>
            <span class="card-title">Products in ${escapeHtml(branchName)}</span>
            <div class="text-xs text-muted inventory-result-summary">Showing ${fromItem}-${toItem} of ${inventoryState.totalCount.toLocaleString()} matching product${inventoryState.totalCount === 1 ? '' : 's'}</div>
          </div>
        </div>

        <div class="inventory-filter-panel">
          <div class="search-box inventory-product-search">
            <span style="color:var(--gray-400)">&#128269;</span>
            <input type="text" id="product-search" value="${escapeHtml(inventoryState.search)}" placeholder="Search product name, category or description..." />
          </div>
          <select class="form-select" id="cat-filter">
            <option value="">All Categories</option>
            ${inventoryState.categories.map((category) => `<option value="${escapeHtml(category)}" ${inventoryState.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}
          </select>
          <select class="form-select" id="filter-type">
            <option value="" ${!inventoryState.filterType ? 'selected' : ''}>All Stock / Expiry</option>
            <option value="low-stock" ${inventoryState.filterType === 'low-stock' ? 'selected' : ''}>Low Stock</option>
            <option value="expired" ${inventoryState.filterType === 'expired' ? 'selected' : ''}>Expired</option>
            <option value="expiring-30" ${inventoryState.filterType === 'expiring-30' ? 'selected' : ''}>Expiring in 30 Days</option>
            <option value="expiring-60" ${inventoryState.filterType === 'expiring-60' ? 'selected' : ''}>Expiring in 60 Days</option>
            <option value="expiring-90" ${inventoryState.filterType === 'expiring-90' ? 'selected' : ''}>Expiring in 90 Days</option>
            <option value="no-expiry" ${inventoryState.filterType === 'no-expiry' ? 'selected' : ''}>No Expiry Date</option>
            <option value="duplicates" ${inventoryState.filterType === 'duplicates' ? 'selected' : ''}>Duplicate Names</option>
          </select>
          <select class="form-select" id="price-sort">
            <option value="" ${!inventoryState.sortType ? 'selected' : ''}>Sort: Product Name</option>
            <option value="selling-asc" ${inventoryState.sortType === 'selling-asc' ? 'selected' : ''}>Selling Price: Low → High</option>
            <option value="selling-desc" ${inventoryState.sortType === 'selling-desc' ? 'selected' : ''}>Selling Price: High → Low</option>
            <option value="cost-asc" ${inventoryState.sortType === 'cost-asc' ? 'selected' : ''}>Cost Price: Low → High</option>
            <option value="cost-desc" ${inventoryState.sortType === 'cost-desc' ? 'selected' : ''}>Cost Price: High → Low</option>
            <option value="margin-asc" ${inventoryState.sortType === 'margin-asc' ? 'selected' : ''}>Profit Margin: Low → High</option>
            <option value="margin-desc" ${inventoryState.sortType === 'margin-desc' ? 'selected' : ''}>Profit Margin: High → Low</option>
            <option value="stock-asc" ${inventoryState.sortType === 'stock-asc' ? 'selected' : ''}>Stock: Low → High</option>
            <option value="stock-desc" ${inventoryState.sortType === 'stock-desc' ? 'selected' : ''}>Stock: High → Low</option>
            <option value="expiry-asc" ${inventoryState.sortType === 'expiry-asc' ? 'selected' : ''}>Expiry: Soonest First</option>
          </select>
          <select class="form-select inventory-page-size" id="inventory-page-size" title="Products per page">
            ${[25, 30, 50].map((size) => `<option value="${size}" ${inventoryState.pageSize === size ? 'selected' : ''}>${size} / page</option>`).join('')}
          </select>
          <button type="button" class="btn btn-ghost" id="clear-inventory-filters">Clear</button>
        </div>

        <div id="bulk-actions-bar" style="display:none;padding:1rem;background:var(--blue-light);border-bottom:1px solid var(--border);gap:1rem;align-items:center;flex-wrap:wrap">
          <span id="bulk-count" class="font-semibold"></span>
          <button class="btn btn-ghost btn-sm" id="bulk-edit-btn" data-online-only="true">✏️ Bulk Edit</button>
          <button class="btn btn-ghost btn-sm" id="bulk-deactivate-btn" data-online-only="true" style="color:var(--amber)">🔒 Deactivate</button>
          <button class="btn btn-ghost btn-sm" id="bulk-activate-btn" data-online-only="true" style="color:var(--success)">✓ Activate</button>
          <button class="btn btn-ghost btn-sm" id="bulk-delete-btn" data-online-only="true" style="color:var(--danger)">🗑️ Delete</button>
          <button class="btn btn-ghost btn-sm" id="bulk-cancel-btn">Cancel</button>
        </div>

        <div class="table-container inventory-table-container">
          <table>
            <thead>
              <tr>
                <th style="width:40px"><input type="checkbox" id="select-all-products" /></th>
                <th>Product Name</th>
                <th>Branch</th>
                <th>Category</th>
                <th>Cost Price</th>
                <th>Selling Price</th>
                <th>Margin</th>
                <th>Stock</th>
                <th>Expiry</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="inventory-tbody">${renderRows(products, branchList)}</tbody>
          </table>
        </div>

        <div class="inventory-pagination-wrap">
          <div class="inventory-pagination-info">Page ${inventoryState.page} of ${totalPages} · ${inventoryState.pageSize} products per page</div>
          ${renderPagination(totalPages)}
        </div>
      </div>
    </div>
  `;

  const refreshPage = async (options = {}) => refreshInventory(containerRef, user, branchList, options);
  const updateView = async (options = {}) => refreshPage({ refreshMeta: true, ...options });

  document.getElementById('branch-selector')?.addEventListener('change', async (event) => {
    selectedBranchId = event.target.value || null;
    inventoryOfflineScope = getInventoryScope(user, selectedBranchId);
    inventoryState.page = 1;
    inventoryState.category = '';
    await refreshPage({ refreshMeta: true, preferCache: !navigator.onLine });
  });

  document.getElementById('inventory-sync-status')?.addEventListener('click', () => showInventorySyncCenter(user));
  document.getElementById('inventory-conflicts-btn')?.addEventListener('click', () => showInventoryConflictCenter(user, updateView));
  document.getElementById('inventory-banner-sync')?.addEventListener('click', async () => {
    if (!navigator.onLine) return showToast('Internet connection is required to synchronize.', 'warning');
    await requestOfflineSync({ reason: 'inventory_banner' });
    await updateInventoryConnectivityUI(user);
  });

  document.getElementById('add-product-btn')?.addEventListener('click', () => showProductModal(null, user, updateView, branchList));
  document.getElementById('add-multiple-btn')?.addEventListener('click', () => {
    if (!navigator.onLine) return showToast('Add Multiple requires internet. Individual products can be added offline.', 'warning');
    showAddMultipleModal(user, updateView, branchList);
  });
  document.getElementById('stock-log-btn')?.addEventListener('click', () => {
    if (!navigator.onLine) return showToast('Server stock history is available when internet returns.', 'warning');
    showStockLogs(user);
  });
  document.getElementById('download-template-btn')?.addEventListener('click', () => downloadInventoryTemplate());
  document.getElementById('import-csv-btn')?.addEventListener('click', () => {
    if (!navigator.onLine) return showToast('CSV/Excel import requires internet. Individual products can be added offline.', 'warning');
    document.getElementById('csv-import-input')?.click();
  });

  document.getElementById('csv-import-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const progressDiv = document.getElementById('import-progress');
    if (progressDiv) progressDiv.style.display = 'block';
    try {
      const fileName = file.name.toLowerCase();
      if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        const reader = new FileReader();
        reader.onload = async (readerEvent) => {
          await importProductsFromExcel(readerEvent.target.result, file.name, user, updateView, progressDiv);
        };
        reader.readAsArrayBuffer(file);
      } else if (fileName.endsWith('.csv')) {
        const reader = new FileReader();
        reader.onload = async (readerEvent) => {
          await importProductsFromCSV(readerEvent.target.result, user, updateView, progressDiv);
        };
        reader.readAsText(file);
      } else {
        showToast('File format not supported. Please use CSV or Excel (.xlsx/.xls) files.', 'error');
        if (progressDiv) progressDiv.style.display = 'none';
      }
    } catch (err) {
      showToast(`Failed to read file: ${err.message}`, 'error');
      if (progressDiv) progressDiv.style.display = 'none';
    }
  });

  const searchProducts = debounce(async () => {
    await refreshPage({ focusSearch: true });
  }, 300);

  document.getElementById('product-search')?.addEventListener('input', (event) => {
    // Update the in-memory value immediately so a slower, older request can never
    // rebuild the page with text the cashier/admin has already typed past.
    inventoryState.search = String(event.target.value || '');
    currentSearchTerm = inventoryState.search;
    inventoryState.page = 1;
    searchProducts();
  });
  document.getElementById('cat-filter')?.addEventListener('change', async (event) => {
    inventoryState.category = event.target.value;
    inventoryState.page = 1;
    await refreshPage();
  });
  document.getElementById('filter-type')?.addEventListener('change', async (event) => {
    inventoryState.filterType = normalizeFilterType(event.target.value);
    currentFilterType = inventoryState.filterType;
    inventoryState.page = 1;
    await refreshPage();
  });
  document.getElementById('price-sort')?.addEventListener('change', async (event) => {
    inventoryState.sortType = event.target.value;
    inventoryState.page = 1;
    await refreshPage();
  });
  document.getElementById('inventory-page-size')?.addEventListener('change', async (event) => {
    inventoryState.pageSize = Number(event.target.value) || 30;
    inventoryState.page = 1;
    await refreshPage();
  });
  document.getElementById('clear-inventory-filters')?.addEventListener('click', async () => {
    inventoryState.search = '';
    inventoryState.category = '';
    inventoryState.filterType = '';
    inventoryState.sortType = '';
    inventoryState.page = 1;
    currentSearchTerm = '';
    currentFilterType = '';
    await refreshPage();
  });

  document.querySelectorAll('.inventory-summary-filter').forEach((card) => {
    card.addEventListener('click', async () => {
      inventoryState.filterType = card.dataset.filter || '';
      currentFilterType = inventoryState.filterType;
      inventoryState.page = 1;
      await refreshPage();
    });
  });

  document.querySelectorAll('[data-inventory-page]').forEach((button) => {
    button.addEventListener('click', async () => {
      const nextPage = Number(button.dataset.inventoryPage);
      if (!Number.isFinite(nextPage) || nextPage < 1 || nextPage > totalPages || nextPage === inventoryState.page) return;
      inventoryState.page = nextPage;
      await refreshPage();
      document.querySelector('.inventory-products-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  document.getElementById('select-all-products')?.addEventListener('change', (event) => {
    document.querySelectorAll('.product-checkbox').forEach((checkbox) => { checkbox.checked = event.target.checked; });
    updateBulkActionsBar();
  });

  bindTableActions(products, user, updateView, branchList);
}

function renderPagination(totalPages) {
  if (totalPages <= 1) return '';
  const current = inventoryState.page;
  const pages = new Set([1, totalPages, current - 2, current - 1, current, current + 1, current + 2]);
  const validPages = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const parts = [];
  let previous = 0;

  validPages.forEach((page) => {
    if (previous && page - previous > 1) parts.push('<span class="inventory-page-ellipsis">…</span>');
    parts.push(`<button type="button" class="btn btn-ghost btn-sm inventory-page-btn ${page === current ? 'active' : ''}" data-inventory-page="${page}" ${page === current ? 'disabled' : ''}>${page}</button>`);
    previous = page;
  });

  return `
    <div class="inventory-pagination">
      <button type="button" class="btn btn-ghost btn-sm" data-inventory-page="${current - 1}" ${current <= 1 ? 'disabled' : ''}>← Previous</button>
      <div class="inventory-page-numbers">${parts.join('')}</div>
      <button type="button" class="btn btn-ghost btn-sm" data-inventory-page="${current + 1}" ${current >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>
  `;
}

function renderRows(products, branchList) {
  if (!products.length) {
    return `<tr><td colspan="11"><div class="empty-state"><div class="empty-state-icon">&#128230;</div><div class="empty-state-title">No products found</div><div class="empty-state-desc">Try a different search or filter, or add a product to this branch.</div></div></td></tr>`;
  }

  return products.map((product) => {
    const stockBoxes = Number(product.stock_boxes || 0);
    const stockUnits = Number(product.stock_units || 0);
    const unitsPerBox = Math.max(1, Number(product.units_per_box || 1));
    const isLow = stockBoxes <= Number(product.low_stock_threshold || 0);
    const expired = isExpired(product.expiry_date);
    const expiringSoon = isExpiringSoon(product.expiry_date);
    const totalUnits = (stockBoxes * unitsPerBox) + stockUnits;
    const branchName = branchList.find((branch) => branch.id === product.branch_id)?.name || 'Unknown Branch';
    const storageUnit = String(product.stock_unit_type || 'box').toLowerCase();
    const sellUnit = String(product.unit_type || 'unit').toLowerCase();
    const sellingPrice = Number(product.price || 0);
    const costPrice = Number(product.cost_price || 0);
    const marginAmount = sellingPrice - costPrice;
    const marginPercent = sellingPrice > 0 ? (marginAmount / sellingPrice) * 100 : 0;
    const syncBadge = product.offline_status === 'conflict'
      ? '<span class="badge inventory-sync-badge conflict">Sync conflict</span>'
      : (product.offline_status === 'pending' || product.offline_created)
        ? '<span class="badge inventory-sync-badge pending">Waiting to sync</span>'
        : '';

    let expiryHtml = '—';
    if (product.expiry_date) {
      expiryHtml = `<span class="${expired ? 'expiry-expired' : expiringSoon ? 'expiry-soon' : ''}">${formatDate(product.expiry_date)}</span>`;
    }

    return `
      <tr>
        <td style="width:40px"><input type="checkbox" class="product-checkbox" data-id="${product.id}" /></td>
        <td>
          <div class="font-semibold inventory-product-name">${escapeHtml(product.name)}</div>
          <div class="text-xs text-muted">${escapeHtml(product.description || '')}</div>
          <div style="margin-top:0.25rem;display:flex;gap:0.35rem;flex-wrap:wrap"><span class="badge" style="background:var(--primary-light);color:var(--primary)">${escapeHtml(sellUnit.charAt(0).toUpperCase() + sellUnit.slice(1))}</span>${syncBadge}</div>
        </td>
        <td><span class="badge badge-blue">${escapeHtml(branchName)}</span></td>
        <td><span class="badge badge-gray">${escapeHtml(product.category || 'General')}</span></td>
        <td class="font-semibold">${costPrice ? formatCurrency(costPrice) : '-'}</td>
        <td class="font-semibold">${formatCurrency(sellingPrice)}</td>
        <td>
          <div class="font-semibold ${marginAmount < 0 ? 'expiry-expired' : ''}">${formatCurrency(marginAmount)}</div>
          <div class="text-xs text-muted">${marginPercent.toFixed(1)}% gross margin</div>
        </td>
        <td>
          <div class="font-semibold ${isLow ? 'expiry-soon' : ''}">${stockBoxes.toLocaleString()} ${escapeHtml(storageUnit)}${stockBoxes === 1 ? '' : 's'}${stockUnits ? ` + ${stockUnits.toLocaleString()} loose ${escapeHtml(sellUnit)}${stockUnits === 1 ? '' : 's'}` : ''}</div>
          <div class="text-xs text-muted">${totalUnits.toLocaleString()} calculated units · ${unitsPerBox.toLocaleString()} per box</div>
        </td>
        <td>${expiryHtml}</td>
        <td>
          ${expired ? '<span class="badge badge-danger">Expired</span>' :
            isLow ? '<span class="badge badge-warning">Low Stock</span>' :
            expiringSoon ? '<span class="badge badge-warning">Expiring Soon</span>' :
            '<span class="badge badge-success">In Stock</span>'}
        </td>
        <td>
          <div class="inventory-row-actions">
            <button class="btn btn-ghost btn-sm edit-product-btn" data-id="${product.id}">Edit</button>
            <button class="btn btn-ghost btn-sm restock-btn" data-id="${product.id}" data-name="${escapeHtml(product.name)}">Restock</button>
            <button class="btn btn-ghost btn-sm adjust-stock-btn" data-id="${product.id}">Adjust</button>
            <button class="btn btn-ghost btn-sm history-product-btn" data-id="${product.id}">History</button>
            <button class="btn btn-ghost btn-sm delete-product-btn" data-id="${product.id}" style="color:var(--danger)">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function makeInventoryOperation(user, productId, branchId, operationType, extra = {}) {
  const createdAt = new Date().toISOString();
  return {
    operation_id: crypto.randomUUID(),
    operation_type: operationType,
    product_id: productId,
    user_id: user.id,
    pharmacy_id: user.profile.pharmacy_id,
    branch_id: branchId,
    scope: getInventoryScope(user, branchId),
    created_at: createdAt,
    ...extra
  };
}

async function queueProductCreateOffline(payload, user) {
  const productId = crypto.randomUUID();
  const unitsPerBox = Math.max(1, Number(payload.units_per_box || 1));
  const initialTotal = Math.max(0, (Number(payload.stock_boxes || 0) * unitsPerBox) + Number(payload.stock_units || 0));
  const normalizedPayload = {
    ...payload,
    stock_boxes: Math.floor(initialTotal / unitsPerBox),
    stock_units: initialTotal % unitsPerBox
  };
  const operation = makeInventoryOperation(user, productId, payload.branch_id, 'create_product', {
    payload: { ...normalizedPayload, id: productId, metadata_version: 1 }
  });
  await queueOfflineInventoryOperation(operation);
  if (navigator.onLine) requestOfflineSync({ reason: 'inventory_create' }).catch(() => {});
  return productId;
}

async function queueProductUpdateOffline(product, payload, user) {
  const branchId = product.branch_id || selectedBranchId;
  const metadataPayload = { ...payload };
  delete metadataPayload.stock_boxes;
  delete metadataPayload.stock_units;
  delete metadataPayload.pharmacy_id;

  const operation = makeInventoryOperation(user, product.id, branchId, 'update_product', {
    payload: metadataPayload,
    base_metadata_version: Number(product.metadata_version || 1)
  });
  await queueOfflineInventoryOperation(operation);

  const newUnitsPerBox = Math.max(1, Number(payload.units_per_box || product.units_per_box || 1));
  const baselineAfterMetadata = (Number(product.stock_boxes || 0) * newUnitsPerBox) + Number(product.stock_units || 0);
  const desiredTotal = (Number(payload.stock_boxes || 0) * newUnitsPerBox) + Number(payload.stock_units || 0);
  const delta = desiredTotal - baselineAfterMetadata;
  if (delta !== 0) {
    await queueOfflineInventoryOperation(makeInventoryOperation(user, product.id, branchId, 'stock_delta', {
      stock_delta_units: delta,
      stock_unit_type: payload.stock_unit_type || product.stock_unit_type || 'box',
      change_type: 'adjustment',
      notes: 'Stock quantity changed while editing product'
    }));
  }
  if (navigator.onLine) requestOfflineSync({ reason: 'inventory_update' }).catch(() => {});
}

async function queueStockDeltaOffline(product, deltaUnits, user, { changeType = 'adjustment', notes = '', stockUnitType = null } = {}) {
  const branchId = product.branch_id || selectedBranchId;
  const requestedStockUnitType = stockUnitType || product.stock_unit_type || 'box';
  if (requestedStockUnitType !== (product.stock_unit_type || 'box')) {
    await queueOfflineInventoryOperation(makeInventoryOperation(user, product.id, branchId, 'update_product', {
      payload: { stock_unit_type: requestedStockUnitType },
      base_metadata_version: Number(product.metadata_version || 1)
    }));
  }
  const operation = makeInventoryOperation(user, product.id, branchId, 'stock_delta', {
    stock_delta_units: Number(deltaUnits || 0),
    stock_unit_type: requestedStockUnitType,
    change_type: changeType,
    notes
  });
  await queueOfflineInventoryOperation(operation);
  if (navigator.onLine) requestOfflineSync({ reason: `inventory_${changeType}` }).catch(() => {});
}

async function queueProductDeactivationOffline(product, user) {
  const operation = makeInventoryOperation(user, product.id, product.branch_id || selectedBranchId, 'update_product', {
    payload: { is_active: false },
    base_metadata_version: Number(product.metadata_version || 1)
  });
  await queueOfflineInventoryOperation(operation);
  if (navigator.onLine) requestOfflineSync({ reason: 'inventory_deactivate' }).catch(() => {});
}


function bindTableActions(products, user, updateView, branchList) {
  const productMap = Object.fromEntries(products.map((product) => [product.id, product]));

  document.querySelectorAll('.product-checkbox').forEach((checkbox) => checkbox.addEventListener('change', updateBulkActionsBar));

  document.getElementById('bulk-edit-btn')?.addEventListener('click', () => {
    if (!navigator.onLine) return showToast('Bulk inventory actions require internet. Individual edits work offline.', 'warning');
    const selected = Array.from(document.querySelectorAll('.product-checkbox:checked')).map((checkbox) => checkbox.dataset.id);
    if (!selected.length) return;
    showBulkEditModal(selected, productMap, user, updateView);
  });

  document.getElementById('bulk-deactivate-btn')?.addEventListener('click', async () => {
    if (!navigator.onLine) return showToast('Bulk inventory actions require internet. Individual edits work offline.', 'warning');
    const selected = Array.from(document.querySelectorAll('.product-checkbox:checked')).map((checkbox) => checkbox.dataset.id);
    if (!selected.length) return;
    if (!await showConfirm(`Deactivate ${selected.length} product(s)?`)) return;
    await bulkUpdateProducts(selected, { is_active: false }, updateView);
  });

  document.getElementById('bulk-activate-btn')?.addEventListener('click', async () => {
    if (!navigator.onLine) return showToast('Bulk inventory actions require internet. Individual edits work offline.', 'warning');
    const selected = Array.from(document.querySelectorAll('.product-checkbox:checked')).map((checkbox) => checkbox.dataset.id);
    if (!selected.length) return;
    if (!await showConfirm(`Activate ${selected.length} product(s)?`)) return;
    await bulkUpdateProducts(selected, { is_active: true }, updateView);
  });

  document.getElementById('bulk-delete-btn')?.addEventListener('click', async () => {
    if (!navigator.onLine) return showToast('Bulk inventory actions require internet. Individual edits work offline.', 'warning');
    const selected = Array.from(document.querySelectorAll('.product-checkbox:checked')).map((checkbox) => checkbox.dataset.id);
    if (!selected.length) return;
    if (!await showConfirm(`Delete ${selected.length} product(s)? This cannot be undone.`)) return;
    await bulkDeleteProducts(selected, updateView);
  });

  document.getElementById('bulk-cancel-btn')?.addEventListener('click', () => {
    document.querySelectorAll('.product-checkbox').forEach((checkbox) => { checkbox.checked = false; });
    const selectAll = document.getElementById('select-all-products');
    if (selectAll) selectAll.checked = false;
    updateBulkActionsBar();
  });

  document.querySelectorAll('.edit-product-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const product = productMap[button.dataset.id];
      if (product) showProductModal(product, user, updateView, branchList);
    });
  });

  document.querySelectorAll('.restock-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const product = productMap[button.dataset.id];
      if (product) showRestockModal(product, user, updateView);
    });
  });

  document.querySelectorAll('.adjust-stock-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const product = productMap[button.dataset.id];
      if (product) showStockAdjustmentModal(product, user, updateView);
    });
  });

  document.querySelectorAll('.history-product-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const product = productMap[button.dataset.id];
      if (!product) return;
      if (!navigator.onLine) return showOfflineProductActivity(product);
      showProductStockHistory(product, user);
    });
  });

  document.querySelectorAll('.delete-product-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const product = productMap[button.dataset.id];
      if (!product || !await showConfirm('Deactivate this product? It will stop appearing in active inventory.')) return;
      try {
        await queueProductDeactivationOffline(product, user);
        showToast(navigator.onLine ? 'Product deactivation queued and syncing' : 'Product deactivation saved offline');
        await updateView({ preferCache: !navigator.onLine });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

async function showProductStockHistory(product, user) {
  const { overlay } = createModal({
    id: 'product-stock-history',
    title: `Stock History · ${escapeHtml(product.name)}`,
    size: 'modal-lg',
    body: `<div class="inventory-history-loading"><div class="text-muted">Loading stock movements…</div></div>`
  });

  try {
    const logs = await getProductStockLogs(user.profile.pharmacy_id, product.id, 100);
    const body = overlay.querySelector('.modal-body');
    if (!body) return;
    body.innerHTML = `
      <div class="inventory-history-summary">
        <div><span class="text-xs text-muted">Current stock</span><strong>${Number(product.stock_boxes || 0).toLocaleString()} ${escapeHtml(product.stock_unit_type || 'box')}${Number(product.stock_boxes || 0) === 1 ? '' : 's'} + ${Number(product.stock_units || 0).toLocaleString()} loose</strong></div>
        <div><span class="text-xs text-muted">Calculated units</span><strong>${((Number(product.stock_boxes || 0) * Math.max(1, Number(product.units_per_box || 1))) + Number(product.stock_units || 0)).toLocaleString()}</strong></div>
        <div><span class="text-xs text-muted">Movements shown</span><strong>${logs.length}</strong></div>
      </div>
      <div class="table-container" style="max-height:520px;overflow:auto">
        <table>
          <thead><tr><th>Date</th><th>Movement</th><th>Change</th><th>Notes</th></tr></thead>
          <tbody>
            ${logs.length ? logs.map((log) => `
              <tr>
                <td>${formatDateTime(log.created_at)}</td>
                <td><span class="badge ${Number(log.quantity_change || 0) < 0 ? 'badge-danger' : 'badge-success'}">${escapeHtml(log.change_type || 'adjustment')}</span></td>
                <td class="font-semibold ${Number(log.quantity_change || 0) < 0 ? 'expiry-expired' : ''}">${Number(log.quantity_change || 0) > 0 ? '+' : ''}${Number(log.quantity_change || 0).toLocaleString()}</td>
                <td class="text-sm text-muted">${escapeHtml(log.notes || '—')}</td>
              </tr>
            `).join('') : `<tr><td colspan="4"><div class="empty-state"><div class="empty-state-title">No stock movement recorded</div><div class="empty-state-desc">Future restocks, sales and adjustments will appear here.</div></div></td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    const body = overlay.querySelector('.modal-body');
    if (body) body.innerHTML = `<div class="alert alert-danger">Failed to load stock history: ${escapeHtml(err.message)}</div>`;
  }
}

function showProductModal(product, user, updateView, branchList) {
  const isEdit = !!product;
  const configuredThreshold = Number(window.pharmacySettings?.operational_settings?.default_low_stock_threshold);
  const defaultLowStockThreshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0 ? configuredThreshold : 5;
  // Pre-select the currently viewed branch when adding a new product
  const preSelectedBranchId = isEdit ? product?.branch_id : selectedBranchId;
  const { overlay, closeModal } = createModal({
    id: 'product-modal',
    title: isEdit ? 'Edit Product' : 'Add New Product',
    size: 'modal-lg',
    body: `
      <form id="product-form">
        <div class="form-group">
          <label class="form-label">Branch *</label>
          <select class="form-select" id="prod-branch" required>
            ${branchList.map(b => `<option value="${b.id}" ${b.id === preSelectedBranchId ? 'selected' : ''}>${b.name}</option>`).join('')}
          </select>
          <div class="text-xs text-muted" style="margin-top: 0.25rem;">Product will be assigned to this branch only</div>
        </div>
        <div class="form-group">
          <label class="form-label">Product Name *</label>
          <input type="text" class="form-input" id="prod-name" value="${product?.name || ''}" placeholder="e.g. Amoxicillin 500mg" required />
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Category</label>
            <input type="text" class="form-input" id="prod-cat" value="${product?.category || 'General'}" placeholder="Antibiotics, Painkillers..." />
          </div>
          <div class="form-group">
            <label class="form-label">Selling Price *</label>
            <input type="number" class="form-input" id="prod-price" value="${product?.price || ''}" min="0" step="0.01" placeholder="0.00" required />
          </div>
          <div class="form-group">
            <label class="form-label">Unit Type *</label>
            <select class="form-select" id="prod-unit-type" required>
              <option value="">Select unit type</option>
              <option value="tablet" ${product?.unit_type === 'tablet' ? 'selected' : ''}>Tablet</option>
              <option value="capsule" ${product?.unit_type === 'capsule' ? 'selected' : ''}>Capsule</option>
              <option value="bottle" ${product?.unit_type === 'bottle' ? 'selected' : ''}>Bottle</option>
              <option value="vial" ${product?.unit_type === 'vial' ? 'selected' : ''}>Vial</option>
              <option value="injection" ${product?.unit_type === 'injection' ? 'selected' : ''}>Injection</option>
              <option value="ml" ${product?.unit_type === 'ml' ? 'selected' : ''}>ML (Milliliters)</option>
              <option value="box" ${product?.unit_type === 'box' || !product?.unit_type ? 'selected' : ''}>Box/Carton</option>
              <option value="blister" ${product?.unit_type === 'blister' ? 'selected' : ''}>Blister Pack</option>
              <option value="jar" ${product?.unit_type === 'jar' ? 'selected' : ''}>Jar</option>
              <option value="tube" ${product?.unit_type === 'tube' ? 'selected' : ''}>Tube</option>
              <option value="sachet" ${product?.unit_type === 'sachet' ? 'selected' : ''}>Sachet</option>
              <option value="strip" ${product?.unit_type === 'strip' ? 'selected' : ''}>Strip</option>
              <option value="bag" ${product?.unit_type === 'bag' ? 'selected' : ''}>Bag</option>
              <option value="pack" ${product?.unit_type === 'pack' ? 'selected' : ''}>Pack</option>
              <option value="piece" ${product?.unit_type === 'piece' ? 'selected' : ''}>Piece</option>
              <option value="cup" ${product?.unit_type === 'cup' ? 'selected' : ''}>Cup</option>
              <option value="card" ${product?.unit_type === 'card' ? 'selected' : ''}>Card</option>
            </select>
            <div class="text-xs text-muted" style="margin-top: 0.25rem;">How is this product sold to customers?</div>
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Cost Price</label>
            <input type="number" class="form-input" id="prod-cost" value="${product?.cost_price || ''}" min="0" step="0.01" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label class="form-label">Minimum Sell Quantity</label>
            <input type="number" class="form-input" id="prod-min-sell" value="${product?.min_sell_quantity || 1}" min="1" />
            <div class="text-xs text-muted" style="margin-top: 0.25rem;">Minimum units allowed per sale</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Units Per Box</label>
          <input type="number" class="form-input" id="prod-upb" value="${product?.units_per_box || 1}" min="1" />
          <div class="text-xs text-muted" style="margin-top: 0.25rem;">How many units are in 1 box (for bulk tracking)</div>
        </div>
        <div class="form-group">
          <label class="form-label">Stock Unit Type *</label>
          <select class="form-select" id="prod-stock-unit-type" required>
            <option value="box" ${product?.stock_unit_type === 'box' || !product?.stock_unit_type ? 'selected' : ''}>Box</option>
            <option value="carton" ${product?.stock_unit_type === 'carton' ? 'selected' : ''}>Carton</option>
            <option value="strip" ${product?.stock_unit_type === 'strip' ? 'selected' : ''}>Strip</option>
            <option value="cup" ${product?.stock_unit_type === 'cup' ? 'selected' : ''}>Cup</option>
            <option value="packet" ${product?.stock_unit_type === 'packet' ? 'selected' : ''}>Packet</option>
            <option value="blister" ${product?.stock_unit_type === 'blister' ? 'selected' : ''}>Blister</option>
            <option value="sachet" ${product?.stock_unit_type === 'sachet' ? 'selected' : ''}>Sachet</option>
            <option value="bottle" ${product?.stock_unit_type === 'bottle' ? 'selected' : ''}>Bottle</option>
            <option value="vial" ${product?.stock_unit_type === 'vial' ? 'selected' : ''}>Vial</option>
            <option value="jar" ${product?.stock_unit_type === 'jar' ? 'selected' : ''}>Jar</option>
            <option value="tube" ${product?.stock_unit_type === 'tube' ? 'selected' : ''}>Tube</option>
            <option value="bag" ${product?.stock_unit_type === 'bag' ? 'selected' : ''}>Bag</option>
            <option value="pack" ${product?.stock_unit_type === 'pack' ? 'selected' : ''}>Pack</option>
            <option value="piece" ${product?.stock_unit_type === 'piece' ? 'selected' : ''}>Piece</option>
            <option value="card" ${product?.stock_unit_type === 'card' ? 'selected' : ''}>Card</option>
          </select>
          <div class="text-xs text-muted" style="margin-top: 0.25rem;">How is stock tracked/stored (boxes, strips, cups, etc)?</div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Stock (Boxes)</label>
            <input type="number" class="form-input" id="prod-boxes" value="${product?.stock_boxes || 0}" min="0" />
          </div>
          <div class="form-group">
            <label class="form-label">Stock (Extra Units)</label>
            <input type="number" class="form-input" id="prod-units" value="${product?.stock_units || 0}" min="0" />
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Expiry Date</label>
            <input type="date" class="form-input" id="prod-expiry" value="${product?.expiry_date || ''}" />
          </div>
          <div class="form-group">
            <label class="form-label">Low Stock Threshold (boxes)</label>
            <input type="number" class="form-input" id="prod-threshold" value="${product?.low_stock_threshold ?? defaultLowStockThreshold}" min="0" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <textarea class="form-textarea" id="prod-desc" placeholder="Optional description...">${product?.description || ''}</textarea>
        </div>
        <div id="product-err" class="alert alert-danger hidden"></div>
      </form>
    `,
    footer: `
      <button class="btn btn-ghost" id="cancel-product">Cancel</button>
      <button class="btn btn-primary" id="save-product">${isEdit ? 'Save Changes' : 'Add Product'}</button>
    `
  });

  overlay.querySelector('#cancel-product').addEventListener('click', closeModal);
  overlay.querySelector('#save-product').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#save-product');
    const errEl = overlay.querySelector('#product-err');
    errEl.classList.add('hidden');

    const payload = {
      name: overlay.querySelector('#prod-name').value.trim(),
      category: overlay.querySelector('#prod-cat').value.trim() || 'General',
      price: parseFloat(overlay.querySelector('#prod-price').value) || 0,
      cost_price: parseFloat(overlay.querySelector('#prod-cost').value) || 0,
      unit_type: overlay.querySelector('#prod-unit-type').value,
      min_sell_quantity: parseInt(overlay.querySelector('#prod-min-sell').value) || 1,
      units_per_box: parseInt(overlay.querySelector('#prod-upb').value) || 1,
      stock_boxes: parseInt(overlay.querySelector('#prod-boxes').value) || 0,
      stock_units: parseInt(overlay.querySelector('#prod-units').value) || 0,
      stock_unit_type: overlay.querySelector('#prod-stock-unit-type').value || 'box',
      expiry_date: overlay.querySelector('#prod-expiry').value || null,
      low_stock_threshold: (() => { const value = parseInt(overlay.querySelector('#prod-threshold').value, 10); return Number.isFinite(value) && value >= 0 ? value : defaultLowStockThreshold; })(),
      description: overlay.querySelector('#prod-desc').value.trim(),
      pharmacy_id: user.profile.pharmacy_id,
      branch_id: overlay.querySelector('#prod-branch').value
    };

    if (!payload.name) { errEl.textContent = 'Product name is required.'; errEl.classList.remove('hidden'); return; }
    if (!payload.unit_type) { errEl.textContent = 'Please select a unit type.'; errEl.classList.remove('hidden'); return; }
    if (!payload.branch_id) { errEl.textContent = 'Please select a branch.'; errEl.classList.remove('hidden'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      if (isEdit && payload.branch_id !== product.branch_id) {
        if (!navigator.onLine) {
          throw new Error('Moving a product to another branch requires internet. Keep the current branch or reconnect first.');
        }
        await updateProduct(product.id, payload);
        showToast('Product moved and updated successfully');
        closeModal();
        await updateView();
        return;
      }

      if (isEdit) {
        await queueProductUpdateOffline(product, payload, user);
        showToast(navigator.onLine ? 'Product update saved and syncing' : 'Product update saved offline');
      } else {
        await queueProductCreateOffline(payload, user);
        showToast(navigator.onLine ? 'Product added locally and syncing' : 'Product added offline');
      }
      closeModal();
      await updateView({ preferCache: !navigator.onLine });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Add Product';
    }
  });
}

function showRestockModal(product, user, updateView) {
  const stockUnitTypes = ['box', 'carton', 'strip', 'cup', 'packet', 'blister', 'sachet', 'bottle', 'vial', 'jar', 'tube', 'bag', 'pack', 'piece'];
  const unitsPerBox = Math.max(1, Number(product.units_per_box || 1));
  const currentUnitType = product.stock_unit_type || 'box';

  const { overlay, closeModal } = createModal({
    id: 'restock-modal',
    title: `Restock: ${escapeHtml(product.name)}`,
    body: `
      <div class="inventory-offline-action-note">
        ${navigator.onLine ? 'This restock is saved locally first and synchronized immediately.' : 'You are offline. This restock will be saved on this device and synchronized later.'}
      </div>
      <div class="form-group">
        <label class="form-label">Storage Unit Type *</label>
        <select class="form-select" id="restock-unit-type" required>
          ${stockUnitTypes.map(unit => `<option value="${unit}" ${unit === currentUnitType ? 'selected' : ''}>${unit.charAt(0).toUpperCase() + unit.slice(1)}</option>`).join('')}
        </select>
        <div class="text-xs text-muted" style="margin-top:0.25rem;">1 storage unit equals ${unitsPerBox.toLocaleString()} sellable unit${unitsPerBox === 1 ? '' : 's'} for this product.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Quantity to Add *</label>
        <input type="number" class="form-input" id="restock-qty" min="1" value="1" placeholder="Enter quantity" />
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input type="text" class="form-input" id="restock-notes" placeholder="e.g. Received from supplier" />
      </div>
      <div id="restock-err" class="alert alert-danger hidden"></div>
    `,
    footer: `
      <button class="btn btn-ghost" id="cancel-restock">Cancel</button>
      <button class="btn btn-success" id="save-restock">Add Stock</button>
    `
  });

  overlay.querySelector('#cancel-restock').addEventListener('click', closeModal);
  overlay.querySelector('#save-restock').addEventListener('click', async () => {
    const qty = parseInt(overlay.querySelector('#restock-qty').value, 10);
    const notes = overlay.querySelector('#restock-notes').value.trim();
    const unitType = overlay.querySelector('#restock-unit-type').value;
    const errEl = overlay.querySelector('#restock-err');
    if (!qty || qty < 1) { errEl.textContent = 'Enter a valid quantity.'; errEl.classList.remove('hidden'); return; }
    if (!unitType) { errEl.textContent = 'Please select a storage unit type.'; errEl.classList.remove('hidden'); return; }
    try {
      const deltaUnits = qty * unitsPerBox;
      await queueStockDeltaOffline(product, deltaUnits, user, {
        changeType: 'restock',
        notes: notes || `Restocked ${qty} ${unitType}${qty === 1 ? '' : 's'}`,
        stockUnitType: unitType
      });
      showToast(navigator.onLine ? `Restock saved and syncing (${qty} ${unitType}${qty === 1 ? '' : 's'})` : `Restock saved offline (${qty} ${unitType}${qty === 1 ? '' : 's'})`);
      closeModal();
      await updateView({ preferCache: !navigator.onLine });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
}

function showStockAdjustmentModal(product, user, updateView) {
  const unitsPerBox = Math.max(1, Number(product.units_per_box || 1));
  const storageUnit = product.stock_unit_type || 'box';
  const sellUnit = product.unit_type || 'unit';
  const { overlay, closeModal } = createModal({
    id: 'stock-adjustment-modal',
    title: `Adjust Stock: ${escapeHtml(product.name)}`,
    body: `
      <div class="inventory-offline-action-note">
        Stock adjustments use quantity changes, not absolute stock replacement. This is safer when devices work offline.
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Adjustment *</label>
          <select class="form-select" id="adjust-direction">
            <option value="increase">Increase stock</option>
            <option value="decrease">Decrease stock</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Measure As *</label>
          <select class="form-select" id="adjust-measure">
            <option value="storage">${escapeHtml(storageUnit.charAt(0).toUpperCase() + storageUnit.slice(1))} (${unitsPerBox} ${escapeHtml(sellUnit)}${unitsPerBox === 1 ? '' : 's'} each)</option>
            <option value="loose">Loose ${escapeHtml(sellUnit)}${sellUnit.endsWith('s') ? '' : 's'}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Quantity *</label>
        <input type="number" class="form-input" id="adjust-qty" min="1" value="1" />
      </div>
      <div class="form-group">
        <label class="form-label">Reason / Notes *</label>
        <input type="text" class="form-input" id="adjust-notes" placeholder="e.g. Physical count correction, damaged stock" />
      </div>
      <div id="adjust-err" class="alert alert-danger hidden"></div>
    `,
    footer: `
      <button class="btn btn-ghost" id="cancel-adjust">Cancel</button>
      <button class="btn btn-primary" id="save-adjust">Save Adjustment</button>
    `
  });

  overlay.querySelector('#cancel-adjust').addEventListener('click', closeModal);
  overlay.querySelector('#save-adjust').addEventListener('click', async () => {
    const direction = overlay.querySelector('#adjust-direction').value;
    const measure = overlay.querySelector('#adjust-measure').value;
    const qty = parseInt(overlay.querySelector('#adjust-qty').value, 10);
    const notes = overlay.querySelector('#adjust-notes').value.trim();
    const errEl = overlay.querySelector('#adjust-err');
    errEl.classList.add('hidden');
    if (!qty || qty < 1) { errEl.textContent = 'Enter a valid quantity.'; errEl.classList.remove('hidden'); return; }
    if (!notes) { errEl.textContent = 'Please enter a reason for this adjustment.'; errEl.classList.remove('hidden'); return; }
    const rawUnits = qty * (measure === 'storage' ? unitsPerBox : 1);
    const deltaUnits = direction === 'decrease' ? -rawUnits : rawUnits;
    try {
      await queueStockDeltaOffline(product, deltaUnits, user, {
        changeType: 'adjustment',
        notes,
        stockUnitType: storageUnit
      });
      showToast(navigator.onLine ? 'Stock adjustment saved and syncing' : 'Stock adjustment saved offline');
      closeModal();
      await updateView({ preferCache: !navigator.onLine });
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
}

function showOfflineProductActivity(product) {
  const pendingPatch = product.pending_metadata_patch || {};
  const pendingDelta = Number(product.pending_delta_units || 0);
  createModal({
    id: 'offline-product-activity',
    title: `Offline Activity · ${escapeHtml(product.name)}`,
    body: `
      <div class="alert alert-info">Full server stock history is available when internet returns.</div>
      <div class="inventory-history-summary">
        <div><span class="text-xs text-muted">Local status</span><strong>${product.offline_status === 'conflict' ? 'Conflict needs review' : product.offline_status === 'pending' || product.offline_created ? 'Waiting to sync' : 'Cached copy'}</strong></div>
        <div><span class="text-xs text-muted">Pending stock change</span><strong>${pendingDelta > 0 ? '+' : ''}${pendingDelta.toLocaleString()} base units</strong></div>
        <div><span class="text-xs text-muted">Pending detail fields</span><strong>${Object.keys(pendingPatch).length}</strong></div>
      </div>
    `
  });
}

async function showStockLogs(user) {
  const { getStockLogs } = await import('../../database.js');
  const { formatDateTime } = await import('../../utils.js');
  const logs = await getStockLogs(user.profile.pharmacy_id, 100);

  const { overlay } = createModal({
    id: 'stock-logs',
    title: 'Stock History',
    size: 'modal-lg',
    body: `
      <div class="table-container" style="max-height:500px;overflow-y:auto">
        <table>
          <thead>
            <tr><th>Product</th><th>Type</th><th>Change</th><th>Notes</th><th>By</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${logs.length === 0 ? `<tr><td colspan="6"><div class="empty-state"><div class="empty-state-title">No stock history</div></div></td></tr>` :
              logs.map(l => `
                <tr>
                  <td class="font-semibold text-sm">${l.product_name}</td>
                  <td><span class="badge ${l.change_type === 'sale' ? 'badge-danger' : 'badge-success'}">${l.change_type}</span></td>
                  <td class="font-semibold ${l.quantity_change < 0 ? 'expiry-expired' : ''}">${l.quantity_change > 0 ? '+' : ''}${l.quantity_change}</td>
                  <td class="text-sm text-muted">${l.notes || '—'}</td>
                  <td class="text-sm text-muted">${l.profiles?.full_name || '—'}</td>
                  <td class="text-xs text-muted">${formatDateTime(l.created_at)}</td>
                </tr>
              `).join('')}
          </tbody>
        </table>
      </div>
    `
  });
}

async function importProductsFromCSV(csvText, user, updateView, progressDiv) {
  const { createProduct } = await import('../../database.js');
  const { showToast } = await import('../../utils.js');
  
  try {
    // Check if a branch is selected
    if (!selectedBranchId) {
      showToast('Please select a branch before importing products', 'error');
      if (progressDiv) progressDiv.style.display = 'none';
      return;
    }
    
    const lines = csvText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    if (lines.length < 2) {
      showToast('CSV file must have header row and at least one product', 'error');
      if (progressDiv) progressDiv.style.display = 'none';
      return;
    }
    
    console.log('CSV import started, total lines:', lines.length);
    
    // Parse CSV header
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine).map(h => h.trim().toLowerCase());
    
    console.log('CSV Headers:', headers);
    
    // Map header positions for flexible column matching
    const getColumnIndex = (possibleNames) => {
      for (const name of possibleNames) {
        const idx = headers.findIndex(h => h.includes(name.toLowerCase()));
        if (idx !== -1) {
          console.log(`Found column "${name}" at index ${idx}`);
          return idx;
        }
      }
      console.warn(`Column not found for: ${possibleNames.join(', ')}`);
      return -1;
    };
    
    const nameIdx = getColumnIndex(['product', 'name']);
    const categoryIdx = getColumnIndex(['category']);
    const descIdx = getColumnIndex(['description']);
    const costPriceIdx = getColumnIndex(['cost', 'price']);
    const sellingPriceIdx = getColumnIndex(['selling', 'price']);
    const lowStockIdx = getColumnIndex(['low', 'stock']);
    const stockBoxesIdx = getColumnIndex(['stock', 'boxes', 'quantity']);
    
    console.log('Column indices:', { nameIdx, categoryIdx, descIdx, costPriceIdx, sellingPriceIdx, lowStockIdx, stockBoxesIdx });
    console.log('Current branch:', selectedBranchId);
    console.log('Current pharmacy:', user.profile.pharmacy_id);
    
    let successCount = 0;
    let errorCount = 0;
    const statusDiv = document.getElementById('import-status');
    
    for (let i = 1; i < lines.length; i++) {
      try {
        if (statusDiv) statusDiv.textContent = `Processing row ${i} of ${lines.length - 1}...`;
        
        const values = parseCSVLine(lines[i]);
        
        // Skip empty rows
        if (values.every(v => !v || !v.trim())) {
          continue;
        }
        
        const getValue = (idx) => idx !== -1 && values[idx] ? values[idx].trim() : '';
        
        const product = {
          name: getValue(nameIdx),
          category: getValue(categoryIdx) || 'Other',
          description: getValue(descIdx),
          cost_price: parseFloat(getValue(costPriceIdx)) || 0,
          price: parseFloat(getValue(sellingPriceIdx)) || 0,
          low_stock_threshold: parseFloat(getValue(lowStockIdx)) || 10,
          stock_boxes: parseFloat(getValue(stockBoxesIdx)) || 0,
          pharmacy_id: user.profile.pharmacy_id,
          branch_id: selectedBranchId || null,
          is_active: true
        };
        
        console.log(`Row ${i} parsed:`, product);
        
        // Validate required fields
        if (!product.name || product.name.length === 0) {
          console.warn(`Row ${i}: Missing product name (raw value at index ${nameIdx}: "${getValue(nameIdx)}")`);
          errorCount++;
          continue;
        }
        
        if (!product.price || product.price === 0) {
          console.warn(`Row ${i}: Invalid selling price. Raw value: "${getValue(sellingPriceIdx)}", Parsed: ${product.price}`);
          errorCount++;
          continue;
        }
        
        if (!product.branch_id) {
          console.warn(`Row ${i}: Missing branch assignment. Please select a branch before importing.`);
          errorCount++;
          continue;
        }
        
        console.log(`Creating CSV product: ${product.name}`);
        const result = await createProduct(product);
        console.log('CSV product created:', result);
        successCount++;
      } catch (err) {
        console.error('Error importing CSV row', i, ':', err);
        if (err.message && err.message.includes('branch_id')) {
          console.warn(`Row ${i}: Product requires a branch. Make sure a branch is selected.`);
        }
        errorCount++;
      }
    }
    
    console.log(`CSV Import completed: ${successCount} successful, ${errorCount} failed`);
    showToast(`✓ Imported ${successCount} products. ${errorCount} errors.`, successCount > 0 ? 'success' : 'warning');
    if (progressDiv) progressDiv.style.display = 'none';
    
    if (successCount > 0) {
      setTimeout(() => updateView(), 500);
    }
  } catch (err) {
    console.error('CSV import error:', err);
    showToast('Failed to import CSV: ' + err.message, 'error');
    if (progressDiv) progressDiv.style.display = 'none';
  }
}

async function importProductsFromExcel(arrayBuffer, fileName, user, updateView, progressDiv) {
  try {
    // Check if a branch is selected
    if (!selectedBranchId) {
      const { showToast } = await import('../../utils.js');
      showToast('Please select a branch before importing products', 'error');
      if (progressDiv) progressDiv.style.display = 'none';
      return;
    }
    
    // Dynamically import xlsx library
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const { createProduct } = await import('../../database.js');
    const { showToast } = await import('../../utils.js');
    
    console.log('Starting Excel import for file:', fileName);
    console.log('Current branch ID:', selectedBranchId);
    console.log('Current pharmacy ID:', user.profile.pharmacy_id);
    
    // Parse Excel file
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    
    if (!sheetName) {
      showToast('Excel file has no sheets', 'error');
      if (progressDiv) progressDiv.style.display = 'none';
      return;
    }
    
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);
    
    console.log('Parsed rows from Excel:', rows.length);
    if (rows.length > 0) {
      console.log('First row keys:', Object.keys(rows[0]));
      console.log('First row data:', rows[0]);
    }
    
    if (rows.length === 0) {
      showToast('Excel sheet is empty or has no valid data', 'error');
      if (progressDiv) progressDiv.style.display = 'none';
      return;
    }
    
    let successCount = 0;
    let errorCount = 0;
    const statusDiv = document.getElementById('import-status');
    
    for (let i = 0; i < rows.length; i++) {
      try {
        if (statusDiv) statusDiv.textContent = `Processing row ${i + 1} of ${rows.length}...`;
        
        const row = rows[i];
        const keys = Object.keys(row);
        
        // Extract values - handle both lowercase and original case headers
        const getValue = (possibleNames) => {
          if (!Array.isArray(possibleNames)) {
            possibleNames = [possibleNames];
          }
          
          for (const name of possibleNames) {
            const matchingKey = keys.find(k => 
              k && k.toLowerCase().includes(name.toLowerCase())
            );
            if (matchingKey !== undefined && row[matchingKey] !== undefined && row[matchingKey] !== null && row[matchingKey] !== '') {
              return row[matchingKey].toString().trim();
            }
          }
          return '';
        };
        
        const product = {
          name: getValue(['Product', 'Name']),
          category: getValue(['Category']) || 'Other',
          description: getValue(['Description']),
          cost_price: parseFloat(getValue(['Cost', 'Price'])) || 0,
          price: parseFloat(getValue(['Selling', 'Price'])) || 0,
          low_stock_threshold: parseFloat(getValue(['Low', 'Stock'])) || 10,
          stock_boxes: parseFloat(getValue(['Stock', 'Boxes'])) || 0,
          pharmacy_id: user.profile.pharmacy_id,
          branch_id: selectedBranchId || null,
          is_active: true
        };
        
        console.log(`Row ${i + 1} parsed product:`, product);
        
        // Validate required fields
        if (!product.name || product.name.length === 0) {
          console.warn(`Row ${i + 1}: Missing product name`);
          errorCount++;
          continue;
        }
        
        if (!product.price || product.price === 0) {
          console.warn(`Row ${i + 1}: Missing or invalid selling price (got: ${getValue(['Selling', 'Price'])})`);
          errorCount++;
          continue;
        }
        
        console.log(`Creating product: ${product.name} - Price: ${product.price}`);
        const result = await createProduct(product);
        console.log(`Product created successfully:`, result);
        successCount++;
      } catch (err) {
        console.error('Error importing row', i + 1, ':', err);
        errorCount++;
      }
    }
    
    console.log(`Import completed: ${successCount} successful, ${errorCount} failed`);
    showToast(`✓ Imported ${successCount} products from Excel. ${errorCount} errors.`, successCount > 0 ? 'success' : 'warning');
    if (progressDiv) progressDiv.style.display = 'none';
    
    if (successCount > 0) {
      setTimeout(() => updateView(), 500);
    }
  } catch (err) {
    console.error('Excel import error:', err);
    showToast('Failed to import Excel file: ' + err.message, 'error');
    if (progressDiv) progressDiv.style.display = 'none';
  }
}

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.replace(/"/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  
  values.push(current.replace(/"/g, ''));
  return values;
}

function downloadInventoryTemplate() {
  // Define CSV headers based on import function requirements
  const headers = ['Product Name', 'Category', 'Description', 'Cost Price', 'Selling Price', 'Low Stock Threshold', 'Stock Boxes', 'Units Per Box'];
  
  // Create sample data rows to guide users
  const sampleData = [
    ['Paracetamol 500mg', 'Analgesic', 'Pain relief and fever reducer', '50', '150', '20', '100', '10'],
    ['Amoxicillin 500mg', 'Antibiotic', 'Broad spectrum antibiotic', '200', '500', '15', '50', '12'],
    ['Multivitamin', 'Supplements', 'Daily vitamin supplement', '100', '200', '10', '75', '1'],
    ['Ibuprofen 400mg', 'Analgesic', 'Anti-inflammatory pain reliever', '40', '120', '25', '80', '1'],
  ];
  
  // Combine headers and sample data
  let csvContent = headers.map(h => `"${h}"`).join(',') + '\n';
  csvContent += sampleData.map(row => row.map(cell => `"${cell}"`).join(',')).join('\n');
  
  // Create blob and download
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  
  link.setAttribute('href', url);
  link.setAttribute('download', `inventory-template-${new Date().toISOString().split('T')[0]}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  // Show success message
  const { showToast } = window;
  if (showToast) {
    showToast('Template downloaded successfully! Edit in Excel and import using the Import button.', 'success');
  }
}

function updateBulkActionsBar() {
  const selected = document.querySelectorAll('.product-checkbox:checked');
  const bar = document.getElementById('bulk-actions-bar');
  const count = document.getElementById('bulk-count');
  
  if (selected.length > 0) {
    bar.style.display = 'flex';
    count.textContent = `${selected.length} product(s) selected`;
  } else {
    bar.style.display = 'none';
  }
}

async function bulkUpdateProducts(productIds, updates, updateView) {
  try {
    let successCount = 0;
    let errorCount = 0;
    
    for (const productId of productIds) {
      try {
        await updateProduct(productId, updates);
        successCount++;
      } catch (err) {
        console.error(`Failed to update product ${productId}:`, err);
        errorCount++;
      }
    }
    
    showToast(`Updated ${successCount} product(s). ${errorCount} failed.`, errorCount === 0 ? 'success' : 'warning');
    document.querySelectorAll('.product-checkbox').forEach(cb => cb.checked = false);
    document.getElementById('select-all-products').checked = false;
    updateBulkActionsBar();
    await updateView();
  } catch (err) {
    showToast(`Bulk update failed: ${err.message}`, 'error');
  }
}

async function bulkDeleteProducts(productIds, updateView) {
  try {
    let successCount = 0;
    let errorCount = 0;
    
    for (const productId of productIds) {
      try {
        await deleteProduct(productId);
        successCount++;
      } catch (err) {
        console.error(`Failed to delete product ${productId}:`, err);
        errorCount++;
      }
    }
    
    showToast(`Deleted ${successCount} product(s). ${errorCount} failed.`, errorCount === 0 ? 'success' : 'warning');
    document.querySelectorAll('.product-checkbox').forEach(cb => cb.checked = false);
    document.getElementById('select-all-products').checked = false;
    updateBulkActionsBar();
    await updateView();
  } catch (err) {
    showToast(`Bulk delete failed: ${err.message}`, 'error');
  }
}

function showBulkEditModal(productIds, productMap, user, updateView) {
  const { overlay, closeModal } = createModal({
    id: 'bulk-edit-modal',
    title: `Bulk Edit (${productIds.length} products)`,
    size: 'modal-lg',
    body: `
      <div class="alert alert-info">
        <strong>Tip:</strong> Leave a field empty to keep the current values for each product
      </div>
      <form id="bulk-edit-form">
        <div class="form-group">
          <label class="form-label">Category</label>
          <input type="text" class="form-input" id="bulk-category" placeholder="Leave empty to skip this field" />
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Selling Price</label>
            <input type="number" class="form-input" id="bulk-price" min="0" step="0.01" placeholder="Leave empty to skip this field" />
          </div>
          <div class="form-group">
            <label class="form-label">Cost Price</label>
            <input type="number" class="form-input" id="bulk-cost" min="0" step="0.01" placeholder="Leave empty to skip this field" />
          </div>
        </div>
        <div class="grid-2">
          <div class="form-group">
            <label class="form-label">Low Stock Threshold</label>
            <input type="number" class="form-input" id="bulk-threshold" min="0" placeholder="Leave empty to skip this field" />
          </div>
          <div class="form-group">
            <label class="form-label">Units Per Box</label>
            <input type="number" class="form-input" id="bulk-upb" min="1" placeholder="Leave empty to skip this field" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="bulk-status">
            <option value="">Don't change status</option>
            <option value="active">Activate</option>
            <option value="inactive">Deactivate</option>
          </select>
        </div>
        <div id="bulk-edit-err" class="alert alert-danger hidden"></div>
      </form>
    `,
    footer: `
      <button class="btn btn-ghost" id="cancel-bulk-edit">Cancel</button>
      <button class="btn btn-primary" id="save-bulk-edit">Update Products</button>
    `
  });

  overlay.querySelector('#cancel-bulk-edit').addEventListener('click', closeModal);
  overlay.querySelector('#save-bulk-edit').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#save-bulk-edit');
    const errEl = overlay.querySelector('#bulk-edit-err');
    errEl.classList.add('hidden');

    const updates = {};
    
    // Only include fields that have values
    const category = overlay.querySelector('#bulk-category').value.trim();
    if (category) updates.category = category;
    
    const price = overlay.querySelector('#bulk-price').value;
    if (price !== '') updates.price = parseFloat(price);
    
    const cost = overlay.querySelector('#bulk-cost').value;
    if (cost !== '') updates.cost_price = parseFloat(cost);
    
    const threshold = overlay.querySelector('#bulk-threshold').value;
    if (threshold !== '') updates.low_stock_threshold = parseInt(threshold);
    
    const upb = overlay.querySelector('#bulk-upb').value;
    if (upb !== '') updates.units_per_box = parseInt(upb);
    
    const status = overlay.querySelector('#bulk-status').value;
    if (status === 'active') updates.is_active = true;
    else if (status === 'inactive') updates.is_active = false;

    if (Object.keys(updates).length === 0) {
      errEl.textContent = 'Please fill in at least one field to update.';
      errEl.classList.remove('hidden');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Updating...';

    try {
      let successCount = 0;
      let errorCount = 0;
      
      for (const productId of productIds) {
        try {
          await updateProduct(productId, updates);
          successCount++;
        } catch (err) {
          console.error(`Failed to update product ${productId}:`, err);
          errorCount++;
        }
      }
      
      showToast(`Updated ${successCount} product(s). ${errorCount} failed.`, errorCount === 0 ? 'success' : 'warning');
      closeModal();
      document.querySelectorAll('.product-checkbox').forEach(cb => cb.checked = false);
      document.getElementById('select-all-products').checked = false;
      updateBulkActionsBar();
      await updateView();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Update Products';
    }
  });
}

function showAddMultipleModal(user, updateView, branchList) {
  const { overlay, closeModal } = createModal({
    id: 'add-multiple-modal',
    title: 'Add Multiple Products',
    size: 'modal-xl',
    body: `
      <div class="alert alert-info">
        <strong>Add up to 20 products at once.</strong> Fill in the Product Name and Selling Price (required). Other fields are optional.
      </div>
      <div id="product-rows-container" style="max-height:500px;overflow-y:auto;margin-bottom:1rem;">
        ${generateProductRow(0)}
      </div>
      <button type="button" class="btn btn-ghost" id="add-row-btn" style="width:100%;margin-bottom:1rem">+ Add Another Product</button>
      <div id="add-multiple-err" class="alert alert-danger hidden" style="margin-bottom:1rem"></div>
      <div style="display:flex;gap:0.5rem;border-top:1px solid var(--border);padding-top:1rem;margin-top:1rem">
        <button type="button" class="btn btn-ghost" id="cancel-add-multiple">Cancel</button>
        <button type="button" class="btn btn-primary" id="save-add-multiple" style="flex:1">✓ Add All Products</button>
      </div>
    `
  });

  let rowCount = 1;

  overlay.querySelector('#add-row-btn').addEventListener('click', () => {
    if (rowCount >= 20) {
      showToast('Maximum 20 products per batch', 'warning');
      return;
    }
    const container = overlay.querySelector('#product-rows-container');
    container.insertAdjacentHTML('beforeend', generateProductRow(rowCount));
    rowCount++;
    
    // Bind remove buttons for new row
    bindRemoveButtons(overlay, rowCount);
  });

  bindRemoveButtons(overlay, rowCount);

  overlay.querySelector('#cancel-add-multiple').addEventListener('click', closeModal);
  overlay.querySelector('#save-add-multiple').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#save-add-multiple');
    const errEl = overlay.querySelector('#add-multiple-err');
    errEl.classList.add('hidden');

    // Collect all products
    const products = [];
    const rows = overlay.querySelectorAll('.product-row');
    
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = row.querySelector('.row-name').value.trim();
      const category = row.querySelector('.row-category').value.trim() || 'General';
      const price = parseFloat(row.querySelector('.row-price').value) || 0;
      const cost = parseFloat(row.querySelector('.row-cost').value) || 0;
      const unitType = row.querySelector('.row-unit-type').value;
      const stockUnitType = row.querySelector('.row-stock-unit-type').value || 'box';
      const minSell = parseInt(row.querySelector('.row-min-sell').value) || 1;
      const upb = parseInt(row.querySelector('.row-upb').value) || 1;
      const boxes = parseInt(row.querySelector('.row-boxes').value) || 0;
      const units = parseInt(row.querySelector('.row-units').value) || 0;
      const threshold = parseInt(row.querySelector('.row-threshold').value) || 5;
      const expiry = row.querySelector('.row-expiry').value || null;
      const desc = row.querySelector('.row-desc').value.trim();

      // Validate required fields
      if (!name) {
        errEl.textContent = `Row ${i + 1}: Product name is required`;
        errEl.classList.remove('hidden');
        return;
      }

      if (price === 0) {
        errEl.textContent = `Row ${i + 1}: Selling price must be greater than 0`;
        errEl.classList.remove('hidden');
        return;
      }

      if (!unitType) {
        errEl.textContent = `Row ${i + 1}: Please select a unit type`;
        errEl.classList.remove('hidden');
        return;
      }

      products.push({
        name,
        category,
        price,
        cost_price: cost,
        unit_type: unitType,
        min_sell_quantity: minSell,
        units_per_box: upb,
        stock_boxes: boxes,
        stock_units: units,
        stock_unit_type: stockUnitType,
        low_stock_threshold: threshold,
        expiry_date: expiry,
        description: desc,
        pharmacy_id: user.profile.pharmacy_id,
        branch_id: selectedBranchId || null,
        is_active: true
      });
    }

    if (products.length === 0) {
      errEl.textContent = 'Please add at least one product';
      errEl.classList.remove('hidden');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Adding...';

    try {
      const { createProduct } = await import('../../database.js');
      let successCount = 0;
      let errorCount = 0;

      for (const product of products) {
        try {
          await createProduct(product);
          successCount++;
        } catch (err) {
          console.error('Error creating product:', err);
          errorCount++;
        }
      }

      showToast(`✓ Added ${successCount} product(s). ${errorCount} failed.`, errorCount === 0 ? 'success' : 'warning');
      closeModal();
      await updateView();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add All Products';
    }
  });
}

function generateProductRow(rowId) {
  return `
    <div class="product-row" style="padding:1rem;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:0.5rem;background:var(--bg-secondary)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem">
        <span class="font-semibold">Product ${rowId + 1}</span>
        ${rowId > 0 ? `<button type="button" class="btn btn-ghost btn-sm remove-row-btn" data-row="${rowId}" style="color:var(--danger)">Remove</button>` : ''}
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Product Name *</label>
          <input type="text" class="form-input row-name" placeholder="e.g. Amoxicillin 500mg" />
        </div>
        <div class="form-group">
          <label class="form-label">Selling Price *</label>
          <input type="number" class="form-input row-price" min="0" step="0.01" placeholder="0.00" />
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Category</label>
          <input type="text" class="form-input row-category" placeholder="Antibiotics, Painkillers..." />
        </div>
        <div class="form-group">
          <label class="form-label">Cost Price</label>
          <input type="number" class="form-input row-cost" min="0" step="0.01" placeholder="0.00" />
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label class="form-label">Unit Type *</label>
          <select class="form-input row-unit-type">
            <option value="">Select unit type</option>
            <option value="tablet">Tablet</option>
            <option value="capsule">Capsule</option>
            <option value="bottle">Bottle</option>
            <option value="vial">Vial</option>
            <option value="injection">Injection</option>
            <option value="ml">ML</option>
            <option value="box">Box</option>
            <option value="blister">Blister</option>
            <option value="jar">Jar</option>
            <option value="tube">Tube</option>
            <option value="sachet">Sachet</option>
            <option value="strip">Strip</option>
            <option value="bag">Bag</option>
            <option value="pack">Pack</option>
            <option value="piece">Piece</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Min Sell Quantity</label>
          <input type="number" class="form-input row-min-sell" value="1" min="1" />
        </div>
      </div>
      <div class="grid-3">
        <div class="form-group">
          <label class="form-label">Units Per Box</label>
          <input type="number" class="form-input row-upb" value="1" min="1" />
        </div>
        <div class="form-group">
          <label class="form-label">Stock Unit Type *</label>
          <select class="form-input row-stock-unit-type" required>
            <option value="box">Box</option>
            <option value="carton">Carton</option>
            <option value="strip">Strip</option>
            <option value="cup">Cup</option>
            <option value="packet">Packet</option>
            <option value="blister">Blister</option>
            <option value="sachet">Sachet</option>
            <option value="bottle">Bottle</option>
            <option value="vial">Vial</option>
            <option value="jar">Jar</option>
            <option value="tube">Tube</option>
            <option value="bag">Bag</option>
            <option value="pack">Pack</option>
            <option value="piece">Piece</option>
            <option value="card">Card</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Stock (Quantity)</label>
          <input type="number" class="form-input row-boxes" value="0" min="0" />
        </div>
      </div>
      <div class="grid-3">
        <div class="form-group">
          <label class="form-label">Low Stock Threshold</label>
          <input type="number" class="form-input row-threshold" value="5" min="0" />
        </div>
        <div class="form-group">
          <label class="form-label">Expiry Date</label>
          <input type="date" class="form-input row-expiry" />
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" class="form-input row-desc" placeholder="Optional description" />
        </div>
      </div>
    </div>
  `;
}

function bindRemoveButtons(overlay, rowCount) {
  overlay.querySelectorAll('.remove-row-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const row = btn.closest('.product-row');
      if (row) row.remove();
    });
  });
}
