// DayMX – mobile-first SPA for daily thread reviews

// ------------------------------
// Persistence
// ------------------------------
const STORAGE_KEY = 'daymx-data-v1';
const REVIEW_STATE_KEY = 'daymx-review-state-v1';
const PANTRY_REVIEW_STATE_KEY = 'daymx-pantry-review-state-v1';

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const defaultData = () => ({
  threads: [], // array of nodes
  pantry: { categories: [] },
});

const store = {
  data: null,
  mode: 'local', // 'local' | 'firebase'
  unsub: null,
  saveTimer: null,
  saveNow(dataOverride) {
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
      this.mode = 'firebase';
      // Subscribe to live updates
      this.unsub = window.daymxFirebase.subscribe((remote) => {
        if (!remote) return;
        this.data = remote;
        if (!this.data.pantry) this.data.pantry = { categories: [] };
        // Normalize and refresh UI on remote updates
        (this.data.threads || []).forEach(normalizeNode);
        (this.data.pantry.categories || []).forEach(normalizeCategory);
        autoAssignThreadColors();
        recomputeIndexes();
        renderThreads();
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
  },
  async save() {
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

// ------------------------------
// Data helpers
// ------------------------------
function createNode(name = 'Untitled') {
  return { id: uid('node'), name, enabled: true, children: [], questions: [], tasks: [] };
}

function createQuestion(text = '') {
  return { id: uid('q'), text };
}

function createTask(text = '') {
  return { id: uid('t'), text, completed: false, priority: 3, availableAt: null, contexts: [], waitingOn: '', followUpAt: null };
}

// Pantry creators
function createCategory(name = 'Category') {
  return { id: uid('cat'), name, enabled: true, children: [], items: [] };
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
  n.tasks.forEach(t => {
    if (typeof t.completed !== 'boolean') t.completed = !!t.completed;
    if (typeof t.priority !== 'number' || t.priority < 1 || t.priority > 5) t.priority = 3;
    if (!('availableAt' in t)) t.availableAt = null;
    if (!('contexts' in t)) t.contexts = [];
    if (!('waitingOn' in t)) t.waitingOn = '';
    if (!('followUpAt' in t)) t.followUpAt = null;
  });
  n.children.forEach(normalizeNode);
}

function normalizeCategory(c) {
  c.children = Array.isArray(c.children) ? c.children : [];
  c.items = Array.isArray(c.items) ? c.items : [];
  c.name = c.name || 'Category';
  if (typeof c.enabled !== 'boolean') c.enabled = true;
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

function isTaskAvailable(t, now = new Date(), currentContext = null) {
  if (t.waitingOn && t.waitingOn.trim()) return false;
  if (t.availableAt) {
    const at = new Date(t.availableAt);
    if (now < at) return false;
  }
  if (Array.isArray(t.contexts) && t.contexts.length) {
    if (!currentContext || !t.contexts.includes(currentContext)) return false;
  }
  return true;
}

function availabilityReason(t, now = new Date(), currentContext = null) {
  if (t.waitingOn && t.waitingOn.trim()) return `Waiting: ${t.waitingOn.trim()}`;
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

function buildAvailabilityControls(nodeId, taskId, rerender) {
  const n = findNodeById(store.data.threads, nodeId);
  const t = (n?.tasks || []).find(x => x.id === taskId);
  const avail = el('div', { class: 'availability' });
  if (!n || !t) return avail;
  // Available From
  const row1 = el('div', { class: 'row' });
  row1.append(el('div', { class: 'subtext' }, 'Available from'));
  const dt = el('input', { type: 'datetime-local' });
  dt.value = toLocalInputValue(t.availableAt);
  dt.addEventListener('change', () => {
    const live = findNodeById(store.data.threads, nodeId);
    const ti = live.tasks.findIndex(x => x.id === taskId);
    if (ti >= 0) live.tasks[ti].availableAt = parseLocalDateTime(dt.value);
    store.saveNow(); rerender && rerender();
  });
  const clear1 = el('button', { class: 'btn ghost' }, 'Clear');
  clear1.addEventListener('click', () => { dt.value = ''; const live = findNodeById(store.data.threads, nodeId); const ti = live.tasks.findIndex(x => x.id === taskId); if (ti >= 0) live.tasks[ti].availableAt = null; store.saveNow(); rerender && rerender(); });
  row1.append(dt, clear1);
  avail.append(row1);

  // Contexts
  const row2 = el('div', { class: 'row' });
  row2.append(el('div', { class: 'subtext' }, 'Contexts'));
  const chipWrap = el('div', { class: 'chiplist' });
  (t.contexts || []).forEach((c) => {
    const ch = el('span', { class: 'chip' }, [c, el('button', {}, '✕')]);
    ch.querySelector('button').addEventListener('click', () => {
      const live = findNodeById(store.data.threads, nodeId);
      const ti = live.tasks.findIndex(x => x.id === taskId);
      if (ti >= 0) {
        live.tasks[ti].contexts = (live.tasks[ti].contexts || []).filter(x => x !== c);
        store.saveNow(); rerender && rerender();
      }
    });
    chipWrap.append(ch);
  });
  const ctxInput = el('input', { type: 'text', placeholder: 'Add context…' });
  const addCtx = el('button', { class: 'btn ghost' }, 'Add');
  addCtx.addEventListener('click', () => {
    const v = ctxInput.value.trim(); if (!v) return;
    const live = findNodeById(store.data.threads, nodeId);
    const ti = live.tasks.findIndex(x => x.id === taskId);
    if (ti >= 0) {
      const arr = live.tasks[ti].contexts || [];
      if (!arr.includes(v)) arr.push(v);
      store.saveNow(); rerender && rerender(); ctxInput.value = '';
    }
  });
  row2.append(chipWrap, addCtx);
  avail.append(row2);

  // Waiting on
  const row3 = el('div', { class: 'row' });
  row3.append(el('div', { class: 'subtext' }, 'Waiting on'));
  const waitInput = el('input', { type: 'text', placeholder: 'Name or reason…' });
  waitInput.value = t.waitingOn || '';
  waitInput.addEventListener('change', () => { const live = findNodeById(store.data.threads, nodeId); const ti = live.tasks.findIndex(x => x.id === taskId); if (ti >= 0) { live.tasks[ti].waitingOn = waitInput.value.trim(); } store.saveNow(); rerender && rerender(); });
  const clearWait = el('button', { class: 'btn ghost' }, 'Clear');
  clearWait.addEventListener('click', () => { const live = findNodeById(store.data.threads, nodeId); const ti = live.tasks.findIndex(x => x.id === taskId); if (ti >= 0) { live.tasks[ti].waitingOn = ''; } store.saveNow(); rerender && rerender(); });
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
  if (!store.data.threads.length) {
    root.append(el('div', { class: 'empty' }, 'No threads yet. Add one to begin.'));
    return;
  }
  for (const node of store.data.threads) {
    root.append(renderNode(node));
  }
}

function renderNode(node) {
  const container = el('div', { class: 'node', 'data-id': node.id });
  const header = el('div', { class: 'node-header' });
  const titleWrap = el('div', { class: 'node-title' });
  const colorDot = el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:999px;background:${node.color || '#666'};margin-right:6px;vertical-align:middle;` });
  titleWrap.append(colorDot, document.createTextNode(node.name || 'Untitled'));
  const actions = el('div', { class: 'node-actions' });

  const btnRename = el('button', { class: 'btn ghost' }, 'Rename');
  btnRename.addEventListener('click', () => {
    const name = confirmName('Rename thread/subthread', node.name);
    if (!name) return;
    node.name = name;
    store.save();
    recomputeIndexes();
    renderThreads();
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
  const enabledToggle = el('label', { class: 'subtext' });
  const en = el('input', { type: 'checkbox' }); en.checked = node.enabled !== false; en.addEventListener('change', ()=>{ node.enabled = en.checked; store.save(); renderThreads(); });
  enabledToggle.append(en, document.createTextNode(' Enabled'));

  actions.append(btnRename, btnAddChild, btnQuestions, btnTasks, enabledToggle);
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
    const label = el('div', {}, q.text);
    const actions = el('div');
    const edit = el('button', { class: 'btn ghost' }, 'Edit');
    edit.addEventListener('click', () => {
      const val = confirmName('Edit question', q.text);
      if (val != null && val.trim()) { q.text = val.trim(); store.save(); renderThreads(); }
    });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.questions = node.questions.filter(x => x.id !== q.id);
      store.save(); renderThreads();
    });
    actions.append(edit, del);
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
  if (!node.tasks.length) tList.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  node.tasks.forEach((t) => {
    const row = el('div', { class: 'inline-item' });
    const top = el('div', { class: 'kv' });
    const label = el('div', {}, t.text);
    const actions = el('div', { class: 'meta' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderThreads(); });
    const edit = el('button', { class: 'btn ghost' }, 'Edit');
    edit.addEventListener('click', () => {
      const val = confirmName('Edit task', t.text);
      if (val != null && val.trim()) { t.text = val.trim(); store.save(); renderThreads(); }
    });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      node.tasks = node.tasks.filter(x => x.id !== t.id);
      store.save(); renderThreads();
    });
    const avail = buildAvailabilityControls(node.id, t.id, () => renderThreads());
    avail.hidden = true;
    const availBtn = el('button', { class: 'btn ghost' }, 'Availability');
    availBtn.addEventListener('click', () => { avail.hidden = !avail.hidden; });
    actions.append(pri, availBtn, edit, del);
    top.append(label, actions);
    // status tint
    if (t.completed) row.classList.add('status-completed');
    else if (isTaskAvailable(t)) row.classList.add('status-available');
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
    for (const child of node.children) kids.append(renderNode(child));
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
    const label = el('div', {}, q.text);
    const actions = el('div');
    const editBtn = el('button', { class: 'btn ghost' }, 'Edit');
    editBtn.addEventListener('click', () => {
      const val = confirmName('Edit question', q.text);
      if (val != null && val.trim()) {
        const live = findNodeById(store.data.threads, n.id);
        const qi = live.questions.findIndex(x => x.id === q.id);
        if (qi >= 0) { live.questions[qi].text = val.trim(); }
        store.saveNow(); renderStoryCard();
      }
    });
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.questions = live.questions.filter(x => x.id !== q.id);
      store.saveNow(); renderStoryCard(); renderProgress();
    });
    actions.append(editBtn, delBtn);
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
  if (!n.tasks.length) tasksEl.append(el('div', { class: 'empty' }, 'No tasks yet.'));
  for (const t of n.tasks) {
    const item = el('div', { class: 'task' + (t.completed ? ' completed' : '') });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!t.completed;
    cb.addEventListener('change', () => {
      const live = findNodeById(store.data.threads, n.id);
      const ti = live.tasks.findIndex(x => x.id === t.id);
      if (ti >= 0) { live.tasks[ti].completed = cb.checked; }
      store.saveNow();
      item.classList.toggle('completed', cb.checked);
    });
    const text = el('div', {}, t.text);
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
    const editBtn = el('button', { class: 'btn ghost' }, 'Edit');
    editBtn.addEventListener('click', () => {
      const val = confirmName('Edit task', t.text);
      if (val != null && val.trim()) {
        const live = findNodeById(store.data.threads, n.id);
        const ti = live.tasks.findIndex(x => x.id === t.id);
        if (ti >= 0) { live.tasks[ti].text = val.trim(); }
        store.saveNow(); renderStoryCard();
      }
    });
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      const live = findNodeById(store.data.threads, n.id);
      live.tasks = live.tasks.filter(x => x.id !== t.id);
      store.saveNow(); renderStoryCard(); renderProgress();
    });
    const avail = buildAvailabilityControls(n.id, t.id, () => renderStoryCard());
    avail.hidden = true;
    const availBtn = el('button', { class: 'btn ghost' }, 'Availability');
    availBtn.addEventListener('click', () => { avail.hidden = !avail.hidden; });
    btns.append(pri, availBtn, editBtn, delBtn);
    item.append(cb, text, btns);
    // Reason pill if blocked (no context filtering here)
    const reason = availabilityReason(t);
    if (reason) item.append(el('span', { class: 'pill' }, reason));
    // Availability controls (Review, hidden by default)
    item.append(avail);
    // Status tint classes
    if (t.completed) item.classList.add('status-completed');
    else if (isTaskAvailable(t)) item.classList.add('status-available');
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

function nextStory() {
  if (reviewState.idx < reviewState.ids.length - 1) {
    reviewState.idx += 1; renderProgress(); renderStoryCard(); saveReviewProgress();
  } else {
    // End of review: hide stage, show start button and a completion message
    $('#review-stage').hidden = true;
    const msg = $('#review-empty');
    msg.textContent = 'Review complete. Press Start Review to run again.';
    msg.hidden = false;
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
  // Attempt Firebase first; fallback to localStorage
  const usedFirebase = await store.tryFirebase();
  if (!usedFirebase) store.load();
  // Normalize, colorize and index
  (store.data.threads || []).forEach(normalizeNode);
  (store.data.pantry?.categories || []).forEach(normalizeCategory);
  autoAssignThreadColors();
  recomputeIndexes();
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
  }

  // Tabs
  $('#tab-prepare').addEventListener('click', () => switchView('prepare'));
  $('#tab-review').addEventListener('click', () => switchView('review'));
  $('#tab-tasks').addEventListener('click', () => switchView('tasks'));
  $('#tab-pantry').addEventListener('click', () => switchView('pantry'));

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
}

function onReviewVisibility() {
  const nodes = subthreadsForReview();
  const has = nodes.length > 0;
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

// ------------------------------
// Pantry views
// ------------------------------
function renderPantryActiveView() {
  const ptabPrep = $('#ptab-prepare');
  const ptabRev = $('#ptab-review');
  const ptabShop = $('#ptab-shopping');
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
  vPrep.hidden = active !== ptabPrep; vPrep.classList.toggle('active', active === ptabPrep);
  vRev.hidden = active !== ptabRev; vRev.classList.toggle('active', active === ptabRev);
  vShop.hidden = active !== ptabShop; vShop.classList.toggle('active', active === ptabShop);
  if (active === ptabPrep) renderPantryPrepare();
  if (active === ptabRev) pantryOnReviewVisibility();
  if (active === ptabShop) renderShoppingList();
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
  const title = el('div', { class: 'node-title' }, cat.name);
  const actions = el('div', { class: 'node-actions' });
  const rename = el('button', { class: 'btn ghost' }, 'Rename');
  rename.addEventListener('click', () => { const n = confirmName('Rename category', cat.name); if (!n) return; cat.name = n; store.saveNow(); renderPantryPrepare(); });
  const addSub = el('button', { class: 'btn ghost' }, '+ Subcategory');
  addSub.addEventListener('click', () => { const n = confirmName('New subcategory', ''); if (!n) return; cat.children.push(createCategory(n)); store.saveNow(); renderPantryPrepare(); });
  const enabledToggle = el('label', { class: 'subtext' });
  const en = el('input', { type: 'checkbox' }); en.checked = cat.enabled !== false; en.addEventListener('change', ()=>{ cat.enabled = en.checked; store.saveNow(); renderPantryPrepare(); });
  enabledToggle.append(en, document.createTextNode(' Enabled'));
  actions.append(rename, addSub, enabledToggle);
  header.append(title, actions);
  container.append(header);
  const meta = el('div', { class: 'subtext' }, `${(cat.children||[]).length} sub, ${(cat.items||[]).length} items`);
  container.append(meta);
  container.classList.toggle('disabled', cat.enabled === false);

  const list = el('div', { class: 'inline-list' });
  (cat.items||[]).forEach(item => {
    const row = el('div', { class: 'inline-item' });
    const top = el('div', { class: 'kv' });
    const label = el('div', {}, `${item.name}`);
    const actions = el('div', { class: 'meta' });
    const status = el('select', { class: 'priority-select' });
    [['to_buy','To buy'],['stocked','Stocked'],['not_needed','Not needed']].forEach(([v,t])=> status.append(el('option',{value:v},t)));
    status.value = item.status;
    status.addEventListener('change', ()=>{ item.status = status.value; store.saveNow(); renderPantryPrepare(); });
    const edit = el('button', { class: 'btn ghost' }, 'Edit');
    edit.addEventListener('click', ()=>{ const n = confirmName('Edit item name', item.name); if (n!=null && n.trim()) { item.name = n.trim(); store.saveNow(); renderPantryPrepare(); }});
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', ()=>{ cat.items = cat.items.filter(x=>x.id!==item.id); store.saveNow(); renderPantryPrepare(); });
    actions.append(status, edit, del);
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
let tasksViewState = { currentContext: 'Any', showBlocked: false };

function allContexts() {
  const set = new Set();
  const refs = flattenTaskRefs();
  refs.forEach(r => (r.task.contexts || []).forEach(c => set.add(c)));
  return Array.from(set).sort();
}

function renderTasksPane() {
  const root = $('#tasks-root');
  if (!root) return;
  root.innerHTML = '';

  // Controls
  const controls = $('#tasks-controls');
  if (controls) {
    controls.innerHTML = '';
    controls.append(el('label', {}, 'Context: '));
    const sel = el('select');
    sel.append(el('option', { value: 'Any' }, 'Any'));
    for (const c of allContexts()) sel.append(el('option', { value: c }, c));
    sel.value = tasksViewState.currentContext || 'Any';
    sel.addEventListener('change', () => { tasksViewState.currentContext = sel.value; renderTasksPane(); });
    const showLbl = el('label', {});
    const showCb = el('input', { type: 'checkbox' });
    showCb.checked = !!tasksViewState.showBlocked;
    showCb.addEventListener('change', () => { tasksViewState.showBlocked = showCb.checked; renderTasksPane(); });
    showLbl.append(showCb, document.createTextNode(' Show blocked'));
    controls.append(sel, showLbl);
  }

  const ctx = tasksViewState.currentContext === 'Any' ? null : tasksViewState.currentContext;
  const now = new Date();
  let refs = flattenTaskRefs();
  const filtered = refs.filter(ref => passesContext(ref.task, ctx) && (tasksViewState.showBlocked ? true : isTaskAvailable(ref.task, now, ctx)));
  refs = filtered
    .sort((a, b) => {
      const aa = isTaskAvailable(a.task, now, ctx) ? 0 : 1;
      const bb = isTaskAvailable(b.task, now, ctx) ? 0 : 1;
      if (aa !== bb) return aa - bb; // available first
      const pa = a.task.priority || 3; const pb = b.task.priority || 3;
      if (pa !== pb) return pa - pb; // 1 highest
      const da = a.task.availableAt ? new Date(a.task.availableAt).getTime() : Infinity;
      const db = b.task.availableAt ? new Date(b.task.availableAt).getTime() : Infinity;
      return da - db;
    });
  if (!refs.length) {
    root.append(el('div', { class: 'empty' }, 'No tasks yet.'));
    return;
  }
  for (const ref of refs) {
    const { task: t, node: n, root: r } = ref;
    const item = el('div', { class: 'task' + (t.completed ? ' completed' : ''), style: `border-left:6px solid ${r?.color || 'var(--accent)'}` });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!t.completed;
    cb.addEventListener('change', () => { t.completed = cb.checked; store.saveNow(); item.classList.toggle('completed', t.completed); });
    const main = el('div');
    main.append(el('div', {}, t.text));
    const reason = availabilityReason(t, now, ctx);
    const ctxLine = nodePath(n) + (reason ? ` • ${reason}` : '');
    main.append(el('div', { class: 'ctx' }, ctxLine));
    const actions = el('div', { class: 'meta' });
    const pri = el('select', { class: 'priority-select', title: 'Priority' });
    for (let i = 1; i <= 5; i++) pri.append(el('option', { value: String(i) }, i));
    pri.value = String(t.priority || 3);
    pri.addEventListener('change', () => { t.priority = Number(pri.value); store.saveNow(); renderTasksPane(); });
    const edit = el('button', { class: 'btn ghost' }, 'Edit');
    edit.addEventListener('click', () => {
      const val = confirmName('Edit task', t.text);
      if (val != null && val.trim()) { t.text = val.trim(); store.save(); renderTasksPane(); }
    });
    const del = el('button', { class: 'btn ghost' }, 'Remove');
    del.addEventListener('click', () => {
      n.tasks = n.tasks.filter(x => x.id !== t.id);
      store.save(); renderTasksPane(); renderThreads(); renderProgress(); if (!$('#review-stage').hidden) renderStoryCard();
    });
    const avail = buildAvailabilityControls(n.id, t.id, () => renderTasksPane());
    avail.hidden = true;
    const availBtn = el('button', { class: 'btn ghost' }, 'Availability');
    availBtn.addEventListener('click', () => { avail.hidden = !avail.hidden; });
    actions.append(pri, availBtn, edit, del);
    item.append(cb, main, actions);
    // Status tint classes
    if (t.completed) item.classList.add('status-completed');
    else if (isTaskAvailable(t, now, ctx)) item.classList.add('status-available');
    else item.classList.add('status-blocked');
    // Availability controls in Tasks pane (hidden by default)
    item.append(avail);
    root.append(item);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (window.daymxUnlockReady) {
    try { await window.daymxUnlockReady; } catch {}
  }
  init();
});
