// FrankApp – mobile-first SPA for daily thread reviews

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
const QUICK_CAPTURE_NEW_TAG = '__new__';

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const defaultData = () => ({
  threads: [], // array of nodes
  pantry: { categories: [] },
  gamification: { daily: {} },
  dailyReview: { dayKey: '', active: false, idx: 0, currentId: null, completedDays: {} },
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
  return Array.isArray(t?.children) && t.children.length > 0;
}

function seriesStats(t) {
  if (!isSeriesTask(t)) return null;
  const list = t.children || [];
  const total = list.length;
  const done = list.filter((s) => s.completed).length;
  const remaining = total - done;
  const incomplete = list.filter((s) => !s.completed);
  const sequential = (t.childMode || 'parallel') === 'sequential';
  const activeItems = sequential ? (incomplete.length ? [incomplete[0]] : []) : incomplete;
  const activeRank = activeItems.length ? list.indexOf(activeItems[0]) + 1 : null;
  const maxRank = total;
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
      ensureDailyReviewInData(this.data);
      this.mode = 'firebase';
      // Subscribe to live updates
      this.unsub = window.daymxFirebase.subscribe((remote) => {
        if (!remote) return;
        this.data = remote;
        if (!this.data.pantry) this.data.pantry = { categories: [] };
        ensureGamificationInData(this.data);
        setRuntimeGamificationFromData(this.data);
        ensureDailyReviewInData(this.data);
        // Normalize and refresh UI on remote updates
        (this.data.threads || []).forEach(normalizeNode);
        (this.data.pantry.categories || []).forEach(normalizeCategory);
        autoAssignThreadColors();
        recomputeIndexes();
        renderThreads();
        historyState.lastSerialized = serializeData(this.data);
        // If review is visible, refresh progress/card state
        if (!$('#view-review').hidden) onReviewVisibility();
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
    ensureDailyReviewInData(this.data);
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
  lastView: 'tasks',
  pantryTab: 'prepare',
  captureNodeId: null,
  capturePriority: 3,
  captureTag: '',
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
const openPausePanels = {
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

function isPausePanelOpen(view, taskId) {
  const set = openPausePanels[view];
  if (!set || !taskId) return false;
  return set.has(taskId);
}

function setPausePanelOpen(view, taskId, open) {
  const set = openPausePanels[view];
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

function clampPriority(value, fallback = 3) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(1, Math.min(5, n));
}

function parseDayKey(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey || ''))) return null;
  const [y, m, d] = String(dayKey).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  if (isNaN(dt)) return null;
  return dt;
}

function formatDayKeyLabel(dayKey) {
  const d = parseDayKey(dayKey);
  const value = d || new Date();
  return value.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function normalizeReviewCompletions(raw) {
  const out = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key || ''))) return;
    if (value === false || value == null) return;
    out[key] = true;
  });
  return out;
}

function previousDayKey(dayKey) {
  const d = parseDayKey(dayKey);
  if (!d) return null;
  d.setDate(d.getDate() - 1);
  return dayKeyFromDate(d);
}

function ensureDailyReviewInData(data, now = new Date()) {
  if (!data || typeof data !== 'object') return { dayKey: dayKeyFromDate(now), active: false, idx: 0, currentId: null };
  if (!data.dailyReview || typeof data.dailyReview !== 'object') data.dailyReview = {};
  const today = dayKeyFromDate(now);
  const state = data.dailyReview;
  let changed = false;
  let reset = false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(state.dayKey || ''))) {
    state.dayKey = today;
    changed = true;
  }
  if (typeof state.active !== 'boolean') {
    state.active = false;
    changed = true;
  }
  if (!Number.isFinite(state.idx) || state.idx < 0) {
    state.idx = 0;
    changed = true;
  } else {
    state.idx = Math.floor(state.idx);
  }
  if (state.currentId != null && typeof state.currentId !== 'string') {
    state.currentId = null;
    changed = true;
  }
  const normalizedCompleted = normalizeReviewCompletions(state.completedDays);
  if (JSON.stringify(normalizedCompleted) !== JSON.stringify(state.completedDays || {})) {
    state.completedDays = normalizedCompleted;
    changed = true;
  } else if (!state.completedDays || typeof state.completedDays !== 'object') {
    state.completedDays = {};
    changed = true;
  }
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.active = false;
    state.idx = 0;
    state.currentId = null;
    changed = true;
    reset = true;
  }
  return { state, changed, reset };
}

function reviewStreakInfo(state, now = new Date()) {
  const today = dayKeyFromDate(now);
  const completed = normalizeReviewCompletions(state?.completedDays);
  const todayDone = !!completed[today];
  let start = today;
  if (!todayDone) {
    const yesterday = previousDayKey(today);
    start = yesterday && completed[yesterday] ? yesterday : today;
  }
  let streak = 0;
  let cursor = start;
  while (cursor && completed[cursor]) {
    streak += 1;
    cursor = previousDayKey(cursor);
  }
  const missedToday = !todayDone;
  return { streak, todayDone, missedToday, completed };
}

function markDailyReviewCompleted(data, now = new Date()) {
  const ensured = ensureDailyReviewInData(data, now);
  const state = ensured.state;
  const key = dayKeyFromDate(now);
  if (!state.completedDays || typeof state.completedDays !== 'object') state.completedDays = {};
  const already = !!state.completedDays[key];
  state.completedDays[key] = true;
  return { changed: !already, state };
}

function persistSharedStateWithoutHistory() {
  store.saveNow(store.data || {});
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

const movingTaskState = {
  prepare: new Map(),
  review: new Map(),
  tasks: new Map(),
};

let quickCaptureJumpState = null;

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

function movingTaskEntries(view, nodeId = null) {
  const map = movingTaskState[view];
  if (!map) return [];
  const items = Array.from(map.values());
  if (!nodeId) return items;
  return items.filter((entry) => entry.sourceNodeId === nodeId);
}

function rememberMovingTask(view, payload) {
  const map = movingTaskState[view];
  if (!map || !payload?.taskId) return;
  map.set(payload.taskId, {
    taskId: payload.taskId,
    text: payload.text || 'Untitled task',
    sourceNodeId: payload.sourceNodeId || null,
    sourcePath: payload.sourcePath || '',
    targetNodeId: payload.targetNodeId || null,
    targetName: payload.targetName || 'thread',
    targetPath: payload.targetPath || payload.targetName || 'thread',
    priority: clampPriority(payload.priority, 3),
  });
}

function clearMovingTasksForView(view) {
  const map = movingTaskState[view];
  if (!map) return;
  map.clear();
}

function buildMovingTaskNotice(entry, mode = 'task') {
  if (mode === 'inline') {
    const row = el('div', { class: 'inline-item moving-task' });
    const title = el('div', { class: 'moving-task-title' }, entry.text || 'Untitled task');
    const meta = el('div', { class: 'meta' });
    meta.append(el('span', { class: 'pill warn moving-pill' }, `moving to ${entry.targetName}...`));
    row.append(title, meta);
    const path = entry.targetPath ? el('div', { class: 'subtext moving-task-path' }, entry.targetPath) : null;
    if (path) row.append(path);
    return row;
  }
  const item = el('div', { class: 'task moving-task' });
  item.append(
    el('div'),
    el('div', { class: 'task-main' }, [
      el('div', { class: 'task-title-row' }, el('div', { class: 'moving-task-title' }, entry.text || 'Untitled task')),
      el('div', { class: 'ctx moving-task-path' }, entry.sourcePath ? `${entry.sourcePath} -> ${entry.targetPath}` : entry.targetPath || ''),
      el('div', { class: 'tagline' }, el('span', { class: 'pill warn moving-pill' }, `moving to ${entry.targetName}...`)),
    ])
  );
  return item;
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
  uiPrefs.capturePriority = clampPriority(saved.capturePriority, uiPrefs.capturePriority);
  uiPrefs.captureTag = normalizeTagValue(saved.captureTag || uiPrefs.captureTag);
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
  if (!$('#view-review').hidden) onReviewVisibility();
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
  ensureDailyReviewInData(store.data);
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
    completionPointsAwardedAt: null,
    loc: '',
    locations: [],
    duration: null,
    blocked: false,
    starred: false,
    children: [],
    childMode: 'parallel',
    series: [],
  };
}

function createSubtask(text = '', rank = 1) {
  const task = createTask(text);
  task.id = uid('s');
  task.rank = Math.max(1, Number(rank) || 1);
  task.order = 0;
  return task;
}

function legacySeriesOrder(list = []) {
  return list.slice().sort((a, b) => {
    const ra = Math.max(1, Number(a.rank) || 1);
    const rb = Math.max(1, Number(b.rank) || 1);
    if (ra !== rb) return ra - rb;
    const oa = Number.isFinite(a.order) ? Number(a.order) : 0;
    const ob = Number.isFinite(b.order) ? Number(b.order) : 0;
    if (oa !== ob) return oa - ob;
    return (a.text || '').localeCompare(b.text || '');
  });
}

function legacySeriesItemToTask(item, parentTask = null) {
  const task = createTask(item?.text || '');
  task.id = item?.id || uid('s');
  task.text = item?.text || '';
  task.createdAt = item?.createdAt || task.createdAt;
  task.completed = !!item?.completed;
  task.completedAt = item?.completedAt || null;
  task.archivedAt = item?.archivedAt || null;
  task.priority = clampPriority(parentTask?.priority, 3);
  task.locations = taskLocations(parentTask || {});
  task.loc = task.locations[0] || '';
  task.rank = Math.max(1, Number(item?.rank) || 1);
  task.order = Number.isFinite(item?.order) ? Number(item.order) : 0;
  if (task.completed && !task.completionPointsAwardedAt) {
    task.completionPointsAwardedAt = task.completedAt || nowIso();
  }
  return task;
}

function normalizeTaskNode(task, opts = {}) {
  if (!task || typeof task !== 'object') return;
  if (!task.id) task.id = uid(opts.idPrefix || 't');
  task.text = task.text || '';
  if (typeof task.completed !== 'boolean') task.completed = !!task.completed;
  if (!('createdAt' in task)) task.createdAt = nowIso();
  if (!('completedAt' in task)) task.completedAt = null;
  if (!('archivedAt' in task)) task.archivedAt = null;
  if (typeof task.priority !== 'number' || task.priority < 1 || task.priority > 5) task.priority = 3;
  if (!('availableAt' in task)) task.availableAt = null;
  if (!('dueAt' in task)) task.dueAt = null;
  if (!('contexts' in task) || !Array.isArray(task.contexts)) task.contexts = [];
  if (!('blockedBy' in task) || !Array.isArray(task.blockedBy)) task.blockedBy = [];
  task.blockedBy = task.blockedBy.filter(Boolean);
  if (!('waitingOn' in task)) task.waitingOn = '';
  if (!('followUpAt' in task)) task.followUpAt = null;
  if (!('recurrence' in task)) task.recurrence = 'none';
  if (!['none', 'daily', 'weekly', 'monthly'].includes(task.recurrence)) task.recurrence = 'none';
  if (!('nextRecurringAt' in task)) task.nextRecurringAt = null;
  if (!('completionPointsAwardedAt' in task)) task.completionPointsAwardedAt = null;
  if (!('loc' in task)) task.loc = '';
  if (!('locations' in task) || !Array.isArray(task.locations)) task.locations = [];
  if (!('duration' in task)) task.duration = null;
  if (!('blocked' in task)) task.blocked = false;
  if (!('starred' in task)) task.starred = false;
  if (!('childMode' in task) || !['parallel', 'sequential'].includes(task.childMode)) {
    task.childMode = opts.defaultChildMode || 'parallel';
  }
  if (!('children' in task) || !Array.isArray(task.children)) task.children = [];

  task.duration = normalizeDurationValue(task.duration);
  const legacyLoc = normalizeTagValue(task.loc || '');
  if (legacyLoc && (!task.locations || !task.locations.length)) task.locations = [legacyLoc];
  task.locations = uniqTags(task.locations);
  if (!task.loc && task.locations.length) task.loc = task.locations[0];

  const legacySeries = Array.isArray(task.series) ? legacySeriesOrder(task.series) : [];
  if (legacySeries.length) {
    const existingIds = new Set((task.children || []).map((child) => child.id));
    legacySeries.forEach((item) => {
      const migrated = legacySeriesItemToTask(item, task);
      if (!existingIds.has(migrated.id)) task.children.push(migrated);
    });
    task.childMode = 'sequential';
    task.series = [];
  } else if (!Array.isArray(task.series)) {
    task.series = [];
  }

  task.children.forEach((child) => normalizeTaskNode(child));
  if (task.completed && !task.completedAt) task.completedAt = task.createdAt || nowIso();
  if (task.completed && !task.completionPointsAwardedAt) {
    task.completionPointsAwardedAt = task.completedAt || nowIso();
  }
}

// Pantry creators
function createCategory(name = 'Category') {
  return { id: uid('cat'), name, enabled: true, collapsed: false, children: [], items: [] };
}

function createItem(name = 'Item') {
  return { id: uid('i'), name, status: 'to_buy', notes: '' };
}

function findNodeById(rootList, id) {
  const stack = Array.isArray(rootList) ? [...rootList] : [];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.id === id) return n;
    const children = Array.isArray(n.children) ? n.children : [];
    if (children.length) stack.push(...children);
  }
  return null;
}

function flattenNodes(rootList) {
  const out = [];
  const queue = Array.isArray(rootList) ? [...rootList] : [];
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (!n) continue;
    out.push(n);
    const children = Array.isArray(n.children) ? n.children : [];
    if (children.length) queue.push(...children);
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
  store.saveNow(); renderThreads();
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

function removeNode(nodeId) {
  const info = findNodeParentInfo(nodeId);
  if (!info) return false;
  const target = info.list?.[info.index];
  if (!target) return false;
  const removedIds = new Set();
  const stack = [target];
  while (stack.length) {
    const n = stack.pop();
    if (!n || removedIds.has(n.id)) continue;
    removedIds.add(n.id);
    (n.children || []).forEach((child) => stack.push(child));
  }
  info.list.splice(info.index, 1);
  if (tasksViewState?.threadNodeId && removedIds.has(tasksViewState.threadNodeId)) {
    tasksViewState.threadNodeId = null;
    saveTasksViewState();
  }
  Object.values(movingTaskState || {}).forEach((map) => {
    if (!(map instanceof Map)) return;
    for (const [taskId, entry] of map.entries()) {
      if (!entry) continue;
      if (removedIds.has(entry.sourceNodeId) || removedIds.has(entry.targetNodeId)) {
        map.delete(taskId);
      }
    }
  });
  recomputeIndexes();
  store.saveNow();
  renderThreads();
  if (!$('#view-review').hidden) onReviewVisibility();
  if (!$('#view-tasks').hidden) renderTasksPane();
  return true;
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
  (taskChildList(task) || []).forEach((s, idx) => { s.order = idx; });
}

function sortSeriesByRankOrder(task) {
  const list = taskChildList(task);
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

function taskChildList(task) {
  return Array.isArray(task?.children) ? task.children : [];
}

function taskHasChildren(task) {
  return taskChildList(task).length > 0;
}

function taskChildMode(task) {
  return task?.childMode === 'sequential' ? 'sequential' : 'parallel';
}

function nextSeriesRank(task) {
  return (task?.children || []).length + 1;
}

function addSubtaskToTask(task, text, rank = null, now = new Date()) {
  const label = String(text || '').trim();
  if (!label) return null;
  const resolvedRank = rank == null ? nextSeriesRank(task) : Math.max(1, Number(rank) || 1);
  const item = createSubtask(label, resolvedRank);
  const list = Array.isArray(task.children) ? task.children : [];
  const insertAt = Math.max(0, Math.min(list.length, resolvedRank - 1));
  list.splice(insertAt, 0, item);
  task.children = list;
  // Any newly-added subtask should re-open the parent task if it was previously complete.
  task.completed = false;
  task.completedAt = null;
  task.archivedAt = null;
  task.nextRecurringAt = null;
  awardPoints(SUBTASK_CREATION_POINTS, now);
  return item;
}

function moveSubtaskRelative(nodeId, taskId, sourceSubtaskId, targetSubtaskId, placeAfter = false) {
  const task = findTaskRefById(taskId)?.task || null;
  const list = task?.children;
  if (!Array.isArray(list)) return false;
  const sourceIndex = list.findIndex((s) => s.id === sourceSubtaskId);
  const targetIndex = list.findIndex((s) => s.id === targetSubtaskId);
  return reorderListByIndex(list, sourceIndex, targetIndex, placeAfter);
}

function findTaskParentInfo(taskId) {
  const ref = findTaskRefById(taskId);
  if (!ref) return null;
  if (ref.parentTask) {
    const list = taskChildList(ref.parentTask);
    const index = list.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    return { node: ref.node, parentTask: ref.parentTask, list, index, ref };
  }
  const list = Array.isArray(ref.node?.tasks) ? ref.node.tasks : [];
  const index = list.findIndex((task) => task.id === taskId);
  if (index < 0) return null;
  return { node: ref.node, parentTask: null, list, index, ref };
}

function updateTaskById(taskId, updater) {
  const ref = findTaskRefById(taskId);
  if (!ref || typeof updater !== 'function') return false;
  updater(ref.task, ref);
  return true;
}

function removeTaskById(taskId, now = new Date()) {
  const info = findTaskParentInfo(taskId);
  if (!info) return false;
  info.list.splice(info.index, 1);
  if (info.parentTask) {
    syncTaskCompletionFromChildren(info.parentTask, now, { reopenWhenEmpty: true });
    syncTaskAncestorsCompletion(info.parentTask.id, now);
  }
  return true;
}

function insertTaskIntoList(list, task, index = null) {
  if (!Array.isArray(list) || !task) return false;
  const insertAt = index == null ? list.length : Math.max(0, Math.min(list.length, Number(index) || 0));
  list.splice(insertAt, 0, task);
  return true;
}

function addChildTask(parentTaskId, text, index = null, now = new Date()) {
  const parent = findTaskRefById(parentTaskId)?.task || null;
  if (!parent) return null;
  const label = String(text || '').trim();
  if (!label) return null;
  const task = createSubtask(label, (index == null ? taskChildList(parent).length : index) + 1);
  const list = taskChildList(parent);
  insertTaskIntoList(list, task, index);
  parent.children = list;
  parent.completed = false;
  parent.completedAt = null;
  parent.archivedAt = null;
  parent.nextRecurringAt = null;
  awardPoints(5, now);
  return task;
}

function addSiblingTask(taskId, text, placeAfter = true, now = new Date()) {
  const info = findTaskParentInfo(taskId);
  const label = String(text || '').trim();
  if (!info || !label) return null;
  const task = info.parentTask ? createSubtask(label) : createTask(label);
  const offset = placeAfter ? 1 : 0;
  insertTaskIntoList(info.list, task, info.index + offset);
  if (info.parentTask) {
    info.parentTask.completed = false;
    info.parentTask.completedAt = null;
    info.parentTask.archivedAt = null;
    info.parentTask.nextRecurringAt = null;
    awardPoints(5, now);
  }
  return task;
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
  n.tasks.forEach((t) => normalizeTaskNode(t));
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

function followUpStatus(task, now = new Date()) {
  const followUp = parseIsoDate(task?.followUpAt);
  if (!followUp) return { state: 'none', label: '' };
  if (followUp.getTime() <= now.getTime()) return { state: 'overdue', label: `Follow up overdue ${followUp.toLocaleString()}` };
  if (dayKeyFromDate(followUp) === dayKeyFromDate(now)) {
    return {
      state: 'today',
      label: `Follow up today ${followUp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`,
    };
  }
  return { state: 'upcoming', label: `Follow up ${followUp.toLocaleDateString()}` };
}

function setTaskCompleted(task, completed, now = new Date(), opts = {}) {
  const wasCompleted = !!task.completed;
  task.completed = !!completed;
  if (task.completed) {
    task.completedAt = now.toISOString();
    if (task.recurrence && task.recurrence !== 'none') task.nextRecurringAt = nextRecurringAt(task.recurrence, now);
  } else {
    task.completedAt = null;
    task.archivedAt = null;
    task.nextRecurringAt = null;
    task.completionPointsAwardedAt = null;
  }
  if (!wasCompleted && task.completed && opts.awardPoints !== false && !task.completionPointsAwardedAt) {
    const awarded = awardPoints(pointsForTaskCompletion(task), now);
    if (awarded > 0) task.completionPointsAwardedAt = now.toISOString();
  }
  if (opts.cascadeChildren && taskHasChildren(task)) {
    taskChildList(task).forEach((child) => {
      setTaskCompleted(child, completed, now, {
        awardPoints: false,
        cascadeChildren: true,
        syncAncestors: false,
      });
    });
  }
  if (opts.syncAncestors !== false && task?.id) syncTaskAncestorsCompletion(task.id, now);
}

function setSubtaskCompleted(task, subtask, completed, now = new Date()) {
  if (!subtask) return;
  setTaskCompleted(subtask, completed, now, { syncAncestors: false });
  const children = taskHasChildren(task) ? taskChildList(task) : (Array.isArray(task?.series) ? task.series : []);
  if (!children.length) return;
  const allDone = children.every((child) => !!child.completed);
  if (allDone) {
    setTaskCompleted(task, true, now, { syncAncestors: false });
  } else {
    task.completed = false;
    task.completedAt = null;
    task.archivedAt = null;
    task.nextRecurringAt = null;
  }
  if (store?.data?.threads && subtask?.id) syncTaskAncestorsCompletion(subtask.id, now);
}

function syncTaskCompletionFromChildren(task, now = new Date(), opts = {}) {
  const children = taskChildList(task);
  if (!children.length) {
    if (opts.reopenWhenEmpty) {
      task.completed = false;
      task.completedAt = null;
      task.archivedAt = null;
      task.nextRecurringAt = null;
    }
    return;
  }
  const allDone = children.every((child) => !!child.completed);
  if (allDone) {
    if (!task.completed) setTaskCompleted(task, true, now, { syncAncestors: false });
    return;
  }
  if (!task.completed) return;
  task.completed = false;
  task.completedAt = null;
  task.archivedAt = null;
  task.nextRecurringAt = null;
}

function syncTaskAncestorsCompletion(taskId, now = new Date()) {
  if (!store?.data?.threads) return;
  const ref = findTaskRefById(taskId);
  if (!ref || !Array.isArray(ref.ancestors)) return;
  ref.ancestors.slice().reverse().forEach((ancestor) => {
    syncTaskCompletionFromChildren(ancestor, now);
  });
}

function setTaskTreeCompleted(task, completed, now = new Date(), opts = {}) {
  setTaskCompleted(task, completed, now, {
    awardPoints: opts.awardRootPoints !== false,
    cascadeChildren: false,
    syncAncestors: false,
  });
  taskChildList(task).forEach((child) => {
    setTaskTreeCompleted(child, completed, now, { awardRootPoints: false });
  });
  if (task?.id) syncTaskAncestorsCompletion(task.id, now);
}

function resetTaskForRecurring(task) {
  task.completed = false;
  task.completedAt = null;
  task.archivedAt = null;
  task.nextRecurringAt = null;
  task.completionPointsAwardedAt = null;
  taskChildList(task).forEach((child) => resetTaskForRecurring(child));
}

function preserveTaskCompletionTracking(task) {
  if (!task || typeof task !== 'object') return;
  if (task.completed && !task.completionPointsAwardedAt) {
    task.completionPointsAwardedAt = task.completedAt || nowIso();
  }
  taskChildList(task).forEach((child) => preserveTaskCompletionTracking(child));
}

function moveTaskToThread(sourceNodeId, taskId, targetNodeId) {
  const sourceNode = findNodeById(store.data.threads || [], sourceNodeId);
  const targetNode = findNodeById(store.data.threads || [], targetNodeId);
  if (!sourceNode || !targetNode) return null;
  if (sourceNode.id === targetNode.id) return null;
  sourceNode.tasks = Array.isArray(sourceNode.tasks) ? sourceNode.tasks : [];
  targetNode.tasks = Array.isArray(targetNode.tasks) ? targetNode.tasks : [];
  const fromIndex = sourceNode.tasks.findIndex((task) => task.id === taskId);
  if (fromIndex < 0) return null;
  const [task] = sourceNode.tasks.splice(fromIndex, 1);
  preserveTaskCompletionTracking(task);
  targetNode.tasks.push(task);
  return { task, sourceNode, targetNode };
}

function runRecurringTasks(now = new Date()) {
  let changed = false;
  flattenTaskRefs().forEach(({ task }) => {
    if (!task.recurrence || task.recurrence === 'none' || !task.nextRecurringAt) return;
    const due = parseIsoDate(task.nextRecurringAt);
    if (!due || now < due) return;
    resetTaskForRecurring(task);
    changed = true;
  });
  return changed;
}

function applyArchivingRules(days = 7, now = new Date()) {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return false;
  const cutoff = n * 24 * 60 * 60 * 1000;
  let changed = false;
  const applyTaskArchive = (task) => {
    if (task.completed && task.completedAt) {
      const age = now.getTime() - new Date(task.completedAt).getTime();
      if (age >= cutoff && !task.archivedAt) { task.archivedAt = now.toISOString(); changed = true; }
    } else if (task.archivedAt) {
      task.archivedAt = null;
      changed = true;
    }
    taskChildList(task).forEach(applyTaskArchive);
  };
  flattenTaskRefs().forEach(({ task, depth }) => {
    if (depth > 0) return;
    applyTaskArchive(task);
  });
  return changed;
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

function nudgeFollowUp(task, days = 2, now = new Date()) {
  const base = parseIsoDate(task?.followUpAt) || now;
  const at = new Date(base);
  at.setDate(at.getDate() + Math.max(1, Number(days) || 2));
  task.followUpAt = at.toISOString();
}

function snoozeFollowUp(task, now = new Date()) {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  task.followUpAt = at.toISOString();
}

function sequenceBlockingSibling(ref) {
  if (!ref?.parentTask || taskChildMode(ref.parentTask) !== 'sequential') return null;
  const siblings = taskChildList(ref.parentTask);
  const firstIncomplete = siblings.find((task) => !task.completed);
  if (!firstIncomplete || firstIncomplete.id === ref.task.id) return null;
  return firstIncomplete;
}

function isTaskAvailable(taskOrRef, now = new Date(), currentContext = null, depMap = null) {
  const ref = taskOrRef?.task ? taskOrRef : (taskOrRef?.id ? findTaskRefById(taskOrRef.id) : null);
  const t = ref?.task || taskOrRef;
  if (!t || t.completed) return false;
  if (t.blocked) return false;
  if (t.waitingOn && t.waitingOn.trim()) return false;
  if (unresolvedDependencyIds(t, depMap).length) return false;
  if (sequenceBlockingSibling(ref)) return false;
  if (t.availableAt) {
    const at = new Date(t.availableAt);
    if (now < at) return false;
  }
  if (Array.isArray(t.contexts) && t.contexts.length) {
    if (!currentContext || !t.contexts.includes(currentContext)) return false;
  }
  return true;
}

function availabilityReason(taskOrRef, now = new Date(), currentContext = null, depMap = null) {
  const ref = taskOrRef?.task ? taskOrRef : (taskOrRef?.id ? findTaskRefById(taskOrRef.id) : null);
  const t = ref?.task || taskOrRef;
  if (t.blocked) return 'Paused';
  const follow = followUpStatus(t, now);
  if (t.waitingOn && t.waitingOn.trim()) {
    if (follow.state === 'overdue' || follow.state === 'today') return `Waiting: ${t.waitingOn.trim()} • ${follow.label}`;
    return `Waiting: ${t.waitingOn.trim()}`;
  }
  const deps = dependencyNames(t, depMap);
  if (deps.length) {
    if (follow.state === 'overdue' || follow.state === 'today') return `Blocked by: ${deps.join(', ')} • ${follow.label}`;
    return `Blocked by: ${deps.join(', ')}`;
  }
  if (t.availableAt) {
    const at = new Date(t.availableAt);
    if (now < at) return `Available ${at.toLocaleString()}`;
  }
  const blockingSibling = sequenceBlockingSibling(ref);
  if (blockingSibling) return `Waiting for earlier step: ${blockingSibling.text || 'Previous task'}`;
  if (follow.state === 'overdue' || follow.state === 'today') return follow.label;
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

function bindEnterToButton(input, btn) {
  if (!input || !btn) return;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    btn.click();
  });
}

function initTaskTextInput(input) {
  if (!input || input.tagName !== 'TEXTAREA') return;
  const syncHeight = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.max(34, input.scrollHeight)}px`;
  };
  input.style.minHeight = '34px';
  input.style.resize = 'none';
  input.style.overflow = 'hidden';
  input.addEventListener('input', syncHeight);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    input.blur();
  });
  syncHeight();
}

function confirmName(promptText, initial = '') {
  const name = window.prompt(promptText, initial);
  if (!name) return null;
  return name.trim();
}

function createInlineIconAction(title, onClick, symbol = '✕', cls = '') {
  const btn = el('button', {
    class: `icon-btn row-action${cls ? ` ${cls}` : ''}`,
    type: 'button',
    title,
    'aria-label': title,
  }, symbol);
  btn.addEventListener('click', onClick);
  return btn;
}

function taskStatusMeta(task, opts = {}) {
  const now = opts.now || new Date();
  const ctx = opts.currentContext || null;
  const depMap = opts.depMap || null;
  const ref = opts.ref || null;
  const done = opts.done != null ? !!opts.done : !!task?.completed;
  if (done) return { label: 'Completed', tone: 'done' };
  if (task?.blocked) return { label: 'Paused', tone: 'blocked' };
  if (task?.waitingOn && String(task.waitingOn).trim()) return { label: 'Blocked', tone: 'blocked' };
  if (unresolvedDependencyIds(task, depMap).length) return { label: 'Blocked', tone: 'blocked' };
  if (sequenceBlockingSibling(ref || findTaskRefById(task?.id))) return { label: 'Queued', tone: 'scheduled' };
  if (task?.availableAt) {
    const at = parseIsoDate(task.availableAt);
    if (at && now < at) return { label: 'Scheduled', tone: 'scheduled' };
  }
  if (Array.isArray(task?.contexts) && task.contexts.length && (!ctx || !task.contexts.includes(ctx))) {
    return { label: 'Context', tone: 'context' };
  }
  const due = dueStatus(task, now);
  if (due.state === 'overdue') return { label: 'Overdue', tone: 'blocked' };
  if (due.state === 'soon') return { label: 'Due Soon', tone: 'scheduled' };
  return { label: 'Ready', tone: 'ready' };
}

function buildTaskStateBadges(task, opts = {}) {
  const pri = clampPriority(task?.priority, 3);
  const status = taskStatusMeta(task, opts);
  const row = el('div', { class: 'task-state-row' });
  row.append(el('span', { class: 'pill task-state-chip priority' }, `P${pri}`));
  row.append(el('span', { class: `pill task-state-chip ${status.tone}` }, status.label));
  return row;
}

function buildTaskMetaRow(t, opts = {}) {
  const quick = opts.quickEdit || null;
  const locs = taskLocations(t);
  const dur = taskDurationMins(t);
  const pri = Math.max(1, Number(t?.priority) || 3);
  const compact = opts.variant === 'compact';
  const includePriority = opts.includePriority !== false;
  const row = el('div', { class: `task-meta-row${compact ? ' compact' : ''}` });
  const addItem = (label, value, onClick, cls = '') => {
    const item = el('div', { class: `task-meta-item${cls ? ` ${cls}` : ''}${compact ? ' compact' : ''}` });
    item.append(el('span', { class: 'task-meta-label' }, label));
    if (typeof onClick === 'function') {
      const btn = el('button', { class: 'task-meta-value', type: 'button' }, value);
      btn.addEventListener('click', onClick);
      item.append(btn);
    } else {
      item.append(el('span', { class: 'task-meta-value' }, value));
    }
    row.append(item);
  };
  if (includePriority) addItem('Priority', `P${pri}`, quick?.onPriorityCycle, 'priority');
  addItem('Time', dur ? formatDuration(dur) : '--', quick?.onDurationCycle, 'time');
  addItem('Location', locs.length ? locs.join(', ') : '--', quick?.onLocationCycle, 'location');
  return row;
}

function buildTaskTagline(t, reason = '', opts = {}) {
  const quick = opts.quickEdit || null;
  const showLocation = opts.showLocation !== false;
  const showDuration = opts.showDuration !== false;
  const locs = taskLocations(t);
  const dur = taskDurationMins(t);
  const includeSeries = opts.includeSeries !== false;
  const series = includeSeries ? seriesSummary(t) : null;
  const due = dueStatus(t);
  const follow = followUpStatus(t);
  if ((!showLocation || !locs.length) && (!showDuration || !dur) && !reason && !series && due.state === 'none' && follow.state === 'none' && !(quick && quick.showEmpty && (showLocation || showDuration))) return null;
  const line = el('div', { class: 'tagline' });
  if (showLocation && locs.length) {
    if (quick && typeof quick.onLocationCycle === 'function') {
      const b = el('button', { class: 'pill tag pill-btn', type: 'button', title: 'Click to cycle location presets' }, `Loc: ${locs.join(', ')}`);
      b.addEventListener('click', quick.onLocationCycle);
      line.append(b);
    } else {
      line.append(el('span', { class: 'pill tag' }, `Loc: ${locs.join(', ')}`));
    }
  } else if (showLocation && quick && quick.showEmpty && typeof quick.onLocationCycle === 'function') {
    const b = el('button', { class: 'pill tag pill-btn add', type: 'button', title: 'Click to add a location preset' }, '+Loc');
    b.addEventListener('click', quick.onLocationCycle);
    line.append(b);
  }
  if (showDuration && dur) {
    if (quick && typeof quick.onDurationCycle === 'function') {
      const b = el('button', { class: 'pill tag pill-btn', type: 'button', title: 'Click to cycle time estimates' }, `Time: ${formatDuration(dur)}`);
      b.addEventListener('click', quick.onDurationCycle);
      line.append(b);
    } else {
      line.append(el('span', { class: 'pill tag' }, `Time: ${formatDuration(dur)}`));
    }
  } else if (showDuration && quick && quick.showEmpty && typeof quick.onDurationCycle === 'function') {
    const b = el('button', { class: 'pill tag pill-btn add', type: 'button', title: 'Click to set a time estimate' }, '+Time');
    b.addEventListener('click', quick.onDurationCycle);
    line.append(b);
  }
  if (series) line.append(el('span', { class: 'pill tag series-pill' }, series));
  if (due.state !== 'none') {
    const cls = due.state === 'overdue' ? 'pill warn' : 'pill tag';
    line.append(el('span', { class: cls }, due.label));
  }
  if (follow.state !== 'none') {
    const cls = follow.state === 'overdue' || follow.state === 'today' ? 'pill warn' : 'pill tag';
    line.append(el('span', { class: cls }, follow.label));
  }
  if (reason) line.append(el('span', { class: 'pill warn' }, reason));
  return line;
}

function cycleTaskDuration(task, presets = DURATION_PRESETS) {
  const base = Array.from(new Set((presets || []).map((x) => normalizeDurationValue(x)).filter(Boolean))).sort((a, b) => a - b);
  if (!base.length) {
    task.duration = null;
    return null;
  }
  const current = taskDurationMins(task);
  if (!current) {
    task.duration = base[0];
    return task.duration;
  }
  const order = Array.from(new Set(base.concat([current]))).sort((a, b) => a - b);
  const idx = order.indexOf(current);
  const next = idx >= 0 ? order[idx + 1] : base[0];
  task.duration = next || null;
  return task.duration;
}

function cycleTaskPresetLocation(task, presets = LOCATION_PRESETS) {
  const list = taskLocations(task);
  const norm = (v) => String(v || '').toLowerCase();
  const idx = (presets || []).findIndex((preset) => list.some((loc) => norm(loc) === norm(preset)));
  let nextList = list.slice();
  if (idx >= 0) {
    const active = presets[idx];
    nextList = nextList.filter((loc) => norm(loc) !== norm(active));
  }
  if (idx + 1 < presets.length) nextList.unshift(presets[idx + 1]);
  setTaskLocations(task, nextList);
  return taskLocations(task);
}

function buildReviewSeriesPanel(task, opts = {}) {
  const stats = seriesStats(task);
  if (!stats) return null;
  const editable = !!opts.editable;
  const panel = el('div', { class: 'review-series-panel' });
  const head = el('div', { class: 'review-series-head' });
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
  head.append(el('strong', {}, `Project Steps • ${stats.done}/${stats.total} complete`));
  const headRight = el('div', { class: 'review-series-head-meta' });
  headRight.append(el('span', { class: 'subtext' }, `${pct}%`));
  if (editable) headRight.append(el('span', { class: 'pill tag' }, 'Inline Edit'));
  head.append(headRight);

  const progress = el('div', { class: 'review-series-progress' });
  const fill = el('div', { class: 'fill' });
  fill.style.width = `${pct}%`;
  progress.append(fill);

  const list = el('div', { class: 'review-series-list' });
  const ordered = taskChildList(task).slice();
  ordered.forEach((s, idx) => {
    const rank = idx + 1;
    const cls = `review-series-row${editable ? ' editable' : ''}${s.completed ? ' done' : ''}${!s.completed && rank === stats.activeRank ? ' current' : ''}`;
    const row = el('div', { class: cls });
    if (!editable) {
      row.append(el('span', { class: 'pill step' }, `Step ${rank}`));
      row.append(el('span', { class: 'review-series-text' }, s.text || 'Untitled subtask'));
      const summary = taskHasChildren(s) ? `${taskChildList(s).length} nested` : (s.completed ? 'Done' : (rank === stats.activeRank ? 'Do Next' : 'Up Next'));
      row.append(el('span', { class: 'review-series-state' }, summary));
      list.append(row);
      return;
    }

    const check = el('input', { type: 'checkbox', class: 'review-series-check' });
    check.checked = !!s.completed;
    check.addEventListener('change', () => {
      if (typeof opts.onToggle === 'function') opts.onToggle(s.id, check.checked);
    });
    const textInput = el('input', { type: 'text', class: 'review-series-text-input', placeholder: 'Subtask name' });
    textInput.value = s.text || '';
    textInput.addEventListener('change', () => {
      const next = textInput.value.trim();
      if (!next) {
        textInput.value = s.text || '';
        return;
      }
      if (typeof opts.onTextChange === 'function') opts.onTextChange(s.id, next);
    });
    const stateLabel = taskHasChildren(s)
      ? `${taskChildList(s).length} nested`
      : (s.completed ? 'Done' : (rank === stats.activeRank ? 'Do Next' : 'Up Next'));
    const state = el('span', { class: 'review-series-state' }, stateLabel);
    const remove = createInlineIconAction('Remove step', () => {
      if (typeof opts.onRemove === 'function') opts.onRemove(s.id);
    }, '✕', 'danger review-series-remove');
    row.append(check, textInput, state, remove);
    list.append(row);
  });
  panel.append(head, progress, list);
  if (editable) {
    const addRow = el('div', { class: 'review-series-add' });
    const addText = el('input', { type: 'text', placeholder: 'Add another step…' });
    const addBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Add');
    const addItem = () => {
      const text = addText.value.trim();
      if (!text) {
        addText.focus();
        return;
      }
      if (typeof opts.onAdd === 'function') opts.onAdd(text, ordered.length + 1);
      addText.value = '';
      addText.focus();
    };
    addBtn.addEventListener('click', addItem);
    addText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addItem();
      }
    });
    addRow.append(addText, addBtn);
    panel.append(addRow);
  }
  return panel;
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

function taskHasPauseState(task, depMap = null) {
  if (!task) return false;
  if (task.blocked) return true;
  if (task.waitingOn && task.waitingOn.trim()) return true;
  return unresolvedDependencyIds(task, depMap).length > 0;
}

function mutateTaskAndRefresh(taskId, updater, rerender, opts = {}) {
  const ref = findTaskRefById(taskId);
  if (!ref || typeof updater !== 'function') return false;
  updater(ref.task, ref);
  store.saveNow();
  if (opts.renderThreads) renderThreads();
  if (!$('#review-stage').hidden) {
    renderProgress();
    renderStoryCard();
  }
  if (typeof rerender === 'function') rerender();
  return true;
}

function buildAvailabilityControls(nodeId, taskId, rerender) {
  const ref = findTaskRefById(taskId);
  const t = ref?.task;
  const avail = el('div', { class: 'availability task-details-panel' });
  if (!ref || !t) return avail;

  const updateTask = (updater, opts = {}) => mutateTaskAndRefresh(taskId, updater, rerender, { renderThreads: !!opts.renderThreads });
  const buildRow = (label) => {
    const row = el('div', { class: 'row' });
    row.append(el('div', { class: 'subtext' }, label));
    return row;
  };
  const currentView = $('#view-tasks') && !$('#view-tasks').hidden
    ? 'tasks'
    : ($('#view-review') && !$('#view-review').hidden ? 'review' : 'prepare');

  const topRow = buildRow('Details');
  const topControls = el('div', { class: 'task-panel-inline-row' });
  const pri = el('select', { class: 'select-sm' });
  for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, `Priority ${i}`));
  pri.value = String(t.priority || 3);
  pri.addEventListener('change', () => updateTask((task) => { task.priority = Number(pri.value); }, { renderThreads: true }));
  topControls.append(pri);
  if (taskHasChildren(t)) {
    const mode = el('select', { class: 'select-sm' });
    mode.append(el('option', { value: 'parallel' }, 'Parallel children'));
    mode.append(el('option', { value: 'sequential' }, 'Sequential children'));
    mode.value = taskChildMode(t);
    mode.addEventListener('change', () => updateTask((task) => { task.childMode = mode.value; }));
    topControls.append(mode);
  }
  if (!ref.parentTask) {
    const threadSel = buildTaskThreadSelect(ref.node.id, t, currentView, () => {
      renderThreads();
      if (!$('#view-review').hidden) onReviewVisibility();
      if (!$('#view-tasks').hidden) renderTasksPane();
    });
    topControls.append(threadSel);
  }
  topRow.append(topControls);
  avail.append(topRow);

  const row1 = buildRow('Available from');
  const dt = el('input', { type: 'datetime-local' });
  dt.value = toLocalInputValue(t.availableAt);
  dt.addEventListener('change', () => updateTask((task) => { task.availableAt = parseLocalDateTime(dt.value); }));
  const clear1 = el('button', { class: 'btn ghost' }, 'Clear');
  clear1.addEventListener('click', () => {
    dt.value = '';
    updateTask((task) => { task.availableAt = null; });
  });
  row1.append(dt, clear1);
  avail.append(row1);

  const rowDue = buildRow('Due');
  const dueInput = el('input', { type: 'datetime-local' });
  dueInput.value = toLocalInputValue(t.dueAt);
  dueInput.addEventListener('change', () => updateTask((task) => { task.dueAt = parseLocalDateTime(dueInput.value); }));
  const clearDue = el('button', { class: 'btn ghost' }, 'Clear');
  clearDue.addEventListener('click', () => {
    dueInput.value = '';
    updateTask((task) => { task.dueAt = null; });
  });
  rowDue.append(dueInput, clearDue);
  avail.append(rowDue);

  const row2 = buildRow('Contexts');
  const ctxStack = el('div', { class: 'stack' });
  const chipWrap = el('div', { class: 'chiplist' });
  (t.contexts || []).forEach((c) => {
    const ch = el('span', { class: 'chip' }, [c, el('button', {}, '✕')]);
    ch.querySelector('button').addEventListener('click', () => {
      updateTask((task) => { task.contexts = (task.contexts || []).filter((x) => x !== c); });
    });
    chipWrap.append(ch);
  });
  const ctxAddRow = el('div', { class: 'mini-add' });
  const ctxInput = el('input', { type: 'text', placeholder: 'Add context…' });
  const addCtx = el('button', { class: 'btn ghost' }, 'Add');
  addCtx.addEventListener('click', () => {
    const v = ctxInput.value.trim();
    if (!v) return;
    updateTask((task) => {
      const arr = Array.isArray(task.contexts) ? task.contexts.slice() : [];
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

  const rowLoc = buildRow('Locations');
  const locStack = el('div', { class: 'stack' });
  const locChips = el('div', { class: 'chiplist' });
  const locOptions = uniqTags([].concat(LOCATION_PRESETS, taskLocations(t)));
  locOptions.forEach((loc) => {
    const active = taskLocations(t).some((x) => x.toLowerCase() === loc.toLowerCase());
    const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, loc);
    btn.addEventListener('click', () => {
      updateTask((task) => {
        const list = taskLocations(task);
        const idx = list.findIndex((x) => x.toLowerCase() === loc.toLowerCase());
        if (idx >= 0) list.splice(idx, 1);
        else list.push(loc);
        setTaskLocations(task, list);
      }, { renderThreads: true });
    });
    locChips.append(btn);
  });
  const locAddRow = el('div', { class: 'mini-add' });
  const locInput = el('input', { type: 'text', placeholder: 'Add location…' });
  const addLoc = el('button', { class: 'btn ghost' }, 'Add');
  addLoc.addEventListener('click', () => {
    const v = locInput.value.trim();
    if (!v) return;
    updateTask((task) => {
      const list = taskLocations(task);
      list.push(v);
      setTaskLocations(task, list);
    }, { renderThreads: true });
    locInput.value = '';
  });
  locInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLoc.click(); }
  });
  locAddRow.append(locInput, addLoc);
  locStack.append(locChips, locAddRow);
  const clearLoc = el('button', { class: 'btn ghost' }, 'Clear');
  clearLoc.addEventListener('click', () => updateTask((task) => { setTaskLocations(task, []); }, { renderThreads: true }));
  rowLoc.append(locStack, clearLoc);
  avail.append(rowLoc);

  const rowTime = buildRow('Time');
  const timeStack = el('div', { class: 'stack' });
  const timeChips = el('div', { class: 'chiplist' });
  const current = taskDurationMins(t);
  const timeOptions = Array.from(new Set([].concat(DURATION_PRESETS, current ? [current] : []))).sort((a, b) => a - b);
  timeOptions.forEach((mins) => {
    const active = current === mins;
    const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, formatDuration(mins) || `${mins}m`);
    btn.addEventListener('click', () => {
      updateTask((task) => {
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
    updateTask((task) => { task.duration = v; });
    timeInput.value = '';
  });
  timeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); timeSet.click(); }
  });
  timeAddRow.append(timeInput, timeSet);
  timeStack.append(timeChips, timeAddRow);
  const clearTime = el('button', { class: 'btn ghost' }, 'Clear');
  clearTime.addEventListener('click', () => updateTask((task) => { task.duration = null; }));
  rowTime.append(timeStack, clearTime);
  avail.append(rowTime);

  const rowRecur = buildRow('Repeat');
  const recurSel = el('select', { class: 'select-sm' });
  [['none', 'No repeat'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']].forEach(([v, label]) => {
    recurSel.append(el('option', { value: v }, label));
  });
  recurSel.value = t.recurrence || 'none';
  recurSel.addEventListener('change', () => {
    updateTask((task) => {
      task.recurrence = recurSel.value;
      if (task.recurrence === 'none') task.nextRecurringAt = null;
      else if (task.completed && !task.nextRecurringAt) task.nextRecurringAt = nextRecurringAt(task.recurrence);
    });
  });
  const recurMeta = el('div', { class: 'subtext' }, t.nextRecurringAt ? `Next ${new Date(t.nextRecurringAt).toLocaleString()}` : '');
  rowRecur.append(recurSel, recurMeta);
  avail.append(rowRecur);

  if (taskHasChildren(t)) {
    const rowStructure = buildRow('Breakdown');
    const stats = seriesStats(t);
    const note = el('div', { class: 'subtext' }, `${stats?.done || 0}/${stats?.total || 0} complete • ${taskChildMode(t) === 'sequential' ? 'Sequential' : 'Parallel'} children`);
    const openTasks = el('button', { class: 'btn ghost' }, 'Open in Tasks');
    openTasks.addEventListener('click', () => {
      switchView('tasks');
      tasksViewState.focusTaskId = taskId;
      saveTasksViewState();
      renderTasksPane();
    });
    rowStructure.append(note, openTasks);
    avail.append(rowStructure);
  }

  return avail;
}

function buildPauseControls(taskId, rerender) {
  const ref = findTaskRefById(taskId);
  const t = ref?.task;
  const panel = el('div', { class: 'availability task-pause-panel' });
  if (!ref || !t) return panel;

  const updateTask = (updater) => mutateTaskAndRefresh(taskId, updater, rerender, { renderThreads: true });
  const buildRow = (label) => {
    const row = el('div', { class: 'row' });
    row.append(el('div', { class: 'subtext' }, label));
    return row;
  };

  const rowBlocked = buildRow('Pause task');
  const blockedLabel = el('label', { class: 'filter-toggle' });
  const blockedInput = el('input', { type: 'checkbox' });
  blockedInput.checked = !!t.blocked;
  blockedInput.addEventListener('change', () => updateTask((task) => { task.blocked = blockedInput.checked; }));
  blockedLabel.append(blockedInput, document.createTextNode(' Paused'));
  rowBlocked.append(blockedLabel);
  panel.append(rowBlocked);

  const rowWait = buildRow('Waiting on');
  const waitInput = el('input', { type: 'text', placeholder: 'Name or reason…' });
  waitInput.value = t.waitingOn || '';
  waitInput.addEventListener('change', () => updateTask((task) => { task.waitingOn = waitInput.value.trim(); }));
  const clearWait = el('button', { class: 'btn ghost' }, 'Clear');
  clearWait.addEventListener('click', () => {
    waitInput.value = '';
    updateTask((task) => { task.waitingOn = ''; });
  });
  rowWait.append(waitInput, clearWait);
  panel.append(rowWait);

  const rowFollow = buildRow('Follow up on');
  const followInput = el('input', { type: 'datetime-local' });
  followInput.value = toLocalInputValue(t.followUpAt);
  followInput.addEventListener('change', () => updateTask((task) => { task.followUpAt = parseLocalDateTime(followInput.value); }));
  const clearFollow = el('button', { class: 'btn ghost' }, 'Clear');
  clearFollow.addEventListener('click', () => {
    followInput.value = '';
    updateTask((task) => { task.followUpAt = null; });
  });
  rowFollow.append(followInput, clearFollow);
  panel.append(rowFollow);

  const rowDeps = buildRow('Blocked by');
  const depStack = el('div', { class: 'stack' });
  const depChips = el('div', { class: 'chiplist' });
  const allRefs = flattenTaskRefs().filter((entry) => entry.task.id !== taskId);
  const byId = new Map(allRefs.map((entry) => [entry.task.id, entry]));
  (t.blockedBy || []).forEach((depId) => {
    const depRef = byId.get(depId);
    if (!depRef) return;
    const label = depRef.task.text || 'Dependency';
    const chip = el('span', { class: 'chip' }, [label, el('button', {}, '✕')]);
    chip.querySelector('button').addEventListener('click', () => {
      updateTask((task) => { task.blockedBy = (task.blockedBy || []).filter((id) => id !== depId); });
    });
    depChips.append(chip);
  });
  const depAddRow = el('div', { class: 'mini-add' });
  const depSel = el('select', { class: 'select-sm' });
  depSel.append(el('option', { value: '' }, 'Add dependency...'));
  allRefs.forEach((entry) => {
    const label = `${entry.task.text || 'Task'} (${taskRefPath(entry)})`;
    depSel.append(el('option', { value: entry.task.id }, label));
  });
  const depAdd = el('button', { class: 'btn ghost' }, 'Add');
  depAdd.addEventListener('click', () => {
    const depId = depSel.value;
    if (!depId) return;
    updateTask((task) => {
      const arr = Array.isArray(task.blockedBy) ? task.blockedBy.slice() : [];
      if (!arr.includes(depId)) arr.push(depId);
      task.blockedBy = arr;
    });
    depSel.value = '';
  });
  depAddRow.append(depSel, depAdd);
  depStack.append(depChips, depAddRow);
  rowDeps.append(depStack, el('div'));
  panel.append(rowDeps);

  const rowSnooze = buildRow('Pause until');
  const snoozeRow = el('div', { class: 'chiplist' });
  const mkSnoozeBtn = (label, mode) => {
    const btn = el('button', { class: 'chip toggle' }, label);
    btn.addEventListener('click', () => {
      updateTask((task) => { snoozeTask(task, mode); });
      showToast(`Snoozed to ${label.toLowerCase()}`);
    });
    return btn;
  };
  snoozeRow.append(mkSnoozeBtn('Later today', 'later'), mkSnoozeBtn('Tomorrow', 'tomorrow'), mkSnoozeBtn('Next week', 'next-week'));
  const clearSnooze = el('button', { class: 'btn ghost' }, 'Clear');
  clearSnooze.addEventListener('click', () => updateTask((task) => { task.availableAt = null; }));
  rowSnooze.append(snoozeRow, clearSnooze);
  panel.append(rowSnooze);

  return panel;
}

// ------------------------------
// Preparation view
// ------------------------------
function refreshPreparePrimaryAction() {
  const btn = $('#btn-add-thread');
  if (!btn) return;
  const hasThreads = Array.isArray(store.data?.threads) && store.data.threads.length > 0;
  btn.classList.toggle('primary', !hasThreads);
  btn.classList.toggle('ghost', hasThreads);
}

function renderThreads() {
  const root = $('#threads-root');
  root.innerHTML = '';
  const depMap = allTaskRefMap();
  refreshPreparePrimaryAction();
  if (!store.data.threads.length) {
    root.append(el('div', { class: 'empty' }, 'No threads yet. Add one to begin.'));
    refreshQuickCaptureTargets();
    return;
  }
  for (const node of store.data.threads) {
    root.append(renderNode(node, depMap));
  }
  refreshQuickCaptureTargets();
  renderQuickCaptureJumpLink();
}

function renderNode(node, depMap = null) {
  const container = el('div', { class: 'node', 'data-id': node.id });
  const header = el('div', { class: 'node-header' });
  const titleWrap = el('div', { class: 'node-title' });
  const caret = el('button', { class: 'btn ghost', title: 'Collapse/Expand' }, node.collapsed ? '▸' : '▾');
  caret.addEventListener('click', () => { node.collapsed = !node.collapsed; store.saveNow(); renderThreads(); });
  const colorDot = el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:999px;background:${node.color || '#666'};margin-right:6px;vertical-align:middle;` });
  const titleInput = el('input', { type: 'text', class: 'task-title-input' });
  titleInput.value = node.name || 'Untitled';
  titleInput.addEventListener('change', () => {
    const v = titleInput.value.trim();
    if (!v) { titleInput.value = node.name || 'Untitled'; return; }
    node.name = v;
    store.saveNow();
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
    store.saveNow();
    recomputeIndexes();
    renderThreads();
  });

  const btnDeleteNode = el('button', {
    class: 'btn ghost danger node-delete-btn',
    type: 'button',
    title: 'Delete this thread and all nested content',
    'aria-label': 'Delete thread',
  }, 'Delete');
  btnDeleteNode.addEventListener('click', () => {
    const label = nodePath(node) || node.name || 'thread';
    const ok = window.confirm(`Delete "${label}" and all nested subthreads, questions, and tasks? This cannot be undone.`);
    if (!ok) return;
    const removed = removeNode(node.id);
    if (!removed) return;
    showToast(`Deleted ${node.name || 'thread'}`);
  });

  const enabledToggle = el('label', { class: 'subtext' });
  const en = el('input', { type: 'checkbox' }); en.checked = node.enabled !== false; en.addEventListener('change', ()=>{ node.enabled = en.checked; store.saveNow(); renderThreads(); });
  enabledToggle.append(en, document.createTextNode(' Enabled'));

  const more = el('details', { class: 'node-menu' });
  const moreTrigger = el('summary', { class: 'node-menu-trigger', title: 'More actions', 'aria-label': 'More actions' }, '⋯');
  const morePanel = el('div', { class: 'node-menu-panel' });
  const closeMore = () => { more.removeAttribute('open'); };
  const wireMenuAction = (button, handler) => {
    button.addEventListener('click', () => {
      handler();
      closeMore();
    });
    return button;
  };
  morePanel.append(
    wireMenuAction(el('button', { class: 'btn ghost', type: 'button' }, 'Questions'), () => openQuestionsModal(node.id)),
    wireMenuAction(el('button', { class: 'btn ghost', type: 'button' }, 'Tasks'), () => openTasksModal(node.id)),
    wireMenuAction(el('button', { class: 'btn ghost', type: 'button' }, 'Move Up'), () => moveNode(node.id, -1)),
    wireMenuAction(el('button', { class: 'btn ghost', type: 'button' }, 'Move Down'), () => moveNode(node.id, +1))
  );
  more.append(moreTrigger, morePanel);

  actions.append(dragHandle, btnAddChild, btnDeleteNode, enabledToggle, more);
  header.append(titleWrap, actions);
  container.append(header);

  const footer = el('div', { class: 'kv' });
  const meta = el('div', { class: 'subtext node-meta' }, `${node.children.length} sub, ${node.questions.length} q, ${node.tasks.length} tasks`);
  footer.append(meta, el('div'));
  container.append(footer);
  container.classList.toggle('disabled', node.enabled === false);

  // Inline Questions (Prepare)
  const qSection = el('div', { class: 'story-section' });
  qSection.append(el('div', { class: 'subtext section-kicker' }, 'Questions'));
  const qList = el('div', { class: 'inline-list' });
  if (!node.questions.length) qList.append(el('div', { class: 'empty' }, 'No questions yet.'));
  node.questions.forEach((q) => {
    const row = el('div', { class: 'inline-item question-inline-row' });
    const top = el('div', { class: 'kv' });
    const label = el('input', { type: 'text', class: 'task-title-input' });
    label.value = q.text;
    label.addEventListener('change', () => { q.text = label.value.trim() || q.text; store.saveNow(); });
    const actions = el('div', { class: 'row-actions' });
    const del = createInlineIconAction('Remove question', () => {
      node.questions = node.questions.filter(x => x.id !== q.id);
      store.saveNow(); renderThreads();
    }, '✕', 'danger');
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
    store.saveNow(); renderThreads();
  });
  qAdd.append(qInput, qBtn);
  qSection.append(qList, qAdd);
  container.append(qSection);

  // Inline Tasks (Prepare)
  const tSection = el('div', { class: 'story-section' });
  tSection.append(el('div', { class: 'subtext section-kicker' }, 'Tasks'));
  const tList = el('div', { class: 'inline-list' });
  const now = new Date();
  const movingEntries = movingTaskEntries('prepare', node.id);
  if (!node.tasks.length && !movingEntries.length) tList.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  node.tasks.forEach((t) => {
    const row = el('div', { class: 'inline-item task-inline-row', 'data-task-id': t.id });
    const top = el('div', { class: 'kv task-inline-top' });
    const label = el('textarea', { class: 'task-title-input', rows: '1' });
    initTaskTextInput(label);
    label.value = t.text;
    label.addEventListener('change', () => { t.text = label.value.trim() || t.text; store.saveNow(); });
    const actions = el('div', { class: 'meta task-inline-actions' });
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
    const threadSel = buildTaskThreadSelect(node.id, t, 'prepare', () => {
      renderThreads();
      if (!$('#view-review').hidden) onReviewVisibility();
      if (!$('#view-tasks').hidden) renderTasksPane();
    });
    const del = createInlineIconAction('Remove task', () => {
      node.tasks = node.tasks.filter(x => x.id !== t.id);
      store.saveNow(); renderThreads();
    }, '✕', 'danger');
    const avail = buildAvailabilityControls(node.id, t.id, () => renderThreads());
    avail.hidden = !isTagPanelOpen('prepare', t.id);
    const availBtn = el('button', { class: 'btn ghost btn-lite' }, 'Tags');
    availBtn.addEventListener('click', () => {
      avail.hidden = !avail.hidden;
      setTagPanelOpen('prepare', t.id, !avail.hidden);
    });
    actions.append(taskDrag, pri, threadSel, availBtn, del);
    top.append(label, actions);
    const badges = buildTaskStateBadges(t, { now, depMap });
    // status tint
    if (t.completed) row.classList.add('status-completed');
    else if (isTaskAvailable(t, now, null, depMap)) row.classList.add('status-available');
    else row.classList.add('status-blocked');
    row.append(top, badges);
    // Availability controls (Prepare, hidden by default)
    row.append(avail);
    tList.append(row);
  });
  movingEntries.forEach((entry) => {
    tList.append(buildMovingTaskNotice(entry, 'inline'));
  });
  const tAdd = el('div', { class: 'add-row' });
  const tInput = el('input', { type: 'text', placeholder: 'Add task…' });
  const tBtn = el('button', { class: 'btn primary' }, 'Add');
  bindEnterToButton(tInput, tBtn);
  tBtn.addEventListener('click', () => {
    const txt = tInput.value.trim(); if (!txt) return;
    node.tasks.push(createTask(txt)); tInput.value = '';
    store.saveNow(); renderThreads();
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
    ta.addEventListener('input', () => { q.text = ta.value; store.saveNow(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.questions = node.questions.filter(x => x.id !== q.id);
      store.saveNow();
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
    store.saveNow(); openQuestionsModal(nodeId);
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
    const text = el('textarea', { class: 'task-title-input', rows: '1' });
    initTaskTextInput(text);
    text.value = t.text;
    text.addEventListener('input', () => { t.text = text.value; store.saveNow(); });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.tasks = node.tasks.filter(x => x.id !== t.id);
      store.saveNow(); openTasksModal(nodeId);
    });
    row.append(text, del);
    list.append(row);
  });

  const addRow = el('div', { class: 'add-row' });
  const input = el('input', { type: 'text', placeholder: 'Add task…' });
  const addBtn = el('button', { class: 'btn primary' }, 'Add');
  bindEnterToButton(input, addBtn);
  addBtn.addEventListener('click', () => {
    const t = input.value.trim(); if (!t) return;
    node.tasks.push(createTask(t)); input.value = '';
    store.saveNow(); openTasksModal(nodeId);
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
  const { state } = ensureDailyReviewInData(store.data);
  return !!state.active && Array.isArray(reviewState.ids) && reviewState.ids.length > 0;
}

function renderReviewStreak(now = new Date()) {
  const host = $('#review-streak');
  if (!host) return;
  const { state } = ensureDailyReviewInData(store.data, now);
  const info = reviewStreakInfo(state, now);
  const streakLabel = `${info.streak} day${info.streak === 1 ? '' : 's'}`;
  host.innerHTML = '';
  const card = el('div', { class: `review-streak-card${info.todayDone ? ' complete' : ''}` });
  const head = el('div', { class: 'review-streak-head' });
  head.append(
    el('span', { class: 'review-streak-title' }, 'Review Streak'),
    el('strong', { class: 'review-streak-value' }, streakLabel)
  );
  let metaText = 'Start your streak today';
  if (info.todayDone) metaText = 'Completed today';
  else if (info.streak > 0) metaText = 'Complete today to keep it alive';
  const meta = el('div', { class: 'review-streak-meta' }, metaText);
  const strip = el('div', { class: 'review-streak-strip', 'aria-hidden': 'true' });
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = dayKeyFromDate(d);
    const dot = el('span', { class: 'review-streak-dot' });
    if (info.completed[key]) dot.classList.add('done');
    if (i === 0) dot.classList.add('today');
    strip.append(dot);
  }
  card.append(head, meta, strip);
  host.append(card);
  host.hidden = false;
}

function renderReviewDate() {
  const dateNode = $('#review-date');
  if (!dateNode) return;
  const { state } = ensureDailyReviewInData(store.data);
  dateNode.textContent = formatDayKeyLabel(state.dayKey);
  renderReviewStreak();
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
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.reset) {
    reviewState = { ids: [], idx: 0 };
    persistSharedStateWithoutHistory();
    onReviewVisibility();
    return;
  }
  const shared = ensured.state;
  if (!reviewState.ids.length) {
    clearReviewProgress();
    return;
  }
  shared.dayKey = dayKeyFromDate(new Date());
  shared.active = true;
  shared.idx = Math.max(0, Number(reviewState.idx) || 0);
  shared.currentId = reviewState.ids[reviewState.idx] || null;
  persistSharedStateWithoutHistory();
  try {
    localStorage.setItem(REVIEW_STATE_KEY, JSON.stringify({
      active: true,
      dayKey: shared.dayKey,
      idx: shared.idx,
      currentId: shared.currentId,
    }));
  } catch {}
}

function clearReviewProgress() {
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.state) {
    ensured.state.active = false;
    ensured.state.idx = 0;
    ensured.state.currentId = null;
  }
  persistSharedStateWithoutHistory();
  try { localStorage.removeItem(REVIEW_STATE_KEY); } catch {}
}

function restoreReviewProgressIfAny() {
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.changed) persistSharedStateWithoutHistory();
  renderReviewDate();
  const saved = ensured.state;
  if (!saved || !saved.active) return false;
  const nodes = subthreadsForReview();
  const ids = nodes.map(n => n.id);
  if (!ids.length) return false;
  let idx = Math.min(Math.max(0, Number(saved.idx) || 0), ids.length - 1);
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
}

function startReview() {
  // ensure latest structure is indexed
  recomputeIndexes();
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.changed) persistSharedStateWithoutHistory();
  renderReviewDate();
  const summary = $('#review-summary');
  if (summary) summary.hidden = true;
  const nodes = subthreadsForReview();
  reviewState = { ids: nodes.map(n => n.id), idx: 0 };
  if (!nodes.length) {
    $('#review-empty').hidden = false;
    $('#review-stage').hidden = true;
    $('#btn-start-review').hidden = false;
    clearReviewProgress();
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
  renderReviewDate();
  if (!bar) return;
  bar.innerHTML = '';
  const total = reviewState.ids.length;
  if (!total) return;
  for (let i = 0; i < total; i++) {
    const node = findNodeById(store.data.threads, reviewState.ids[i]);
    const root = rootOf(node);
    // divider between different root threads
    if (i > 0) {
      const prevNode = findNodeById(store.data.threads, reviewState.ids[i - 1]);
      const prevRoot = rootOf(prevNode);
      if (prevRoot?.id !== root?.id) bar.append(el('div', { class: 'divider' }));
    }
    const seg = el('button', {
      class: 'segment',
      type: 'button',
      'data-idx': String(i),
      title: `Jump to item ${i + 1}`,
    });
    seg.style.setProperty('--seg-color', root?.color || 'white');
    const fill = el('div', { class: 'fill' });
    if (i < reviewState.idx) seg.classList.add('done');
    if (i === reviewState.idx) seg.classList.add('current');
    seg.addEventListener('click', () => {
      if (i === reviewState.idx) return;
      reviewState.idx = i;
      renderProgress();
      renderStoryCard();
      saveReviewProgress();
    });
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
  const rootName = (root?.name || 'Thread').trim();
  const nodeName = (n?.name || '').trim();
  const sameScope = !!root && (
    root.id === n.id ||
    (rootName && nodeName && rootName.toLowerCase() === nodeName.toLowerCase())
  );
  card.style.setProperty('--thread-color', root?.color || 'var(--accent)');

  // Header
  const header = el('div', { class: 'story-header' });
  const threadLine = el('div', { class: 'thread-line' });
  const initial = (root?.name || '?').trim().charAt(0).toUpperCase();
  threadLine.append(
    el('div', { class: 'thread-pill' }, [
      el('div', { class: 'thread-avatar' }, initial),
      sameScope ? 'Thread' : (rootName || 'Thread')
    ])
  );
  const breadcrumb = sameScope ? null : el('div', { class: 'breadcrumb' }, `${rootName} › ${nodeName}`);
  const title = el('div', { class: 'story-title' }, n.name);
  header.append(threadLine);
  header.append(title);
  if (breadcrumb) header.append(breadcrumb);

  // Questions
  const qSection = el('div', { class: 'story-section' });
  qSection.append(el('div', { class: 'subtext section-kicker' }, sameScope ? 'Questions' : `${rootName} — Questions`));
  if (!n.questions.length) qSection.append(el('div', { class: 'empty' }, 'No questions yet.'));
  for (const q of n.questions) {
    const wrap = el('div', { class: 'inline-item question-inline-row' });
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
    const actions = el('div', { class: 'row-actions' });
    const delBtn = createInlineIconAction('Remove question', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.questions = live.questions.filter(x => x.id !== q.id);
      store.saveNow(); renderStoryCard(); renderProgress();
    }, '✕', 'danger');
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
  tSection.append(el('div', { class: 'subtext section-kicker' }, sameScope ? 'Tasks' : `${rootName} — Tasks`));
  const tasksEl = el('div', { class: 'tasks' });
  const depMap = allTaskRefMap();
  const now = new Date();
  const movingEntries = movingTaskEntries('review', n.id);
  if (!n.tasks.length && !movingEntries.length) tasksEl.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  for (const t of n.tasks) {
    const stats = seriesStats(t);
    const isSeries = !!stats;
    const done = isSeries ? (stats.remaining === 0) : !!t.completed;
    const item = el('div', { class: 'task review-task-card' + (done ? ' completed' : '') });
    if (isSeries) item.classList.add('series-task');
    const mutateReviewTask = (updater, options = {}) => {
      const liveNode = findNodeById(store.data.threads, n.id);
      const ti = liveNode?.tasks?.findIndex((x) => x.id === t.id) ?? -1;
      if (ti < 0) return false;
      updater(liveNode.tasks[ti], liveNode);
      store.saveNow();
      if (options.renderThreads) renderThreads();
      renderProgress();
      renderStoryCard();
      if (!$('#view-tasks').hidden) renderTasksPane();
      return true;
    };
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!done;
    if (isSeries) {
      cb.title = done ? 'Mark project open' : 'Mark task tree done';
      cb.addEventListener('change', () => {
        mutateReviewTask((liveTask) => {
          setTaskTreeCompleted(liveTask, cb.checked);
        }, { renderThreads: true });
      });
    } else {
      cb.addEventListener('change', () => {
        mutateReviewTask((liveTask) => {
          setTaskCompleted(liveTask, cb.checked);
        });
      });
    }
    const main = el('div', { class: 'review-task-main' });
    const titleInput = el('textarea', { class: 'task-title-input', rows: '1' });
    initTaskTextInput(titleInput);
    titleInput.value = t.text;
    titleInput.addEventListener('change', () => {
      const next = titleInput.value.trim();
      if (!next) {
        titleInput.value = t.text;
        return;
      }
      mutateReviewTask((liveTask) => {
        liveTask.text = next;
      }, { renderThreads: true });
    });
    main.append(titleInput);
    const btns = el('div', { class: 'meta review-task-actions' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => {
      mutateReviewTask((liveTask) => {
        liveTask.priority = Number(pri.value);
      });
    });
    const threadSel = buildTaskThreadSelect(n.id, t, 'review', () => {
      renderThreads();
      renderProgress();
      renderStoryCard();
      if (!$('#view-tasks').hidden) renderTasksPane();
    });
    const delBtn = createInlineIconAction('Remove task', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.tasks = live.tasks.filter(x => x.id !== t.id);
      store.saveNow();
      renderProgress();
      renderStoryCard();
      renderThreads();
      if (!$('#view-tasks').hidden) renderTasksPane();
    }, '✕', 'danger');
    const avail = buildAvailabilityControls(n.id, t.id, () => renderStoryCard());
    avail.hidden = !isTagPanelOpen('review', t.id);
    const availBtn = el('button', { class: 'btn ghost btn-lite' }, 'Tags');
    availBtn.addEventListener('click', () => {
      avail.hidden = !avail.hidden;
      setTagPanelOpen('review', t.id, !avail.hidden);
    });
    btns.append(pri, threadSel, availBtn, delBtn);
    main.append(buildTaskStateBadges(t, { now, depMap, done }));
    const reason = availabilityReason(t, now, null, depMap);
    const tagline = buildTaskTagline(t, reason, {
      includeSeries: false,
      quickEdit: {
        showEmpty: true,
        onDurationCycle: () => {
          mutateReviewTask((liveTask) => {
            cycleTaskDuration(liveTask);
          }, { renderThreads: true });
        },
        onLocationCycle: () => {
          mutateReviewTask((liveTask) => {
            cycleTaskPresetLocation(liveTask);
          }, { renderThreads: true });
        },
      },
    });
    if (tagline) main.append(tagline);
    if (isSeries) {
      const panel = buildReviewSeriesPanel(t, {
        editable: true,
        onToggle: (subtaskId, completed) => {
          mutateReviewTask((liveTask) => {
            const subtask = taskChildList(liveTask).find((s) => s.id === subtaskId);
            if (!subtask) return;
            setSubtaskCompleted(liveTask, subtask, completed);
          }, { renderThreads: true });
        },
        onTextChange: (subtaskId, text) => {
          mutateReviewTask((liveTask) => {
            const subtask = taskChildList(liveTask).find((s) => s.id === subtaskId);
            if (!subtask) return;
            subtask.text = text;
          }, { renderThreads: true });
        },
        onRankChange: (subtaskId, rank) => {
          mutateReviewTask((liveTask) => {
            const subtask = taskChildList(liveTask).find((s) => s.id === subtaskId);
            if (!subtask) return;
            subtask.rank = Math.max(1, Number(rank) || 1);
            sortSeriesByRankOrder(liveTask);
          }, { renderThreads: true });
        },
        onRemove: (subtaskId) => {
          mutateReviewTask((liveTask) => {
            liveTask.children = taskChildList(liveTask).filter((s) => s.id !== subtaskId);
            if (!liveTask.children.length) {
              liveTask.completed = false;
              liveTask.completedAt = null;
            } else {
              sortSeriesByRankOrder(liveTask);
            }
          }, { renderThreads: true });
        },
        onAdd: (text, rank) => {
          mutateReviewTask((liveTask) => {
            addSubtaskToTask(liveTask, text, rank);
          }, { renderThreads: true });
        },
      });
      if (panel) main.append(panel);
    }
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
    const headline = el('div', { class: 'task-card-headline' });
    headline.append(cb, main);
    const controls = el('div', { class: 'task-card-controls review-task-controls' });
    controls.append(btns);
    item.append(headline, controls);
    // Availability controls (Review, hidden by default)
    item.append(avail);
    // Status tint classes
    if (done) item.classList.add('status-completed');
    else if (isTaskAvailable(t, now, null, depMap)) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    tasksEl.append(item);
  }
  movingEntries.forEach((entry) => {
    tasksEl.append(buildMovingTaskNotice(entry));
  });
  // Quick add task in review
  const addT = el('div', { class: 'add-row' });
  const tInput = el('input', { type: 'text', placeholder: 'Add task…' });
  const tBtn = el('button', { class: 'btn' }, 'Add');
  bindEnterToButton(tInput, tBtn);
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
  const reviewStreak = reviewStreakInfo(ensureDailyReviewInData(store.data, now).state, now).streak;
  const recs = buildCarryForwardRecommendations(6);
  summary.innerHTML = '';
  const header = el('div', { class: 'summary-header' });
  header.append(el('h2', {}, 'Review Summary'));
  header.append(el('div', { class: 'subtext' }, `${completed}/${total} tasks completed`));
  const metrics = el('div', { class: 'summary-metrics' });
  metrics.append(el('div', { class: 'summary-metric' }, [`${reviewStreak}`, el('span', {}, 'Streak')]));
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
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.reset) {
    reviewState = { ids: [], idx: 0 };
    persistSharedStateWithoutHistory();
    onReviewVisibility();
    return;
  }
  if (reviewState.idx < reviewState.ids.length - 1) {
    reviewState.idx += 1; renderProgress(); renderStoryCard(); saveReviewProgress();
  } else {
    const marked = markDailyReviewCompleted(store.data, new Date());
    if (marked.changed) persistSharedStateWithoutHistory();
    const streak = reviewStreakInfo(marked.state, new Date()).streak;
    showToast(`Review streak: ${streak} day${streak === 1 ? '' : 's'}`);
    // End of review: hide stage, show start button and a completion message
    renderReviewSummary();
    renderReviewDate();
    reviewState = { ids: [], idx: 0 };
    $('#btn-start-review').hidden = false;
    clearReviewProgress();
  }
}

function jumpReviewToIndex(nextIdx) {
  const total = reviewState.ids.length;
  if (!total) return false;
  const clamped = Math.max(0, Math.min(total - 1, Number(nextIdx) || 0));
  if (clamped === reviewState.idx) return false;
  reviewState.idx = clamped;
  renderProgress();
  renderStoryCard();
  saveReviewProgress();
  return true;
}

function prevStory() {
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.reset) {
    reviewState = { ids: [], idx: 0 };
    persistSharedStateWithoutHistory();
    onReviewVisibility();
    return;
  }
  if (reviewState.idx > 0) {
    reviewState.idx -= 1; renderProgress(); renderStoryCard(); saveReviewProgress();
  }
}

function isTextEntryTarget(target) {
  if (!target) return false;
  return !!(
    target.matches?.('input[type="text"], input[type="search"], input[type="number"], input[type="datetime-local"], textarea, select') ||
    target.isContentEditable
  );
}

function isReviewVisible() {
  const review = $('#view-review');
  return !!review && !review.hidden;
}

function handleReviewShortcut(e) {
  if (!isReviewVisible()) return false;
  if (isTextEntryTarget(e.target)) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;

  const startBtn = $('#btn-start-review');
  const stage = $('#review-stage');
  const hasStage = !!stage && !stage.hidden && reviewState.ids.length > 0;
  const key = e.key;
  const lower = key.toLowerCase();

  if (lower === 's' && startBtn && !startBtn.hidden) {
    e.preventDefault();
    startReview();
    return true;
  }

  if (!hasStage) return false;

  if (key === 'ArrowRight' || lower === 'n' || lower === 'j') {
    e.preventDefault();
    nextStory();
    return true;
  }
  if (key === 'ArrowLeft' || lower === 'p' || lower === 'k') {
    e.preventDefault();
    prevStory();
    return true;
  }
  if (key === 'Home') {
    e.preventDefault();
    return jumpReviewToIndex(0);
  }
  if (key === 'End') {
    e.preventDefault();
    return jumpReviewToIndex(reviewState.ids.length - 1);
  }
  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1;
    if (idx < reviewState.ids.length) {
      e.preventDefault();
      return jumpReviewToIndex(idx);
    }
  }
  return false;
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
  const reviewSeed = ensureDailyReviewInData(store.data);
  if (reviewSeed.changed) persistSharedStateWithoutHistory();
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
    store.saveNow();
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
  const quickCapturePriority = $('#quick-capture-priority');
  const quickCaptureTag = $('#quick-capture-tag');
  const quickCaptureTarget = $('#quick-capture-target');
  quickCaptureForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = quickCaptureInput?.value || '';
    quickCaptureTask({
      text,
      nodeId: quickCaptureTarget?.value || null,
      priority: quickCapturePriority?.value || uiPrefs.capturePriority,
      tag: quickCaptureTag?.value || uiPrefs.captureTag,
    });
    if (quickCaptureInput) quickCaptureInput.value = '';
  });
  quickCaptureTarget?.addEventListener('change', () => {
    uiPrefs.captureNodeId = quickCaptureTarget.value || null;
    persistUiPrefs();
  });
  quickCapturePriority?.addEventListener('change', () => {
    uiPrefs.capturePriority = clampPriority(quickCapturePriority.value, uiPrefs.capturePriority);
    persistUiPrefs();
  });
  quickCaptureTag?.addEventListener('change', () => {
    if (quickCaptureTag.value === QUICK_CAPTURE_NEW_TAG) {
      const created = normalizeTagValue(confirmName('New tag', uiPrefs.captureTag || ''));
      if (created) {
        uiPrefs.captureTag = created;
      }
      persistUiPrefs();
      refreshQuickCaptureTagOptions();
      return;
    }
    uiPrefs.captureTag = normalizeTagValue(quickCaptureTag.value || '');
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
    const inUtilityBar = !!(bar && bar.contains(e.target));
    if (!inUtilityBar) {
      if (globalSearch) globalSearch.value = '';
      renderSearchResults('');
    }
    $$('.node-menu[open]').forEach((menu) => {
      if (menu.contains(e.target)) return;
      menu.removeAttribute('open');
    });
  });
  $('#btn-undo')?.addEventListener('click', undoChange);
  $('#btn-redo')?.addEventListener('click', redoChange);
  document.addEventListener('keydown', (e) => {
    if (handleReviewShortcut(e)) return;
    if (isTextEntryTarget(e.target)) return;
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
    store.saveNow();
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
  renderQuickCaptureJumpLink();
  onReviewVisibility();
  switchView('tasks');
  // Pre-render tasks pane if selected later
  // No-op here; render on switch
  // Restore review if previously active (main), else try pantry review
  if (!restoreReviewProgressIfAny()) {
    restorePantryReviewProgressIfAny();
  }
}

function switchView(name) {
  const previousView = uiPrefs.lastView || 'prepare';
  if (previousView !== name && movingTaskState[previousView]) {
    clearMovingTasksForView(previousView);
  }
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
  if (!isTasks) clearTasksStickyVisibilitySync();
  if (isReview) onReviewVisibility();
  if (isTasks) renderTasksPane();
  if (isPantry) renderPantryActiveView();
  uiPrefs.lastView = name;
  persistUiPrefs();
}

function onReviewVisibility() {
  const summary = $('#review-summary');
  if (summary) summary.hidden = true;
  const ensured = ensureDailyReviewInData(store.data);
  if (ensured.changed) persistSharedStateWithoutHistory();
  renderReviewDate();
  const shared = ensured.state;
  if (shared?.active) {
    const nodes = subthreadsForReview();
    const ids = nodes.map((n) => n.id);
    if (!ids.length) {
      reviewState = { ids: [], idx: 0 };
      clearReviewProgress();
    } else {
      let idx = Math.min(Math.max(0, Number(shared.idx) || 0), ids.length - 1);
      if (shared.currentId) {
        const j = ids.indexOf(shared.currentId);
        if (j >= 0) idx = j;
      }
      reviewState = { ids, idx };
    }
  }
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
  const walkTasks = (node, tasks, parentTask = null, depth = 0, rootTask = null, ancestors = []) => {
    const list = Array.isArray(tasks) ? tasks : [];
    list.forEach((task, index) => {
      const nextRootTask = rootTask || task;
      const ref = {
        node,
        index,
        task,
        root: rootOf(node),
        depth,
        parentTask,
        rootTask: nextRootTask,
        ancestors: ancestors.slice(),
      };
      out.push(ref);
      if (taskHasChildren(task)) {
        walkTasks(node, taskChildList(task), task, depth + 1, nextRootTask, ancestors.concat(task));
      }
    });
  };
  const walk = (list) => {
    for (const n of list) {
      if (!isNodePathEnabled(n)) { if (n.children?.length) walk(n.children); continue; }
      walkTasks(n, n.tasks || []);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

function taskRefPath(ref, opts = {}) {
  if (!ref) return '';
  const divider = opts.divider || ' › ';
  const parts = [];
  const threadPath = nodePath(ref.node);
  if (threadPath) parts.push(threadPath);
  if (opts.includeAncestors !== false) {
    (ref.ancestors || []).forEach((task) => {
      if (task?.text) parts.push(task.text);
    });
  }
  return parts.join(divider);
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

function allThreadNodes() {
  return flattenNodes(store.data.threads || []);
}

function nodeInScope(node, scopeId) {
  if (!scopeId) return true;
  let cur = node;
  while (cur) {
    if (cur.id === scopeId) return true;
    const pid = parentById.get(cur.id);
    cur = pid ? nodeById.get(pid) : null;
  }
  return false;
}

function buildTaskThreadSelect(sourceNodeId, task, viewName, onMove) {
  const currentNode = findNodeById(store.data.threads || [], sourceNodeId);
  const sel = el('select', { class: 'select-sm task-thread-select', title: 'Move task to thread' });
  const threads = allThreadNodes().filter(isNodePathEnabled);
  threads.forEach((threadNode) => {
    const optionLabel = nodePath(threadNode);
    sel.append(el('option', { value: threadNode.id }, optionLabel));
  });
  if (currentNode) sel.value = currentNode.id;
  sel.addEventListener('change', () => {
    const targetNodeId = sel.value;
    if (!targetNodeId || targetNodeId === sourceNodeId) return;
    const moved = moveTaskToThread(sourceNodeId, task.id, targetNodeId);
    if (!moved) {
      sel.value = sourceNodeId;
      return;
    }
    rememberMovingTask(viewName, {
      taskId: moved.task.id,
      text: moved.task.text,
      sourceNodeId: moved.sourceNode.id,
      sourcePath: nodePath(moved.sourceNode),
      targetNodeId: moved.targetNode.id,
      targetName: moved.targetNode.name,
      targetPath: nodePath(moved.targetNode),
      priority: moved.task.priority,
    });
    recomputeIndexes();
    persistSharedStateWithoutHistory();
    if (typeof onMove === 'function') onMove(moved);
    showToast(`Moving to ${moved.targetNode.name}...`);
  });
  return sel;
}

function findTaskRefById(taskId) {
  if (!taskId) return null;
  return flattenTaskRefs().find((ref) => ref.task.id === taskId) || null;
}

function revealPrepareTask(taskId, fallbackNodeId = null) {
  const taskRef = findTaskRefById(taskId);
  const node = taskRef?.node || (fallbackNodeId ? findNodeById(store.data.threads || [], fallbackNodeId) : null);
  if (!node) return;
  let cursor = node;
  while (cursor) {
    cursor.collapsed = false;
    const parentId = parentById.get(cursor.id);
    cursor = parentId ? nodeById.get(parentId) : null;
  }
  renderThreads();
  window.requestAnimationFrame(() => {
    const row = document.querySelector(`.inline-item[data-task-id="${taskId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('next-step-focus');
    setTimeout(() => row.classList.remove('next-step-focus'), 1800);
  });
}

function renderQuickCaptureJumpLink() {
  const host = $('#quick-capture-link');
  if (!host) return;
  host.innerHTML = '';
  if (!quickCaptureJumpState?.taskId) {
    host.hidden = true;
    return;
  }
  const latest = findTaskRefById(quickCaptureJumpState.taskId);
  if (latest?.node) {
    quickCaptureJumpState.nodeId = latest.node.id;
    quickCaptureJumpState.path = nodePath(latest.node);
    quickCaptureJumpState.text = latest.task.text || quickCaptureJumpState.text;
  }
  const jump = el('button', { class: 'capture-jump', type: 'button' });
  jump.append(
    el('span', { class: 'capture-jump-title' }, `Open "${quickCaptureJumpState.text}" in Prepare`),
    el('span', { class: 'capture-jump-meta' }, quickCaptureJumpState.path || '')
  );
  jump.addEventListener('click', () => {
    switchView('prepare');
    revealPrepareTask(quickCaptureJumpState.taskId, quickCaptureJumpState.nodeId);
  });
  host.append(jump);
  host.hidden = false;
}

function refreshQuickCaptureTagOptions() {
  const sel = $('#quick-capture-tag');
  if (!sel) return;
  const current = normalizeTagValue(uiPrefs.captureTag || '');
  const options = uniqTags([].concat(LOCATION_PRESETS, allLocations(), current ? [current] : []));
  sel.innerHTML = '';
  sel.append(el('option', { value: '' }, 'No tag'));
  options.forEach((tag) => {
    sel.append(el('option', { value: tag }, tag));
  });
  sel.append(el('option', { value: QUICK_CAPTURE_NEW_TAG }, '+ Add tag...'));
  if (current && options.some((tag) => tag.toLowerCase() === current.toLowerCase())) {
    const actual = options.find((tag) => tag.toLowerCase() === current.toLowerCase()) || current;
    sel.value = actual;
  } else {
    sel.value = '';
  }
}

function flattenTaskEntries() {
  return flattenTaskRefs().map((ref) => ({ kind: 'task', ...ref }));
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
  threadNodeId: null,
  currentContext: 'Any',
  locationTags: [],
  durationMax: null,
  priorityValues: [],
  focusTaskId: null,
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
let projectNudge = null;
let recentProjectCompletion = null;
let recentProjectCompletionTimer = null;
let tasksStickyVisibilityCleanup = null;
const stickyDoneTaskAnchors = new Map();
const collapsedTaskTrees = new Set();
let taskComposerState = null;

function triggerProjectCompletionCue(task) {
  if (!task || !task.id) return;
  recentProjectCompletion = { taskId: task.id, until: Date.now() + 2600 };
  if (recentProjectCompletionTimer) clearTimeout(recentProjectCompletionTimer);
  recentProjectCompletionTimer = setTimeout(() => {
    if (!recentProjectCompletion) return;
    if (Date.now() >= recentProjectCompletion.until) {
      recentProjectCompletion = null;
      if (!$('#view-tasks').hidden) renderTasksPane();
    }
  }, 2700);
}

function saveTasksViewState() {
  const payload = {
    threadNodeId: tasksViewState.threadNodeId,
    currentContext: tasksViewState.currentContext,
    locationTags: tasksViewState.locationTags,
    durationMax: tasksViewState.durationMax,
    priorityValues: tasksViewState.priorityValues,
    focusTaskId: tasksViewState.focusTaskId,
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
  tasksViewState.threadNodeId = saved.threadNodeId || null;
  tasksViewState.currentContext = saved.currentContext || 'Any';
  tasksViewState.locationTags = uniqTags(saved.locationTags || []);
  tasksViewState.durationMax = normalizeDurationValue(saved.durationMax);
  tasksViewState.priorityValues = normalizePriorityList(saved.priorityValues || []);
  tasksViewState.focusTaskId = saved.focusTaskId || null;
  tasksViewState.showBlocked = !!saved.showBlocked;
  tasksViewState.searchText = (saved.searchText || '').trim();
  tasksViewState.archiveAfterDays = Number(saved.archiveAfterDays) > 0 ? Number(saved.archiveAfterDays) : 7;
  tasksViewState.showArchived = !!saved.showArchived;
  tasksViewState.sortBy = ['priority', 'due', 'path'].includes(saved.sortBy) ? saved.sortBy : 'priority';
  tasksViewState.groupBy = ['status', 'none'].includes(saved.groupBy) ? saved.groupBy : 'status';
  tasksViewState.compactMode = !!saved.compactMode;
}

function entryKey(ref) {
  return String(ref?.task?.id || '');
}

function applyStickyTaskPlacement(entries) {
  if (!Array.isArray(entries) || !entries.length || !stickyDoneTaskAnchors.size) return entries;
  const list = entries.slice();
  const moved = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const ref = list[i];
    if (!ref?.done) continue;
    if (!stickyDoneTaskAnchors.has(ref.task.id)) continue;
    moved.push({
      ref,
      anchor: Math.max(0, Number(stickyDoneTaskAnchors.get(ref.task.id)) || 0),
      idx: i,
    });
    list.splice(i, 1);
  }
  if (!moved.length) return entries;
  moved
    .sort((a, b) => (a.anchor - b.anchor) || (a.idx - b.idx))
    .forEach(({ ref, anchor }) => {
      const insertAt = Math.max(0, Math.min(list.length, anchor));
      list.splice(insertAt, 0, ref);
    });
  return list;
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

function quickCaptureTask(input, nodeId = null) {
  const opts = (typeof input === 'object' && input) ? input : null;
  const raw = normalizeTagValue(opts ? opts.text : input);
  if (!raw) return;
  const resolvedNodeId = opts ? opts.nodeId : nodeId;
  let node = resolvedNodeId ? findNodeById(store.data.threads, resolvedNodeId) : null;
  if (!node) node = ensureInboxNode();
  const task = createTask(raw);
  task.priority = clampPriority(opts?.priority ?? uiPrefs.capturePriority, 3);
  const chosenTagRaw = normalizeTagValue(opts?.tag ?? uiPrefs.captureTag);
  const chosenTag = chosenTagRaw === QUICK_CAPTURE_NEW_TAG ? '' : chosenTagRaw;
  if (chosenTag) setTaskLocations(task, [chosenTag]);
  node.tasks.push(task);
  uiPrefs.captureNodeId = node.id;
  uiPrefs.capturePriority = task.priority;
  uiPrefs.captureTag = chosenTag;
  quickCaptureJumpState = {
    taskId: task.id,
    text: task.text,
    nodeId: node.id,
    path: nodePath(node),
  };
  persistUiPrefs();
  persistSharedStateWithoutHistory();
  recomputeIndexes();
  renderThreads();
  renderQuickCaptureJumpLink();
  if (!$('#view-tasks').hidden) renderTasksPane();
  if (!$('#view-review').hidden) onReviewVisibility();
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
  const priority = $('#quick-capture-priority');
  if (priority) priority.value = String(clampPriority(uiPrefs.capturePriority, 3));
  refreshQuickCaptureTagOptions();
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
  });
  flattenTaskRefs().forEach((ref) => {
    const parentTrail = (ref.ancestors || []).map((task) => task.text).filter(Boolean);
    const hay = [
      ref.task.text,
      taskRefPath(ref),
      parentTrail.join(' '),
      (ref.task.contexts || []).join(' '),
      taskLocations(ref.task).join(' '),
    ].join(' ').toLowerCase();
    if (!hay.includes(q)) return;
    const metaParts = [taskRefPath(ref)];
    if (ref.depth > 0 && parentTrail.length) metaParts.push(parentTrail[parentTrail.length - 1]);
    out.push({
      kind: 'task',
      id: ref.task.id,
      nodeId: ref.node.id,
      title: ref.task.text,
      meta: metaParts.filter(Boolean).join(' • '),
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
        const node = findNodeById(store.data.threads || [], r.id);
        let cursor = node;
        while (cursor) {
          cursor.collapsed = false;
          const parentId = parentById.get(cursor.id);
          cursor = parentId ? nodeById.get(parentId) : null;
        }
        renderThreads();
        window.requestAnimationFrame(() => {
          const row = document.querySelector(`.node[data-id="${r.id}"]`);
          row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      } else {
        switchView('tasks');
        tasksViewState.focusTaskId = r.id;
        tasksViewState.searchText = '';
        tasksViewState.showBlocked = true;
        saveTasksViewState();
        renderTasksPane();
        window.requestAnimationFrame(() => {
          let target = null;
          try {
            if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
              target = document.querySelector(`.task[data-task-id="${CSS.escape(String(r.id))}"]`);
            }
          } catch {}
          if (!target) {
            target = Array.from(document.querySelectorAll('.task[data-task-id]')).find((row) => row.dataset?.taskId === String(r.id)) || null;
          }
          if (!target) return;
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('next-step-focus');
          setTimeout(() => target.classList.remove('next-step-focus'), 1800);
        });
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
  return entries;
}

function buildSeriesDisplayEntries(entries) {
  return entries || [];
}

function flushPendingSeriesRevealUi() {
  if (!pendingSeriesReveal) return;
  const keys = (pendingSeriesReveal.nextKeys || []).filter(Boolean);
  let target = null;
  for (const k of keys) {
    const node = document.querySelector(`#tasks-root [data-entry-key="${k}"]`);
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
  const card = target.classList.contains('task') ? target : target.closest('.task');
  if (card) {
    card.classList.add('next-step-focus');
    setTimeout(() => card.classList.remove('next-step-focus'), 1800);
  }
  target.classList.add('next-step-inline-focus');
  setTimeout(() => target.classList.remove('next-step-inline-focus'), 1800);
  const cb = target.querySelector('input[type="checkbox"]');
  cb?.focus({ preventScroll: true });
  if (pendingSeriesReveal.nextLabel) {
    showToast(`Next step unlocked: ${pendingSeriesReveal.nextLabel}`);
  } else {
    showToast('Next step unlocked');
  }
  pendingSeriesReveal = null;
}

function rerenderTasksPaneKeepViewport() {
  const prevY = window.scrollY;
  renderTasksPane();
  requestAnimationFrame(() => {
    const maxY = Math.max(0, (document.documentElement?.scrollHeight || 0) - window.innerHeight);
    const nextY = Math.max(0, Math.min(prevY, maxY));
    if (Math.abs(window.scrollY - nextY) > 1) window.scrollTo(0, nextY);
  });
}

function clearTasksStickyVisibilitySync() {
  if (typeof tasksStickyVisibilityCleanup === 'function') {
    tasksStickyVisibilityCleanup();
    tasksStickyVisibilityCleanup = null;
  }
}

function bindTasksStickyVisibility(stickyBar, filterPanel) {
  clearTasksStickyVisibilitySync();
  if (!stickyBar || !filterPanel) return;

  let raf = 0;
  const topOffset = () => {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--tasks-sticky-top');
    const px = Number.parseFloat(raw);
    return Number.isFinite(px) ? px : 72;
  };
  const sync = () => {
    const tasksView = $('#view-tasks');
    if (!tasksView || tasksView.hidden) {
      stickyBar.classList.remove('is-visible');
      stickyBar.classList.add('is-hidden');
      return;
    }
    const rect = filterPanel.getBoundingClientRect();
    const shouldShow = rect.bottom <= topOffset() + 6;
    stickyBar.classList.toggle('is-visible', shouldShow);
    stickyBar.classList.toggle('is-hidden', !shouldShow);
  };
  const queueSync = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      sync();
    });
  };

  window.addEventListener('scroll', queueSync, { passive: true });
  window.addEventListener('resize', queueSync);
  sync();
  tasksStickyVisibilityCleanup = () => {
    window.removeEventListener('scroll', queueSync);
    window.removeEventListener('resize', queueSync);
    if (raf) cancelAnimationFrame(raf);
  };
}

function renderTasksPane() {
  return renderTasksPaneV2();
  const root = $('#tasks-root');
  if (!root) {
    clearTasksStickyVisibilitySync();
    return;
  }
  clearTasksStickyVisibilitySync();
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
  const allTaskRefs = flattenTaskRefs();
  if (tasksViewState.threadNodeId && !nodeById.has(tasksViewState.threadNodeId)) {
    tasksViewState.threadNodeId = null;
    saveTasksViewState();
  }
  if (tasksViewState.focusTaskId && !allTaskRefs.some((r) => r.task.id === tasksViewState.focusTaskId)) {
    tasksViewState.focusTaskId = null;
    saveTasksViewState();
  }
  const threadNodeId = tasksViewState.threadNodeId || null;
  const threadFilterName = threadNodeId ? (nodeById.get(threadNodeId) ? nodePath(nodeById.get(threadNodeId)) : '') : '';
  const focusTaskId = tasksViewState.focusTaskId || null;
  const focusedTaskName = focusTaskId ? (depMap.get(focusTaskId)?.task?.text || 'Project') : '';
  const textNeedle = (tasksViewState.searchText || '').trim().toLowerCase();
  const followUpEntries = allTaskRefs
    .map((ref) => {
      const task = ref.task;
      if (!nodeInScope(ref.node, threadNodeId)) return null;
      if (!task || task.completed) return null;
      if (!tasksViewState.showArchived && task.archivedAt) return null;
      const waiting = !!(task.waitingOn && task.waitingOn.trim());
      const blockedByDeps = unresolvedDependencyIds(task, depMap).length > 0;
      if (!waiting && !blockedByDeps) return null;
      const follow = followUpStatus(task, now);
      if (follow.state !== 'overdue' && follow.state !== 'today') return null;
      return { ...ref, follow };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const fa = parseIsoDate(a.task.followUpAt)?.getTime() ?? Infinity;
      const fb = parseIsoDate(b.task.followUpAt)?.getTime() ?? Infinity;
      if (fa !== fb) return fa - fb;
      const pa = Number(a.task.priority) || 3;
      const pb = Number(b.task.priority) || 3;
      if (pa !== pb) return pa - pb;
      return nodePath(a.node).localeCompare(nodePath(b.node));
    });

  const allEntries = flattenTaskEntries();
  const baseFiltered = allEntries.filter((ref) => {
    const base = ref.task;
    const okThread = nodeInScope(ref.node, threadNodeId);
    const okCtx = passesContext(base, ctx);
    const okLoc = locSet.size === 0 || taskLocations(base).some(l => locSet.has(l.toLowerCase()));
    const dur = taskDurationMins(base);
    const okTime = !maxDur || (dur != null && dur <= maxDur);
    const okPriority = priSet.size === 0 || priSet.has(Number(base.priority || 3));
    const okFocus = !focusTaskId || base.id === focusTaskId;
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
    return okThread && okCtx && okLoc && okTime && okPriority && okFocus && okSearch && okArchived;
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
  for (const taskId of Array.from(stickyDoneTaskAnchors.keys())) {
    const stillDone = entries.some((e) => e.task?.id === taskId && e.done);
    if (!stillDone) stickyDoneTaskAnchors.delete(taskId);
  }
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
  let orderedEntries = entries.slice().sort(sorters[sortBy]);
  orderedEntries = applyPendingSeriesReveal(orderedEntries);
  orderedEntries = applyStickyTaskPlacement(orderedEntries);
  const orderIndexByKey = new Map(orderedEntries.map((entry, idx) => [entryKey(entry), idx]));
  entries = buildSeriesDisplayEntries(orderedEntries);
  const movingTaskIds = new Set(movingTaskEntries('tasks').map((entry) => entry.taskId));
  if (movingTaskIds.size) {
    entries = entries.filter((entry) => !movingTaskIds.has(entry.task.id));
  }
  const viewStats = {
    total: entries.length,
    ready: entries.filter(e => !e.done && e.available).length,
    blocked: entries.filter(e => !e.done && !e.available).length,
    done: entries.filter(e => e.done).length,
    urgent: entries.filter(e => !e.done && (e.due.state === 'overdue' || e.due.state === 'soon')).length,
  };
  const jumpToTaskCard = (taskId) => {
    if (!taskId) return false;
    const rawTaskId = String(taskId);
    let target = null;
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      try {
        target = root.querySelector(`.task[data-task-id="${CSS.escape(rawTaskId)}"]`);
      } catch {}
    }
    if (!target) {
      const rows = root.querySelectorAll('.task[data-task-id]');
      for (const row of rows) {
        if (row.dataset?.taskId === rawTaskId) {
          target = row;
          break;
        }
      }
    }
    if (!target) return false;
    if (!isElementOnScreen(target)) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('next-step-focus');
    setTimeout(() => target.classList.remove('next-step-focus'), 1800);
    const firstCb = target.querySelector('input[type="checkbox"]');
    firstCb?.focus({ preventScroll: true });
    return true;
  };

  const seenEstimateTasks = new Set();
  let estimateTaggedMins = 0;
  let estimateTaggedCount = 0;
  const completedProjects = entries.filter((e) => e.kind === 'series-flow' && e.done).length;
  const activeProjects = entries.filter((e) => e.kind === 'series-flow' && !e.done).length;
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
    const resetAllFilters = () => {
      tasksViewState.threadNodeId = null;
      tasksViewState.currentContext = 'Any';
      tasksViewState.locationTags = [];
      tasksViewState.durationMax = null;
      tasksViewState.priorityValues = [];
      tasksViewState.focusTaskId = null;
      tasksViewState.showBlocked = false;
      tasksViewState.searchText = '';
      tasksViewState.showArchived = false;
      tasksViewState.sortBy = 'priority';
      tasksViewState.groupBy = 'status';
      tasksViewState.compactMode = false;
      tasksViewState.selectionMode = false;
      selectedTaskKeys = new Set();
    };
    const activeLocs = uniqTags(tasksViewState.locationTags || []);
    const activePriorities = normalizePriorityList(tasksViewState.priorityValues || []);
    const currentMax = maxDur;
    const sortOptions = [
      ['priority', 'Priority'],
      ['due', 'Due'],
      ['path', 'Path'],
    ];
    const mkSortChip = (key, label) => {
      const active = tasksViewState.sortBy === key;
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}`, type: 'button' }, label);
      btn.addEventListener('click', () => {
        tasksViewState.sortBy = key;
        saveTasksViewState();
        renderTasksPane();
      });
      return btn;
    };

    const statusPanel = el('section', { class: 'tasks-status-panel' });
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
    const estimateLabel = formatDuration(estimateTaggedMins) || '0m';
    const metricsSummary = el('div', { class: 'tasks-summary' });
    metricsSummary.append(
      metric('Matching', viewStats.total),
      metric('Ready', viewStats.ready, 'good'),
      metric('Blocked', viewStats.blocked, viewStats.blocked ? 'warn' : ''),
      metric('Urgent', viewStats.urgent, viewStats.urgent ? 'warn' : ''),
      metric('Active Projects', activeProjects),
      metric('Projects Done', completedProjects, completedProjects ? 'good' : ''),
      metric('Est. Time', estimateLabel, estimateTaggedCount ? 'good' : ''),
      metric('Done', viewStats.done),
    );
    scorePanel.append(scoreHead, scoreSub, scoreBar, metricsSummary);
    statusPanel.append(scorePanel);

    if (projectNudge && projectNudge.taskId) {
      const nudge = el('div', { class: 'project-nudge' });
      const text = el('div', { class: 'project-nudge-text' }, `Progress made on ${projectNudge.taskText || 'project'} • ${projectNudge.nextLabel || 'Next step unlocked'}`);
      const row = el('div', { class: 'project-nudge-actions' });
      const open = el('button', { class: 'btn primary', type: 'button' }, 'Jump to Project');
      open.addEventListener('click', () => {
        const taskId = projectNudge.taskId;
        projectNudge = null;
        nudge.remove();
        if (!jumpToTaskCard(taskId)) renderTasksPane();
      });
      const dismiss = el('button', { class: 'btn ghost', type: 'button' }, 'Dismiss');
      dismiss.addEventListener('click', () => {
        projectNudge = null;
        renderTasksPane();
      });
      row.append(open, dismiss);
      nudge.append(text, row);
      statusPanel.append(nudge);
    }
    controls.append(statusPanel);

    const filterPanel = el('section', { class: 'tasks-filter-panel' });
    const primaryFilters = el('div', { class: 'tasks-primary-filters' });

    const searchRow = el('div', { class: 'filter-row' });
    const searchInput = el('input', { type: 'search', placeholder: 'Search within tasks...' });
    searchInput.value = tasksViewState.searchText || '';
    searchInput.addEventListener('input', () => {
      tasksViewState.searchText = searchInput.value;
      saveTasksViewState();
      renderTasksPane();
    });
    searchRow.append(searchInput);
    primaryFilters.append(buildGroup('Search', searchRow));

    const sortRow = el('div', { class: 'filter-row' });
    sortOptions.forEach(([key, label]) => sortRow.append(mkSortChip(key, label)));
    primaryFilters.append(buildGroup('Sort', sortRow));

    const activeFilters = [];
    const addActiveFilter = (label, onClear) => {
      activeFilters.push({ label, onClear });
    };
    if (textNeedle) addActiveFilter(`Search: ${tasksViewState.searchText}`, () => { tasksViewState.searchText = ''; });
    if (threadNodeId && threadFilterName) addActiveFilter(`Thread: ${threadFilterName}`, () => { tasksViewState.threadNodeId = null; });
    if (ctx) addActiveFilter(`Context: ${ctx}`, () => { tasksViewState.currentContext = 'Any'; });
    if (focusTaskId) addActiveFilter(`Project: ${focusedTaskName}`, () => { tasksViewState.focusTaskId = null; });
    activePriorities.forEach((p) => {
      addActiveFilter(`Priority: P${p}`, () => {
        tasksViewState.priorityValues = normalizePriorityList((tasksViewState.priorityValues || []).filter((x) => Number(x) !== Number(p)));
      });
    });
    activeLocs.forEach((loc) => {
      addActiveFilter(`Loc: ${loc}`, () => {
        tasksViewState.locationTags = uniqTags((tasksViewState.locationTags || []).filter((x) => x.toLowerCase() !== loc.toLowerCase()));
      });
    });
    if (currentMax) addActiveFilter(`Time <= ${formatDuration(currentMax)}`, () => { tasksViewState.durationMax = null; });
    if (tasksViewState.showBlocked) addActiveFilter('Blocked shown', () => { tasksViewState.showBlocked = false; });
    if (tasksViewState.showArchived) addActiveFilter('Archived shown', () => { tasksViewState.showArchived = false; });
    if (tasksViewState.sortBy !== 'priority') addActiveFilter(`Sort: ${tasksViewState.sortBy}`, () => { tasksViewState.sortBy = 'priority'; });
    if (tasksViewState.groupBy !== 'status') addActiveFilter('Flat list', () => { tasksViewState.groupBy = 'status'; });
    if (tasksViewState.compactMode) addActiveFilter('Compact', () => { tasksViewState.compactMode = false; });
    if (tasksViewState.selectionMode) addActiveFilter('Selection mode', () => {
      tasksViewState.selectionMode = false;
      selectedTaskKeys = new Set();
    });
    const buildActiveFilterChip = (entry, cls = 'chip toggle active') => {
      const chip = el('button', { class: cls, type: 'button' }, entry.label);
      chip.addEventListener('click', () => {
        entry.onClear();
        saveTasksViewState();
        renderTasksPane();
      });
      return chip;
    };
    const activeWrap = el('div', { class: 'filter-row active-filters' });
    if (activeFilters.length) {
      activeFilters.forEach((entry) => activeWrap.append(buildActiveFilterChip(entry)));
    } else {
      activeWrap.append(el('span', { class: 'subtext' }, 'No active filters'));
    }
    const reset = el('button', { class: 'btn ghost', type: 'button' }, 'Reset Filters');
    reset.disabled = !activeFilters.length;
    reset.addEventListener('click', () => {
      resetAllFilters();
      saveTasksViewState();
      renderTasksPane();
    });
    const activeRow = el('div', { class: 'filter-row active-filter-row' });
    activeRow.append(activeWrap, reset);
    primaryFilters.append(buildGroup('Active Filters', activeRow));
    filterPanel.append(primaryFilters);

    const advancedActiveCount = (threadNodeId ? 1 : 0)
      + (ctx ? 1 : 0)
      + (focusTaskId ? 1 : 0)
      + activePriorities.length
      + activeLocs.length
      + (currentMax ? 1 : 0)
      + (tasksViewState.showBlocked ? 1 : 0)
      + (tasksViewState.showArchived ? 1 : 0)
      + (tasksViewState.groupBy !== 'status' ? 1 : 0)
      + (tasksViewState.compactMode ? 1 : 0)
      + (tasksViewState.selectionMode ? 1 : 0);

    const moreFilters = el('details', { class: 'tasks-more-filters' });
    const moreLabel = advancedActiveCount ? `More filters (${advancedActiveCount} active)` : 'More filters';
    const moreSummary = el('summary', {}, moreLabel);
    const moreBody = el('div', { class: 'tasks-more-filters-body' });
    moreFilters.append(moreSummary, moreBody);

    const threadRow = el('div', { class: 'filter-row' });
    const threadSel = el('select', { class: 'select-sm task-thread-filter-select', 'aria-label': 'Filter by thread' });
    threadSel.append(el('option', { value: '' }, 'Any thread'));
    const threadOptions = allThreadNodes().filter(isNodePathEnabled);
    threadOptions.forEach((threadNode) => {
      threadSel.append(el('option', { value: threadNode.id }, nodePath(threadNode)));
    });
    threadSel.value = threadNodeId && threadOptions.some((n) => n.id === threadNodeId) ? threadNodeId : '';
    threadSel.addEventListener('change', () => {
      tasksViewState.threadNodeId = threadSel.value || null;
      saveTasksViewState();
      renderTasksPane();
    });
    threadRow.append(threadSel);
    moreBody.append(buildGroup('Thread', threadRow));

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
      moreBody.append(buildGroup('Context', ctxRow));
    }

    const priRow = el('div', { class: 'filter-row' });
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
    moreBody.append(buildGroup('Priority', priRow));

    const locRow = el('div', { class: 'filter-row' });
    const activeLocSet = new Set(activeLocs.map((l) => l.toLowerCase()));
    const locAny = el('button', { class: `chip toggle${activeLocs.length ? '' : ' active'}` }, 'Any');
    locAny.addEventListener('click', () => {
      tasksViewState.locationTags = [];
      saveTasksViewState();
      renderTasksPane();
    });
    locRow.append(locAny);
    for (const loc of allLocations()) {
      const active = activeLocSet.has(loc.toLowerCase());
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}` }, loc);
      btn.addEventListener('click', () => {
        const next = uniqTags(activeLocs);
        const idx = next.findIndex((x) => x.toLowerCase() === loc.toLowerCase());
        if (idx >= 0) next.splice(idx, 1);
        else next.push(loc);
        tasksViewState.locationTags = next;
        saveTasksViewState();
        renderTasksPane();
      });
      locRow.append(btn);
    }
    moreBody.append(buildGroup('Location', locRow));

    const timeRow = el('div', { class: 'filter-row' });
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
    moreBody.append(buildGroup('Time ≤', timeRow));

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
    moreBody.append(buildGroup('Display', displayRow));

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
    moreBody.append(buildGroup('Options', optRow));

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
          const idx = orderIndexByKey.get(k);
          if (typeof idx === 'number') stickyDoneTaskAnchors.set(ref.task.id, idx);
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
        rerenderTasksPaneKeepViewport();
        showToast('Tags updated');
      });
      const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
      delBtn.addEventListener('click', () => {
        const map = selectionEntries();
        selectedTaskKeys.forEach((k) => {
          const ref = map.get(k);
          if (!ref) return;
          if (ref.kind === 'subtask') ref.task.series = (ref.task.series || []).filter((s) => s.id !== ref.subtask.id);
          else ref.node.tasks = (ref.node.tasks || []).filter((x) => x.id !== ref.task.id);
        });
        selectedTaskKeys = new Set();
        store.saveNow();
        renderTasksPane();
        renderThreads();
        showToast('Selected items removed');
      });
      bulkRow.append(doneBtn, priSel, priBtn, locInput, locBtn, delBtn);
    }
    moreBody.append(buildGroup('Selection', bulkRow));
    filterPanel.append(moreFilters);

    const stickyBar = el('div', { class: 'tasks-sticky-controls is-hidden' });
    const stickySearch = el('input', { type: 'search', placeholder: 'Search within tasks...', 'aria-label': 'Search within tasks' });
    stickySearch.value = tasksViewState.searchText || '';
    stickySearch.addEventListener('input', () => {
      tasksViewState.searchText = stickySearch.value;
      saveTasksViewState();
      renderTasksPane();
    });
    const stickyActive = el('div', { class: 'tasks-sticky-active' });
    if (activeFilters.length) {
      activeFilters.slice(0, 3).forEach((entry) => stickyActive.append(buildActiveFilterChip(entry, 'chip toggle active sticky-chip')));
      if (activeFilters.length > 3) stickyActive.append(el('span', { class: 'pill tag' }, `+${activeFilters.length - 3} more`));
    } else {
      stickyActive.append(el('span', { class: 'subtext' }, 'No active filters'));
    }
    const stickyTools = el('div', { class: 'tasks-sticky-tools' });
    const stickySort = el('select', { class: 'select-sm', 'aria-label': 'Sort tasks' });
    sortOptions.forEach(([key, label]) => stickySort.append(el('option', { value: key }, label)));
    stickySort.value = tasksViewState.sortBy || 'priority';
    stickySort.addEventListener('change', () => {
      tasksViewState.sortBy = stickySort.value;
      saveTasksViewState();
      renderTasksPane();
    });
    const moreBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, advancedActiveCount ? `Filters (${advancedActiveCount})` : 'Filters');
    moreBtn.addEventListener('click', () => {
      moreFilters.open = !moreFilters.open;
      if (moreFilters.open) moreFilters.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    stickyTools.append(stickySort, moreBtn);
    if (activeFilters.length) {
      const resetMini = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Reset');
      resetMini.addEventListener('click', () => {
        resetAllFilters();
        saveTasksViewState();
        renderTasksPane();
      });
      stickyTools.append(resetMini);
    }
    stickyBar.append(stickySearch, stickyActive, stickyTools);

    controls.append(filterPanel, stickyBar);
    bindTasksStickyVisibility(stickyBar, filterPanel);
  }
  const applyFollowUpMutation = (ref, updater) => {
    updater(ref.task);
    store.saveNow();
    renderThreads();
    if (!$('#review-stage').hidden) {
      renderProgress();
      renderStoryCard();
    }
    rerenderTasksPaneKeepViewport();
  };
  const makeFollowUpCard = (ref) => {
    const { task: t, node: n, root: r } = ref;
    const follow = followUpStatus(t, now);
    const item = el('div', {
      class: `task followup-task${follow.state === 'overdue' ? ' due-overdue' : ''}`,
      style: `border-left:6px solid ${r?.color || 'var(--accent)'}`,
      'data-task-id': t.id,
    });
    const pin = el('div');
    pin.append(el('span', { class: `pill ${follow.state === 'overdue' ? 'warn' : 'tag'}` }, follow.label || 'Follow up'));
    const main = el('div', { class: 'task-main' });
    const title = el('div', { class: 'task-title' }, t.text || 'Untitled task');
    const reason = availabilityReason(t, now, null, depMap);
    const path = nodePath(n);
    const contextLine = reason ? `${path} • ${reason}` : path;
    main.append(title, el('div', { class: 'ctx' }, contextLine));
    const actions = el('div', { class: 'meta task-actions followup-actions' });
    const nudgeBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Nudged today');
    nudgeBtn.addEventListener('click', () => {
      applyFollowUpMutation(ref, (task) => nudgeFollowUp(task, 2, now));
      showToast('Follow-up nudged +2 days');
    });
    const clearWaitBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Clear waiting');
    clearWaitBtn.disabled = !(t.waitingOn && t.waitingOn.trim());
    clearWaitBtn.addEventListener('click', () => {
      applyFollowUpMutation(ref, (task) => { task.waitingOn = ''; });
      showToast('Waiting note cleared');
    });
    const snoozeBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Snooze');
    snoozeBtn.addEventListener('click', () => {
      applyFollowUpMutation(ref, (task) => snoozeFollowUp(task, now));
      showToast('Follow-up snoozed');
    });
    const threadSel = buildTaskThreadSelect(n.id, t, 'tasks', () => {
      renderThreads();
      if (!$('#view-review').hidden) onReviewVisibility();
      renderTasksPane();
    });
    const openBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Open task');
    openBtn.addEventListener('click', () => {
      tasksViewState.focusTaskId = t.id;
      tasksViewState.showBlocked = true;
      saveTasksViewState();
      renderTasksPane();
    });
    actions.append(nudgeBtn, clearWaitBtn, snoozeBtn, threadSel, openBtn);
    item.append(pin, main, actions);
    return item;
  };

  if (followUpEntries.length) {
    const followSection = el('section', { class: 'task-section task-section-followups' });
    const head = el('div', { class: 'task-section-head' });
    head.append(el('h3', {}, 'Follow-Ups Due'));
    head.append(el('span', { class: 'pill warn' }, `${followUpEntries.length}`));
    followSection.append(head);
    followUpEntries.forEach((entry) => followSection.append(makeFollowUpCard(entry)));
    root.append(followSection);
  }

  const movingEntries = movingTaskEntries('tasks');
  if (movingEntries.length) {
    const movingSection = el('section', { class: 'task-section task-section-moving' });
    const head = el('div', { class: 'task-section-head' });
    head.append(el('h3', {}, 'Moving Tasks'));
    head.append(el('span', { class: 'pill warn' }, `${movingEntries.length}`));
    movingSection.append(head);
    movingEntries.forEach((entry) => {
      movingSection.append(buildMovingTaskNotice(entry));
    });
    root.append(movingSection);
  }
  if (!entries.length && !movingEntries.length && !followUpEntries.length) {
    const msg = stats.total ? 'No tasks in the current view.' : 'No tasks match the current filters.';
    root.append(el('div', { class: 'empty' }, msg));
    pendingSeriesReveal = null;
    return;
  }
  if (!entries.length) {
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
      'data-task-id': t.id,
    });
    const applyTaskCardMutation = (updater, options = {}) => {
      updater(t);
      store.saveNow();
      if (options.renderThreads) renderThreads();
      if (!$('#review-stage').hidden) {
        renderProgress();
        renderStoryCard();
      }
      rerenderTasksPaneKeepViewport();
    };
    if (ref.kind === 'series-flow') {
      item.classList.add('series-flow-card');
      if (ref.due.state === 'overdue') item.classList.add('due-overdue');
      else if (ref.due.state === 'soon') item.classList.add('due-soon');
      if (ref.archivedAt) item.classList.add('archived');

      const stats = ref.series || seriesStats(t) || { total: 0, done: 0, remaining: 0, maxRank: 0, activeRank: null, activeItems: [] };
      const allStepsDone = stats.remaining === 0;
      const isProjectDone = !!t.completed;
      const celebrating = isProjectDone && recentProjectCompletion && recentProjectCompletion.taskId === t.id && Date.now() < recentProjectCompletion.until;
      const completedAt = parseIsoDate(t.completedAt);
      const orderedSeries = (t.series || []).slice().sort((a, b) => {
        const ra = Math.max(1, Number(a.rank) || 1);
        const rb = Math.max(1, Number(b.rank) || 1);
        if (ra !== rb) return ra - rb;
        const oa = Number.isFinite(a.order) ? Number(a.order) : 0;
        const ob = Number.isFinite(b.order) ? Number(b.order) : 0;
        return oa - ob;
      });
      const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
      const activeRank = stats.activeRank || stats.maxRank || 1;
      const currentGroup = (t.series || []).filter((s) => Math.max(1, Number(s.rank) || 1) === activeRank);
      const activeCount = (ref.activeSubtasks || []).length;
      const groupDone = currentGroup.filter((s) => !!s.completed).length;
      if (isProjectDone) item.classList.add('series-flow-complete');
      if (celebrating) item.classList.add('series-flow-celebrate');

      const head = el('div', { class: 'series-flow-head' });
      const titleWrap = el('div', { class: 'series-flow-title-wrap' });
      const title = el('textarea', { class: 'task-title-input series-flow-title', rows: '1' });
      initTaskTextInput(title);
      title.value = t.text;
      title.addEventListener('change', () => {
        const v = title.value.trim();
        if (!v) { title.value = t.text; return; }
        t.text = v;
        store.saveNow();
        renderThreads();
      });
      titleWrap.append(title);
      const completeStamp = completedAt ? ` • ${completedAt.toLocaleString()}` : '';
      const metaText = isProjectDone
        ? `Project complete • ${stats.total} steps finished${completeStamp}`
        : (allStepsDone
          ? `All listed steps complete • ${stats.done}/${stats.total} done`
          : `Step ${activeRank}/${Math.max(1, stats.maxRank || 1)} • ${stats.done}/${stats.total} done • ${pct}%`);
      const meta = el('div', { class: 'series-flow-meta' }, metaText);
      head.append(titleWrap, meta);

      const progress = el('div', { class: 'series-flow-progress' });
      const fill = el('div', { class: 'fill' });
      fill.style.width = `${pct}%`;
      progress.append(fill);

      const nextBlock = el('div', { class: isProjectDone ? 'series-complete-block' : 'series-do-next' });
      if (isProjectDone) {
        const doneHead = el('div', { class: 'series-complete-head' });
        doneHead.append(el('strong', {}, 'Project Completed'));
        doneHead.append(el('span', { class: 'subtext' }, `${stats.total} steps finished`));
        nextBlock.append(doneHead);
      } else {
        const nextHead = el('div', { class: 'series-do-next-head' });
        if (allStepsDone) {
          nextHead.append(el('span', { class: 'subtext' }, `Ready to close • ${stats.done}/${stats.total} listed steps complete`));
        } else {
          nextHead.append(el('span', { class: 'subtext' }, `Do Next • Step ${activeRank} (${groupDone}/${Math.max(1, currentGroup.length)} complete)`));
          if (activeCount > 1) nextHead.append(el('span', { class: 'pill tag' }, `${activeCount} parallel`));
        }
        nextBlock.append(nextHead);
      }

      const nextList = el('div', { class: 'series-next-list' });
      const activeSubtasks = ref.activeSubtasks || [];
      if (isProjectDone) {
        const preview = orderedSeries.slice(0, 6);
        preview.forEach((s) => {
          const rank = Math.max(1, Number(s.rank) || 1);
          nextList.append(el('span', { class: 'series-completed-chip' }, `Step ${rank} • ${s.text || 'Step'} ✓`));
        });
        if (orderedSeries.length > preview.length) {
          nextList.append(el('span', { class: 'series-completed-chip' }, `+${orderedSeries.length - preview.length} more`));
        }
      } else if (allStepsDone) {
        nextList.append(el('div', { class: 'subtext series-next-empty-note' }, 'Mark project done when fully complete.'));
      } else if (!activeSubtasks.length) {
        nextList.append(el('div', { class: 'subtext series-next-empty-note' }, 'No active steps.'));
      } else {
        activeSubtasks.forEach((s) => {
          const rowKey = `subtask:${t.id}:${s.id}`;
          const row = el('div', { class: 'series-next-row', 'data-entry-key': rowKey });
          const cb = el('input', { type: 'checkbox' });
          cb.checked = !!s.completed;
          cb.addEventListener('change', () => {
            const wasDone = !!s.completed;
            setSubtaskCompleted(t, s, cb.checked);
            if (!wasDone && cb.checked) {
              const statsAfter = seriesStats(t);
              const nextItems = (statsAfter?.activeItems || []).filter((x) => !x.completed);
              const nextKeys = nextItems.map((x) => `subtask:${t.id}:${x.id}`);
              if (nextKeys.length) {
                const nextLabel = nextItems.length === 1 ? (nextItems[0].text || 'Next step') : `${nextItems.length} steps unlocked`;
                pendingSeriesReveal = {
                  fromIndex: orderIndexByKey.get(rowKey) ?? 0,
                  nextKeys,
                  nextLabel,
                };
                projectNudge = {
                  taskId: t.id,
                  taskText: t.text,
                  nextLabel,
                };
              } else {
                pendingSeriesReveal = null;
                projectNudge = null;
                showToast(`All listed steps done for: ${t.text}`);
              }
            } else {
              pendingSeriesReveal = null;
            }
            store.saveNow();
            renderTasksPane();
          });
          const text = el('textarea', { class: 'task-title-input series-next-text', rows: '1' });
          initTaskTextInput(text);
          text.value = s.text || '';
          text.addEventListener('change', () => {
            const v = text.value.trim();
            if (!v) { text.value = s.text || ''; return; }
            s.text = v;
            store.saveNow();
            renderThreads();
          });
          row.append(cb, el('span', { class: 'pill step' }, `Step ${Math.max(1, Number(s.rank) || 1)}`), text);
          nextList.append(row);
        });
      }
      nextBlock.append(nextList);

      const recent = el('div', { class: 'series-completed-strip' });
      const recentItems = ref.recentlyCompleted || [];
      if (recentItems.length) {
        recent.append(el('span', { class: 'subtext' }, 'Just Completed'));
        recentItems.forEach((s) => {
          recent.append(el('span', { class: 'series-completed-chip' }, `${s.text || 'Step'} ✓`));
        });
      }

      const actions = el('div', { class: 'series-actions-wrap' });
      const primaryActions = el('div', { class: 'meta task-actions series-actions-inline series-actions-primary' });
      const secondaryActions = el('div', { class: 'meta task-actions card-task-actions series-actions-inline series-actions-secondary' });
      const applyDoneState = (checked) => {
        if (checked) stickyDoneTaskAnchors.set(t.id, orderIndexByKey.get(key) ?? 0);
        else stickyDoneTaskAnchors.delete(t.id);
        applyTaskCardMutation((task) => {
          const wasDone = !!task.completed;
          setTaskCompleted(task, checked);
          if (!wasDone && task.completed) triggerProjectCompletionCue(task);
        }, { renderThreads: true });
      };
      const reopenLastCompletedStep = () => {
        applyTaskCardMutation((task) => {
          const list = (task.series || []).slice().sort((a, b) => {
            const ra = Math.max(1, Number(a.rank) || 1);
            const rb = Math.max(1, Number(b.rank) || 1);
            if (ra !== rb) return rb - ra;
            const oa = Number.isFinite(a.order) ? Number(a.order) : 0;
            const ob = Number.isFinite(b.order) ? Number(b.order) : 0;
            return ob - oa;
          });
          const latestDone = list.find((s) => !!s.completed);
          if (!latestDone) return;
          setSubtaskCompleted(task, latestDone, false);
        }, { renderThreads: true });
      };
      if (!isProjectDone) {
        if (allStepsDone) {
          const doneBtn = el('button', { class: 'btn primary', type: 'button' }, 'Mark Project Done');
          doneBtn.addEventListener('click', () => {
            applyDoneState(true);
          });
          const reopenPrep = el('button', { class: 'btn ghost', type: 'button' }, 'Reopen Last Step');
          reopenPrep.addEventListener('click', reopenLastCompletedStep);
          primaryActions.append(doneBtn, reopenPrep);
        } else {
          const startBtn = el('button', { class: 'btn primary', type: 'button' }, 'Start Next Step');
          startBtn.addEventListener('click', () => {
            const firstRow = nextList.querySelector('.series-next-row');
            const firstCb = firstRow?.querySelector('input[type="checkbox"]');
            firstCb?.focus();
            if (firstRow && !isElementOnScreen(firstRow)) firstRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
          });
          if (!activeSubtasks.length) startBtn.disabled = true;
          primaryActions.append(startBtn);
          if (stats.done > 0) {
            const reopenRecent = el('button', { class: 'btn ghost', type: 'button' }, 'Reopen Last Step');
            reopenRecent.addEventListener('click', reopenLastCompletedStep);
            primaryActions.append(reopenRecent);
          }
        }
      } else {
        const archiveNow = el('button', { class: 'btn primary', type: 'button' }, 'Archive Now');
        archiveNow.addEventListener('click', () => {
          applyTaskCardMutation((task) => {
            task.archivedAt = nowIso();
          }, { renderThreads: true });
        });
        const reopen = el('button', { class: 'btn ghost', type: 'button' }, 'Reopen Last Step');
        reopen.addEventListener('click', reopenLastCompletedStep);
        const markOpen = el('button', { class: 'btn ghost', type: 'button' }, 'Mark Project Open');
        markOpen.addEventListener('click', () => {
          applyDoneState(false);
        });
        primaryActions.append(archiveNow, reopen, markOpen);
      }
      const pri = el('select', { class: 'priority-select', title: 'Priority' });
      for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
      pri.value = String(t.priority || 3);
      pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderTasksPane(); });
      const threadSel = buildTaskThreadSelect(n.id, t, 'tasks', () => {
        renderThreads();
        if (!$('#view-review').hidden) onReviewVisibility();
        renderTasksPane();
      });
      const avail = buildAvailabilityControls(n.id, t.id, () => rerenderTasksPaneKeepViewport());
      avail.hidden = !isTagPanelOpen('tasks', t.id);
      const availBtn = el('button', { class: 'btn ghost btn-lite' }, 'Tags');
      availBtn.addEventListener('click', () => {
        avail.hidden = !avail.hidden;
        setTagPanelOpen('tasks', t.id, !avail.hidden);
      });
      const del = el('button', { class: 'btn ghost danger' }, 'Remove');
      del.addEventListener('click', () => {
        n.tasks = n.tasks.filter((x) => x.id !== t.id);
        if (tasksViewState.focusTaskId === t.id) tasksViewState.focusTaskId = null;
        store.saveNow();
        renderTasksPane();
        renderThreads();
        renderProgress();
        if (!$('#review-stage').hidden) renderStoryCard();
      });
      secondaryActions.append(pri, threadSel, availBtn, del);
      actions.append(primaryActions, secondaryActions);

      const contextLine = nodePath(n) + (ref.reason ? ` • ${ref.reason}` : '');
      const ctxEl = el('div', { class: 'ctx' }, contextLine);
      const stateBadges = buildTaskStateBadges(t, { now, depMap, done: ref.done });
      const metaRow = buildTaskMetaRow(t, {
        variant: 'compact',
        includePriority: false,
        quickEdit: {
          onDurationCycle: () => {
            applyTaskCardMutation((task) => {
              cycleTaskDuration(task);
            }, { renderThreads: true });
          },
          onLocationCycle: () => {
            applyTaskCardMutation((task) => {
              cycleTaskPresetLocation(task);
            }, { renderThreads: true });
          },
        },
      });
      const tagline = buildTaskTagline(t, '', {
        includeSeries: false,
        showLocation: false,
        showDuration: false,
      });
      item.append(head, progress, nextBlock, stateBadges, metaRow, ctxEl);
      if (recentItems.length) item.append(recent);
      if (tagline) item.append(tagline);
      item.append(actions, avail);
      if (ref.done) item.classList.add('status-completed');
      else if (ref.available) item.classList.add('status-available');
      else item.classList.add('status-blocked');
      return item;
    }

    if (ref.due.state === 'overdue') item.classList.add('due-overdue');
    else if (ref.due.state === 'soon') item.classList.add('due-soon');
    if (ref.archivedAt) item.classList.add('archived');
    item.classList.add('tasks-pane-card');
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
            projectNudge = {
              taskId: t.id,
              taskText: t.text,
              nextLabel,
            };
          } else {
            pendingSeriesReveal = null;
            projectNudge = null;
            showToast(`All listed steps done for: ${t.text}`);
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
        if (cb.checked) stickyDoneTaskAnchors.set(t.id, orderIndexByKey.get(key) ?? 0);
        else stickyDoneTaskAnchors.delete(t.id);
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
    const titleInput = el('textarea', { class: 'task-title-input', rows: '1' });
    initTaskTextInput(titleInput);
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
    titleRow.append(titleInput);
    main.append(titleRow);
    const ctxLine = nodePath(n) + (ref.reason ? ` • ${ref.reason}` : '');
    main.append(el('div', { class: 'ctx' }, ctxLine));
    const metaRow = buildTaskMetaRow(t, {
      variant: 'compact',
      includePriority: false,
      quickEdit: {
        onDurationCycle: () => {
          applyTaskCardMutation((task) => {
            cycleTaskDuration(task);
          }, { renderThreads: true });
        },
        onLocationCycle: () => {
          applyTaskCardMutation((task) => {
            cycleTaskPresetLocation(task);
          }, { renderThreads: true });
        },
      },
    });
    main.append(metaRow);
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
    const tagline = buildTaskTagline(t, '', {
      includeSeries: !sub,
      showLocation: false,
      showDuration: false,
    });
    if (tagline) main.append(tagline);
    main.append(buildTaskStateBadges(t, { now, depMap, done: ref.done }));
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
        rerenderTasksPaneKeepViewport();
        showToast('Series started');
        return true;
      });
      main.append(breakdown);
    }
    const actions = el('div', { class: 'meta task-actions card-task-actions' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderTasksPane(); });
    const threadSel = buildTaskThreadSelect(n.id, t, 'tasks', () => {
      renderThreads();
      if (!$('#view-review').hidden) onReviewVisibility();
      renderTasksPane();
    });
    const del = createInlineIconAction('Remove task', () => {
      if (sub) {
        t.series = (t.series || []).filter(x => x.id !== sub.id);
        store.saveNow(); renderTasksPane();
      } else {
        n.tasks = n.tasks.filter(x => x.id !== t.id);
        store.saveNow(); renderTasksPane(); renderThreads(); renderProgress(); if (!$('#review-stage').hidden) renderStoryCard();
      }
    }, '✕', 'danger');
    const avail = buildAvailabilityControls(n.id, t.id, () => rerenderTasksPaneKeepViewport());
    avail.hidden = !isTagPanelOpen('tasks', t.id);
    const availBtn = el('button', { class: 'btn ghost btn-lite' }, 'Tags');
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
    actions.append(pri, threadSel, availBtn, del);
    const headline = el('div', { class: 'task-card-headline' });
    headline.append(cb, main);
    const controls = el('div', { class: 'task-card-controls tasks-pane-controls' });
    controls.append(actions);
    item.append(headline, controls);
    // Status tint classes
    if (ref.done) item.classList.add('status-completed');
    else if (ref.available) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    // Availability controls in Tasks pane (hidden by default)
    item.append(avail);
    return item;
  };

  if (tasksViewState.groupBy === 'status') {
    const isStickyDoneEntry = (entry) => !!entry?.done && stickyDoneTaskAnchors.has(entry.task?.id);
    const openItems = entries.filter((e) => !e.done || isStickyDoneEntry(e));
    const stickyOpenCount = openItems.filter((e) => isStickyDoneEntry(e)).length;
    const openLabel = (tasksViewState.showBlocked || stickyOpenCount) ? 'Open Tasks' : 'Ready Now';
    const groups = [
      { key: 'ready', label: openLabel, items: openItems },
      { key: 'done-projects', label: 'Completed Projects', items: entries.filter((e) => e.done && e.kind === 'series-flow' && !isStickyDoneEntry(e)) },
      { key: 'done', label: 'Completed Tasks', items: entries.filter((e) => e.done && e.kind !== 'series-flow' && !isStickyDoneEntry(e)) },
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

function renderTasksPaneV2() {
  const root = $('#tasks-root');
  if (!root) {
    clearTasksStickyVisibilitySync();
    return;
  }
  clearTasksStickyVisibilitySync();
  root.innerHTML = '';
  root.classList.toggle('tasks-compact', !!tasksViewState.compactMode);

  const now = new Date();
  const changedRecurring = runRecurringTasks(now);
  const changedArchive = applyArchivingRules(tasksViewState.archiveAfterDays, now);
  if (changedRecurring || changedArchive) store.saveNow();

  const depMap = allTaskRefMap();
  const ctx = tasksViewState.currentContext === 'Any' ? null : tasksViewState.currentContext;
  const locSet = new Set(uniqTags(tasksViewState.locationTags || []).map((tag) => tag.toLowerCase()));
  const maxDur = normalizeDurationValue(tasksViewState.durationMax);
  const priSet = new Set(normalizePriorityList(tasksViewState.priorityValues || []));
  const textNeedle = (tasksViewState.searchText || '').trim().toLowerCase();
  const allTaskRefs = flattenTaskRefs();

  if (tasksViewState.threadNodeId && !nodeById.has(tasksViewState.threadNodeId)) {
    tasksViewState.threadNodeId = null;
    saveTasksViewState();
  }
  if (tasksViewState.focusTaskId && !allTaskRefs.some((ref) => ref.task.id === tasksViewState.focusTaskId)) {
    tasksViewState.focusTaskId = null;
    saveTasksViewState();
  }

  const threadNodeId = tasksViewState.threadNodeId || null;
  const focusTaskId = tasksViewState.focusTaskId || null;
  const refById = new Map(allTaskRefs.map((ref) => [ref.task.id, ref]));
  const focusedTaskName = focusTaskId ? (refById.get(focusTaskId)?.task?.text || 'Task') : '';
  const metaById = new Map();

  allTaskRefs.forEach((ref) => {
    const task = ref.task;
    const done = !!task.completed;
    metaById.set(task.id, {
      done,
      available: done ? true : isTaskAvailable(ref, now, ctx, depMap),
      reason: availabilityReason(ref, now, ctx, depMap),
      due: dueStatus(task, now),
      archivedAt: task.archivedAt || null,
    });
  });

  const matchesDirect = (ref) => {
    const task = ref.task;
    const meta = metaById.get(task.id);
    const focusScope = !focusTaskId || task.id === focusTaskId || ref.ancestors.some((ancestor) => ancestor.id === focusTaskId);
    const okThread = nodeInScope(ref.node, threadNodeId);
    const okCtx = passesContext(task, ctx);
    const okLoc = locSet.size === 0 || taskLocations(task).some((tag) => locSet.has(tag.toLowerCase()));
    const dur = taskDurationMins(task);
    const okTime = !maxDur || (dur != null && dur <= maxDur);
    const okPriority = priSet.size === 0 || priSet.has(Number(task.priority || 3));
    const okArchived = tasksViewState.showArchived ? true : !task.archivedAt;
    const hay = [
      task.text,
      taskRefPath(ref),
      (ref.ancestors || []).map((ancestor) => ancestor.text).join(' '),
      taskLocations(task).join(' '),
      (task.contexts || []).join(' '),
    ].join(' ').toLowerCase();
    const okSearch = !textNeedle || hay.includes(textNeedle);
    const okAvailability = tasksViewState.showBlocked || meta.done || meta.available || !!focusTaskId;
    return okThread && okCtx && okLoc && okTime && okPriority && okArchived && okSearch && focusScope && okAvailability;
  };

  const directMatchIds = new Set(allTaskRefs.filter(matchesDirect).map((ref) => ref.task.id));
  const visibleById = new Map();
  const markVisible = (task) => {
    const childVisible = taskChildList(task).some((child) => markVisible(child));
    const visible = directMatchIds.has(task.id) || childVisible;
    visibleById.set(task.id, visible);
    return visible;
  };
  flattenNodes(store.data.threads || []).forEach((node) => {
    if (!isNodePathEnabled(node)) return;
    (node.tasks || []).forEach((task) => markVisible(task));
  });

  const visibleRefs = allTaskRefs.filter((ref) => visibleById.get(ref.task.id));
  selectedTaskKeys = new Set([...selectedTaskKeys].filter((id) => visibleById.get(id)));

  const stats = {
    total: visibleRefs.length,
    ready: visibleRefs.filter((ref) => {
      const meta = metaById.get(ref.task.id);
      return meta && !meta.done && meta.available;
    }).length,
    blocked: visibleRefs.filter((ref) => {
      const meta = metaById.get(ref.task.id);
      return meta && !meta.done && !meta.available;
    }).length,
    done: visibleRefs.filter((ref) => metaById.get(ref.task.id)?.done).length,
    starred: visibleRefs.filter((ref) => !ref.task.completed && ref.task.starred).length,
    urgent: visibleRefs.filter((ref) => {
      const due = metaById.get(ref.task.id)?.due;
      return !ref.task.completed && (due?.state === 'overdue' || due?.state === 'soon');
    }).length,
  };

  const sorters = {
    priority: (a, b) => {
      const pa = Number(a.task.priority) || 3;
      const pb = Number(b.task.priority) || 3;
      if (pa !== pb) return pa - pb;
      const aa = metaById.get(a.task.id)?.available ? 0 : 1;
      const bb = metaById.get(b.task.id)?.available ? 0 : 1;
      if (aa !== bb) return aa - bb;
      const da = parseIsoDate(a.task.dueAt)?.getTime() ?? Infinity;
      const db = parseIsoDate(b.task.dueAt)?.getTime() ?? Infinity;
      return da - db;
    },
    due: (a, b) => {
      const da = parseIsoDate(a.task.dueAt)?.getTime() ?? Infinity;
      const db = parseIsoDate(b.task.dueAt)?.getTime() ?? Infinity;
      if (da !== db) return da - db;
      return (Number(a.task.priority) || 3) - (Number(b.task.priority) || 3);
    },
    path: (a, b) => {
      const cmp = taskRefPath(a).localeCompare(taskRefPath(b));
      if (cmp !== 0) return cmp;
      return (Number(a.task.priority) || 3) - (Number(b.task.priority) || 3);
    },
  };
  const sortBy = ['priority', 'due', 'path'].includes(tasksViewState.sortBy) ? tasksViewState.sortBy : 'priority';
  const sortRefs = (refs) => refs.slice().sort(sorters[sortBy]);
  const visibleChildRefs = (task) => taskChildList(task).map((child) => refById.get(child.id)).filter((ref) => ref && visibleById.get(ref.task.id));
  const childSummary = (task) => {
    const children = taskChildList(task);
    if (!children.length) return '';
    const ready = children.filter((child) => {
      const meta = metaById.get(child.id);
      return meta && !meta.done && meta.available;
    }).length;
    const blocked = children.filter((child) => {
      const meta = metaById.get(child.id);
      return meta && !meta.done && !meta.available;
    }).length;
    const starred = children.filter((child) => !child.completed && child.starred).length;
    const parts = [`${children.length} subtask${children.length === 1 ? '' : 's'}`];
    if (ready) parts.push(`${ready} ready`);
    if (blocked) parts.push(`${blocked} blocked`);
    if (starred) parts.push(`${starred} starred`);
    if (taskChildMode(task) === 'sequential') {
      const next = children.find((child) => !child.completed);
      parts.push(next ? `Next: ${next.text || 'Task'}` : 'All done');
    }
    return parts.join(' • ');
  };

  const rerenderEverywhere = () => {
    renderThreads();
    if (!$('#review-stage').hidden) {
      renderProgress();
      renderStoryCard();
    }
    renderTasksPane();
  };
  const openComposer = (kind, taskId) => {
    taskComposerState = { kind, taskId };
    renderTasksPane();
  };
  const closeComposer = () => {
    taskComposerState = null;
    renderTasksPane();
  };
  const appendComposer = (host, ref) => {
    if (!taskComposerState || taskComposerState.taskId !== ref.task.id) return;
    const kind = taskComposerState.kind;
    const row = el('div', { class: 'task-compose-row' });
    const input = el('input', { type: 'text', placeholder: kind === 'sibling' ? 'Add sibling task…' : 'Add subtask…' });
    const addBtn = el('button', { class: 'btn primary', type: 'button' }, kind === 'sibling' ? 'Add sibling' : 'Add subtask');
    const cancelBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const commit = () => {
      const text = input.value.trim();
      if (!text) {
        input.focus();
        return;
      }
      const created = kind === 'sibling' ? addSiblingTask(ref.task.id, text) : addChildTask(ref.task.id, text);
      if (!created) return;
      taskComposerState = null;
      store.saveNow();
      rerenderEverywhere();
      showToast(kind === 'sibling' ? 'Sibling task added' : 'Subtask added');
    };
    bindEnterToButton(input, addBtn);
    addBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', closeComposer);
    row.append(input, addBtn, cancelBtn);
    host.append(row);
    requestAnimationFrame(() => input.focus());
  };

  const makeTaskCard = (ref, opts = {}) => {
    const task = ref.task;
    const meta = metaById.get(task.id);
    const depth = Number(ref.depth) || 0;
    const item = el('div', {
      class: `task task-tree-card${meta?.done ? ' completed' : ''}${depth ? ' nested-task-card' : ''}${opts.flat ? ' flat-task-card' : ''}`,
      style: `border-left:6px solid ${ref.root?.color || 'var(--accent)'}`,
      'data-task-id': task.id,
    });
    item.style.setProperty('--task-depth', String(depth));
    if (meta?.due?.state === 'overdue') item.classList.add('due-overdue');
    else if (meta?.due?.state === 'soon') item.classList.add('due-soon');
    if (meta?.archivedAt) item.classList.add('archived');
    if (task.starred) item.classList.add('is-starred');

    const head = el('div', { class: 'task-tree-head' });
    const titleGroup = el('div', { class: 'task-tree-title-group' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!meta?.done;
    cb.addEventListener('change', () => {
      if (taskHasChildren(task)) setTaskTreeCompleted(task, cb.checked);
      else setTaskCompleted(task, cb.checked);
      store.saveNow();
      rerenderEverywhere();
    });
    titleGroup.append(cb);
    if (taskHasChildren(task) && !opts.flat) {
      const toggle = el('button', { class: 'btn ghost task-tree-toggle', type: 'button' }, collapsedTaskTrees.has(task.id) ? '▸' : '▾');
      toggle.addEventListener('click', () => {
        if (collapsedTaskTrees.has(task.id)) collapsedTaskTrees.delete(task.id);
        else collapsedTaskTrees.add(task.id);
        renderTasksPane();
      });
      titleGroup.append(toggle);
    } else {
      titleGroup.append(el('span', { class: 'task-tree-spacer', 'aria-hidden': 'true' }, ''));
    }

    const titleWrap = el('div', { class: 'task-tree-title-wrap' });
    const titleInput = el('textarea', { class: 'task-title-input task-tree-title', rows: '1' });
    initTaskTextInput(titleInput);
    titleInput.value = task.text || '';
    titleInput.addEventListener('change', () => {
      const next = titleInput.value.trim();
      if (!next) {
        titleInput.value = task.text || '';
        return;
      }
      task.text = next;
      store.saveNow();
      renderThreads();
      if (!$('#review-stage').hidden) renderStoryCard();
    });
    titleWrap.append(titleInput);
    if (!tasksViewState.compactMode) {
      const infoParts = [];
      const path = taskRefPath(ref);
      if (path) infoParts.push(path);
      if (!meta?.done && meta?.reason) infoParts.push(meta.reason);
      if (!meta?.done && (meta?.due?.state === 'overdue' || meta?.due?.state === 'soon')) infoParts.push(meta.due.label);
      const summary = childSummary(task);
      if (summary) infoParts.push(summary);
      if (infoParts.length) titleWrap.append(el('div', { class: 'task-tree-subline' }, infoParts.join(' • ')));
    }
    head.append(titleGroup, titleWrap);

    const tools = el('div', { class: 'task-tree-tools' });
    if (tasksViewState.selectionMode) {
      const pick = el('input', { type: 'checkbox', title: 'Select task' });
      pick.checked = selectedTaskKeys.has(task.id);
      pick.addEventListener('change', () => {
        if (pick.checked) selectedTaskKeys.add(task.id);
        else selectedTaskKeys.delete(task.id);
        item.classList.toggle('selected', pick.checked);
      });
      tools.append(pick);
      item.classList.toggle('selected', pick.checked);
    }
    const starBtn = el('button', {
      class: `task-icon-btn${task.starred ? ' active star' : ''}`,
      type: 'button',
      title: task.starred ? 'Remove star' : 'Star task',
      'aria-label': task.starred ? 'Remove star' : 'Star task',
    }, task.starred ? '★' : '☆');
    starBtn.addEventListener('click', () => {
      task.starred = !task.starred;
      store.saveNow();
      renderTasksPane();
    });
    const pauseBtn = el('button', {
      class: `task-icon-btn${taskHasPauseState(task, depMap) ? ' active pause' : ''}`,
      type: 'button',
      title: 'Pause and dependencies',
      'aria-label': 'Pause and dependencies',
    }, '⏸');
    pauseBtn.addEventListener('click', () => {
      const next = !isPausePanelOpen('tasks', task.id);
      setPausePanelOpen('tasks', task.id, next);
      if (next) setTagPanelOpen('tasks', task.id, false);
      renderTasksPane();
    });
    const detailBtn = el('button', {
      class: `task-icon-btn${isTagPanelOpen('tasks', task.id) ? ' active' : ''}`,
      type: 'button',
      title: 'Task details',
      'aria-label': 'Task details',
    }, '⋯');
    detailBtn.addEventListener('click', () => {
      const next = !isTagPanelOpen('tasks', task.id);
      setTagPanelOpen('tasks', task.id, next);
      if (next) setPausePanelOpen('tasks', task.id, false);
      renderTasksPane();
    });
    tools.append(starBtn, pauseBtn, detailBtn);
    head.append(tools);
    item.append(head);

    const badgeRow = buildTaskStateBadges(task, { now, depMap, done: meta?.done, ref });
    if (taskHasChildren(task)) {
      badgeRow.append(el('span', { class: 'pill task-state-chip tag' }, taskChildMode(task) === 'sequential' ? 'Sequential' : 'Parallel'));
    }
    if (task.starred) badgeRow.append(el('span', { class: 'pill task-state-chip warn' }, 'Starred'));
    item.append(badgeRow);

    if (!tasksViewState.compactMode && !opts.flat) {
      item.append(buildTaskMetaRow(task, { variant: 'compact', includePriority: false }));
    }

    if (!opts.flat) {
      const actionRow = el('div', { class: 'task-tree-action-row' });
      const addChildBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, '+ Add subtask');
      addChildBtn.addEventListener('click', () => openComposer('child', task.id));
      actionRow.append(addChildBtn);
      if (ref.parentTask) {
        const addSiblingBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, '+ Add sibling');
        addSiblingBtn.addEventListener('click', () => openComposer('sibling', task.id));
        actionRow.append(addSiblingBtn);
      }
      const deleteBtn = el('button', { class: 'btn ghost danger btn-lite', type: 'button' }, 'Delete');
      deleteBtn.addEventListener('click', () => {
        removeTaskById(task.id);
        if (tasksViewState.focusTaskId === task.id) tasksViewState.focusTaskId = null;
        store.saveNow();
        rerenderEverywhere();
        showToast('Task removed');
      });
      actionRow.append(deleteBtn);
      item.append(actionRow);
    }

    if (isPausePanelOpen('tasks', task.id)) item.append(buildPauseControls(task.id, () => renderTasksPane()));
    if (isTagPanelOpen('tasks', task.id)) item.append(buildAvailabilityControls(ref.node.id, task.id, () => renderTasksPane()));

    if (!opts.flat) {
      appendComposer(item, ref);
      const children = visibleChildRefs(task);
      const forceOpen = !!focusTaskId && children.some((childRef) => childRef.task.id === focusTaskId || childRef.ancestors.some((ancestor) => ancestor.id === focusTaskId));
      const expanded = taskHasChildren(task) && (!collapsedTaskTrees.has(task.id) || forceOpen || !!tasksViewState.searchText);
      if (children.length && expanded) {
        const kids = el('div', { class: 'task-tree-children' });
        children.forEach((childRef) => kids.append(makeTaskCard(childRef)));
        item.append(kids);
      }
    }

    if (meta?.done) item.classList.add('status-completed');
    else if (meta?.available) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    return item;
  };

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
    const resetAllFilters = () => {
      tasksViewState.threadNodeId = null;
      tasksViewState.currentContext = 'Any';
      tasksViewState.locationTags = [];
      tasksViewState.durationMax = null;
      tasksViewState.priorityValues = [];
      tasksViewState.focusTaskId = null;
      tasksViewState.showBlocked = false;
      tasksViewState.searchText = '';
      tasksViewState.showArchived = false;
      tasksViewState.sortBy = 'priority';
      tasksViewState.compactMode = false;
      tasksViewState.selectionMode = false;
      selectedTaskKeys = new Set();
    };
    const score = gamificationSummary(now);
    const statusPanel = el('section', { class: 'tasks-status-panel' });
    const scorePanel = el('div', { class: `points-panel${score.points >= score.goal ? ' complete' : ''}` });
    const scoreHead = el('div', { class: 'points-head' });
    scoreHead.append(el('div', { class: 'points-title' }, 'Daily Points'), el('div', { class: 'points-value' }, `${score.points}/${score.goal}`));
    const scoreMeta = score.remaining
      ? `${score.remaining} to goal • Streak ${score.streak} day${score.streak === 1 ? '' : 's'}`
      : `Goal reached • Streak ${score.streak} day${score.streak === 1 ? '' : 's'}`;
    const scoreSub = el('div', { class: 'points-meta' }, `${scoreMeta} • Goal days ${score.goalDays}`);
    const scoreBar = el('div', { class: 'points-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(score.goal), 'aria-valuenow': String(score.points) });
    const scoreFill = el('div', { class: 'points-fill' });
    scoreFill.style.width = `${score.pct}%`;
    scoreBar.append(scoreFill);
    const metricsSummary = el('div', { class: 'tasks-summary' });
    metricsSummary.append(
      metric('Visible', stats.total),
      metric('Ready', stats.ready, 'good'),
      metric('Blocked', stats.blocked, stats.blocked ? 'warn' : ''),
      metric('Starred', stats.starred, stats.starred ? 'good' : ''),
      metric('Urgent', stats.urgent, stats.urgent ? 'warn' : ''),
      metric('Done', stats.done)
    );
    scorePanel.append(scoreHead, scoreSub, scoreBar, metricsSummary);
    statusPanel.append(scorePanel);
    controls.append(statusPanel);

    const filterPanel = el('section', { class: 'tasks-filter-panel' });
    const searchRow = el('div', { class: 'filter-row' });
    const searchInput = el('input', { type: 'search', placeholder: 'Search within tasks…' });
    searchInput.value = tasksViewState.searchText || '';
    searchInput.addEventListener('input', () => {
      tasksViewState.searchText = searchInput.value;
      saveTasksViewState();
      renderTasksPane();
    });
    const resetBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Reset Filters');
    resetBtn.addEventListener('click', () => {
      resetAllFilters();
      saveTasksViewState();
      renderTasksPane();
    });
    searchRow.append(searchInput, resetBtn);
    filterPanel.append(buildGroup('Search', searchRow));

    const sortRow = el('div', { class: 'filter-row' });
    [['priority', 'Priority'], ['due', 'Due'], ['path', 'Path']].forEach(([key, label]) => {
      const btn = el('button', { class: `chip toggle${tasksViewState.sortBy === key ? ' active' : ''}`, type: 'button' }, label);
      btn.addEventListener('click', () => {
        tasksViewState.sortBy = key;
        saveTasksViewState();
        renderTasksPane();
      });
      sortRow.append(btn);
    });
    filterPanel.append(buildGroup('Sort', sortRow));

    const quickRow = el('div', { class: 'filter-row' });
    const mkToggle = (label, checked, onChange) => {
      const wrap = el('label', { class: 'filter-toggle' });
      const input = el('input', { type: 'checkbox' });
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      wrap.append(input, document.createTextNode(` ${label}`));
      return wrap;
    };
    quickRow.append(
      mkToggle('Show blocked', !!tasksViewState.showBlocked, (value) => {
        tasksViewState.showBlocked = value;
        saveTasksViewState();
        renderTasksPane();
      }),
      mkToggle('Show archived', !!tasksViewState.showArchived, (value) => {
        tasksViewState.showArchived = value;
        saveTasksViewState();
        renderTasksPane();
      }),
      mkToggle('Compact', !!tasksViewState.compactMode, (value) => {
        tasksViewState.compactMode = value;
        saveTasksViewState();
        renderTasksPane();
      }),
      mkToggle('Select mode', !!tasksViewState.selectionMode, (value) => {
        tasksViewState.selectionMode = value;
        if (!value) selectedTaskKeys = new Set();
        renderTasksPane();
      })
    );
    filterPanel.append(buildGroup('View', quickRow));

    const advanced = el('details', { class: 'tasks-more-filters' });
    const advancedSummary = el('summary', {}, 'More filters');
    const advancedBody = el('div', { class: 'tasks-more-filters-body' });
    advanced.append(advancedSummary, advancedBody);

    const threadRow = el('div', { class: 'filter-row' });
    const threadSel = el('select', { class: 'select-sm' });
    threadSel.append(el('option', { value: '' }, 'Any thread'));
    allThreadNodes().filter(isNodePathEnabled).forEach((node) => {
      threadSel.append(el('option', { value: node.id }, nodePath(node)));
    });
    threadSel.value = threadNodeId || '';
    threadSel.addEventListener('change', () => {
      tasksViewState.threadNodeId = threadSel.value || null;
      saveTasksViewState();
      renderTasksPane();
    });
    threadRow.append(threadSel);
    advancedBody.append(buildGroup('Thread', threadRow));

    const ctxs = allContexts();
    if (ctxs.length) {
      const ctxRow = el('div', { class: 'filter-row' });
      const sel = el('select', { class: 'select-sm' });
      sel.append(el('option', { value: 'Any' }, 'Any'));
      ctxs.forEach((name) => sel.append(el('option', { value: name }, name)));
      sel.value = tasksViewState.currentContext || 'Any';
      sel.addEventListener('change', () => {
        tasksViewState.currentContext = sel.value;
        saveTasksViewState();
        renderTasksPane();
      });
      ctxRow.append(sel);
      advancedBody.append(buildGroup('Context', ctxRow));
    }

    const activePriorities = normalizePriorityList(tasksViewState.priorityValues || []);
    const priRow = el('div', { class: 'filter-row' });
    const priAny = el('button', { class: `chip toggle${activePriorities.length ? '' : ' active'}`, type: 'button' }, 'Any');
    priAny.addEventListener('click', () => {
      tasksViewState.priorityValues = [];
      saveTasksViewState();
      renderTasksPane();
    });
    priRow.append(priAny);
    PRIORITY_PRESETS.forEach((priority) => {
      const active = activePriorities.includes(priority);
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}`, type: 'button' }, `P${priority}`);
      btn.addEventListener('click', () => {
        const next = normalizePriorityList(tasksViewState.priorityValues || []);
        const idx = next.indexOf(priority);
        if (idx >= 0) next.splice(idx, 1);
        else next.push(priority);
        tasksViewState.priorityValues = normalizePriorityList(next);
        saveTasksViewState();
        renderTasksPane();
      });
      priRow.append(btn);
    });
    advancedBody.append(buildGroup('Priority', priRow));

    const activeLocs = uniqTags(tasksViewState.locationTags || []);
    const locRow = el('div', { class: 'filter-row' });
    const locAny = el('button', { class: `chip toggle${activeLocs.length ? '' : ' active'}`, type: 'button' }, 'Any');
    locAny.addEventListener('click', () => {
      tasksViewState.locationTags = [];
      saveTasksViewState();
      renderTasksPane();
    });
    locRow.append(locAny);
    allLocations().forEach((loc) => {
      const active = activeLocs.some((tag) => tag.toLowerCase() === loc.toLowerCase());
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}`, type: 'button' }, loc);
      btn.addEventListener('click', () => {
        const next = uniqTags(tasksViewState.locationTags || []);
        const idx = next.findIndex((tag) => tag.toLowerCase() === loc.toLowerCase());
        if (idx >= 0) next.splice(idx, 1);
        else next.push(loc);
        tasksViewState.locationTags = next;
        saveTasksViewState();
        renderTasksPane();
      });
      locRow.append(btn);
    });
    advancedBody.append(buildGroup('Location', locRow));

    const timeRow = el('div', { class: 'filter-row' });
    const timeAny = el('button', { class: `chip toggle${maxDur ? '' : ' active'}`, type: 'button' }, 'Any');
    timeAny.addEventListener('click', () => {
      tasksViewState.durationMax = null;
      saveTasksViewState();
      renderTasksPane();
    });
    timeRow.append(timeAny);
    allDurations().forEach((mins) => {
      const active = maxDur === mins;
      const btn = el('button', { class: `chip toggle${active ? ' active' : ''}`, type: 'button' }, formatDuration(mins) || `${mins}m`);
      btn.addEventListener('click', () => {
        tasksViewState.durationMax = active ? null : mins;
        saveTasksViewState();
        renderTasksPane();
      });
      timeRow.append(btn);
    });
    advancedBody.append(buildGroup('Time ≤', timeRow));

    if (focusTaskId) {
      const focusRow = el('div', { class: 'filter-row' });
      const chip = el('button', { class: 'chip toggle active', type: 'button' }, `Focus: ${focusedTaskName}`);
      chip.addEventListener('click', () => {
        tasksViewState.focusTaskId = null;
        saveTasksViewState();
        renderTasksPane();
      });
      focusRow.append(chip);
      advancedBody.append(buildGroup('Focus', focusRow));
    }

    if (tasksViewState.selectionMode) {
      const selectedRefs = [...selectedTaskKeys].map((id) => refById.get(id)).filter(Boolean);
      const bulkRow = el('div', { class: 'filter-row' });
      bulkRow.append(el('span', { class: 'subtext' }, `${selectedRefs.length} selected`));
      const doneBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Complete');
      doneBtn.addEventListener('click', () => {
        selectedRefs.forEach((ref) => {
          if (taskHasChildren(ref.task)) setTaskTreeCompleted(ref.task, true);
          else setTaskCompleted(ref.task, true);
        });
        selectedTaskKeys = new Set();
        store.saveNow();
        rerenderEverywhere();
        showToast('Bulk complete applied');
      });
      const starBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Star');
      starBtn.addEventListener('click', () => {
        selectedRefs.forEach((ref) => { ref.task.starred = true; });
        store.saveNow();
        renderTasksPane();
      });
      const priSel = el('select', { class: 'select-sm' });
      [1, 2, 3, 4, 5].forEach((priority) => priSel.append(el('option', { value: String(priority) }, `P${priority}`)));
      const priBtn = el('button', { class: 'btn ghost', type: 'button' }, 'Set priority');
      priBtn.addEventListener('click', () => {
        selectedRefs.forEach((ref) => { ref.task.priority = Number(priSel.value); });
        store.saveNow();
        rerenderEverywhere();
      });
      const delBtn = el('button', { class: 'btn ghost danger', type: 'button' }, 'Remove');
      delBtn.addEventListener('click', () => {
        selectedRefs.forEach((ref) => removeTaskById(ref.task.id));
        selectedTaskKeys = new Set();
        store.saveNow();
        rerenderEverywhere();
        showToast('Selected tasks removed');
      });
      bulkRow.append(doneBtn, starBtn, priSel, priBtn, delBtn);
      advancedBody.append(buildGroup('Selection', bulkRow));
    }

    filterPanel.append(advanced);
    controls.append(filterPanel);
  }

  const makeFollowUpCard = (ref) => {
    const task = ref.task;
    const follow = followUpStatus(task, now);
    const item = el('div', {
      class: `task followup-task${follow.state === 'overdue' ? ' due-overdue' : ''}`,
      style: `border-left:6px solid ${ref.root?.color || 'var(--accent)'}`,
      'data-task-id': task.id,
    });
    const pin = el('div');
    pin.append(el('span', { class: `pill ${follow.state === 'overdue' ? 'warn' : 'tag'}` }, follow.label || 'Follow up'));
    const main = el('div', { class: 'task-main' });
    main.append(
      el('div', { class: 'task-title' }, task.text || 'Untitled task'),
      el('div', { class: 'ctx' }, `${taskRefPath(ref)}${availabilityReason(ref, now, null, depMap) ? ` • ${availabilityReason(ref, now, null, depMap)}` : ''}`)
    );
    const actions = el('div', { class: 'meta task-actions followup-actions' });
    const nudgeBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Nudge +2d');
    nudgeBtn.addEventListener('click', () => {
      nudgeFollowUp(task, 2, now);
      store.saveNow();
      renderTasksPane();
    });
    const clearWaitBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Clear waiting');
    clearWaitBtn.disabled = !(task.waitingOn && task.waitingOn.trim());
    clearWaitBtn.addEventListener('click', () => {
      task.waitingOn = '';
      store.saveNow();
      renderTasksPane();
    });
    const openBtn = el('button', { class: 'btn ghost btn-lite', type: 'button' }, 'Open');
    openBtn.addEventListener('click', () => {
      tasksViewState.focusTaskId = task.id;
      tasksViewState.showBlocked = true;
      saveTasksViewState();
      renderTasksPane();
    });
    actions.append(nudgeBtn, clearWaitBtn, openBtn);
    item.append(pin, main, actions);
    return item;
  };

  const followUpEntries = allTaskRefs
    .map((ref) => {
      const task = ref.task;
      if (!nodeInScope(ref.node, threadNodeId)) return null;
      if (!task || task.completed) return null;
      if (!tasksViewState.showArchived && task.archivedAt) return null;
      if (!taskHasPauseState(task, depMap)) return null;
      const follow = followUpStatus(task, now);
      if (follow.state !== 'overdue' && follow.state !== 'today') return null;
      return { ...ref, follow };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const fa = parseIsoDate(a.task.followUpAt)?.getTime() ?? Infinity;
      const fb = parseIsoDate(b.task.followUpAt)?.getTime() ?? Infinity;
      if (fa !== fb) return fa - fb;
      return (Number(a.task.priority) || 3) - (Number(b.task.priority) || 3);
    });

  const movingEntries = movingTaskEntries('tasks');
  if (movingEntries.length) {
    const movingSection = el('section', { class: 'task-section task-section-moving' });
    const head = el('div', { class: 'task-section-head' });
    head.append(el('h3', {}, 'Moving Tasks'));
    head.append(el('span', { class: 'pill warn' }, `${movingEntries.length}`));
    movingSection.append(head);
    movingEntries.forEach((entry) => movingSection.append(buildMovingTaskNotice(entry)));
    root.append(movingSection);
  }

  if (followUpEntries.length) {
    const followSection = el('section', { class: 'task-section task-section-followups' });
    const head = el('div', { class: 'task-section-head' });
    head.append(el('h3', {}, 'Follow-Ups Due'));
    head.append(el('span', { class: 'pill warn' }, `${followUpEntries.length}`));
    followSection.append(head);
    followUpEntries.forEach((entry) => followSection.append(makeFollowUpCard(entry)));
    root.append(followSection);
  }

  const appendSection = (title, refs, opts = {}) => {
    if (!refs.length) return;
    const section = el('section', { class: `task-section${opts.extraClass ? ` ${opts.extraClass}` : ''}` });
    const head = el('div', { class: 'task-section-head' });
    head.append(el('h3', {}, title));
    head.append(el('span', { class: 'pill tag' }, `${refs.length}`));
    section.append(head);
    refs.forEach((ref) => section.append(makeTaskCard(ref, opts.cardOpts || {})));
    root.append(section);
  };

  const topLevelRefs = sortRefs(allTaskRefs.filter((ref) => ref.depth === 0 && visibleById.get(ref.task.id)));
  const openRoots = topLevelRefs.filter((ref) => !ref.task.completed);
  const doneRoots = topLevelRefs.filter((ref) => ref.task.completed);
  const starredRefs = sortRefs(visibleRefs.filter((ref) => !ref.task.completed && ref.task.starred));

  if (starredRefs.length) appendSection('Starred', starredRefs, { extraClass: 'task-section-starred', cardOpts: { flat: true } });
  if (openRoots.length) appendSection(tasksViewState.showBlocked ? 'Open Tasks' : 'Ready Tasks', openRoots);
  if (doneRoots.length) appendSection('Completed', doneRoots);

  if (!openRoots.length && !doneRoots.length && !movingEntries.length && !followUpEntries.length) {
    const msg = stats.total ? 'No tasks in the current view.' : 'No tasks match the current filters.';
    root.append(el('div', { class: 'empty' }, msg));
  }
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
      followUpStatus,
      reviewStreakInfo,
      markDailyReviewCompleted,
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
