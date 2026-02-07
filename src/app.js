// DayMX – mobile-first SPA for daily thread reviews

// ------------------------------
// Persistence
// ------------------------------
const STORAGE_KEY = 'daymx-data-v1';
const REVIEW_STATE_KEY = 'daymx-review-state-v1';
const PANTRY_REVIEW_STATE_KEY = 'daymx-pantry-review-state-v1';
const TASKS_VIEW_STATE_KEY = 'daymx-tasks-view-v2';
const UI_PREFS_KEY = 'daymx-ui-prefs-v1';
const GAMIFICATION_KEY = 'daymx-gamification-v1';
const HISTORY_LIMIT = 80;

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const defaultData = () => ({
  threads: [], // array of nodes
  pantry: { categories: [] },
  gamification: { daily: {} },
});

const LOCATION_PRESETS = ['mobile', 'laptop', 'home', 'work'];
const DURATION_PRESETS = [1, 5, 15, 30, 60];
const PRIORITY_PRESETS = [1, 2, 3, 4, 5];
const DAILY_POINTS_GOAL = 100;
const SUBTASK_CREATION_POINTS = 5;

function normalizeTagValue(value) {
  return String(value || '').trim();
}

function uniqTags(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((raw) => {
    const v = normalizeTagValue(raw);
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  });
  return out;
}

function normalizeDurationValue(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && isFinite(value) && value > 0) return Math.round(value);
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\d+)\s*m/);
  if (m) return Number(m[1]);
  const h = raw.match(/^(\d+)\s*h/);
  if (h) return Number(h[1]) * 60;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  return null;
}

function formatDuration(mins) {
  const v = normalizeDurationValue(mins);
  if (!v) return '';
  if (v < 60) return `${v}m`;
  if (v % 60 === 0) return `${v / 60}h`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return `${h}h ${m}m`;
}

function normalizePriorityList(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((raw) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) return;
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  });
  return out.sort((a, b) => a - b);
}

function taskLocations(t) {
  const base = Array.isArray(t?.locations) ? t.locations : [];
  const legacy = normalizeTagValue(t?.loc || '');
  const merged = legacy ? base.concat([legacy]) : base;
  return uniqTags(merged);
}

function setTaskLocations(t, locations) {
  const list = uniqTags(locations);
  t.locations = list;
  t.loc = list[0] || '';
}

function taskDurationMins(t) {
  return normalizeDurationValue(t?.duration);
}

function isSeriesTask(t) {
  return Array.isArray(t?.series) && t.series.length > 0;
}

function seriesStats(t) {
  if (!isSeriesTask(t)) return null;
  const total = t.series.length;
  const done = t.series.filter(s => s.completed).length;
  const remaining = total - done;
  const maxRank = Math.max(...t.series.map(s => Math.max(1, Number(s.rank) || 1)));
  const incomplete = t.series.filter(s => !s.completed);
  const activeRank = incomplete.length ? Math.min(...incomplete.map(s => Math.max(1, Number(s.rank) || 1))) : null;
  const activeItems = activeRank == null ? [] : incomplete.filter(s => (Number(s.rank) || 1) === activeRank);
  return { total, done, remaining, maxRank, activeRank, activeItems };
}

function seriesSummary(t) {
  const stats = seriesStats(t);
  if (!stats) return null;
  if (stats.remaining === 0) return `Series complete (${stats.total})`;
  const step = stats.activeRank ? `Step ${stats.activeRank}/${stats.maxRank}` : `Step 0/${stats.maxRank}`;
  return `Series ${stats.done}/${stats.total} • ${step}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function serializeData(data) {
  return JSON.stringify(data);
}

function parseIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d)) return null;
  return d;
}

const store = {
  data: null,
  mode: 'local', // 'local' | 'firebase'
  unsub: null,
  saveTimer: null,
  saveNow(dataOverride) {
    if (!dataOverride) pushHistorySnapshot();
    if (this.mode === 'firebase') {
      try {
        const payload = dataOverride || JSON.parse(JSON.stringify(this.data));
        window.daymxFirebase.setData(payload);
      } catch (e) { console.warn('Immediate save failed', e); }
    } else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch {}
    }
  },
  async tryFirebase() {
    try {
      if (!window.daymxFirebase) return false;
      await window.daymxFirebase.ready;
      const json = await window.daymxFirebase.getData();
      if (json && typeof json === 'object') {
        this.data = json;
      } else {
        this.data = defaultData();
        // Seed empty doc so subscription works
        await window.daymxFirebase.setData(this.data);
      }
      ensureGamificationInData(this.data);
      setRuntimeGamificationFromData(this.data);
      this.mode = 'firebase';
      // Subscribe to live updates
      this.unsub = window.daymxFirebase.subscribe((remote) => {
        if (!remote) return;
        this.data = remote;
        if (!this.data.pantry) this.data.pantry = { categories: [] };
        ensureGamificationInData(this.data);
        setRuntimeGamificationFromData(this.data);
        // Normalize and refresh UI on remote updates
        (this.data.threads || []).forEach(normalizeNode);
        (this.data.pantry.categories || []).forEach(normalizeCategory);
        autoAssignThreadColors();
        recomputeIndexes();
        renderThreads();
        historyState.lastSerialized = serializeData(this.data);
        // If review is visible, refresh progress/card state
        if (!$('#review-stage').hidden) { renderProgress(); renderStoryCard(); }
        if (!$('#view-tasks').hidden) { renderTasksPane(); }
        if (!$('#view-pantry').hidden) { renderPantryActiveView(); }
      });
      return true;
    } catch (e) {
      console.warn('Firebase init failed, falling back to local', e);
      return false;
    }
  },
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.data = raw ? JSON.parse(raw) : defaultData();
    } catch (e) {
      console.warn('Failed to load data, resetting', e);
      this.data = defaultData();
    }
    if (!this.data.pantry) this.data.pantry = { categories: [] };
    ensureGamificationInData(this.data);
    setRuntimeGamificationFromData(this.data);
  },
  async save() {
    pushHistorySnapshot();
    if (this.mode === 'firebase') {
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(async () => {
        try { await window.daymxFirebase.setData(this.data); } catch (e) { console.warn('Firebase save failed', e); }
      }, 250);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    }
  },
};

const historyState = {
  undo: [],
  redo: [],
  lastSerialized: '',
  applying: false,
};

let toastTimer = null;

const uiPrefs = {
  lastView: 'prepare',
  pantryTab: 'prepare',
  captureNodeId: null,
};

const gamificationState = {
  daily: {},
};

function normalizeGamificationDaily(rawDaily) {
  const daily = {};
  Object.entries(rawDaily || {}).forEach(([k, v]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return;
    const points = Math.max(0, Math.round(Number(v) || 0));
    if (!points) return;
    daily[k] = points;
  });
  return daily;
}

function ensureGamificationInData(data) {
  if (!data || typeof data !== 'object') return { daily: {} };
  if (!data.gamification || typeof data.gamification !== 'object') data.gamification = { daily: {} };
  data.gamification.daily = normalizeGamificationDaily(data.gamification.daily || {});
  return data.gamification;
}

function setRuntimeGamificationFromData(data) {
  const g = ensureGamificationInData(data);
  gamificationState.daily = g.daily;
}

function mergeGamificationDaily(baseDaily, incomingDaily) {
  const out = { ...normalizeGamificationDaily(baseDaily || {}) };
  const incoming = normalizeGamificationDaily(incomingDaily || {});
  Object.entries(incoming).forEach(([k, v]) => {
    out[k] = Math.max(Number(out[k] || 0), Number(v || 0));
  });
  return out;
}

const openTagPanels = {
  prepare: new Set(),
  review: new Set(),
  tasks: new Set(),
};

function isTagPanelOpen(view, taskId) {
  const set = openTagPanels[view];
  if (!set || !taskId) return false;
  return set.has(taskId);
}

function setTagPanelOpen(view, taskId, open) {
  const set = openTagPanels[view];
  if (!set || !taskId) return;
  if (open) set.add(taskId);
  else set.delete(taskId);
}

function dayKeyFromDate(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function saveGamificationState() {
  // Keep runtime state attached to shared store data so Firebase sync can propagate across devices.
  if (store.data && typeof store.data === 'object') {
    const g = ensureGamificationInData(store.data);
    g.daily = mergeGamificationDaily(g.daily, gamificationState.daily);
    gamificationState.daily = g.daily;
  } else {
    gamificationState.daily = normalizeGamificationDaily(gamificationState.daily);
  }
  // Legacy local cache retained as a migration/fallback source.
  try { localStorage.setItem(GAMIFICATION_KEY, JSON.stringify({ daily: gamificationState.daily })); } catch {}
}

function loadGamificationState() {
  const g = ensureGamificationInData(store.data || defaultData());
  const before = JSON.stringify(g.daily || {});
  const saved = safeJsonParse((typeof localStorage !== 'undefined' ? localStorage.getItem(GAMIFICATION_KEY) : null), null);
  const legacyDaily = normalizeGamificationDaily(saved?.daily || {});
  g.daily = mergeGamificationDaily(g.daily, legacyDaily);
  gamificationState.daily = g.daily;
  try { localStorage.setItem(GAMIFICATION_KEY, JSON.stringify({ daily: gamificationState.daily })); } catch {}
  return JSON.stringify(g.daily || {}) !== before;
}

function pointsForTaskCompletion(task) {
  const mins = taskDurationMins(task);
  if (mins === 1) return 5;
  if (mins === 5) return 10;
  if (mins === 15) return 25;
  return 0;
}

function awardPoints(points, when = new Date()) {
  const value = Math.max(0, Math.round(Number(points) || 0));
  if (!value) return 0;
  const key = dayKeyFromDate(when);
  if (!key) return 0;
  gamificationState.daily[key] = (Number(gamificationState.daily[key]) || 0) + value;
  saveGamificationState();
  return value;
}

function todayPoints(date = new Date()) {
  return Number(gamificationState.daily[dayKeyFromDate(date)] || 0);
}

function currentStreak(date = new Date()) {
  const cur = new Date(date);
  if (isNaN(cur)) return 0;
  cur.setHours(0, 0, 0, 0);
  const todayKey = dayKeyFromDate(cur);
  if (Number(gamificationState.daily[todayKey] || 0) < DAILY_POINTS_GOAL) {
    cur.setDate(cur.getDate() - 1);
  }
  let streak = 0;
  while (true) {
    const key = dayKeyFromDate(cur);
    const points = Number(gamificationState.daily[key] || 0);
    if (points < DAILY_POINTS_GOAL) break;
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

function completedGoalDays() {
  return Object.values(gamificationState.daily).filter(v => Number(v) >= DAILY_POINTS_GOAL).length;
}

function gamificationSummary(now = new Date()) {
  const points = todayPoints(now);
  const goal = DAILY_POINTS_GOAL;
  const pct = Math.max(0, Math.min(100, Math.round((points / goal) * 100)));
  return {
    goal,
    points,
    pct,
    remaining: Math.max(0, goal - points),
    streak: currentStreak(now),
    goalDays: completedGoalDays(),
  };
}

const dragState = {
  kind: null, // 'node' | 'task' | 'subtask'
  sourceNodeId: null,
  sourceTaskId: null,
  sourceSubtaskId: null,
  sourceParentId: null,
};

function setDragState(next) {
  dragState.kind = next.kind || null;
  dragState.sourceNodeId = next.sourceNodeId || null;
  dragState.sourceTaskId = next.sourceTaskId || null;
  dragState.sourceSubtaskId = next.sourceSubtaskId || null;
  dragState.sourceParentId = next.sourceParentId || null;
}

function clearDropIndicators() {
  $$('.drop-target').forEach((node) => node.classList.remove('drop-target', 'drop-after'));
}

function clearDragState() {
  setDragState({ kind: null });
  clearDropIndicators();
  $$('.dragging').forEach((node) => node.classList.remove('dragging'));
}

function isDropAfterPointer(evt, target) {
  const rect = target.getBoundingClientRect();
  return evt.clientY > rect.top + rect.height / 2;
}

function showToast(message, kind = 'info') {
  const node = $('#toast');
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
  node.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 1900);
}

function persistUiPrefs() {
  try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(uiPrefs)); } catch {}
}

function loadUiPrefs() {
  const saved = safeJsonParse(localStorage.getItem(UI_PREFS_KEY), null);
  if (!saved || typeof saved !== 'object') return;
  uiPrefs.lastView = saved.lastView || uiPrefs.lastView;
  uiPrefs.pantryTab = saved.pantryTab || uiPrefs.pantryTab;
  uiPrefs.captureNodeId = saved.captureNodeId || uiPrefs.captureNodeId;
}

function resetHistoryBaseline() {
  historyState.undo = [];
  historyState.redo = [];
  historyState.lastSerialized = serializeData(store.data);
}

function pushHistorySnapshot() {
  if (historyState.applying) return;
  const current = serializeData(store.data);
  if (!historyState.lastSerialized) {
    historyState.lastSerialized = current;
    return;
  }
  if (current === historyState.lastSerialized) return;
  historyState.undo.push(historyState.lastSerialized);
  if (historyState.undo.length > HISTORY_LIMIT) historyState.undo.shift();
  historyState.redo = [];
  historyState.lastSerialized = current;
}

function rerenderAll() {
  recomputeIndexes();
  renderThreads();
  if (!$('#review-stage').hidden) { renderProgress(); renderStoryCard(); }
  if (!$('#view-tasks').hidden) renderTasksPane();
  if (!$('#view-pantry').hidden) renderPantryActiveView();
}

function applyHistorySnapshot(serialized, pushTo) {
  const current = serializeData(store.data);
  historyState.applying = true;
  if (pushTo === 'redo') historyState.redo.push(current);
  else if (pushTo === 'undo') historyState.undo.push(current);
  store.data = safeJsonParse(serialized, defaultData()) || defaultData();
  if (!store.data.pantry) store.data.pantry = { categories: [] };
  ensureGamificationInData(store.data);
  setRuntimeGamificationFromData(store.data);
  (store.data.threads || []).forEach(normalizeNode);
  (store.data.pantry.categories || []).forEach(normalizeCategory);
  autoAssignThreadColors();
  rerenderAll();
  historyState.lastSerialized = serializeData(store.data);
  historyState.applying = false;
  store.saveNow();
}

function undoChange() {
  if (!historyState.undo.length) { showToast('Nothing to undo'); return; }
  const prev = historyState.undo.pop();
  applyHistorySnapshot(prev, 'redo');
  showToast('Undid last change');
}

function redoChange() {
  if (!historyState.redo.length) { showToast('Nothing to redo'); return; }
  const next = historyState.redo.pop();
  applyHistorySnapshot(next, 'undo');
  showToast('Redid change');
}

// ------------------------------
// Data helpers
// ------------------------------
function createNode(name = 'Untitled') {
  return { id: uid('node'), name, enabled: true, collapsed: false, children: [], questions: [], tasks: [] };
}

function createQuestion(text = '') {
  return { id: uid('q'), text };
}

function createTask(text = '') {
  const ts = nowIso();
  return {
    id: uid('t'),
    text,
    createdAt: ts,
    completed: false,
    completedAt: null,
    archivedAt: null,
    priority: 3,
    availableAt: null,
    dueAt: null,
    contexts: [],
    blockedBy: [],
    waitingOn: '',
    followUpAt: null,
    recurrence: 'none',
    nextRecurringAt: null,
    loc: '',
    locations: [],
    duration: null,
    series: [],
  };
}

function createSubtask(text = '', rank = 1) {
  const ts = nowIso();
  return {
    id: uid('s'),
    text,
    rank: Math.max(1, Number(rank) || 1),
    order: 0,
    completed: false,
    createdAt: ts,
    completedAt: null,
    archivedAt: null,
  };
}

// Pantry creators
function createCategory(name = 'Category') {
  return { id: uid('cat'), name, enabled: true, collapsed: false, children: [], items: [] };
}

function createItem(name = 'Item') {
  return { id: uid('i'), name, status: 'stocked', notes: '' };
}

function findNodeById(rootList, id) {
  const stack = [...rootList];
  while (stack.length) {
    const n = stack.pop();
    if (n.id === id) return n;
    stack.push(...n.children);
  }
  return null;
}

function flattenNodes(rootList) {
  const out = [];
  const stack = [...rootList];
  while (stack.length) {
    const n = stack.shift();
    out.push(n);
    if (n.children?.length) stack.unshift(...n.children);
  }
  return out;
}

// Consider every node a "subthread" for review. If you want only leaves, filter by !children.length
function subthreadsForReview() {
  const nodes = flattenNodes(store.data.threads);
  return nodes.filter(isNodePathEnabled); // change to filter leaves if preferred
}

function isNodePathEnabled(node) {
  if (!node) return false;
  if (node.enabled === false) return false;
  let cur = node;
  while (true) {
    const pid = parentById.get(cur.id);
    if (!pid) break;
    const p = nodeById.get(pid);
    if (!p) break;
    if (p.enabled === false) return false;
    cur = p;
  }
  return true;
}

// Reordering helpers (main threads)
function moveNode(nodeId, delta) {
  const info = findNodeParentInfo(nodeId);
  if (!info) return;
  const { list, index } = info;
  const j = index + delta;
  if (j < 0 || j >= list.length) return;
  const tmp = list[index]; list[index] = list[j]; list[j] = tmp;
  store.save(); renderThreads();
}

function findNodeParentInfo(targetId) {
  const roots = store.data.threads;
  if (!roots) return null;
  // check top-level
  const idxTop = roots.findIndex(n => n.id === targetId);
  if (idxTop >= 0) return { parent: null, list: roots, index: idxTop };
  // DFS
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop();
    const kids = n.children || [];
    const idx = kids.findIndex(c => c.id === targetId);
    if (idx >= 0) return { parent: n, list: kids, index: idx };
    stack.push(...kids);
  }
  return null;
}

function reorderListByIndex(list, fromIndex, targetIndex, placeAfter = false) {
  if (!Array.isArray(list)) return false;
  if (fromIndex < 0 || targetIndex < 0 || fromIndex >= list.length || targetIndex >= list.length) return false;
  if (fromIndex === targetIndex) return false;
  const [moved] = list.splice(fromIndex, 1);
  let insertAt = placeAfter ? targetIndex + 1 : targetIndex;
  if (fromIndex < insertAt) insertAt -= 1;
  list.splice(insertAt, 0, moved);
  return true;
}

function moveNodeRelative(sourceId, targetId, placeAfter = false) {
  const fromInfo = findNodeParentInfo(sourceId);
  const toInfo = findNodeParentInfo(targetId);
  if (!fromInfo || !toInfo) return false;
  // Sibling-only DnD keeps hierarchy predictable.
  if (fromInfo.list !== toInfo.list) return false;
  return reorderListByIndex(fromInfo.list, fromInfo.index, toInfo.index, placeAfter);
}

function moveTaskRelative(nodeId, sourceTaskId, targetTaskId, placeAfter = false) {
  const node = findNodeById(store.data.threads || [], nodeId);
  if (!node || !Array.isArray(node.tasks)) return false;
  const fromIndex = node.tasks.findIndex((t) => t.id === sourceTaskId);
  const targetIndex = node.tasks.findIndex((t) => t.id === targetTaskId);
  return reorderListByIndex(node.tasks, fromIndex, targetIndex, placeAfter);
}

function refreshSeriesOrder(task) {
  (task.series || []).forEach((s, idx) => { s.order = idx; });
}

function sortSeriesByRankOrder(task) {
  const list = task?.series;
  if (!Array.isArray(list)) return;
  list.sort((a, b) => {
    const ra = Math.max(1, Number(a.rank) || 1);
    const rb = Math.max(1, Number(b.rank) || 1);
    if (ra !== rb) return ra - rb;
    const oa = Number.isFinite(a.order) ? Number(a.order) : 0;
    const ob = Number.isFinite(b.order) ? Number(b.order) : 0;
    if (oa !== ob) return oa - ob;
    return (a.text || '').localeCompare(b.text || '');
  });
  refreshSeriesOrder(task);
}

function nextSeriesRank(task) {
  const ranks = (task?.series || []).map((s) => Math.max(1, Number(s.rank) || 1));
  if (!ranks.length) return 1;
  return Math.max(...ranks) + 1;
}

function addSubtaskToTask(task, text, rank = null, now = new Date()) {
  const label = String(text || '').trim();
  if (!label) return null;
  const resolvedRank = rank == null ? nextSeriesRank(task) : Math.max(1, Number(rank) || 1);
  const item = createSubtask(label, resolvedRank);
  item.order = (task.series || []).length;
  task.series = (task.series || []).concat([item]);
  sortSeriesByRankOrder(task);
  // Any newly-added subtask should re-open the parent task if it was previously complete.
  task.completed = false;
  task.completedAt = null;
  task.archivedAt = null;
  task.nextRecurringAt = null;
  awardPoints(SUBTASK_CREATION_POINTS, now);
  return item;
}

function moveSubtaskRelative(nodeId, taskId, sourceSubtaskId, targetSubtaskId, placeAfter = false) {
  const node = findNodeById(store.data.threads || [], nodeId);
  const task = (node?.tasks || []).find((t) => t.id === taskId);
  const list = task?.series;
  if (!Array.isArray(list)) return false;
  const source = list.find((s) => s.id === sourceSubtaskId);
  const target = list.find((s) => s.id === targetSubtaskId);
  if (!source || !target || source.id === target.id) return false;
  source.rank = Math.max(1, Number(target.rank) || 1);
  const targetOrder = Number.isFinite(target.order) ? Number(target.order) : 0;
  source.order = targetOrder + (placeAfter ? 0.5 : -0.5);
  sortSeriesByRankOrder(task);
  return true;
}

// Reordering helpers (pantry categories)
function moveCategory(catId, delta) {
  const info = findCategoryParentInfo(catId);
  if (!info) return;
  const { list, index } = info;
  const j = index + delta;
  if (j < 0 || j >= list.length) return;
  const tmp = list[index]; list[index] = list[j]; list[j] = tmp;
  store.saveNow(); renderPantryPrepare();
}

function findCategoryParentInfo(targetId) {
  const roots = store.data.pantry?.categories || [];
  const idxTop = roots.findIndex(c => c.id === targetId);
  if (idxTop >= 0) return { parent: null, list: roots, index: idxTop };
  const stack = [...roots];
  while (stack.length) {
    const c = stack.pop();
    const kids = c.children || [];
    const idx = kids.findIndex(ch => ch.id === targetId);
    if (idx >= 0) return { parent: c, list: kids, index: idx };
    stack.push(...kids);
  }
  return null;
}

// ------------------------------
// Parent/root maps and colors
// ------------------------------
let parentById = new Map();
let nodeById = new Map();
let rootById = new Map();

function recomputeIndexes() {
  parentById = new Map();
  nodeById = new Map();
  rootById = new Map();
  const roots = store.data.threads || [];
  const walk = (list, parent = null, rootId = null) => {
    for (const n of list) {
      const thisRootId = parent ? rootId : n.id; // top-level nodes are their own root
      nodeById.set(n.id, n);
      if (parent) parentById.set(n.id, parent.id);
      rootById.set(n.id, thisRootId);
      if (n.children?.length) walk(n.children, n, thisRootId);
    }
  };
  walk(roots, null, null);
}

function rootOf(node) {
  if (!node) return null;
  const rootId = rootById.get(node.id);
  if (!rootId) return node; // if not found, assume itself
  return nodeById.get(rootId) || node;
}

const THREAD_PALETTE = ['#4f8cff', '#36d399', '#f6ad55', '#ef5350', '#c084fc', '#22d3ee', '#eab308'];

function hashName(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function autoAssignThreadColors() {
  const roots = store.data.threads || [];
  roots.forEach((t, idx) => {
    if (!t.color) {
      const h = hashName(t.name || '') + idx;
      t.color = THREAD_PALETTE[h % THREAD_PALETTE.length];
    }
  });
}

function normalizeNode(n) {
  n.children = Array.isArray(n.children) ? n.children : [];
  n.questions = Array.isArray(n.questions) ? n.questions : [];
  n.tasks = Array.isArray(n.tasks) ? n.tasks : [];
  n.name = n.name || 'Untitled';
  if (typeof n.enabled !== 'boolean') n.enabled = true;
  if (typeof n.collapsed !== 'boolean') n.collapsed = false;
  n.tasks.forEach(t => {
    if (typeof t.completed !== 'boolean') t.completed = !!t.completed;
    if (!('createdAt' in t)) t.createdAt = nowIso();
    if (!('completedAt' in t)) t.completedAt = null;
    if (!('archivedAt' in t)) t.archivedAt = null;
    if (typeof t.priority !== 'number' || t.priority < 1 || t.priority > 5) t.priority = 3;
    if (!('availableAt' in t)) t.availableAt = null;
    if (!('dueAt' in t)) t.dueAt = null;
    if (!('contexts' in t)) t.contexts = [];
    if (!Array.isArray(t.contexts)) t.contexts = [];
    if (!('blockedBy' in t)) t.blockedBy = [];
    if (!Array.isArray(t.blockedBy)) t.blockedBy = [];
    t.blockedBy = t.blockedBy.filter(Boolean);
    if (!('waitingOn' in t)) t.waitingOn = '';
    if (!('followUpAt' in t)) t.followUpAt = null;
    if (!('recurrence' in t)) t.recurrence = 'none';
    if (!['none', 'daily', 'weekly', 'monthly'].includes(t.recurrence)) t.recurrence = 'none';
    if (!('nextRecurringAt' in t)) t.nextRecurringAt = null;
    if (!('loc' in t)) t.loc = '';
    if (!('locations' in t)) t.locations = [];
    if (!Array.isArray(t.locations)) t.locations = [];
    if (!('duration' in t)) t.duration = null;
    t.duration = normalizeDurationValue(t.duration);
    const legacyLoc = normalizeTagValue(t.loc || '');
    if (legacyLoc && (!t.locations || !t.locations.length)) t.locations = [legacyLoc];
    t.locations = uniqTags(t.locations);
    if (!t.loc && t.locations.length) t.loc = t.locations[0];
    if (!('series' in t)) t.series = [];
    if (!Array.isArray(t.series)) t.series = [];
    t.series.forEach(s => {
      if (!s.id) s.id = uid('s');
      s.text = s.text || '';
      s.rank = Math.max(1, Number(s.rank) || 1);
      if (!('order' in s) || !Number.isFinite(s.order)) s.order = 0;
      if (typeof s.completed !== 'boolean') s.completed = !!s.completed;
      if (!('createdAt' in s)) s.createdAt = nowIso();
      if (!('completedAt' in s)) s.completedAt = null;
      if (!('archivedAt' in s)) s.archivedAt = null;
    });
    sortSeriesByRankOrder(t);
    if (t.completed && !t.completedAt) t.completedAt = t.createdAt || nowIso();
  });
  n.children.forEach(normalizeNode);
}

function normalizeCategory(c) {
  c.children = Array.isArray(c.children) ? c.children : [];
  c.items = Array.isArray(c.items) ? c.items : [];
  c.name = c.name || 'Category';
  if (typeof c.enabled !== 'boolean') c.enabled = true;
  if (typeof c.collapsed !== 'boolean') c.collapsed = false;
  c.items.forEach(it => {
    if (!it.id) it.id = uid('i');
    if (!it.name) it.name = 'Item';
    if (!['to_buy','stocked','not_needed'].includes(it.status)) it.status = 'stocked';
    it.notes = it.notes || '';
  });
  c.children.forEach(normalizeCategory);
}

// ------------------------------
// Availability helpers
// ------------------------------
function parseLocalDateTime(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (isNaN(dt)) return null;
  return dt.toISOString();
}

function toLocalInputValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function nextRecurringAt(cadence, fromDate = new Date()) {
  const d = new Date(fromDate);
  if (isNaN(d)) return null;
  if (cadence === 'daily') d.setDate(d.getDate() + 1);
  else if (cadence === 'weekly') d.setDate(d.getDate() + 7);
  else if (cadence === 'monthly') d.setMonth(d.getMonth() + 1);
  else return null;
  return d.toISOString();
}

function dueStatus(task, now = new Date()) {
  const due = parseIsoDate(task?.dueAt);
  if (!due) return { state: 'none', label: '' };
  if (due < now) return { state: 'overdue', label: `Overdue ${due.toLocaleString()}` };
  if ((due.getTime() - now.getTime()) <= 24 * 60 * 60 * 1000) return { state: 'soon', label: `Due ${due.toLocaleString()}` };
  return { state: 'upcoming', label: `Due ${due.toLocaleDateString()}` };
}

function setTaskCompleted(task, completed, now = new Date()) {
  const wasCompleted = !!task.completed;
  task.completed = !!completed;
  if (task.completed) {
    task.completedAt = now.toISOString();
    if (task.recurrence && task.recurrence !== 'none') task.nextRecurringAt = nextRecurringAt(task.recurrence, now);
  } else {
    task.completedAt = null;
    task.archivedAt = null;
    task.nextRecurringAt = null;
  }
  if (!wasCompleted && task.completed) {
    awardPoints(pointsForTaskCompletion(task), now);
  }
}

function setSubtaskCompleted(task, subtask, completed, now = new Date()) {
  subtask.completed = !!completed;
  if (subtask.completed) subtask.completedAt = now.toISOString();
  else {
    subtask.completedAt = null;
    subtask.archivedAt = null;
  }
  const stats = seriesStats(task);
  if (!stats) return;
  if (stats.remaining === 0) setTaskCompleted(task, true, now);
  else {
    task.completed = false;
    task.completedAt = null;
    task.archivedAt = null;
    task.nextRecurringAt = null;
  }
}

function allTaskRefMap() {
  const map = new Map();
  flattenTaskRefs().forEach(ref => map.set(ref.task.id, ref));
  return map;
}

function unresolvedDependencyIds(task, refs = null) {
  const ids = Array.isArray(task?.blockedBy) ? task.blockedBy : [];
  if (!ids.length) return [];
  const map = refs || allTaskRefMap();
  return ids.filter((id) => {
    const dep = map.get(id)?.task;
    return dep && !dep.completed;
  });
}

function dependencyNames(task, refs = null) {
  const map = refs || allTaskRefMap();
  const ids = unresolvedDependencyIds(task, map);
  if (!ids.length) return [];
  return ids.map(id => map.get(id)?.task?.text || 'Dependency');
}

function runRecurringTasks(now = new Date()) {
  let changed = false;
  flattenTaskRefs().forEach(({ task }) => {
    if (!task.recurrence || task.recurrence === 'none' || !task.nextRecurringAt) return;
    const due = parseIsoDate(task.nextRecurringAt);
    if (!due || now < due) return;
    task.completed = false;
    task.completedAt = null;
    task.archivedAt = null;
    task.nextRecurringAt = null;
    if (isSeriesTask(task)) {
      task.series.forEach((s) => {
        s.completed = false;
        s.completedAt = null;
        s.archivedAt = null;
      });
    }
    changed = true;
  });
  return changed;
}

function applyArchivingRules(days = 7, now = new Date()) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return false;
  const cutoff = n * 24 * 60 * 60 * 1000;
  let changed = false;
  flattenTaskRefs().forEach(({ task }) => {
    if (task.completed && task.completedAt) {
      const age = now.getTime() - new Date(task.completedAt).getTime();
      if (age >= cutoff && !task.archivedAt) { task.archivedAt = now.toISOString(); changed = true; }
    } else if (task.archivedAt) {
      task.archivedAt = null;
      changed = true;
    }
    (task.series || []).forEach((s) => {
      if (s.completed && s.completedAt) {
        const age = now.getTime() - new Date(s.completedAt).getTime();
        if (age >= cutoff && !s.archivedAt) { s.archivedAt = now.toISOString(); changed = true; }
      } else if (s.archivedAt) {
        s.archivedAt = null;
        changed = true;
      }
    });
  });
  return changed;
}

function snoozeTask(task, mode, now = new Date()) {
  const at = new Date(now);
  if (mode === 'later') {
    at.setHours(at.getHours() + 3, 0, 0, 0);
  } else if (mode === 'tomorrow') {
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
  } else if (mode === 'next-week') {
    at.setDate(at.getDate() + 7);
    at.setHours(9, 0, 0, 0);
  } else return;
  task.availableAt = at.toISOString();
}

function isTaskAvailable(t, now = new Date(), currentContext = null, depMap = null) {
  if (t.waitingOn && t.waitingOn.trim()) return false;
  if (unresolvedDependencyIds(t, depMap).length) return false;
  if (t.availableAt) {
    const at = new Date(t.availableAt);
    if (now < at) return false;
  }
  if (Array.isArray(t.contexts) && t.contexts.length) {
    if (!currentContext || !t.contexts.includes(currentContext)) return false;
  }
  return true;
}

function availabilityReason(t, now = new Date(), currentContext = null, depMap = null) {
  if (t.waitingOn && t.waitingOn.trim()) return `Waiting: ${t.waitingOn.trim()}`;
  const deps = dependencyNames(t, depMap);
  if (deps.length) return `Blocked by: ${deps.join(', ')}`;
  if (t.availableAt) {
    const at = new Date(t.availableAt);
    if (now < at) return `Available ${at.toLocaleString()}`;
  }
  if (Array.isArray(t.contexts) && t.contexts.length) {
    if (!currentContext || !t.contexts.includes(currentContext)) return `Context: ${t.contexts.join(', ')}`;
  }
  return '';
}

function passesContext(t, ctx) {
  if (!ctx || ctx === 'Any') return true;
  const arr = Array.isArray(t.contexts) ? t.contexts : [];
  // Show tasks with no contexts or those that include the selected context
  return arr.length === 0 || arr.includes(ctx);
}

// ------------------------------
// DOM helpers
// ------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(props).forEach(([k, v]) => {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined) node.setAttribute(k, v);
  });
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function confirmName(promptText, initial = '') {
  const name = window.prompt(promptText, initial);
  if (!name) return null;
  return name.trim();
}

function buildTaskTagline(t, reason = '', opts = {}) {
  const locs = taskLocations(t);
  const dur = taskDurationMins(t);
  const includeSeries = opts.includeSeries !== false;
  const series = includeSeries ? seriesSummary(t) : null;
  const due = dueStatus(t);
  if (!locs.length && !dur && !reason && !series && due.state === 'none') return null;
  const line = el('div', { class: 'tagline' });
  if (locs.length) line.append(el('span', { class: 'pill tag' }, `Loc: ${locs.join(', ')}`));
  if (dur) line.append(el('span', { class: 'pill tag' }, `Time: ${formatDuration(dur)}`));
  if (series) line.append(el('span', { class: 'pill tag series-pill' }, series));
  if (due.state !== 'none') {
    const cls = due.state === 'overdue' ? 'pill warn' : 'pill tag';
    line.append(el('span', { class: cls }, due.label));
  }
  if (reason) line.append(el('span', { class: 'pill warn' }, reason));
  return line;
}

function buildBreakIntoStepsCta(onAddStep) {
  const wrap = el('div', { class: 'breakdown-cta' });
  const copy = el('div', { class: 'breakdown-copy' }, 'Break this into smaller steps (+5 each)');
  const trigger = el('button', { class: 'btn ghost breakdown-trigger', type: 'button' }, 'Break Into Steps');
  const compose = el('div', { class: 'breakdown-compose' });
  compose.hidden = true;
  const input = el('input', { type: 'text', placeholder: 'First actionable step...' });
  const add = el('button', { class: 'btn ghost', type: 'button' }, 'Add');
  const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const closeCompose = () => {
    compose.hidden = true;
    trigger.hidden = false;
    input.value = '';
  };
  trigger.addEventListener('click', () => {
    compose.hidden = false;
    trigger.hidden = true;
    input.focus();
  });
  const addStep = () => {
    const value = input.value.trim();
    if (!value) {
      input.focus();
      return;
    }
    if (onAddStep(value) === false) return;
    input.value = '';
    input.focus();
  };
  add.addEventListener('click', addStep);
  cancel.addEventListener('click', closeCompose);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addStep();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeCompose();
    }
  });
  compose.append(input, add, cancel);
  wrap.append(copy, trigger, compose);
  return wrap;
}

function buildAvailabilityControls(nodeId, taskId, rerender) {
  const n = findNodeById(store.data.threads, nodeId);
  const t = (n?.tasks || []).find(x => x.id === taskId);
  const avail = el('div', { class: 'availability' });
  if (!n || !t) return avail;
  function updateTask(updater) {
    const live = findNodeById(store.data.threads, nodeId);
    const ti = live?.tasks?.findIndex(x => x.id === taskId) ?? -1;
    if (ti < 0) return;
    updater(live.tasks[ti]);
    store.saveNow(); rerender && rerender();
  }
  // Available From
  const row1 = el('div', { class: 'row' });
  row1.append(el('div', { class: 'subtext' }, 'Available from'));
  const dt = el('input', { type: 'datetime-local' });
  dt.value = toLocalInputValue(t.availableAt);
  dt.addEventListener('change', () => {
    updateTask(task => { task.availableAt = parseLocalDateTime(dt.value); });
  });
  const clear1 = el('button', { class: 'btn ghost' }, 'Clear');
  clear1.addEventListener('click', () => { dt.value = ''; updateTask(task => { task.availableAt = null; }); });
  row1.append(dt, clear1);
  avail.append(row1);

  // Due date
  const rowDue = el('div', { class: 'row' });
  rowDue.append(el('div', { class: 'subtext' }, 'Due'));
  const dueInput = el('input', { type: 'datetime-local' });
  dueInput.value = toLocalInputValue(t.dueAt);
  dueInput.addEventListener('change', () => {
    updateTask(task => { task.dueAt = parseLocalDateTime(dueInput.value); });
  });
  const clearDue = el('button', { class: 'btn ghost' }, 'Clear');
  clearDue.addEventListener('click', () => {
    dueInput.value = '';
    updateTask(task => { task.dueAt = null; });
  });
  rowDue.append(dueInput, clearDue);
  avail.append(rowDue);

  // Contexts
  const row2 = el('div', { class: 'row' });
  row2.append(el('div', { class: 'subtext' }, 'Contexts'));
  const ctxStack = el('div', { class: 'stack' });
  const chipWrap = el('div', { class: 'chiplist' });
  (t.contexts || []).forEach((c) => {
    const ch = el('span', { class: 'chip' }, [c, el('button', {}, '✕')]);
    ch.querySelector('button').addEventListener('click', () => {
      updateTask(task => { task.contexts = (task.contexts || []).filter(x => x !== c); });
    });
    chipWrap.append(ch);
  });
  const ctxAddRow = el('div', { class: 'mini-add' });
  const ctxInput = el('input', { type: 'text', placeholder: 'Add context…' });
  const addCtx = el('button', { class: 'btn ghost' }, 'Add');
  addCtx.addEventListener('click', () => {
    const v = ctxInput.value.trim(); if (!v) return;
    updateTask(task => {
      const arr = task.contexts || [];
      if (!arr.includes(v)) arr.push(v);
      task.contexts = arr;
    });
    ctxInput.value = '';
  });
  ctxInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCtx.click(); }
  });
  ctxAddRow.append(ctxInput, addCtx);
  ctxStack.append(chipWrap, ctxAddRow);
  row2.append(ctxStack, el('div'));
  avail.append(row2);

  // Locations (tags)
  const rowLoc = el('div', { class: 'row' });
  rowLoc.append(el('div', { class: 'subtext' }, 'Locations'));
  const locStack = el('div', { class: 'stack' });
  const locChips = el('div', { class: 'chiplist' });
  const locOptions = uniqTags([].concat(LOCATION_PRESETS, taskLocations(t)));
  locOptions.forEach((loc) => {
    const active = taskLocations(t).some(x => x.toLowerCase() === loc.toLowerCase());
    const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, loc);
    btn.addEventListener('click', () => {
      updateTask(task => {
        const list = taskLocations(task);
        const idx = list.findIndex(x => x.toLowerCase() === loc.toLowerCase());
        if (idx >= 0) list.splice(idx, 1);
        else list.push(loc);
        setTaskLocations(task, list);
      });
    });
    locChips.append(btn);
  });
  const locAddRow = el('div', { class: 'mini-add' });
  const locInput = el('input', { type: 'text', placeholder: 'Add location…' });
  const addLoc = el('button', { class: 'btn ghost' }, 'Add');
  addLoc.addEventListener('click', () => {
    const v = locInput.value.trim(); if (!v) return;
    updateTask(task => {
      const list = taskLocations(task);
      list.push(v);
      setTaskLocations(task, list);
    });
    locInput.value = '';
  });
  locInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLoc.click(); }
  });
  locAddRow.append(locInput, addLoc);
  locStack.append(locChips, locAddRow);
  const clearLoc = el('button', { class: 'btn ghost' }, 'Clear');
  clearLoc.addEventListener('click', () => { updateTask(task => { setTaskLocations(task, []); }); });
  rowLoc.append(locStack, clearLoc);
  avail.append(rowLoc);

  // Time estimate
  const rowTime = el('div', { class: 'row' });
  rowTime.append(el('div', { class: 'subtext' }, 'Time'));
  const timeStack = el('div', { class: 'stack' });
  const timeChips = el('div', { class: 'chiplist' });
  const current = taskDurationMins(t);
  const timeOptions = Array.from(new Set([].concat(DURATION_PRESETS, current ? [current] : []))).sort((a, b) => a - b);
  timeOptions.forEach((mins) => {
    const active = current === mins;
    const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, formatDuration(mins) || `${mins}m`);
    btn.addEventListener('click', () => {
      updateTask(task => {
        const cur = taskDurationMins(task);
        task.duration = cur === mins ? null : mins;
      });
    });
    timeChips.append(btn);
  });
  const timeAddRow = el('div', { class: 'mini-add' });
  const timeInput = el('input', { type: 'number', min: '1', placeholder: 'Custom mins' });
  const timeSet = el('button', { class: 'btn ghost' }, 'Set');
  timeSet.addEventListener('click', () => {
    const v = normalizeDurationValue(timeInput.value);
    if (!v) return;
    updateTask(task => { task.duration = v; });
    timeInput.value = '';
  });
  timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); timeSet.click(); }
  });
  timeAddRow.append(timeInput, timeSet);
  timeStack.append(timeChips, timeAddRow);
  const clearTime = el('button', { class: 'btn ghost' }, 'Clear');
  clearTime.addEventListener('click', () => { updateTask(task => { task.duration = null; }); });
  rowTime.append(timeStack, clearTime);
  avail.append(rowTime);

  // Recurrence
  const rowRecur = el('div', { class: 'row' });
  rowRecur.append(el('div', { class: 'subtext' }, 'Repeat'));
  const recurSel = el('select', { class: 'select-sm' });
  [['none', 'No repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].forEach(([v, label]) => {
    recurSel.append(el('option', { value: v }, label));
  });
  recurSel.value = t.recurrence || 'none';
  recurSel.addEventListener('change', () => {
    updateTask(task => {
      task.recurrence = recurSel.value;
      if (task.recurrence === 'none') task.nextRecurringAt = null;
      else if (task.completed && !task.nextRecurringAt) task.nextRecurringAt = nextRecurringAt(task.recurrence);
    });
  });
  const recurMeta = el('div', { class: 'subtext' }, t.nextRecurringAt ? `Next ${new Date(t.nextRecurringAt).toLocaleString()}` : '');
  rowRecur.append(recurSel, recurMeta);
  avail.append(rowRecur);

  // Dependencies
  const rowDeps = el('div', { class: 'row' });
  rowDeps.append(el('div', { class: 'subtext' }, 'Blocked by'));
  const depStack = el('div', { class: 'stack' });
  const depChips = el('div', { class: 'chiplist' });
  const allRefs = flattenTaskRefs().filter(r => r.task.id !== taskId);
  const byId = new Map(allRefs.map(r => [r.task.id, r]));
  (t.blockedBy || []).forEach((depId) => {
    const depRef = byId.get(depId);
    if (!depRef) return;
    const chip = el('span', { class: 'chip' }, [`${depRef.task.text}`, el('button', {}, '✕')]);
    chip.querySelector('button').addEventListener('click', () => {
      updateTask(task => { task.blockedBy = (task.blockedBy || []).filter(id => id !== depId); });
    });
    depChips.append(chip);
  });
  const depAddRow = el('div', { class: 'mini-add' });
  const depSel = el('select', { class: 'select-sm' });
  depSel.append(el('option', { value: '' }, 'Add dependency...'));
  allRefs.forEach((r) => {
    const label = `${r.task.text} (${nodePath(r.node)})`;
    depSel.append(el('option', { value: r.task.id }, label));
  });
  const depAdd = el('button', { class: 'btn ghost' }, 'Add');
  depAdd.addEventListener('click', () => {
    const depId = depSel.value;
    if (!depId) return;
    updateTask(task => {
      const arr = task.blockedBy || [];
      if (!arr.includes(depId)) arr.push(depId);
      task.blockedBy = arr;
    });
    depSel.value = '';
  });
  depAddRow.append(depSel, depAdd);
  depStack.append(depChips, depAddRow);
  rowDeps.append(depStack, el('div'));
  avail.append(rowDeps);

  // Snooze
  const rowSnooze = el('div', { class: 'row' });
  rowSnooze.append(el('div', { class: 'subtext' }, 'Snooze'));
  const snoozeRow = el('div', { class: 'chiplist' });
  const mkSnoozeBtn = (label, mode) => {
    const btn = el('button', { class: 'chip toggle' }, label);
    btn.addEventListener('click', () => {
      updateTask(task => { snoozeTask(task, mode); });
      showToast(`Snoozed to ${label.toLowerCase()}`);
    });
    return btn;
  };
  snoozeRow.append(mkSnoozeBtn('Later today', 'later'), mkSnoozeBtn('Tomorrow', 'tomorrow'), mkSnoozeBtn('Next week', 'next-week'));
  const clearSnooze = el('button', { class: 'btn ghost' }, 'Clear');
  clearSnooze.addEventListener('click', () => { updateTask(task => { task.availableAt = null; }); });
  rowSnooze.append(snoozeRow, clearSnooze);
  avail.append(rowSnooze);

  // Series
  const rowSeries = el('div', { class: 'row' });
  rowSeries.append(el('div', { class: 'subtext' }, 'Series'));
  const seriesEditor = el('div', { class: 'series-editor' });
  const stats = seriesStats(t);
  const total = stats?.total || 0;
  const done = stats?.done || 0;
  const maxRank = stats?.maxRank || 0;
  const activeRank = stats?.activeRank || null;

  const seriesHeader = el('div', { class: 'series-header' });
  const summary = el('div', { class: 'series-summary' });
  if (!total) {
    summary.append(el('span', { class: 'subtext' }, 'No subtasks yet.'));
  } else {
    summary.append(el('span', { class: 'series-badge' }, `Series ${done}/${total}`));
    summary.append(el('span', { class: 'subtext' }, activeRank ? `Step ${activeRank}/${maxRank}` : `Step 0/${maxRank}`));
  }
  const progress = el('div', { class: 'series-progress' });
  const fill = el('div', { class: 'fill' });
  const pct = total ? Math.round((done / total) * 100) : 0;
  fill.style.width = `${pct}%`;
  progress.append(fill);
  seriesHeader.append(summary, progress);

  const seriesList = el('div', { class: 'series-list' });
  const seriesItems = (t.series || []).slice().sort((a, b) => {
    const ra = Math.max(1, Number(a.rank) || 1);
    const rb = Math.max(1, Number(b.rank) || 1);
    if (ra !== rb) return ra - rb;
    const oa = Number.isFinite(a.order) ? Number(a.order) : 0;
    const ob = Number.isFinite(b.order) ? Number(b.order) : 0;
    if (oa !== ob) return oa - ob;
    return (a.text || '').localeCompare(b.text || '');
  });
  if (!seriesItems.length) {
    seriesList.append(el('div', { class: 'series-empty' }, 'Add your first step below.'));
  } else {
    const groups = new Map();
    seriesItems.forEach((s) => {
      const r = Math.max(1, Number(s.rank) || 1);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(s);
    });
    const ranks = Array.from(groups.keys()).sort((a, b) => a - b);
    ranks.forEach((r) => {
      const items = groups.get(r) || [];
      const doneCount = items.filter(s => s.completed).length;
      const allDone = doneCount === items.length;
      const group = el('div', { class: `series-group${allDone ? ' done' : ''}${activeRank === r ? ' current' : ''}` });
      const header = el('div', { class: 'series-group-header' });
      header.append(el('span', { class: 'series-step-pill' }, `Step ${r}`));
      header.append(el('span', { class: 'series-group-meta' }, `${doneCount}/${items.length} done`));
      const list = el('div', { class: 'series-group-list' });
      items.forEach((s) => {
        const row = el('div', { class: 'series-item' + (s.completed ? ' completed' : '') });
        const drag = el('button', { class: 'drag-handle', title: 'Drag to reorder', draggable: 'true', type: 'button' }, '⋮⋮');
        drag.addEventListener('dragstart', (e) => {
          setDragState({
            kind: 'subtask',
            sourceNodeId: nodeId,
            sourceTaskId: taskId,
            sourceSubtaskId: s.id,
            sourceParentId: taskId,
          });
          row.classList.add('dragging');
          try {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', `subtask:${s.id}`);
          } catch {}
        });
        drag.addEventListener('dragend', clearDragState);
        row.addEventListener('dragover', (e) => {
          if (dragState.kind !== 'subtask') return;
          if (!dragState.sourceSubtaskId || dragState.sourceSubtaskId === s.id) return;
          if (dragState.sourceParentId !== taskId) return;
          e.preventDefault();
          const after = isDropAfterPointer(e, row);
          clearDropIndicators();
          row.classList.add('drop-target');
          row.classList.toggle('drop-after', after);
        });
        row.addEventListener('drop', (e) => {
          if (dragState.kind !== 'subtask') return;
          if (!dragState.sourceSubtaskId || dragState.sourceSubtaskId === s.id) return;
          if (dragState.sourceParentId !== taskId) return;
          e.preventDefault();
          const placeAfter = row.classList.contains('drop-after');
          const moved = moveSubtaskRelative(nodeId, taskId, dragState.sourceSubtaskId, s.id, placeAfter);
          clearDragState();
          if (!moved) return;
          store.saveNow();
          rerender && rerender();
          showToast('Subtask order updated');
        });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!s.completed;
        cb.addEventListener('change', () => {
          updateTask(task => {
            const sub = (task.series || []).find(x => x.id === s.id);
            if (sub) setSubtaskCompleted(task, sub, cb.checked);
          });
        });
        const rankInput = el('input', { type: 'number', min: '1', class: 'series-rank' });
        rankInput.value = String(Math.max(1, Number(s.rank) || 1));
        rankInput.addEventListener('change', () => {
          updateTask(task => {
            const sub = (task.series || []).find(x => x.id === s.id);
            if (sub) sub.rank = Math.max(1, Number(rankInput.value) || 1);
            sortSeriesByRankOrder(task);
          });
        });
        const textInput = el('input', { type: 'text', class: 'series-text' });
        textInput.value = s.text || '';
        textInput.addEventListener('change', () => {
          updateTask(task => {
            const sub = (task.series || []).find(x => x.id === s.id);
            if (sub) sub.text = textInput.value.trim() || sub.text;
          });
        });
        const del = el('button', { class: 'btn ghost' }, 'Remove');
        del.addEventListener('click', () => {
          updateTask(task => {
            task.series = (task.series || []).filter(x => x.id !== s.id);
            sortSeriesByRankOrder(task);
          });
        });
        row.append(drag, cb, rankInput, textInput, del);
        list.append(row);
      });
      group.append(header, list);
      seriesList.append(group);
    });
  }

  const seriesAdd = el('div', { class: 'series-add' });
  const addText = el('input', { type: 'text', placeholder: 'Add subtask…' });
  const ranksExisting = Array.from(new Set((t.series || []).map(s => Math.max(1, Number(s.rank) || 1))));
  const nextRank = ranksExisting.length ? Math.max(...ranksExisting) + 1 : 1;
  const addRank = el('input', { type: 'number', min: '1', class: 'series-rank' });
  addRank.value = String(nextRank);
  const addBtn = el('button', { class: 'btn ghost' }, 'Add');
  const addSeriesItem = () => {
    const txt = addText.value.trim(); if (!txt) return;
    const rank = Math.max(1, Number(addRank.value) || 1);
    updateTask(task => {
      addSubtaskToTask(task, txt, rank);
    });
    addText.value = '';
    addRank.value = String(rank);
  };
  addBtn.addEventListener('click', addSeriesItem);
  addText.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSeriesItem(); } });
  seriesAdd.append(addText, addRank, addBtn);

  const rankChips = el('div', { class: 'rank-chips' });
  let rankOptions = ranksExisting.slice(0, 6);
  if (!rankOptions.includes(nextRank)) rankOptions.push(nextRank);
  rankOptions = Array.from(new Set(rankOptions)).sort((a, b) => a - b);
  const updateRankChipActive = () => {
    const cur = Math.max(1, Number(addRank.value) || 1);
    Array.from(rankChips.children).forEach((btn) => {
      const v = Number(btn.getAttribute('data-rank'));
      btn.classList.toggle('active', v === cur);
    });
  };
  rankOptions.forEach((r) => {
    const btn = el('button', { class: 'chip toggle', 'data-rank': String(r) }, `Step ${r}`);
    btn.addEventListener('click', () => {
      addRank.value = String(r);
      updateRankChipActive();
    });
    rankChips.append(btn);
  });
  addRank.addEventListener('input', updateRankChipActive);
  updateRankChipActive();

  const seriesNote = el('div', { class: 'series-note' }, 'Steps unlock in rank order. All tasks in a rank must be done to reveal the next rank. Tags apply to the whole series.');
  seriesEditor.append(seriesHeader, seriesList, seriesAdd, rankChips, seriesNote);
  rowSeries.append(seriesEditor, el('div'));
  avail.append(rowSeries);

  // Waiting on
  const row3 = el('div', { class: 'row' });
  row3.append(el('div', { class: 'subtext' }, 'Waiting on'));
  const waitInput = el('input', { type: 'text', placeholder: 'Name or reason…' });
  waitInput.value = t.waitingOn || '';
  waitInput.addEventListener('change', () => { updateTask(task => { task.waitingOn = waitInput.value.trim(); }); });
  const clearWait = el('button', { class: 'btn ghost' }, 'Clear');
  clearWait.addEventListener('click', () => { updateTask(task => { task.waitingOn = ''; }); });
  row3.append(waitInput, clearWait);
  avail.append(row3);

  return avail;
}

// ------------------------------
// Preparation view
// ------------------------------
function renderThreads() {
  const root = $('#threads-root');
  root.innerHTML = '';
  const depMap = allTaskRefMap();
  if (!store.data.threads.length) {
    root.append(el('div', { class: 'empty' }, 'No threads yet. Add one to begin.'));
    refreshQuickCaptureTargets();
    return;
  }
  for (const node of store.data.threads) {
    root.append(renderNode(node, depMap));
  }
  refreshQuickCaptureTargets();
}

function renderNode(node, depMap = null) {
  const container = el('div', { class: 'node', 'data-id': node.id });
  const header = el('div', { class: 'node-header' });
  const titleWrap = el('div', { class: 'node-title' });
  const caret = el('button', { class: 'btn ghost', title: 'Collapse/Expand' }, node.collapsed ? '▸' : '▾');
  caret.addEventListener('click', () => { node.collapsed = !node.collapsed; store.save(); renderThreads(); });
  const colorDot = el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:999px;background:${node.color || '#666'};margin-right:6px;vertical-align:middle;` });
  const titleInput = el('input', { type: 'text', class: 'task-title-input' });
  titleInput.value = node.name || 'Untitled';
  titleInput.addEventListener('change', () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = node.name || 'Untitled'; return; }
    node.name = v;
    store.save();
    recomputeIndexes();
    renderThreads();
  });
  titleWrap.append(caret, colorDot, titleInput);
  const actions = el('div', { class: 'node-actions' });

  const dragHandle = el('button', { class: 'drag-handle', title: 'Drag to reorder', draggable: 'true', type: 'button' }, '⋮⋮');
  dragHandle.addEventListener('dragstart', (e) => {
    setDragState({ kind: 'node', sourceNodeId: node.id });
    container.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `node:${node.id}`);
    } catch {}
  });
  dragHandle.addEventListener('dragend', clearDragState);
  container.addEventListener('dragover', (e) => {
    if (dragState.kind !== 'node') return;
    if (!dragState.sourceNodeId || dragState.sourceNodeId === node.id) return;
    e.preventDefault();
    const after = isDropAfterPointer(e, container);
    clearDropIndicators();
    container.classList.add('drop-target');
    container.classList.toggle('drop-after', after);
  });
  container.addEventListener('drop', (e) => {
    if (dragState.kind !== 'node') return;
    if (!dragState.sourceNodeId || dragState.sourceNodeId === node.id) return;
    e.preventDefault();
    const placeAfter = container.classList.contains('drop-after');
    const moved = moveNodeRelative(dragState.sourceNodeId, node.id, placeAfter);
    clearDragState();
    if (!moved) return;
    store.saveNow();
    recomputeIndexes();
    renderThreads();
    if (!$('#review-stage').hidden) { renderProgress(); renderStoryCard(); }
    if (!$('#view-tasks').hidden) renderTasksPane();
    showToast('Thread order updated');
  });

  const btnAddChild = el('button', { class: 'btn ghost' }, '+ Subthread');
  btnAddChild.addEventListener('click', () => {
    const name = confirmName('New subthread name', '');
    if (!name) return;
    node.children.push(createNode(name));
    store.save();
    recomputeIndexes();
    renderThreads();
  });

  const btnQuestions = el('button', { class: 'btn ghost' }, 'Questions');
  btnQuestions.addEventListener('click', () => openQuestionsModal(node.id));

  const btnTasks = el('button', { class: 'btn ghost' }, 'Tasks');
  btnTasks.addEventListener('click', () => openTasksModal(node.id));
  const moveUp = el('button', { class: 'btn ghost', title: 'Move up' }, '↑');
  moveUp.addEventListener('click', ()=>{ moveNode(node.id, -1); });
  const moveDown = el('button', { class: 'btn ghost', title: 'Move down' }, '↓');
  moveDown.addEventListener('click', ()=>{ moveNode(node.id, +1); });
  const enabledToggle = el('label', { class: 'subtext' });
  const en = el('input', { type: 'checkbox' }); en.checked = node.enabled !== false; en.addEventListener('change', ()=>{ node.enabled = en.checked; store.save(); renderThreads(); });
  enabledToggle.append(en, document.createTextNode(' Enabled'));

  actions.append(dragHandle, moveUp, moveDown, btnAddChild, btnQuestions, btnTasks, enabledToggle);
  header.append(titleWrap, actions);
  container.append(header);

  const footer = el('div', { class: 'kv' });
  const meta = el('div', { class: 'subtext' }, `${node.children.length} sub, ${node.questions.length} q, ${node.tasks.length} tasks`);
  footer.append(meta, el('div'));
  container.append(footer);
  container.classList.toggle('disabled', node.enabled === false);

  // Inline Questions (Prepare)
  const qSection = el('div', { class: 'story-section' });
  qSection.append(el('div', { class: 'subtext' }, 'Questions'));
  const qList = el('div', { class: 'inline-list' });
  if (!node.questions.length) qList.append(el('div', { class: 'empty' }, 'No questions yet.'));
  node.questions.forEach((q) => {
    const row = el('div', { class: 'inline-item' });
    const top = el('div', { class: 'kv' });
    const label = el('input', { type: 'text', class: 'task-title-input' });
    label.value = q.text;
    label.addEventListener('change', () => { q.text = label.value.trim() || q.text; store.save(); });
    const actions = el('div');
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.questions = node.questions.filter(x => x.id !== q.id);
      store.save(); renderThreads();
    });
    actions.append(del);
    top.append(label, actions);
    row.append(top);
    qList.append(row);
  });
  const qAdd = el('div', { class: 'add-row' });
  const qInput = el('input', { type: 'text', placeholder: 'Add question…' });
  const qBtn = el('button', { class: 'btn primary' }, 'Add');
  qBtn.addEventListener('click', () => {
    const t = qInput.value.trim(); if (!t) return;
    node.questions.push(createQuestion(t)); qInput.value = '';
    store.save(); renderThreads();
  });
  qAdd.append(qInput, qBtn);
  qSection.append(qList, qAdd);
  container.append(qSection);

  // Inline Tasks (Prepare)
  const tSection = el('div', { class: 'story-section' });
  tSection.append(el('div', { class: 'subtext' }, 'Tasks'));
  const tList = el('div', { class: 'inline-list' });
  const now = new Date();
  if (!node.tasks.length) tList.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  node.tasks.forEach((t) => {
    const row = el('div', { class: 'inline-item' });
    const top = el('div', { class: 'kv' });
    const label = el('input', { type: 'text', class: 'task-title-input' });
    label.value = t.text;
    label.addEventListener('change', () => { t.text = label.value.trim() || t.text; store.saveNow(); });
    const actions = el('div', { class: 'meta' });
    const taskDrag = el('button', { class: 'drag-handle', title: 'Drag to reorder', draggable: 'true', type: 'button' }, '⋮⋮');
    taskDrag.addEventListener('dragstart', (e) => {
      setDragState({ kind: 'task', sourceNodeId: node.id, sourceTaskId: t.id, sourceParentId: node.id });
      row.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `task:${t.id}`);
      } catch {}
    });
    taskDrag.addEventListener('dragend', clearDragState);
    row.addEventListener('dragover', (e) => {
      if (dragState.kind !== 'task') return;
      if (!dragState.sourceTaskId || dragState.sourceTaskId === t.id) return;
      if (dragState.sourceParentId !== node.id) return;
      e.preventDefault();
      const after = isDropAfterPointer(e, row);
      clearDropIndicators();
      row.classList.add('drop-target');
      row.classList.toggle('drop-after', after);
    });
    row.addEventListener('drop', (e) => {
      if (dragState.kind !== 'task') return;
      if (!dragState.sourceTaskId || dragState.sourceTaskId === t.id) return;
      if (dragState.sourceParentId !== node.id) return;
      e.preventDefault();
      const placeAfter = row.classList.contains('drop-after');
      const moved = moveTaskRelative(node.id, dragState.sourceTaskId, t.id, placeAfter);
      clearDragState();
      if (!moved) return;
      store.saveNow();
      renderThreads();
      if (!$('#review-stage').hidden) { renderProgress(); renderStoryCard(); }
      if (!$('#view-tasks').hidden) renderTasksPane();
      showToast('Task order updated');
    });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderThreads(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.tasks = node.tasks.filter(x => x.id !== t.id);
      store.save(); renderThreads();
    });
    const avail = buildAvailabilityControls(node.id, t.id, () => renderThreads());
    avail.hidden = !isTagPanelOpen('prepare', t.id);
    const availBtn = el('button', { class: 'btn ghost' }, 'Tags');
    availBtn.addEventListener('click', () => {
      avail.hidden = !avail.hidden;
      setTagPanelOpen('prepare', t.id, !avail.hidden);
    });
    actions.append(taskDrag, pri, availBtn, del);
    top.append(label, actions);
    // status tint
    if (t.completed) row.classList.add('status-completed');
    else if (isTaskAvailable(t, now, null, depMap)) row.classList.add('status-available');
    else row.classList.add('status-blocked');
    row.append(top);
    // Availability controls (Prepare, hidden by default)
    row.append(avail);
    tList.append(row);
  });
  const tAdd = el('div', { class: 'add-row' });
  const tInput = el('input', { type: 'text', placeholder: 'Add task…' });
  const tBtn = el('button', { class: 'btn primary' }, 'Add');
  tBtn.addEventListener('click', () => {
    const txt = tInput.value.trim(); if (!txt) return;
    node.tasks.push(createTask(txt)); tInput.value = '';
    store.save(); renderThreads();
  });
  tAdd.append(tInput, tBtn);
  tSection.append(tList, tAdd);
  container.append(tSection);

  if (node.children.length) {
    const kids = el('div', { class: 'node-children' });
    kids.hidden = !!node.collapsed;
    for (const child of node.children) kids.append(renderNode(child, depMap));
    container.append(kids);
  }
  return container;
}

function openQuestionsModal(nodeId) {
  const node = findNodeById(store.data.threads, nodeId);
  const body = $('#modal-body');
  const title = $('#modal-title');
  title.textContent = `Questions · ${node.name}`;
  body.innerHTML = '';

  const list = el('div', { class: 'inline-list' });
  node.questions.forEach((q) => {
    const row = el('div', { class: 'inline-item' });
    const ta = el('textarea', { value: q.text });
    ta.value = q.text;
    ta.addEventListener('input', () => { q.text = ta.value; store.save(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.questions = node.questions.filter(x => x.id !== q.id);
      store.save();
      openQuestionsModal(nodeId);
    });
    row.append(ta, del);
    list.append(row);
  });

  const addRow = el('div', { class: 'add-row' });
  const input = el('input', { type: 'text', placeholder: 'Add question…' });
  const addBtn = el('button', { class: 'btn primary' }, 'Add');
  addBtn.addEventListener('click', () => {
    const t = input.value.trim(); if (!t) return;
    node.questions.push(createQuestion(t)); input.value = '';
    store.save(); openQuestionsModal(nodeId);
  });
  addRow.append(input, addBtn);

  body.append(list, addRow);
  openModal();
}

function openTasksModal(nodeId) {
  const node = findNodeById(store.data.threads, nodeId);
  const body = $('#modal-body');
  const title = $('#modal-title');
  title.textContent = `Tasks · ${node.name}`;
  body.innerHTML = '';

  const list = el('div', { class: 'inline-list' });
  node.tasks.forEach((t) => {
    const row = el('div', { class: 'inline-item' });
    const text = el('input', { type: 'text' });
    text.value = t.text;
    text.addEventListener('input', () => { t.text = text.value; store.save(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.tasks = node.tasks.filter(x => x.id !== t.id);
      store.save(); openTasksModal(nodeId);
    });
    row.append(text, del);
    list.append(row);
  });

  const addRow = el('div', { class: 'add-row' });
  const input = el('input', { type: 'text', placeholder: 'Add task…' });
  const addBtn = el('button', { class: 'btn primary' }, 'Add');
  addBtn.addEventListener('click', () => {
    const t = input.value.trim(); if (!t) return;
    node.tasks.push(createTask(t)); input.value = '';
    store.save(); openTasksModal(nodeId);
  });
  addRow.append(input, addBtn);

  body.append(list, addRow);
  openModal();
}

// ------------------------------
// Review flow
// ------------------------------
let reviewState = {
  ids: [],
  idx: 0,
};

function hasActiveReviewProgress() {
  return Array.isArray(reviewState.ids) && reviewState.ids.length > 0;
}

function syncReviewStateToCurrentNodes() {
  const nodes = subthreadsForReview();
  const ids = nodes.map((n) => n.id);
  if (!ids.length) {
    reviewState = { ids: [], idx: 0 };
    clearReviewProgress();
    return false;
  }
  let idx = Math.min(Math.max(0, Number(reviewState.idx) || 0), ids.length - 1);
  const currentId = reviewState.ids[reviewState.idx] || null;
  if (currentId) {
    const j = ids.indexOf(currentId);
    if (j >= 0) idx = j;
  }
  reviewState = { ids, idx };
  return true;
}

function saveReviewProgress() {
  try {
    if (!reviewState.ids.length) { localStorage.removeItem(REVIEW_STATE_KEY); return; }
    const payload = {
      active: true,
      idx: reviewState.idx,
      currentId: reviewState.ids[reviewState.idx] || null,
    };
    localStorage.setItem(REVIEW_STATE_KEY, JSON.stringify(payload));
  } catch {}
}

function clearReviewProgress() {
  try { localStorage.removeItem(REVIEW_STATE_KEY); } catch {}
}

function restoreReviewProgressIfAny() {
  try {
    const raw = localStorage.getItem(REVIEW_STATE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved || !saved.active) return false;
    const nodes = subthreadsForReview();
    const ids = nodes.map(n => n.id);
    if (!ids.length) return false;
    let idx = Math.min(Math.max(0, saved.idx || 0), ids.length - 1);
    if (saved.currentId) {
      const j = ids.indexOf(saved.currentId);
      if (j >= 0) idx = j;
    }
    reviewState = { ids, idx };
    // ensure review view visible
    switchView('review');
    const summary = $('#review-summary');
    if (summary) summary.hidden = true;
    $('#review-empty').hidden = true;
    $('#review-stage').hidden = false;
    $('#btn-start-review').hidden = true;
    renderProgress();
    renderStoryCard();
    return true;
  } catch {
    return false;
  }
}

function startReview() {
  // ensure latest structure is indexed
  recomputeIndexes();
  const summary = $('#review-summary');
  if (summary) summary.hidden = true;
  const nodes = subthreadsForReview();
  reviewState = { ids: nodes.map(n => n.id), idx: 0 };
  if (!nodes.length) {
    $('#review-empty').hidden = false;
    $('#review-stage').hidden = true;
    $('#btn-start-review').hidden = false;
    return;
  }
  $('#review-empty').hidden = true;
  $('#review-stage').hidden = false;
  $('#btn-start-review').hidden = true;
  renderProgress();
  renderStoryCard();
  saveReviewProgress();
}

function renderProgress() {
  const bar = $('#story-progress');
  bar.innerHTML = '';
  const total = reviewState.ids.length || 1;
  for (let i = 0; i < total; i++) {
    const node = findNodeById(store.data.threads, reviewState.ids[i]);
    const root = rootOf(node);
    // divider between different root threads
    if (i > 0) {
      const prevNode = findNodeById(store.data.threads, reviewState.ids[i - 1]);
      const prevRoot = rootOf(prevNode);
      if (prevRoot?.id !== root?.id) bar.append(el('div', { class: 'divider' }));
    }
    const seg = el('div', { class: 'segment' });
    seg.style.setProperty('--seg-color', root?.color || 'white');
    const fill = el('div', { class: 'fill' });
    if (i < reviewState.idx) seg.classList.add('done');
    if (i === reviewState.idx) seg.classList.add('current');
    seg.append(fill);
    bar.append(seg);
  }
  // set current width to 100% statically (no timer). Could animate later.
  const current = bar.querySelector('.segment.current .fill');
  if (current) current.style.setProperty('--w', '100%');
}

function renderStoryCard() {
  const n = findNodeById(store.data.threads, reviewState.ids[reviewState.idx]);
  const card = $('#story-card');
  card.innerHTML = '';

  if (!n) {
    card.append(el('div', { class: 'empty' }, 'Review complete.'));
    return;
  }

  const root = rootOf(n);
  card.style.setProperty('--thread-color', root?.color || 'var(--accent)');

  // Header
  const header = el('div', { class: 'story-header' });
  const threadLine = el('div', { class: 'thread-line' });
  const initial = (root?.name || '?').trim().charAt(0).toUpperCase();
  threadLine.append(
    el('div', { class: 'thread-pill' }, [
      el('div', { class: 'thread-avatar' }, initial),
      root?.name || 'Thread'
    ])
  );
  const breadcrumb = el('div', { class: 'breadcrumb' }, `${root?.name || ''} › ${n.name}`);
  const title = el('div', { class: 'story-title' }, n.name);
  header.append(threadLine);
  header.append(title);
  header.append(breadcrumb);

  // Questions
  const qSection = el('div', { class: 'story-section' });
  qSection.append(el('div', { class: 'subtext' }, `${root?.name || 'Thread'} — Questions`));
  if (!n.questions.length) qSection.append(el('div', { class: 'empty' }, 'No questions yet.'));
  for (const q of n.questions) {
    const wrap = el('div', { class: 'inline-item' });
    // Top row: label + actions
    const top = el('div', { class: 'kv' });
    const label = el('input', { type: 'text', class: 'task-title-input' });
    label.value = q.text;
    label.addEventListener('change', () => {
      const live = findNodeById(store.data.threads, n.id);
      const qi = live.questions.findIndex(x => x.id === q.id);
      if (qi >= 0) live.questions[qi].text = label.value.trim() || live.questions[qi].text;
      store.saveNow();
    });
    const actions = el('div');
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.questions = live.questions.filter(x => x.id !== q.id);
      store.saveNow(); renderStoryCard(); renderProgress();
    });
    actions.append(delBtn);
    top.append(label, actions);
    wrap.append(top);
    qSection.append(wrap);
  }
  // Quick add question in review
  const addQ = el('div', { class: 'add-row' });
  const qInput = el('input', { type: 'text', placeholder: 'Add question…' });
  const qBtn = el('button', { class: 'btn' }, 'Add');
  qBtn.addEventListener('click', () => {
    const t = qInput.value.trim(); if (!t) return;
    const live = findNodeById(store.data.threads, n.id);
    live.questions.push(createQuestion(t)); qInput.value = '';
    store.saveNow(); renderProgress(); renderStoryCard();
  });
  addQ.append(qInput, qBtn);
  qSection.append(addQ);

  // Tasks
  const tSection = el('div', { class: 'story-section' });
  tSection.append(el('div', { class: 'subtext' }, `${root?.name || 'Thread'} — Tasks`));
  const tasksEl = el('div', { class: 'tasks' });
  const depMap = allTaskRefMap();
  const now = new Date();
  if (!n.tasks.length) tasksEl.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  for (const t of n.tasks) {
    const stats = seriesStats(t);
    const isSeries = !!stats;
    const done = isSeries ? (stats.remaining === 0) : !!t.completed;
    const item = el('div', { class: 'task' + (done ? ' completed' : '') });
    if (isSeries) item.classList.add('series-task');
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!done;
    if (isSeries) {
      cb.disabled = true;
      cb.title = done ? 'Series complete' : 'Complete subtasks to finish series';
    } else {
      cb.addEventListener('change', () => {
        const live = findNodeById(store.data.threads, n.id);
        const ti = live.tasks.findIndex(x => x.id === t.id);
        if (ti >= 0) setTaskCompleted(live.tasks[ti], cb.checked);
        store.saveNow();
        item.classList.toggle('completed', cb.checked);
      });
    }
    const main = el('div');
    const titleInput = el('input', { type: 'text', class: 'task-title-input' });
    titleInput.value = t.text;
    titleInput.addEventListener('change', () => {
      const live = findNodeById(store.data.threads, n.id);
      const ti = live.tasks.findIndex(x => x.id === t.id);
      if (ti >= 0) live.tasks[ti].text = titleInput.value.trim() || live.tasks[ti].text;
      store.saveNow();
      renderThreads();
    });
    main.append(titleInput);
    const btns = el('div', { class: 'meta' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => {
      const live = findNodeById(store.data.threads, n.id);
      const ti = live.tasks.findIndex(x => x.id === t.id);
      if (ti >= 0) { live.tasks[ti].priority = Number(pri.value); }
      store.saveNow(); renderStoryCard(); renderProgress();
    });
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.tasks = live.tasks.filter(x => x.id !== t.id);
      store.saveNow(); renderStoryCard(); renderProgress();
    });
    const avail = buildAvailabilityControls(n.id, t.id, () => renderStoryCard());
    avail.hidden = !isTagPanelOpen('review', t.id);
    const availBtn = el('button', { class: 'btn ghost' }, 'Tags');
    availBtn.addEventListener('click', () => {
      avail.hidden = !avail.hidden;
      setTagPanelOpen('review', t.id, !avail.hidden);
    });
    btns.append(pri, availBtn, delBtn);
    const reason = availabilityReason(t, now, null, depMap);
    const tagline = buildTaskTagline(t, reason);
    if (tagline) main.append(tagline);
    if (!isSeries) {
      const breakdown = buildBreakIntoStepsCta((stepText) => {
        const live = findNodeById(store.data.threads, n.id);
        const ti = live?.tasks?.findIndex(x => x.id === t.id) ?? -1;
        if (ti < 0) return false;
        addSubtaskToTask(live.tasks[ti], stepText, 1);
        setTagPanelOpen('review', t.id, true);
        store.saveNow();
        renderThreads();
        renderProgress();
        renderStoryCard();
        showToast('Series started');
        return true;
      });
      main.append(breakdown);
    }
    item.append(cb, main, btns);
    // Availability controls (Review, hidden by default)
    item.append(avail);
    // Status tint classes
    if (done) item.classList.add('status-completed');
    else if (isTaskAvailable(t, now, null, depMap)) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    tasksEl.append(item);
  }
  // Quick add task in review
  const addT = el('div', { class: 'add-row' });
  const tInput = el('input', { type: 'text', placeholder: 'Add task…' });
  const tBtn = el('button', { class: 'btn' }, 'Add');
  tBtn.addEventListener('click', () => {
    const t = tInput.value.trim(); if (!t) return;
    const live = findNodeById(store.data.threads, n.id);
    live.tasks.push(createTask(t)); tInput.value = '';
    store.saveNow(); renderProgress(); renderStoryCard();
  });
  addT.append(tInput, tBtn);

  card.append(header, qSection, tSection, tasksEl, addT);
}

function buildCarryForwardRecommendations(limit = 6) {
  const now = new Date();
  const depMap = allTaskRefMap();
  const refs = flattenTaskEntries().filter((ref) => {
    if (ref.kind === 'subtask') return !ref.subtask.completed && isTaskAvailable(ref.task, now, null, depMap);
    return !ref.task.completed && isTaskAvailable(ref.task, now, null, depMap);
  });
  refs.sort((a, b) => {
    const pa = a.task.priority || 3;
    const pb = b.task.priority || 3;
    if (pa !== pb) return pa - pb;
    const da = a.task.dueAt ? new Date(a.task.dueAt).getTime() : Infinity;
    const db = b.task.dueAt ? new Date(b.task.dueAt).getTime() : Infinity;
    return da - db;
  });
  return refs.slice(0, limit);
}

function renderReviewSummary() {
  const stage = $('#review-stage');
  const empty = $('#review-empty');
  const summary = $('#review-summary');
  if (!summary || !empty || !stage) return;
  stage.hidden = true;
  empty.hidden = true;
  summary.hidden = false;
  const refs = flattenTaskRefs();
  const now = new Date();
  const depMap = allTaskRefMap();
  const total = refs.length;
  const completed = refs.filter(r => r.task.completed).length;
  const blocked = refs.filter(r => !isTaskAvailable(r.task, now, null, depMap)).length;
  const dueSoon = refs.filter((r) => {
    const ds = dueStatus(r.task);
    return ds.state === 'overdue' || ds.state === 'soon';
  }).length;
  const recs = buildCarryForwardRecommendations(6);
  summary.innerHTML = '';
  const header = el('div', { class: 'summary-header' });
  header.append(el('h2', {}, 'Review Summary'));
  header.append(el('div', { class: 'subtext' }, `${completed}/${total} tasks completed`));
  const metrics = el('div', { class: 'summary-metrics' });
  metrics.append(el('div', { class: 'summary-metric' }, [`${blocked}`, el('span', {}, 'Blocked')]));
  metrics.append(el('div', { class: 'summary-metric' }, [`${dueSoon}`, el('span', {}, 'Urgent')]));
  const list = el('div', { class: 'summary-list' });
  if (!recs.length) list.append(el('div', { class: 'empty' }, 'No carry-forward tasks. Review is clear.'));
  recs.forEach((ref) => {
    const title = ref.kind === 'subtask' ? ref.subtask.text : ref.task.text;
    const parent = ref.kind === 'subtask' ? ` (${ref.task.text})` : '';
    const row = el('div', { class: 'summary-item' });
    row.append(el('strong', {}, title + parent));
    row.append(el('div', { class: 'subtext' }, `${nodePath(ref.node)} • Priority ${ref.task.priority || 3}`));
    list.append(row);
  });
  const footer = el('div', { class: 'summary-actions' });
  const openTasks = el('button', { class: 'btn primary' }, 'Open Carry-Forward Tasks');
  openTasks.addEventListener('click', () => {
    switchView('tasks');
    renderTasksPane();
  });
  const rerun = el('button', { class: 'btn ghost' }, 'Run Review Again');
  rerun.addEventListener('click', startReview);
  footer.append(openTasks, rerun);
  summary.append(header, metrics, list, footer);
}

function nextStory() {
  if (reviewState.idx < reviewState.ids.length - 1) {
    reviewState.idx += 1; renderProgress(); renderStoryCard(); saveReviewProgress();
  } else {
    // End of review: hide stage, show start button and a completion message
    renderReviewSummary();
    reviewState = { ids: [], idx: 0 };
    $('#btn-start-review').hidden = false;
    clearReviewProgress();
  }
}

function prevStory() {
  if (reviewState.idx > 0) {
    reviewState.idx -= 1; renderProgress(); renderStoryCard(); saveReviewProgress();
  }
}

// ------------------------------
// Modal helpers
// ------------------------------
function openModal() { $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; }

// ------------------------------
// App wiring
// ------------------------------
async function init() {
  loadUiPrefs();
  loadTasksViewState();
  // Attempt Firebase first; fallback to localStorage
  const usedFirebase = await store.tryFirebase();
  if (!usedFirebase) store.load();
  const gamificationChanged = loadGamificationState();
  if (gamificationChanged) store.saveNow();
  // Normalize, colorize and index
  (store.data.threads || []).forEach(normalizeNode);
  (store.data.pantry?.categories || []).forEach(normalizeCategory);
  autoAssignThreadColors();
  recomputeIndexes();
  resetHistoryBaseline();
  // Seed example if empty
  if (store.mode === 'local' && !store.data.threads.length) {
    const fitness = createNode('Fitness');
    fitness.children.push(createNode('Strength'));
    fitness.children.push(createNode('Cardio'));
    const reading = createNode('Reading');
    const academic = createNode('Academic');
    const personal = createNode('Personal Reading');
    const exam = createNode('Exam Study');
    const audit = createNode('Clinical Audit');
    academic.children.push(personal, exam, audit);
    exam.questions.push(createQuestion('When do I plan to complete this?'));
    exam.tasks.push(createTask('Read chapter on cardiology'));
    store.data.threads.push(fitness, reading, academic);
    autoAssignThreadColors();
    store.save();
    recomputeIndexes();
    resetHistoryBaseline();
  }

  // Tabs
  $('#tab-prepare').addEventListener('click', () => switchView('prepare'));
  $('#tab-review').addEventListener('click', () => switchView('review'));
  $('#tab-tasks').addEventListener('click', () => switchView('tasks'));
  $('#tab-pantry').addEventListener('click', () => switchView('pantry'));
  const quickCaptureForm = $('#quick-capture-form');
  const quickCaptureInput = $('#quick-capture-input');
  const quickCaptureTarget = $('#quick-capture-target');
  quickCaptureForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = quickCaptureInput?.value || '';
    quickCaptureTask(text, quickCaptureTarget?.value || null);
    if (quickCaptureInput) quickCaptureInput.value = '';
  });
  quickCaptureTarget?.addEventListener('change', () => {
    uiPrefs.captureNodeId = quickCaptureTarget.value || null;
    persistUiPrefs();
  });
  const globalSearch = $('#global-search');
  globalSearch?.addEventListener('input', () => renderSearchResults(globalSearch.value));
  globalSearch?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      globalSearch.value = '';
      renderSearchResults('');
      globalSearch.blur();
    }
  });
  document.addEventListener('click', (e) => {
    const bar = $('.utility-bar');
    if (!bar || bar.contains(e.target)) return;
    if (globalSearch) globalSearch.value = '';
    renderSearchResults('');
  });
  $('#btn-undo')?.addEventListener('click', undoChange);
  $('#btn-redo')?.addEventListener('click', redoChange);
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const isTypingField = !!target && (
      target.matches?.('input[type="text"], input[type="search"], input[type="number"], input[type="datetime-local"], textarea, select') ||
      target.isContentEditable
    );
    if (isTypingField) return;
    const z = e.key.toLowerCase() === 'z';
    const meta = e.metaKey || e.ctrlKey;
    if (meta && z && !e.shiftKey) { e.preventDefault(); undoChange(); }
    if (meta && z && e.shiftKey) { e.preventDefault(); redoChange(); }
  });

  // Prepare actions
  $('#btn-add-thread').addEventListener('click', () => {
    const name = confirmName('New thread name');
    if (!name) return;
    const t = createNode(name);
    // assign color to new top-level thread
    t.color = THREAD_PALETTE[hashName(name) % THREAD_PALETTE.length];
    store.data.threads.push(t);
    store.save();
    recomputeIndexes();
    renderThreads();
  });

  // Review actions
  $('#btn-start-review').addEventListener('click', startReview);
  $('#btn-next').addEventListener('click', nextStory);
  $('#btn-prev').addEventListener('click', prevStory);

  // Modal events
  $('#modal').addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) closeModal();
  });

  renderThreads();
  onReviewVisibility();
  switchView(uiPrefs.lastView || 'prepare');
  // Pre-render tasks pane if selected later
  // No-op here; render on switch
  // Restore review if previously active (main), else try pantry review
  if (!restoreReviewProgressIfAny()) {
    restorePantryReviewProgressIfAny();
  }
}

function switchView(name) {
  const prepare = $('#view-prepare');
  const review = $('#view-review');
  const tasks = $('#view-tasks');
  const pantry = $('#view-pantry');
  const tPrepare = $('#tab-prepare');
  const tReview = $('#tab-review');
  const tTasks = $('#tab-tasks');
  const tPantry = $('#tab-pantry');
  const isPrepare = name === 'prepare';
  const isReview = name === 'review';
  const isTasks = name === 'tasks';
  const isPantry = name === 'pantry';
  prepare.hidden = !isPrepare; review.hidden = !isReview; tasks.hidden = !isTasks; pantry.hidden = !isPantry;
  prepare.classList.toggle('active', isPrepare);
  review.classList.toggle('active', isReview);
  tasks.classList.toggle('active', isTasks);
  pantry.classList.toggle('active', isPantry);
  tPrepare.classList.toggle('active', isPrepare);
  tReview.classList.toggle('active', isReview);
  tTasks.classList.toggle('active', isTasks);
  tPantry.classList.toggle('active', isPantry);
  if (isReview) onReviewVisibility();
  if (isTasks) renderTasksPane();
  if (isPantry) renderPantryActiveView();
  uiPrefs.lastView = name;
  persistUiPrefs();
}

function onReviewVisibility() {
  const summary = $('#review-summary');
  if (summary) summary.hidden = true;
  if (hasActiveReviewProgress() && syncReviewStateToCurrentNodes()) {
    $('#review-empty').hidden = true;
    $('#review-stage').hidden = false;
    $('#btn-start-review').hidden = true;
    renderProgress();
    renderStoryCard();
    saveReviewProgress();
    return;
  }
  const has = subthreadsForReview().length > 0;
  // Show empty only when there are no subthreads; stage remains hidden until start
  const empty = $('#review-empty');
  if (has) {
    empty.textContent = 'Press Start Review to begin.';
    empty.hidden = false;
  } else {
    empty.textContent = 'No subthreads yet. Add some in Prepare.';
    empty.hidden = false;
  }
  $('#review-stage').hidden = true;
  $('#btn-start-review').hidden = false;
}

// ------------------------------
// Tasks screen (all tasks by priority)
// ------------------------------
function flattenTaskRefs() {
  const out = [];
  const roots = store.data.threads || [];
  const walk = (list) => {
    for (const n of list) {
      if (!isNodePathEnabled(n)) { if (n.children?.length) walk(n.children); continue; }
      for (let i = 0; i < (n.tasks || []).length; i++) {
        const t = n.tasks[i];
        out.push({ node: n, index: i, task: t, root: rootOf(n) });
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

function nodePath(n) {
  const names = [];
  let cur = n;
  while (cur) {
    names.unshift(cur.name);
    const pid = parentById.get(cur.id);
    cur = pid ? nodeById.get(pid) : null;
  }
  return names.join(' › ');
}

function flattenTaskEntries() {
  const out = [];
  const refs = flattenTaskRefs();
  refs.forEach((ref) => {
    const t = ref.task;
    if (isSeriesTask(t)) {
      const stats = seriesStats(t);
      const active = stats?.activeItems || [];
      active.forEach((s) => {
        out.push({ kind: 'subtask', subtask: s, series: stats, ...ref });
      });
    } else {
      out.push({ kind: 'task', ...ref });
    }
  });
  return out;
}

// ------------------------------
// Pantry views
// ------------------------------
function renderPantryActiveView() {
  const ptabPrep = $('#ptab-prepare');
  const ptabRev = $('#ptab-review');
  const ptabShop = $('#ptab-shopping');
  if (![ptabPrep, ptabRev, ptabShop].some(b => b.classList.contains('active'))) {
    if (uiPrefs.pantryTab === 'review') ptabRev.classList.add('active');
    else if (uiPrefs.pantryTab === 'shopping') ptabShop.classList.add('active');
    else ptabPrep.classList.add('active');
  }
  // attach listeners once
  if (!ptabPrep._wired) {
    ptabPrep._wired = true;
    ptabPrep.addEventListener('click', () => { ptabPrep.classList.add('active'); ptabRev.classList.remove('active'); ptabShop.classList.remove('active'); renderPantryActiveView(); });
    ptabRev.addEventListener('click', () => { ptabRev.classList.add('active'); ptabPrep.classList.remove('active'); ptabShop.classList.remove('active'); renderPantryActiveView(); });
    ptabShop.addEventListener('click', () => { ptabShop.classList.add('active'); ptabPrep.classList.remove('active'); ptabRev.classList.remove('active'); renderPantryActiveView(); });
    // buttons in review
    $('#btn-start-pantry-review').addEventListener('click', startPantryReview);
    $('#pbtn-next').addEventListener('click', pantryNext);
    $('#pbtn-prev').addEventListener('click', pantryPrev);
  }
  const vPrep = $('#pantry-prepare');
  const vRev = $('#pantry-review');
  const vShop = $('#pantry-shopping');
  const active = [ptabPrep, ptabRev, ptabShop].find(b => b.classList.contains('active')) || ptabPrep;
  if (active === ptabPrep) uiPrefs.pantryTab = 'prepare';
  if (active === ptabRev) uiPrefs.pantryTab = 'review';
  if (active === ptabShop) uiPrefs.pantryTab = 'shopping';
  persistUiPrefs();
  vPrep.hidden = active !== ptabPrep; vPrep.classList.toggle('active', active === ptabPrep);
  vRev.hidden = active !== ptabRev; vRev.classList.toggle('active', active === ptabRev);
  vShop.hidden = active !== ptabShop; vShop.classList.toggle('active', active === ptabShop);
  if (active === ptabPrep) renderPantryPrepare();
  if (active === ptabRev) pantryOnReviewVisibility();
  if (active === ptabShop) { renderShoppingList(); wireCopyShopping(); }
}

function renderPantryPrepare() {
  const root = $('#pantry-prepare-root');
  root.innerHTML = '';
  const cats = store.data.pantry?.categories || [];
  if (!cats.length) root.append(el('div', { class: 'empty' }, 'No categories yet. Add one to begin.'));
  cats.forEach(c => root.append(renderPantryCategory(c)));
  const addBtn = $('#btn-add-category');
  if (addBtn) addBtn.onclick = () => { const name = confirmName('New category name', ''); if (!name) return; store.data.pantry.categories.push(createCategory(name)); store.saveNow(); renderPantryPrepare(); };
}

function renderPantryCategory(cat) {
  const container = el('div', { class: 'node', 'data-id': cat.id });
  const header = el('div', { class: 'node-header' });
  const title = el('div', { class: 'node-title' });
  const caret = el('button', { class: 'btn ghost', title: 'Collapse/Expand' }, cat.collapsed ? '▸' : '▾');
  caret.addEventListener('click', ()=>{ cat.collapsed = !cat.collapsed; store.saveNow(); renderPantryPrepare(); });
  const titleInput = el('input', { type: 'text', class: 'task-title-input' });
  titleInput.value = cat.name;
  titleInput.addEventListener('change', () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = cat.name; return; }
    cat.name = v;
    store.saveNow();
    renderPantryPrepare();
  });
  title.append(caret, titleInput);
  const actions = el('div', { class: 'node-actions' });
  const addSub = el('button', { class: 'btn ghost' }, '+ Subcategory');
  const moveUp = el('button', { class: 'btn ghost', title: 'Move up' }, '↑');
  moveUp.addEventListener('click', ()=>{ moveCategory(cat.id, -1); });
  const moveDown = el('button', { class: 'btn ghost', title: 'Move down' }, '↓');
  moveDown.addEventListener('click', ()=>{ moveCategory(cat.id, +1); });
  addSub.addEventListener('click', () => { const n = confirmName('New subcategory', ''); if (!n) return; cat.children.push(createCategory(n)); store.saveNow(); renderPantryPrepare(); });
  const enabledToggle = el('label', { class: 'subtext' });
  const en = el('input', { type: 'checkbox' }); en.checked = cat.enabled !== false; en.addEventListener('change', ()=>{ cat.enabled = en.checked; store.saveNow(); renderPantryPrepare(); });
  enabledToggle.append(en, document.createTextNode(' Enabled'));
  actions.append(moveUp, moveDown, addSub, enabledToggle);
  header.append(title, actions);
  container.append(header);
  const meta = el('div', { class: 'subtext' }, `${(cat.children||[]).length} sub, ${(cat.items||[]).length} items`);
  container.append(meta);
  container.classList.toggle('disabled', cat.enabled === false);

  const list = el('div', { class: 'inline-list' });
  list.hidden = !!cat.collapsed;
  (cat.items||[]).forEach(item => {
    const row = el('div', { class: 'inline-item' });
    const top = el('div', { class: 'kv' });
    const label = el('input', { type: 'text', class: 'task-title-input' });
    label.value = item.name;
    label.addEventListener('change', () => {
      item.name = label.value.trim() || item.name;
      store.saveNow();
    });
    const actions = el('div', { class: 'meta' });
    const status = el('select', { class: 'priority-select' });
    [['to_buy','To buy'],['stocked','Stocked'],['not_needed','Not needed']].forEach(([v,t])=> status.append(el('option',{value:v},t)));
    status.value = item.status;
    status.addEventListener('change', ()=>{ item.status = status.value; store.saveNow(); renderPantryPrepare(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', ()=>{ cat.items = cat.items.filter(x=>x.id!==item.id); store.saveNow(); renderPantryPrepare(); });
    actions.append(status, del);
    top.append(label, actions);
    // status tint
    row.classList.add(`pantry-${item.status}`);
    row.append(top);
    list.append(row);
  });
  const addRow = el('div', { class: 'add-row' });
  const inName = el('input', { type: 'text', placeholder: 'Add item…' });
  const addBtn = el('button', { class: 'btn primary' }, 'Add');
  addBtn.addEventListener('click', ()=>{ const v=inName.value.trim(); if(!v) return; cat.items.push(createItem(v)); inName.value=''; store.saveNow(); renderPantryPrepare(); });
  addRow.append(inName, addBtn);
  container.append(list, addRow);

  if ((cat.children||[]).length) {
    const kids = el('div', { class: 'node-children' });
    kids.hidden = !!cat.collapsed;
    cat.children.forEach(ch => kids.append(renderPantryCategory(ch)));
    container.append(kids);
  }
  return container;
}

// Pantry review
let pantryReviewState = { ids: [], idx: 0 };
function pantryFlattenCats(){ const out=[]; const walk=(list, enabledPath=true)=>{ (list||[]).forEach(c=>{ const en = enabledPath && c.enabled !== false; if (en) out.push(c); if(c.children?.length) walk(c.children, en); }); }; walk(store.data.pantry?.categories||[]); return out; }
function startPantryReview(){ const list=pantryFlattenCats(); pantryReviewState={ids:list.map(c=>c.id), idx:0}; if(!list.length){ $('#pantry-review-empty').hidden=false; $('#pantry-review-stage').hidden=true; return;} $('#pantry-review-empty').hidden=true; $('#pantry-review-stage').hidden=false; renderPantryProgress(); renderPantryCard(); savePantryReviewProgress(); }
function findCategoryById(id){ const stack=[...(store.data.pantry?.categories||[])]; while(stack.length){ const c=stack.pop(); if(c.id===id) return c; (c.children||[]).forEach(x=>stack.push(x)); } return null; }
function renderPantryProgress(){ const bar=$('#pprogress'); bar.innerHTML=''; const total=pantryReviewState.ids.length||1; for(let i=0;i<total;i++){ const seg=el('div',{class:'segment'}); const fill=el('div',{class:'fill'}); if(i<pantryReviewState.idx) seg.classList.add('done'); if(i===pantryReviewState.idx) seg.classList.add('current'); seg.append(fill); bar.append(seg);} const cur=bar.querySelector('.segment.current .fill'); if(cur) cur.style.setProperty('--w','100%'); }
function renderPantryCard(){ const c=findCategoryById(pantryReviewState.ids[pantryReviewState.idx]); const card=$('#pcard'); card.innerHTML=''; if(!c){ card.append(el('div',{class:'empty'},'Review complete.')); return;} const header=el('div',{class:'story-header'}); header.append(el('div',{class:'story-title'},c.name)); card.append(header); (c.items||[]).forEach(item=>{ const row=el('div',{class:'task'}); row.classList.add(`pantry-${item.status}`); const status=el('select',{class:'priority-select'}); [['to_buy','To buy'],['stocked','Stocked'],['not_needed','Not needed']].forEach(([v,t])=>status.append(el('option',{value:v},t))); status.value=item.status; status.addEventListener('change',()=>{ item.status=status.value; store.saveNow(); renderPantryCard(); }); const title=el('div',{},item.name); const meta=el('div',{class:'meta'}); meta.append(status); row.append(el('div'), title, meta); card.append(row); }); }
function pantryNext(){ if(pantryReviewState.idx<pantryReviewState.ids.length-1){ pantryReviewState.idx++; renderPantryProgress(); renderPantryCard(); savePantryReviewProgress(); } else { $('#pantry-review-stage').hidden=true; const e=$('#pantry-review-empty'); e.textContent='Review complete.'; e.hidden=false; clearPantryReviewProgress(); } }
function pantryPrev(){ if(pantryReviewState.idx>0){ pantryReviewState.idx--; renderPantryProgress(); renderPantryCard(); savePantryReviewProgress(); } }
function pantryOnReviewVisibility(){ const list=pantryFlattenCats(); const has=list.length>0; const e=$('#pantry-review-empty'); e.textContent = has ? 'Press Start Review to begin.' : 'No categories/items yet. Add some in Prepare.'; e.hidden=false; $('#pantry-review-stage').hidden=true; }

// Pantry review persistence
function savePantryReviewProgress(){ try { if(!pantryReviewState.ids.length){ localStorage.removeItem(PANTRY_REVIEW_STATE_KEY); return; } const payload={ active:true, idx:pantryReviewState.idx, currentId: pantryReviewState.ids[pantryReviewState.idx]||null }; localStorage.setItem(PANTRY_REVIEW_STATE_KEY, JSON.stringify(payload)); } catch {} }
function clearPantryReviewProgress(){ try { localStorage.removeItem(PANTRY_REVIEW_STATE_KEY); } catch {} }
function restorePantryReviewProgressIfAny(){ try { const raw=localStorage.getItem(PANTRY_REVIEW_STATE_KEY); if(!raw) return false; const saved=JSON.parse(raw); if(!saved||!saved.active) return false; const list=pantryFlattenCats(); const ids=list.map(c=>c.id); if(!ids.length) return false; let idx=Math.min(Math.max(0, saved.idx||0), ids.length-1); if(saved.currentId){ const j=ids.indexOf(saved.currentId); if(j>=0) idx=j; } pantryReviewState={ids, idx}; // switch into pantry review
  switchView('pantry'); const ptabRev=$('#ptab-review'); const ptabPrep=$('#ptab-prepare'); const ptabShop=$('#ptab-shopping'); ptabRev.classList.add('active'); ptabPrep.classList.remove('active'); ptabShop.classList.remove('active'); $('#pantry-review-empty').hidden=true; $('#pantry-review-stage').hidden=false; renderPantryProgress(); renderPantryCard(); return true; } catch { return false; } }

// Pantry shopping list
function shoppingItems(){ const out=[]; const cats=pantryFlattenCats(); cats.forEach(c=> (c.items||[]).forEach(it=> out.push({cat:c,item:it})) ); return out; }
function needsBuying(item){ return item.status === 'to_buy'; }
function nodePathLike(n){ const names=[]; let cur=n; const all=pantryFlattenCats(); const parent=new Map(); all.forEach(c=> (c.children||[]).forEach(ch=> parent.set(ch.id,c.id))); while(cur){ names.unshift(cur.name); const pid=parent.get(cur.id); cur = pid ? all.find(c=>c.id===pid) : null; } return names.join(' › '); }
function renderShoppingList(){ const root=$('#shopping-root'); if(!root) return; root.innerHTML=''; const arr=shoppingItems().filter(x=>needsBuying(x.item)); if(!arr.length){ root.append(el('div',{class:'empty'},'Nothing to buy.')); return;} const byCat=new Map(); arr.forEach(({cat,item})=>{ const k=nodePathLike(cat); if(!byCat.has(k)) byCat.set(k,[]); byCat.get(k).push({cat,item}); }); for(const [path,list] of byCat.entries()){ root.append(el('div',{class:'subtext'},path)); list.forEach(({cat,item})=>{ const row=el('div',{class:'task'}); row.classList.add('pantry-to_buy'); const cb=el('input',{type:'checkbox'}); cb.checked=false; cb.addEventListener('change',()=>{ if(cb.checked){ item.status='stocked'; store.saveNow(); renderShoppingList(); }}); const main=el('div',{},item.name); const meta=el('div',{class:'meta'}); const del=el('button',{class:'btn ghost'},'Remove'); del.addEventListener('click',()=>{ cat.items=cat.items.filter(x=>x.id!==item.id); store.saveNow(); renderShoppingList(); renderPantryPrepare(); }); meta.append(del); row.append(cb, main, meta); root.append(row); }); }
}

function buildShoppingText(){
  const arr = shoppingItems().filter(x=>needsBuying(x.item));
  if (!arr.length) return 'Nothing to buy.';
  const byCat = new Map();
  arr.forEach(({cat,item})=>{ const k=nodePathLike(cat); if(!byCat.has(k)) byCat.set(k,[]); byCat.get(k).push(item); });
  const sections = [];
  for (const [path, items] of byCat.entries()){
    sections.push(path);
    items.forEach(it => sections.push(`- ${it.name}`));
    sections.push('');
  }
  return sections.join('\n').trim();
}

function wireCopyShopping(){
  const btn = $('#btn-copy-shopping');
  if (!btn) return;
  btn.onclick = async () => {
    const text = buildShoppingText();
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent; btn.textContent = 'Copied!';
      setTimeout(()=>{ btn.textContent = prev; }, 1200);
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      const prev = btn.textContent; btn.textContent = 'Copied!';
      setTimeout(()=>{ btn.textContent = prev; }, 1200);
    }
  };
}
let tasksViewState = {
  currentContext: 'Any',
  locationTags: [],
  durationMax: null,
  priorityValues: [],
  showBlocked: false,
  searchText: '',
  archiveAfterDays: 7,
  showArchived: false,
  sortBy: 'priority',
  groupBy: 'status',
  compactMode: false,
  selectionMode: false,
};
let selectedTaskKeys = new Set();
let pendingSeriesReveal = null;

function saveTasksViewState() {
  const payload = {
    currentContext: tasksViewState.currentContext,
    locationTags: tasksViewState.locationTags,
    durationMax: tasksViewState.durationMax,
    priorityValues: tasksViewState.priorityValues,
    showBlocked: tasksViewState.showBlocked,
    searchText: tasksViewState.searchText,
    archiveAfterDays: tasksViewState.archiveAfterDays,
    showArchived: tasksViewState.showArchived,
    sortBy: tasksViewState.sortBy,
    groupBy: tasksViewState.groupBy,
    compactMode: tasksViewState.compactMode,
  };
  try { localStorage.setItem(TASKS_VIEW_STATE_KEY, JSON.stringify(payload)); } catch {}
}

function loadTasksViewState() {
  const saved = safeJsonParse(localStorage.getItem(TASKS_VIEW_STATE_KEY), null);
  if (!saved || typeof saved !== 'object') return;
  tasksViewState.currentContext = saved.currentContext || 'Any';
  tasksViewState.locationTags = uniqTags(saved.locationTags || []);
  tasksViewState.durationMax = normalizeDurationValue(saved.durationMax);
  tasksViewState.priorityValues = normalizePriorityList(saved.priorityValues || []);
  tasksViewState.showBlocked = !!saved.showBlocked;
  tasksViewState.searchText = (saved.searchText || '').trim();
  tasksViewState.archiveAfterDays = Number(saved.archiveAfterDays) > 0 ? Number(saved.archiveAfterDays) : 7;
  tasksViewState.showArchived = !!saved.showArchived;
  tasksViewState.sortBy = ['priority', 'due', 'path'].includes(saved.sortBy) ? saved.sortBy : 'priority';
  tasksViewState.groupBy = ['status', 'none'].includes(saved.groupBy) ? saved.groupBy : 'status';
  tasksViewState.compactMode = !!saved.compactMode;
}

function entryKey(ref) {
  if (ref.kind === 'subtask') return `subtask:${ref.task.id}:${ref.subtask.id}`;
  return `task:${ref.task.id}`;
}

function selectionEntries() {
  const map = new Map();
  flattenTaskEntries().forEach(ref => map.set(entryKey(ref), ref));
  return map;
}

function ensureInboxNode() {
  let inbox = (store.data.threads || []).find(n => (n.name || '').toLowerCase() === 'inbox');
  if (!inbox) {
    inbox = createNode('Inbox');
    inbox.color = THREAD_PALETTE[hashName('Inbox') % THREAD_PALETTE.length];
    store.data.threads.unshift(inbox);
    autoAssignThreadColors();
    recomputeIndexes();
    renderThreads();
  }
  return inbox;
}

function quickCaptureTask(text, nodeId = null) {
  const raw = (text || '').trim();
  if (!raw) return;
  let node = nodeId ? findNodeById(store.data.threads, nodeId) : null;
  if (!node) node = ensureInboxNode();
  node.tasks.push(createTask(raw));
  uiPrefs.captureNodeId = node.id;
  persistUiPrefs();
  store.saveNow();
  recomputeIndexes();
  renderThreads();
  if (!$('#view-tasks').hidden) renderTasksPane();
  if (!$('#review-stage').hidden) { renderProgress(); renderStoryCard(); }
  showToast(`Captured to ${node.name}`);
}

function refreshQuickCaptureTargets() {
  const sel = $('#quick-capture-target');
  if (!sel) return;
  const nodes = flattenNodes(store.data.threads).filter(isNodePathEnabled);
  sel.innerHTML = '';
  nodes.forEach((n) => {
    sel.append(el('option', { value: n.id }, nodePath(n)));
  });
  if (!nodes.length) {
    const inbox = ensureInboxNode();
    sel.append(el('option', { value: inbox.id }, inbox.name));
  }
  const existing = nodes.find(n => n.id === uiPrefs.captureNodeId) || nodes[0];
  if (existing) sel.value = existing.id;
}

function searchIndex(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  const nodes = flattenNodes(store.data.threads || []);
  nodes.forEach((n) => {
    const path = nodePath(n);
    if ((n.name || '').toLowerCase().includes(q) || path.toLowerCase().includes(q)) {
      out.push({ kind: 'thread', id: n.id, title: n.name, meta: path });
    }
    (n.questions || []).forEach((qu) => {
      if ((qu.text || '').toLowerCase().includes(q)) out.push({ kind: 'question', id: n.id, title: qu.text, meta: path });
    });
    (n.tasks || []).forEach((t) => {
      const hay = [t.text, path, (t.contexts || []).join(' '), taskLocations(t).join(' ')].join(' ').toLowerCase();
      if (hay.includes(q)) out.push({ kind: 'task', id: t.id, nodeId: n.id, title: t.text, meta: path });
      (t.series || []).forEach((s) => {
        const shay = `${s.text} ${t.text} ${path}`.toLowerCase();
        if (shay.includes(q)) out.push({ kind: 'subtask', id: s.id, taskId: t.id, nodeId: n.id, title: s.text, meta: `${path} • ${t.text}` });
      });
    });
  });
  return out.slice(0, 40);
}

function renderSearchResults(query) {
  const box = $('#search-results');
  if (!box) return;
  const q = (query || '').trim();
  if (!q) { box.hidden = true; box.innerHTML = ''; return; }
  const results = searchIndex(q);
  box.innerHTML = '';
  if (!results.length) {
    box.append(el('div', { class: 'search-empty' }, 'No matches'));
    box.hidden = false;
    return;
  }
  results.forEach((r) => {
    const btn = el('button', { class: 'search-item', type: 'button' });
    btn.append(el('span', { class: 'search-kind' }, r.kind), el('strong', {}, r.title), el('span', { class: 'search-meta' }, r.meta));
    btn.addEventListener('click', () => {
      if (r.kind === 'thread' || r.kind === 'question') {
        switchView('prepare');
        const row = document.querySelector(`.node[data-id="${r.id}"]`);
        row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        switchView('tasks');
        tasksViewState.searchText = r.title;
        saveTasksViewState();
        renderTasksPane();
      }
      box.hidden = true;
    });
    box.append(btn);
  });
  box.hidden = false;
}

function allContexts() {
  const set = new Set();
  const refs = flattenTaskRefs();
  refs.forEach(r => (r.task.contexts || []).forEach(c => set.add(c)));
  return Array.from(set).sort();
}

function allLocations() {
  const set = new Set();
  const refs = flattenTaskRefs();
  LOCATION_PRESETS.forEach(l => set.add(l));
  refs.forEach(r => taskLocations(r.task).forEach(l => set.add(l)));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function allDurations() {
  const set = new Set(DURATION_PRESETS);
  const refs = flattenTaskRefs();
  refs.forEach(r => {
    const v = taskDurationMins(r.task);
    if (v) set.add(v);
  });
  return Array.from(set).sort((a, b) => a - b);
}

function isElementOnScreen(node) {
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.top >= 72 && rect.bottom <= vh - 20;
}

function applyPendingSeriesReveal(entries) {
  if (!pendingSeriesReveal || !Array.isArray(entries) || !entries.length) return entries;
  const keys = (pendingSeriesReveal.nextKeys || []).filter(Boolean);
  if (!keys.length) return entries;
  const list = entries.slice();
  const moved = [];
  keys.forEach((k) => {
    const idx = list.findIndex((e) => entryKey(e) === k);
    if (idx < 0) return;
    moved.push(list[idx]);
    list.splice(idx, 1);
  });
  if (!moved.length) return entries;
  const fromIndex = Math.max(0, Math.min(list.length, Number(pendingSeriesReveal.fromIndex) || 0));
  list.splice(fromIndex, 0, ...moved);
  return list;
}

function flushPendingSeriesRevealUi() {
  if (!pendingSeriesReveal) return;
  const keys = (pendingSeriesReveal.nextKeys || []).filter(Boolean);
  let target = null;
  for (const k of keys) {
    const node = document.querySelector(`#tasks-root .task[data-entry-key="${k}"]`);
    if (!node) continue;
    target = node;
    break;
  }
  if (!target) {
    pendingSeriesReveal = null;
    return;
  }
  if (!isElementOnScreen(target)) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  target.classList.add('next-step-focus');
  setTimeout(() => target.classList.remove('next-step-focus'), 1800);
  if (pendingSeriesReveal.nextLabel) {
    showToast(`Next step unlocked: ${pendingSeriesReveal.nextLabel}`);
  } else {
    showToast('Next step unlocked');
  }
  pendingSeriesReveal = null;
}

function renderTasksPane() {
  const root = $('#tasks-root');
  if (!root) return;
  root.innerHTML = '';
  root.classList.toggle('tasks-compact', !!tasksViewState.compactMode);
  const now = new Date();
  const changedRecurring = runRecurringTasks(now);
  const changedArchive = applyArchivingRules(tasksViewState.archiveAfterDays, now);
  if (changedRecurring || changedArchive) store.saveNow();
  const depMap = allTaskRefMap();
  const ctx = tasksViewState.currentContext === 'Any' ? null : tasksViewState.currentContext;
  const locSet = new Set(uniqTags(tasksViewState.locationTags || []).map(l => l.toLowerCase()));
  const maxDur = normalizeDurationValue(tasksViewState.durationMax);
  const priSet = new Set(normalizePriorityList(tasksViewState.priorityValues || []));
  const textNeedle = (tasksViewState.searchText || '').trim().toLowerCase();

  const allEntries = flattenTaskEntries();
  const baseFiltered = allEntries.filter((ref) => {
    const base = ref.task;
    const okCtx = passesContext(base, ctx);
    const okLoc = locSet.size === 0 || taskLocations(base).some(l => locSet.has(l.toLowerCase()));
    const dur = taskDurationMins(base);
    const okTime = !maxDur || (dur != null && dur <= maxDur);
    const okPriority = priSet.size === 0 || priSet.has(Number(base.priority || 3));
    const textHay = [
      ref.kind === 'subtask' ? ref.subtask.text : base.text,
      nodePath(ref.node),
      base.text,
      taskLocations(base).join(' '),
      (base.contexts || []).join(' '),
    ].join(' ').toLowerCase();
    const okSearch = !textNeedle || textHay.includes(textNeedle);
    const archivedAt = ref.kind === 'subtask' ? ref.subtask.archivedAt : base.archivedAt;
    const okArchived = tasksViewState.showArchived ? true : !archivedAt;
    return okCtx && okLoc && okTime && okPriority && okSearch && okArchived;
  });

  const enriched = baseFiltered.map((ref) => {
    const base = ref.task;
    const sub = ref.kind === 'subtask' ? ref.subtask : null;
    const done = sub ? !!sub.completed : !!base.completed;
    const available = done ? true : isTaskAvailable(base, now, ctx, depMap);
    const reason = availabilityReason(base, now, ctx, depMap);
    const due = dueStatus(base, now);
    const archivedAt = ref.kind === 'subtask' ? sub?.archivedAt : base.archivedAt;
    return { ...ref, done, available, reason, due, archivedAt };
  });

  const stats = {
    total: enriched.length,
    ready: enriched.filter(e => !e.done && e.available).length,
    blocked: enriched.filter(e => !e.done && !e.available).length,
    done: enriched.filter(e => e.done).length,
    urgent: enriched.filter(e => !e.done && (e.due.state === 'overdue' || e.due.state === 'soon')).length,
  };

  let entries = tasksViewState.showBlocked ? enriched : enriched.filter(e => e.available || e.done);
  const sorters = {
    priority: (a, b) => {
      const pa = a.task.priority || 3;
      const pb = b.task.priority || 3;
      if (pa !== pb) return pa - pb;
      const aa = a.available ? 0 : 1;
      const bb = b.available ? 0 : 1;
      if (aa !== bb) return aa - bb;
      const da = a.task.availableAt ? new Date(a.task.availableAt).getTime() : Infinity;
      const db = b.task.availableAt ? new Date(b.task.availableAt).getTime() : Infinity;
      return da - db;
    },
    due: (a, b) => {
      const da = a.task.dueAt ? new Date(a.task.dueAt).getTime() : Infinity;
      const db = b.task.dueAt ? new Date(b.task.dueAt).getTime() : Infinity;
      if (da !== db) return da - db;
      return (a.task.priority || 3) - (b.task.priority || 3);
    },
    path: (a, b) => {
      const pa = nodePath(a.node);
      const pb = nodePath(b.node);
      const cmp = pa.localeCompare(pb);
      if (cmp !== 0) return cmp;
      return (a.task.priority || 3) - (b.task.priority || 3);
    },
  };
  const sortBy = ['priority', 'due', 'path'].includes(tasksViewState.sortBy) ? tasksViewState.sortBy : 'priority';
  entries = entries.slice().sort(sorters[sortBy]);
  entries = applyPendingSeriesReveal(entries);

  const seenEstimateTasks = new Set();
  let estimateTaggedMins = 0;
  let estimateTaggedCount = 0;
  entries.forEach((ref) => {
    if (ref.done) return;
    if (seenEstimateTasks.has(ref.task.id)) return;
    seenEstimateTasks.add(ref.task.id);
    const mins = taskDurationMins(ref.task);
    if (!mins) return;
    estimateTaggedMins += mins;
    estimateTaggedCount += 1;
  });
  const score = gamificationSummary(now);

  const currentSelectionMap = selectionEntries();
  selectedTaskKeys = new Set([...selectedTaskKeys].filter(k => currentSelectionMap.has(k)));
  const orderIndexByKey = new Map(entries.map((entry, idx) => [entryKey(entry), idx]));

  // Controls
  const controls = $('#tasks-controls');
  if (controls) {
    controls.innerHTML = '';
    controls.classList.toggle('compact', !!tasksViewState.compactMode);
    const buildGroup = (labelText, contentEl) => {
      const group = el('div', { class: 'filter-group' });
      group.append(el('div', { class: 'filter-label' }, labelText));
      group.append(contentEl);
      return group;
    };
    const metric = (label, value, cls = '') => {
      const card = el('div', { class: `tasks-metric${cls ? ` ${cls}` : ''}` });
      card.append(el('div', { class: 'tasks-metric-value' }, String(value)));
      card.append(el('div', { class: 'tasks-metric-label' }, label));
      return card;
    };

    const summary = el('div', { class: 'tasks-summary' });
    const scorePanel = el('div', { class: `points-panel${score.points >= score.goal ? ' complete' : ''}` });
    const scoreHead = el('div', { class: 'points-head' });
    scoreHead.append(
      el('div', { class: 'points-title' }, 'Daily Points'),
      el('div', { class: 'points-value' }, `${score.points}/${score.goal}`)
    );
    const scoreMeta = score.remaining
      ? `${score.remaining} to goal • Streak ${score.streak} day${score.streak === 1 ? '' : 's'}`
      : `Goal reached • Streak ${score.streak} day${score.streak === 1 ? '' : 's'}`;
    const scoreSub = el('div', { class: 'points-meta' }, `${scoreMeta} • Goal days ${score.goalDays}`);
    const scoreBar = el('div', { class: 'points-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(score.goal), 'aria-valuenow': String(score.points) });
    const scoreFill = el('div', { class: 'points-fill' });
    scoreFill.style.width = `${score.pct}%`;
    scoreBar.append(scoreFill);
    scorePanel.append(scoreHead, scoreSub, scoreBar);
    controls.append(scorePanel);

    const estimateLabel = formatDuration(estimateTaggedMins) || '0m';
    summary.append(
      metric('Matching', stats.total),
      metric('Est. Time', estimateLabel, estimateTaggedCount ? 'good' : ''),
      metric('Ready', stats.ready, 'good'),
      metric('Blocked', stats.blocked, stats.blocked ? 'warn' : ''),
      metric('Urgent', stats.urgent, stats.urgent ? 'warn' : ''),
      metric('Done', stats.done),
    );
    controls.append(summary);

    const activeWrap = el('div', { class: 'filter-row active-filters' });
    let activeCount = 0;
    const addFilterChip = (label, onClear) => {
      activeCount += 1;
      const chip = el('button', { class: 'chip toggle active', type: 'button' }, label);
      chip.addEventListener('click', () => {
        onClear();
        saveTasksViewState();
        renderTasksPane();
      });
      activeWrap.append(chip);
    };
    if (textNeedle) addFilterChip(`Search: ${tasksViewState.searchText}`, () => { tasksViewState.searchText = ''; });
    if (ctx) addFilterChip(`Context: ${ctx}`, () => { tasksViewState.currentContext = 'Any'; });
    (tasksViewState.priorityValues || []).forEach((p) => {
      addFilterChip(`Priority: P${p}`, () => {
        tasksViewState.priorityValues = normalizePriorityList((tasksViewState.priorityValues || []).filter((x) => Number(x) !== Number(p)));
      });
    });
    (tasksViewState.locationTags || []).forEach((loc) => {
      addFilterChip(`Loc: ${loc}`, () => {
        tasksViewState.locationTags = uniqTags((tasksViewState.locationTags || []).filter(x => x.toLowerCase() !== loc.toLowerCase()));
      });
    });
    if (maxDur) addFilterChip(`Time <= ${formatDuration(maxDur)}`, () => { tasksViewState.durationMax = null; });
    if (tasksViewState.showBlocked) addFilterChip('Blocked shown', () => { tasksViewState.showBlocked = false; });
    if (tasksViewState.showArchived) addFilterChip('Archived shown', () => { tasksViewState.showArchived = false; });
    if (tasksViewState.sortBy !== 'priority') addFilterChip(`Sort: ${tasksViewState.sortBy}`, () => { tasksViewState.sortBy = 'priority'; });
    if (tasksViewState.groupBy !== 'status') addFilterChip('Flat list', () => { tasksViewState.groupBy = 'status'; });
    if (tasksViewState.compactMode) addFilterChip('Compact', () => { tasksViewState.compactMode = false; });
    if (activeCount) {
      const reset = el('button', { class: 'btn ghost', type: 'button' }, 'Reset Filters');
      reset.addEventListener('click', () => {
        tasksViewState.currentContext = 'Any';
        tasksViewState.locationTags = [];
        tasksViewState.durationMax = null;
        tasksViewState.priorityValues = [];
        tasksViewState.showBlocked = false;
        tasksViewState.searchText = '';
        tasksViewState.showArchived = false;
        tasksViewState.sortBy = 'priority';
        tasksViewState.groupBy = 'status';
        tasksViewState.compactMode = false;
        saveTasksViewState();
        renderTasksPane();
      });
      const row = el('div', { class: 'filter-row' });
      row.append(activeWrap, reset);
      controls.append(buildGroup('Active Filters', row));
    }

    const searchRow = el('div', { class: 'filter-row' });
    const searchInput = el('input', { type: 'search', placeholder: 'Search within tasks...' });
    searchInput.value = tasksViewState.searchText || '';
    searchInput.addEventListener('input', () => {
      tasksViewState.searchText = searchInput.value;
      saveTasksViewState();
      renderTasksPane();
    });
    searchRow.append(searchInput);
    controls.append(buildGroup('Search', searchRow));

    const ctxs = allContexts();
    if (ctxs.length) {
      const ctxRow = el('div', { class: 'filter-row' });
      const sel = el('select', { class: 'select-sm' });
      sel.append(el('option', { value: 'Any' }, 'Any'));
      for (const c of ctxs) sel.append(el('option', { value: c }, c));
      sel.value = tasksViewState.currentContext || 'Any';
      sel.addEventListener('change', () => {
        tasksViewState.currentContext = sel.value;
        saveTasksViewState();
        renderTasksPane();
      });
      ctxRow.append(sel);
      controls.append(buildGroup('Context', ctxRow));
    }

    const locRow = el('div', { class: 'filter-row' });
    const activeLocs = uniqTags(tasksViewState.locationTags || []);
    const locSet = new Set(activeLocs.map(l => l.toLowerCase()));
    const locAny = el('button', { class: `chip toggle${activeLocs.length ? '' : ' active'}` }, 'Any');
    locAny.addEventListener('click', () => {
      tasksViewState.locationTags = [];
      saveTasksViewState();
      renderTasksPane();
    });
    locRow.append(locAny);
    for (const loc of allLocations()) {
      const active = locSet.has(loc.toLowerCase());
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, loc);
      btn.addEventListener('click', () => {
        const next = uniqTags(activeLocs);
        const idx = next.findIndex(x => x.toLowerCase() === loc.toLowerCase());
        if (idx >= 0) next.splice(idx, 1);
        else next.push(loc);
        tasksViewState.locationTags = next;
        saveTasksViewState();
        renderTasksPane();
      });
      locRow.append(btn);
    }
    controls.append(buildGroup('Location', locRow));

    const timeRow = el('div', { class: 'filter-row' });
    const currentMax = normalizeDurationValue(tasksViewState.durationMax);
    const timeAny = el('button', { class: `chip toggle${currentMax ? '' : ' active'}` }, 'Any');
    timeAny.addEventListener('click', () => {
      tasksViewState.durationMax = null;
      saveTasksViewState();
      renderTasksPane();
    });
    timeRow.append(timeAny);
    for (const mins of allDurations()) {
      const active = currentMax === mins;
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, formatDuration(mins) || `${mins}m`);
      btn.addEventListener('click', () => {
        tasksViewState.durationMax = active ? null : mins;
        saveTasksViewState();
        renderTasksPane();
      });
      timeRow.append(btn);
    }
    controls.append(buildGroup('Time ≤', timeRow));

    const priRow = el('div', { class: 'filter-row' });
    const activePriorities = normalizePriorityList(tasksViewState.priorityValues || []);
    const priActiveSet = new Set(activePriorities);
    const priAny = el('button', { class: `chip toggle${activePriorities.length ? '' : ' active'}` }, 'Any');
    priAny.addEventListener('click', () => {
      tasksViewState.priorityValues = [];
      saveTasksViewState();
      renderTasksPane();
    });
    priRow.append(priAny);
    PRIORITY_PRESETS.forEach((p) => {
      const active = priActiveSet.has(p);
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, `P${p}`);
      btn.addEventListener('click', () => {
        const next = normalizePriorityList(activePriorities);
        const idx = next.indexOf(p);
        if (idx >= 0) next.splice(idx, 1);
        else next.push(p);
        tasksViewState.priorityValues = normalizePriorityList(next);
        saveTasksViewState();
        renderTasksPane();
      });
      priRow.append(btn);
    });
    controls.append(buildGroup('Priority', priRow));

    const sortRow = el('div', { class: 'filter-row' });
    const mkSort = (key, label) => {
      const active = tasksViewState.sortBy === key;
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}`, type: 'button' }, label);
      btn.addEventListener('click', () => {
        tasksViewState.sortBy = key;
        saveTasksViewState();
        renderTasksPane();
      });
      return btn;
    };
    sortRow.append(mkSort('priority', 'Priority'), mkSort('due', 'Due'), mkSort('path', 'Path'));
    controls.append(buildGroup('Sort', sortRow));

    const displayRow = el('div', { class: 'filter-row' });
    const grouped = el('button', { class: `chip toggle${tasksViewState.groupBy === 'status' ? ' active' : ''}`, type: 'button' }, 'Grouped');
    grouped.addEventListener('click', () => {
      tasksViewState.groupBy = 'status';
      saveTasksViewState();
      renderTasksPane();
    });
    const flat = el('button', { class: `chip toggle${tasksViewState.groupBy === 'none' ? ' active' : ''}`, type: 'button' }, 'Flat');
    flat.addEventListener('click', () => {
      tasksViewState.groupBy = 'none';
      saveTasksViewState();
      renderTasksPane();
    });
    const compact = el('button', { class: `chip toggle${tasksViewState.compactMode ? ' active' : ''}`, type: 'button' }, 'Compact');
    compact.addEventListener('click', () => {
      tasksViewState.compactMode = !tasksViewState.compactMode;
      saveTasksViewState();
      renderTasksPane();
    });
    displayRow.append(grouped, flat, compact);
    controls.append(buildGroup('Display', displayRow));

    const optRow = el('div', { class: 'filter-row' });
    const showLbl = el('label', { class: 'filter-toggle' });
    const showCb = el('input', { type: 'checkbox' });
    showCb.checked = !!tasksViewState.showBlocked;
    showCb.addEventListener('change', () => {
      tasksViewState.showBlocked = showCb.checked;
      saveTasksViewState();
      renderTasksPane();
    });
    showLbl.append(showCb, document.createTextNode(' Show blocked'));
    optRow.append(showLbl);
    const showArchLbl = el('label', { class: 'filter-toggle' });
    const showArch = el('input', { type: 'checkbox' });
    showArch.checked = !!tasksViewState.showArchived;
    showArch.addEventListener('change', () => {
      tasksViewState.showArchived = showArch.checked;
      saveTasksViewState();
      renderTasksPane();
    });
    showArchLbl.append(showArch, document.createTextNode(' Show archived'));
    optRow.append(showArchLbl);
    const archiveDays = el('input', { type: 'number', min: '1', class: 'select-sm', title: 'Archive completed after days' });
    archiveDays.value = String(tasksViewState.archiveAfterDays || 7);
    archiveDays.addEventListener('change', () => {
      tasksViewState.archiveAfterDays = Math.max(1, Number(archiveDays.value) || 7);
      saveTasksViewState();
      renderTasksPane();
    });
    optRow.append(el('span', { class: 'subtext' }, 'Archive after'));
    optRow.append(archiveDays);
    optRow.append(el('span', { class: 'subtext' }, 'days'));
    controls.append(buildGroup('Options', optRow));

    const bulkRow = el('div', { class: 'filter-row' });
    const selectModeBtn = el('button', { class: `btn ghost${tasksViewState.selectionMode ? ' active' : ''}` }, tasksViewState.selectionMode ? 'Exit Select' : 'Select');
    selectModeBtn.addEventListener('click', () => {
      tasksViewState.selectionMode = !tasksViewState.selectionMode;
      if (!tasksViewState.selectionMode) selectedTaskKeys = new Set();
      renderTasksPane();
    });
    bulkRow.append(selectModeBtn);
    if (tasksViewState.selectionMode) {
      bulkRow.append(el('span', { class: 'subtext' }, `${selectedTaskKeys.size} selected`));
      const doneBtn = el('button', { class: 'btn ghost' }, 'Complete');
      doneBtn.addEventListener('click', () => {
        const map = selectionEntries();
        selectedTaskKeys.forEach((k) => {
          const ref = map.get(k);
          if (!ref) return;
          if (ref.kind === 'subtask') setSubtaskCompleted(ref.task, ref.subtask, true);
          else setTaskCompleted(ref.task, true);
        });
        selectedTaskKeys = new Set();
        store.saveNow();
        renderTasksPane();
        showToast('Bulk complete applied');
      });
      const priSel = el('select', { class: 'select-sm' });
      [1, 2, 3, 4, 5].forEach((p) => priSel.append(el('option', { value: String(p) }, `P${p}`)));
      const priBtn = el('button', { class: 'btn ghost' }, 'Set Priority');
      priBtn.addEventListener('click', () => {
        const map = selectionEntries();
        selectedTaskKeys.forEach((k) => {
          const ref = map.get(k);
          if (!ref) return;
          ref.task.priority = Number(priSel.value);
        });
        store.saveNow();
        renderTasksPane();
        showToast('Priority updated');
      });
      const locInput = el('input', { type: 'text', placeholder: 'Add location tag...' });
      const locBtn = el('button', { class: 'btn ghost' }, 'Retag');
      locBtn.addEventListener('click', () => {
        const v = locInput.value.trim();
        if (!v) return;
        const map = selectionEntries();
        selectedTaskKeys.forEach((k) => {
          const ref = map.get(k);
          if (!ref) return;
          const list = taskLocations(ref.task);
          list.push(v);
          setTaskLocations(ref.task, list);
        });
        locInput.value = '';
        store.saveNow();
        renderTasksPane();
        showToast('Tags updated');
      });
      const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
      delBtn.addEventListener('click', () => {
        const map = selectionEntries();
        selectedTaskKeys.forEach((k) => {
          const ref = map.get(k);
          if (!ref) return;
          if (ref.kind === 'subtask') ref.task.series = (ref.task.series || []).filter(s => s.id !== ref.subtask.id);
          else ref.node.tasks = (ref.node.tasks || []).filter(x => x.id !== ref.task.id);
        });
        selectedTaskKeys = new Set();
        store.saveNow();
        renderTasksPane();
        renderThreads();
        showToast('Selected items removed');
      });
      bulkRow.append(doneBtn, priSel, priBtn, locInput, locBtn, delBtn);
    }
    controls.append(buildGroup('Selection', bulkRow));
  }
  if (!entries.length) {
    const msg = stats.total ? 'No tasks in the current view.' : 'No tasks match the current filters.';
    root.append(el('div', { class: 'empty' }, msg));
    pendingSeriesReveal = null;
    return;
  }

  const makeTaskCard = (ref) => {
    const { task: t, node: n, root: r } = ref;
    const sub = ref.kind === 'subtask' ? ref.subtask : null;
    const key = entryKey(ref);
    const item = el('div', {
      class: 'task' + (ref.done ? ' completed' : ''),
      style: `border-left:6px solid ${r?.color || 'var(--accent)'}`,
      'data-entry-key': key,
    });
    if (ref.due.state === 'overdue') item.classList.add('due-overdue');
    else if (ref.due.state === 'soon') item.classList.add('due-soon');
    if (ref.archivedAt) item.classList.add('archived');
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!ref.done;
    if (sub) {
      cb.addEventListener('change', () => {
        const wasDone = !!sub.completed;
        setSubtaskCompleted(t, sub, cb.checked);
        if (!wasDone && cb.checked) {
          const statsAfter = seriesStats(t);
          const nextItems = (statsAfter?.activeItems || []).filter((s) => !s.completed);
          const nextKeys = nextItems.map((s) => `subtask:${t.id}:${s.id}`);
          if (nextKeys.length) {
            const nextLabel = nextItems.length === 1
              ? (nextItems[0].text || 'Next step')
              : `${nextItems.length} steps unlocked`;
            pendingSeriesReveal = {
              fromIndex: orderIndexByKey.get(key) ?? 0,
              nextKeys,
              nextLabel,
            };
          } else {
            pendingSeriesReveal = null;
          }
        } else {
          pendingSeriesReveal = null;
        }
        store.saveNow();
        renderTasksPane();
      });
    } else {
      cb.addEventListener('change', () => {
        pendingSeriesReveal = null;
        setTaskCompleted(t, cb.checked);
        store.saveNow();
        renderTasksPane();
      });
    }
    const main = el('div', { class: 'task-main' });
    const titleRow = el('div', { class: 'task-title-row' });
    if (sub) {
      const step = Math.max(1, Number(sub.rank) || 1);
      titleRow.append(el('span', { class: 'pill step' }, `Step ${step}`));
    }
    const titleInput = el('input', { type: 'text', class: 'task-title-input' });
    titleInput.value = sub ? sub.text : t.text;
    titleInput.addEventListener('change', () => {
      const val = titleInput.value.trim();
      if (!val) { titleInput.value = sub ? sub.text : t.text; return; }
      if (sub) sub.text = val;
      else t.text = val;
      store.saveNow();
      if (!$('#review-stage').hidden) renderStoryCard();
      renderThreads();
    });
    const priPill = el('span', { class: 'pill tag' }, `P${t.priority || 3}`);
    titleRow.append(priPill);
    titleRow.append(titleInput);
    main.append(titleRow);
    const ctxLine = nodePath(n) + (ref.reason ? ` • ${ref.reason}` : '');
    main.append(el('div', { class: 'ctx' }, ctxLine));
    if (sub) {
      item.classList.add('subtask');
      const stats = ref.series || seriesStats(t);
      const step = Math.max(1, Number(sub.rank) || 1);
      const max = stats?.maxRank || step;
      const remaining = stats ? stats.remaining : Math.max(0, (t.series || []).filter(s => !s.completed).length);
      const others = Math.max(0, remaining - 1);
      const seriesLine = `Series: ${t.text} • Step ${step}/${max} • ${others} other${others === 1 ? '' : 's'} remaining`;
      main.append(el('div', { class: 'series-line' }, seriesLine));
    }
    const tagline = buildTaskTagline(t, '', { includeSeries: !sub });
    if (tagline) main.append(tagline);
    if (!sub && !isSeriesTask(t)) {
      const breakdown = buildBreakIntoStepsCta((stepText) => {
        addSubtaskToTask(t, stepText, 1);
        setTagPanelOpen('tasks', t.id, true);
        store.saveNow();
        renderThreads();
        if (!$('#review-stage').hidden) {
          renderProgress();
          renderStoryCard();
        }
        renderTasksPane();
        showToast('Series started');
        return true;
      });
      main.append(breakdown);
    }
    const actions = el('div', { class: 'meta' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderTasksPane(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      if (sub) {
        t.series = (t.series || []).filter(x => x.id !== sub.id);
        store.save(); renderTasksPane();
      } else {
        n.tasks = n.tasks.filter(x => x.id !== t.id);
        store.save(); renderTasksPane(); renderThreads(); renderProgress(); if (!$('#review-stage').hidden) renderStoryCard();
      }
    });
    const avail = buildAvailabilityControls(n.id, t.id, () => renderTasksPane());
    avail.hidden = !isTagPanelOpen('tasks', t.id);
    const availBtn = el('button', { class: 'btn ghost' }, 'Tags');
    availBtn.addEventListener('click', () => {
      avail.hidden = !avail.hidden;
      setTagPanelOpen('tasks', t.id, !avail.hidden);
    });
    if (tasksViewState.selectionMode) {
      const pick = el('input', { type: 'checkbox', title: 'Select task' });
      pick.checked = selectedTaskKeys.has(key);
      if (pick.checked) item.classList.add('selected');
      pick.addEventListener('change', () => {
        if (pick.checked) selectedTaskKeys.add(key);
        else selectedTaskKeys.delete(key);
        item.classList.toggle('selected', pick.checked);
      });
      actions.append(pick);
    }
    actions.append(pri, availBtn, del);
    item.append(cb, main, actions);
    // Status tint classes
    if (ref.done) item.classList.add('status-completed');
    else if (ref.available) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    // Availability controls in Tasks pane (hidden by default)
    item.append(avail);
    return item;
  };

  if (tasksViewState.groupBy === 'status') {
    const groups = [
      { key: 'ready', label: 'Ready Now', items: entries.filter(e => !e.done && e.available) },
      { key: 'blocked', label: 'Blocked / Scheduled', items: entries.filter(e => !e.done && !e.available) },
      { key: 'done', label: 'Completed', items: entries.filter(e => e.done) },
    ];
    groups.forEach((group) => {
      if (!group.items.length) return;
      const section = el('section', { class: `task-section task-section-${group.key}` });
      const header = el('div', { class: 'task-section-head' });
      header.append(el('h3', {}, group.label));
      header.append(el('span', { class: 'pill tag' }, `${group.items.length}`));
      section.append(header);
      group.items.forEach((entry) => section.append(makeTaskCard(entry)));
      root.append(section);
    });
    flushPendingSeriesRevealUi();
    return;
  }

  for (const ref of entries) {
    root.append(makeTaskCard(ref));
  }
  flushPendingSeriesRevealUi();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    if (window.daymxUnlockReady) {
      try { await window.daymxUnlockReady; } catch {}
    }
    init();
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    __test: {
      normalizeDurationValue,
      formatDuration,
      normalizePriorityList,
      dayKeyFromDate,
      pointsForTaskCompletion,
      setTaskCompleted,
      setSubtaskCompleted,
      gamificationSummary,
      awardPoints,
      resetGamificationState: () => { gamificationState.daily = {}; },
      setGamificationDayPoints: (key, points) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return;
        gamificationState.daily[String(key)] = Math.max(0, Number(points) || 0);
      },
      getGamificationState: () => JSON.parse(JSON.stringify(gamificationState)),
    },
  };
}
