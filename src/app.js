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
  const title = el('div', { class: 'node-title' }, node.name || 'Untitled');
  const actions = el('div', { class: 'node-actions' });

  const btnRename = el('button', { class: 'btn ghost' }, 'Rename');
  btnRename.addEventListener('click', () => {
    const name = confirmName('Rename thread/subthread', node.name);
    if (!name) return;
    node.name = name;
    store.save();
    renderThreads();
  });

  const btnAddChild = el('button', { class: 'btn ghost' }, '+ Subthread');
  btnAddChild.addEventListener('click', () => {
    const name = confirmName('New subthread name', '');
    if (!name) return;
    node.children.push(createNode(name));
    store.save();
    renderThreads();
  });

  const btnQuestions = el('button', { class: 'btn ghost' }, 'Questions');
  btnQuestions.addEventListener('click', () => openQuestionsModal(node.id));

  const btnTasks = el('button', { class: 'btn ghost' }, 'Tasks');
  btnTasks.addEventListener('click', () => openTasksModal(node.id));

  actions.append(btnRename, btnAddChild, btnQuestions, btnTasks);
  header.append(title, actions);
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
  const nodes = subthreadsForReview();
  reviewState = { nodes, idx: 0 };
  if (!nodes.length) {
    $('#review-empty').hidden = false;
    $('#review-stage').hidden = true;
    return;
  }
  $('#review-empty').hidden = true;
  $('#review-stage').hidden = false;
  renderProgress();
  renderStoryCard();
}

function renderProgress() {
  const bar = $('#story-progress');
  bar.innerHTML = '';
  const total = reviewState.nodes.length || 1;
  for (let i = 0; i < total; i++) {
    const seg = el('div', { class: 'segment' });
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

  // Header
  const header = el('div', { class: 'story-header' });
  header.append(el('div', { class: 'story-title' }, n.name));

  // Questions
  const qSection = el('div', { class: 'story-section' });
  qSection.append(el('div', { class: 'subtext' }, 'Questions'));
  if (!n.questions.length) qSection.append(el('div', { class: 'empty' }, 'No questions yet.'));
  for (const q of n.questions) {
    const wrap = el('div', { class: 'inline-item' });
    const label = el('div', {}, q.text);
    const note = el('textarea', { placeholder: 'Notes… (optional, not saved)' });
    wrap.append(label, note);
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
  tSection.append(el('div', { class: 'subtext' }, 'Tasks'));
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
    const editBtn = el('button', { class: 'btn ghost' }, 'Edit');
    editBtn.addEventListener('click', () => {
      const val = confirmName('Edit task', t.text);
      if (val != null) { t.text = val; store.save(); renderStoryCard(); }
    });
    item.append(cb, text, editBtn);
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
    // End of review
    $('#story-card').innerHTML = '';
    $('#story-card').append(el('div', { class: 'empty' }, 'Review complete. Great work!'));
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
    store.save();
  }

  // Tabs
  $('#tab-prepare').addEventListener('click', () => switchView('prepare'));
  $('#tab-review').addEventListener('click', () => switchView('review'));

  // Prepare actions
  $('#btn-add-thread').addEventListener('click', () => {
    const name = confirmName('New thread name');
    if (!name) return;
    store.data.threads.push(createNode(name));
    store.save();
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
  $('#review-empty').hidden = has ? true : false;
  $('#review-stage').hidden = true;
}

document.addEventListener('DOMContentLoaded', init);
