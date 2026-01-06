// DayMX – mobile-first SPA for daily thread reviews

// ------------------------------
// Persistence
// ------------------------------
const STORAGE_KEY = 'daymx-data-v1';

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const defaultData = () => ({
  threads: [], // array of nodes
});

const store = {
  data: null,
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.data = raw ? JSON.parse(raw) : defaultData();
    } catch (e) {
      console.warn('Failed to load data, resetting', e);
      this.data = defaultData();
    }
  },
  save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  },
};

// ------------------------------
// Data helpers
// ------------------------------
function createNode(name = 'Untitled') {
  return { id: uid('node'), name, children: [], questions: [], tasks: [] };
}

function createQuestion(text = '') {
  return { id: uid('q'), text };
}

function createTask(text = '') {
  return { id: uid('t'), text, completed: false };
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
  return nodes; // change to nodes.filter(n => n.children.length === 0) to only include leaves
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
  n.children.forEach(normalizeNode);
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

  actions.append(btnRename, btnAddChild, btnQuestions, btnTasks);
  header.append(titleWrap, actions);
  container.append(header);

  const footer = el('div', { class: 'kv' });
  const meta = el('div', { class: 'subtext' }, `${node.children.length} sub, ${node.questions.length} q, ${node.tasks.length} tasks`);
  footer.append(meta, el('div'));
  container.append(footer);

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
  nodes: [],
  idx: 0,
};

function startReview() {
  // ensure latest structure is indexed
  recomputeIndexes();
  const nodes = subthreadsForReview();
  reviewState = { nodes, idx: 0 };
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
}

function renderProgress() {
  const bar = $('#story-progress');
  bar.innerHTML = '';
  const total = reviewState.nodes.length || 1;
  for (let i = 0; i < total; i++) {
    const node = reviewState.nodes[i];
    const root = rootOf(node);
    // divider between different root threads
    if (i > 0) {
      const prevRoot = rootOf(reviewState.nodes[i - 1]);
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
  const n = reviewState.nodes[reviewState.idx];
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
      if (val != null && val.trim()) { q.text = val.trim(); store.save(); renderStoryCard(); }
    });
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      n.questions = n.questions.filter(x => x.id !== q.id);
      store.save(); renderStoryCard(); renderProgress();
    });
    actions.append(editBtn, delBtn);
    top.append(label, actions);
    const note = el('textarea', { placeholder: 'Notes… (optional, not saved)' });
    wrap.append(top, note);
    qSection.append(wrap);
  }
  // Quick add question in review
  const addQ = el('div', { class: 'add-row' });
  const qInput = el('input', { type: 'text', placeholder: 'Add question…' });
  const qBtn = el('button', { class: 'btn' }, 'Add');
  qBtn.addEventListener('click', () => {
    const t = qInput.value.trim(); if (!t) return;
    n.questions.push(createQuestion(t)); qInput.value = '';
    store.save(); renderProgress(); renderStoryCard();
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
      t.completed = cb.checked; store.save();
      item.classList.toggle('completed', t.completed);
    });
    const text = el('div', {}, t.text);
    const btns = el('div');
    const editBtn = el('button', { class: 'btn ghost' }, 'Edit');
    editBtn.addEventListener('click', () => {
      const val = confirmName('Edit task', t.text);
      if (val != null && val.trim()) { t.text = val.trim(); store.save(); renderStoryCard(); }
    });
    const delBtn = el('button', { class: 'btn ghost' }, 'Remove');
    delBtn.addEventListener('click', () => {
      n.tasks = n.tasks.filter(x => x.id !== t.id);
      store.save(); renderStoryCard(); renderProgress();
    });
    btns.append(editBtn, delBtn);
    item.append(cb, text, btns);
    tasksEl.append(item);
  }
  // Quick add task in review
  const addT = el('div', { class: 'add-row' });
  const tInput = el('input', { type: 'text', placeholder: 'Add task…' });
  const tBtn = el('button', { class: 'btn' }, 'Add');
  tBtn.addEventListener('click', () => {
    const t = tInput.value.trim(); if (!t) return;
    n.tasks.push(createTask(t)); tInput.value = '';
    store.save(); renderProgress(); renderStoryCard();
  });
  addT.append(tInput, tBtn);

  card.append(header, qSection, tSection, tasksEl, addT);
}

function nextStory() {
  if (reviewState.idx < reviewState.nodes.length - 1) {
    reviewState.idx += 1; renderProgress(); renderStoryCard();
  } else {
    // End of review: hide stage, show start button and a completion message
    $('#review-stage').hidden = true;
    const msg = $('#review-empty');
    msg.textContent = 'Review complete. Press Start Review to run again.';
    msg.hidden = false;
    $('#btn-start-review').hidden = false;
  }
}

function prevStory() {
  if (reviewState.idx > 0) {
    reviewState.idx -= 1; renderProgress(); renderStoryCard();
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
function init() {
  store.load();
  // Normalize, colorize and index
  (store.data.threads || []).forEach(normalizeNode);
  autoAssignThreadColors();
  recomputeIndexes();
  // Seed example if empty
  if (!store.data.threads.length) {
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
}

function switchView(name) {
  const prepare = $('#view-prepare');
  const review = $('#view-review');
  const tPrepare = $('#tab-prepare');
  const tReview = $('#tab-review');
  const isPrepare = name === 'prepare';
  prepare.hidden = !isPrepare; review.hidden = isPrepare;
  prepare.classList.toggle('active', isPrepare);
  review.classList.toggle('active', !isPrepare);
  tPrepare.classList.toggle('active', isPrepare);
  tReview.classList.toggle('active', !isPrepare);
  onReviewVisibility();
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

document.addEventListener('DOMContentLoaded', init);
