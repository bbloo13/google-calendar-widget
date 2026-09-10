const categoryProgressBar = createProgressBar(document.getElementById('categoryProgressBar'));
const noteProgressBar = createProgressBar(document.getElementById('noteProgressBar'));
const editorProgressBar = createProgressBar(document.getElementById('editorProgressBar'));

const searchInput = document.getElementById('searchInput');
const categoryListEl = document.getElementById('categoryList');
const addCategoryBtn = document.getElementById('addCategoryBtn');
const openDriveBtn = document.getElementById('openDriveBtn');

const listTitleEl = document.getElementById('listTitle');
const noteListEl = document.getElementById('noteList');
const addNoteBtn = document.getElementById('addNoteBtn');

const titleInput = document.getElementById('titleInput');
const contentArea = document.getElementById('contentArea');
const saveStateEl = document.getElementById('saveState');
const strikeBtn = document.getElementById('strikeBtn');
const deleteNoteBtn = document.getElementById('deleteNoteBtn');
const addToCalendarBtn = document.getElementById('addToCalendarBtn');
const attachmentsListEl = document.getElementById('attachmentsList');
const editorPane = document.querySelector('.notes__editor');

const categoryContextMenu = document.getElementById('categoryContextMenu');
const addSubcategoryMenuItem = document.getElementById('addSubcategoryMenuItem');
const renameCategoryMenuItem = document.getElementById('renameCategoryMenuItem');
const deleteCategoryMenuItem = document.getElementById('deleteCategoryMenuItem');

let categories = []; // tree: [{ id, name, noteCount, children: [...] }]
let notes = [];
let selectedCategoryId = null;
let selectedNoteId = null;
let saveTimeout = null;
let contextMenuTarget = null; // { type: 'category' | 'note', id }
let expandedCategoryIds = new Set();
let currentAttachments = []; // files attached to the currently-open note

// Drag-and-drop state: a note carries its source category so a drop on a
// different category moves it; a category also carries its parent so reorder
// is scoped to siblings (dragging never re-nests a category).
let draggedNoteId = null;
let draggedNoteFromCategoryId = null;
let draggedCategoryId = null;
let draggedCategoryParentId = null;

const ROOT_PARENT_KEY = '__root__';

// Stale-while-revalidate caches, keyed by category/note id — painted instantly
// on a repeat visit within the same session, always reconciled by a real
// fetch right after (see selectCategory/loadNotes and selectNote below).
const notesCache = new Map(); // categoryId -> notes array
const noteContentCache = new Map(); // noteId -> { id, name, content, modifiedTime }
const attachmentsCache = new Map(); // noteId -> attachments array

/** Recursively finds a category node anywhere in the tree. */
function findCategory(id, list = categories) {
  for (const cat of list) {
    if (cat.id === id) return cat;
    const found = findCategory(id, cat.children || []);
    if (found) return found;
  }
  return null;
}

/** Finds the array (top-level `categories`, or some node's `.children`) that directly holds this id. */
function findCategoryContainer(id, list = categories) {
  if (list.some((c) => c.id === id)) return list;
  for (const cat of list) {
    const found = findCategoryContainer(id, cat.children || []);
    if (found) return found;
  }
  return null;
}

/** Expands every ancestor of `id` so it's visible in the tree (e.g. after jumping to it from search). */
function expandAncestors(id, list = categories, path = []) {
  for (const cat of list) {
    if (cat.id === id) {
      path.forEach((ancestorId) => expandedCategoryIds.add(ancestorId));
      return true;
    }
    if (expandAncestors(id, cat.children || [], [...path, cat.id])) return true;
  }
  return false;
}

// The Drive file keeps its real ".md" extension (so it stays recognizable as
// markdown in Drive preview, Obsidian, etc.) — this only hides it in the UI.
function displayName(name) {
  return name.replace(/\.md$/i, '');
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

// Swap point inside each row, as a fraction of its height, measured from the
// top — lower than 0.5 (the geometric midpoint) means the cursor only needs
// to reach partway into a row before the drag-target flips, so the reachable
// swap zone starts sooner instead of requiring you to pass dead center.
const SWAP_THRESHOLD_RATIO = 0.2;

/**
 * Sortable-style helper: finds which sibling the dragged element should land before.
 * The trigger line sits near whichever edge of a row you're approaching from
 * (top edge when dragging downward into it, bottom edge when dragging upward
 * into it) — using a single top-anchored line for both directions made upward
 * drags need to travel almost a full row further than downward ones to swap.
 */
function getDragAfterElement(container, y, selector) {
  const dragging = container.querySelector('.is-dragging');
  const items = [...container.querySelectorAll(`${selector}:not(.is-dragging)`)];

  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const approachingFromAbove = dragging
        ? !!(dragging.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING)
        : true;
      const ratio = approachingFromAbove ? SWAP_THRESHOLD_RATIO : 1 - SWAP_THRESHOLD_RATIO;
      const offset = y - box.top - box.height * ratio;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

/** Nearest-by-distance match (unlike a precise hover test) so a whole sidebar column, not just one row's exact pixels, counts as "over" that category. */
function getClosestElement(container, y, selector) {
  const items = [...container.querySelectorAll(selector)];
  if (items.length === 0) return null;
  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const dist = Math.abs(y - (box.top + box.height / 2));
      return dist < closest.dist ? { dist, element: child } : closest;
    },
    { dist: Infinity, element: null }
  ).element;
}

const AUTO_SCROLL_EDGE = 36; // px from a scrollable container's top/bottom edge that starts auto-scroll
const AUTO_SCROLL_SPEED = 10;

/** Lets a long list keep scrolling while a drag is held near its edge, instead of being capped to whatever's on screen. */
function autoScrollWhileDragging(container, clientY) {
  const rect = container.getBoundingClientRect();
  if (clientY - rect.top < AUTO_SCROLL_EDGE) container.scrollTop -= AUTO_SCROLL_SPEED;
  else if (rect.bottom - clientY < AUTO_SCROLL_EDGE) container.scrollTop += AUTO_SCROLL_SPEED;
}

// --- Categories (rendered as a tree — categories can hold sub-categories) ---

function renderCategoryNode(cat, depth, parentKey) {
  const li = document.createElement('li');
  li.className = 'notes__categoryItem' + (cat.id === selectedCategoryId ? ' is-active' : '');
  li.dataset.id = cat.id;
  li.dataset.parentKey = parentKey;
  li.dataset.depth = String(depth);
  li.style.paddingLeft = `${8 + depth * 14}px`;
  li.draggable = true;

  const hasChildren = !!(cat.children && cat.children.length > 0);
  const toggle = document.createElement('span');
  toggle.className = 'notes__categoryToggle';
  if (hasChildren) {
    toggle.textContent = expandedCategoryIds.has(cat.id) ? '▾' : '▸';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (expandedCategoryIds.has(cat.id)) expandedCategoryIds.delete(cat.id);
      else expandedCategoryIds.add(cat.id);
      renderCategories();
    });
  }

  const name = document.createElement('span');
  name.className = 'notes__categoryName';
  name.textContent = cat.name;
  const count = document.createElement('span');
  count.className = 'notes__categoryCount';
  count.textContent = cat.noteCount;

  li.appendChild(toggle);
  li.appendChild(name);
  li.appendChild(count);
  li.addEventListener('click', () => selectCategory(cat.id));
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu('category', cat.id, e.clientX, e.clientY);
  });

  li.addEventListener('dragstart', (e) => {
    draggedCategoryId = cat.id;
    draggedCategoryParentId = parentKey;
    draggedNoteId = null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', cat.id); // some platforms need real payload for drop to fire reliably
    li.classList.add('is-dragging');
  });
  li.addEventListener('dragend', async () => {
    li.classList.remove('is-dragging');
    categoryListEl.querySelectorAll('.is-dragover').forEach((el) => el.classList.remove('is-dragover'));
    // The dragover handler below already reordered the live DOM as a preview —
    // just resync the backing array and persist to whatever order is now on screen.
    // Scoped to same-parent siblings only, so a drag never re-nests a category.
    if (draggedCategoryId === cat.id) {
      const siblingSelector = `.notes__categoryItem[data-parent-key="${CSS.escape(parentKey)}"]`;
      const orderedIds = [...categoryListEl.querySelectorAll(siblingSelector)].map((el) => el.dataset.id);
      const container = findCategoryContainer(cat.id);
      if (container) {
        container.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
        await window.notesAPI.reorderCategories(container.map((c, i) => ({ id: c.id, order: i * 1000 })));
      }
    }
    draggedCategoryId = null;
    draggedCategoryParentId = null;
    draggedNoteId = null;
  });

  categoryListEl.appendChild(li);

  if (hasChildren && expandedCategoryIds.has(cat.id)) {
    for (const child of cat.children) renderCategoryNode(child, depth + 1, cat.id);
  }
}

function renderCategories() {
  categoryListEl.innerHTML = '';
  for (const cat of categories) renderCategoryNode(cat, 0, ROOT_PARENT_KEY);
}

// Container-level drag handlers (added once — the container element itself
// survives re-renders, only its children get replaced).
categoryListEl.addEventListener('dragover', (e) => {
  e.preventDefault(); // required for drop to fire at all
  autoScrollWhileDragging(categoryListEl, e.clientY);
  if (draggedCategoryId) {
    // Reordering categories: live-move the dragged row as you hover, pushing
    // siblings apart, instead of requiring a pixel-precise drop on one item.
    // Scoped to the dragged item's own parent, so it can't jump to a different nesting level.
    const dragging = categoryListEl.querySelector('.is-dragging');
    if (!dragging) return;
    const siblingSelector = `.notes__categoryItem[data-parent-key="${CSS.escape(draggedCategoryParentId)}"]`;
    const afterElement = getDragAfterElement(categoryListEl, e.clientY, siblingSelector);
    if (afterElement == null) {
      // Append after the last sibling (not necessarily the last DOM child overall).
      const siblings = categoryListEl.querySelectorAll(`${siblingSelector}:not(.is-dragging)`);
      const lastSibling = siblings[siblings.length - 1];
      if (lastSibling) lastSibling.after(dragging);
      else categoryListEl.appendChild(dragging);
    } else {
      categoryListEl.insertBefore(dragging, afterElement);
    }
  } else if (draggedNoteId) {
    // Dragging a note over the sidebar: highlight whichever category is nearest —
    // distance-based, not a precise hover, so the whole column is a usable target.
    const hovered = getClosestElement(categoryListEl, e.clientY, '.notes__categoryItem');
    categoryListEl
      .querySelectorAll('.notes__categoryItem')
      .forEach((el) => el.classList.toggle('is-dragover', el === hovered));
  }
});

categoryListEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (draggedNoteId) {
    const target = categoryListEl.querySelector('.notes__categoryItem.is-dragover');
    categoryListEl.querySelectorAll('.is-dragover').forEach((el) => el.classList.remove('is-dragover'));
    if (target) await handleNoteDroppedOnCategory(draggedNoteId, draggedNoteFromCategoryId, target.dataset.id);
  }
  // Category-reorder commit happens in that item's `dragend`, since the DOM
  // preview during dragover already reflects the final order.
});

// --- Context menu (add sub-category / rename / delete) — shared by categories and notes ---

function openContextMenu(type, id, x, y) {
  contextMenuTarget = { type, id };
  addSubcategoryMenuItem.style.display = type === 'category' ? '' : 'none';
  categoryContextMenu.style.left = `${x}px`;
  categoryContextMenu.style.top = `${y}px`;
  categoryContextMenu.classList.add('is-visible');
}

function closeContextMenu() {
  categoryContextMenu.classList.remove('is-visible');
  contextMenuTarget = null;
}

document.addEventListener('click', (e) => {
  if (!categoryContextMenu.contains(e.target)) closeContextMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeContextMenu();
});

function startRenameCategory(id) {
  const cat = findCategory(id);
  const li = categoryListEl.querySelector(`[data-id="${id}"]`);
  if (!cat || !li) return;

  li.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = cat.name;
  input.style.cssText = 'flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:13px;';
  li.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (shouldSave) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (shouldSave && name && name !== cat.name) {
      const res = await window.notesAPI.renameCategory(id, name);
      if (res.ok) {
        cat.name = res.category.name;
        if (selectedCategoryId === id) listTitleEl.textContent = cat.name;
      }
    }
    renderCategories();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/** Adds a new sub-category directly under `parentId`, expanding it so the new row appears right below, as requested. */
function startAddSubcategory(parentId) {
  expandedCategoryIds.add(parentId);
  renderCategories();
  const parentLi = categoryListEl.querySelector(`[data-id="${parentId}"]`);
  if (!parentLi) return;
  const depth = Number(parentLi.dataset.depth || 0) + 1;

  const li = document.createElement('li');
  li.className = 'notes__categoryItem';
  li.style.paddingLeft = `${8 + depth * 14}px`;
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '하위 카테고리 이름';
  input.style.cssText = 'flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:13px;';
  li.appendChild(input);
  parentLi.after(li);
  input.focus();

  let done = false;
  const finish = async (shouldCreate) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    li.remove();
    if (!shouldCreate || !name) return;
    const res = await window.notesAPI.createCategory(name, parentId);
    if (res.ok) {
      const parent = findCategory(parentId);
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(res.category);
      }
      renderCategories();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteCategoryFlow(id) {
  const cat = findCategory(id);
  const ok = await showConfirmDialog(
    `"${cat ? cat.name : ''}" 카테고리와 그 안의 메모를 모두 삭제할까요?\n(Google Drive 휴지통으로 이동하며, 복구할 수 있습니다)`
  );
  if (!ok) return;

  const res = await window.notesAPI.deleteCategory(id);
  if (!res.ok) return;
  const container = findCategoryContainer(id);
  if (container) {
    const idx = container.findIndex((c) => c.id === id);
    if (idx !== -1) container.splice(idx, 1);
  }
  if (selectedCategoryId === id) {
    selectedCategoryId = null;
    notes = [];
    clearEditor();
    listTitleEl.textContent = '카테고리를 선택하세요';
    addNoteBtn.disabled = true;
    noteListEl.innerHTML = '';
  }
  renderCategories();
}

addSubcategoryMenuItem.addEventListener('click', () => {
  const target = contextMenuTarget;
  closeContextMenu();
  if (target && target.type === 'category') startAddSubcategory(target.id);
});

renameCategoryMenuItem.addEventListener('click', () => {
  const target = contextMenuTarget;
  closeContextMenu();
  if (!target) return;
  if (target.type === 'category') startRenameCategory(target.id);
  else startRenameNote(target.id);
});

deleteCategoryMenuItem.addEventListener('click', async () => {
  const target = contextMenuTarget;
  closeContextMenu();
  if (!target) return;
  if (target.type === 'category') await deleteCategoryFlow(target.id);
  else await deleteNoteFlow(target.id);
});

async function loadCategories() {
  categoryProgressBar.start();
  const res = await window.notesAPI.listCategories();
  categoryProgressBar.finish();
  if (!res.ok) return;
  categories = res.categories;
  renderCategories();
}

async function selectCategory(id) {
  selectedCategoryId = id;
  selectedNoteId = null;
  searchInput.value = '';
  renderCategories();
  clearEditor();
  addNoteBtn.disabled = false;
  const cat = findCategory(id);
  listTitleEl.textContent = cat ? cat.name : '-';

  // Stale-while-revalidate: a category visited earlier this session paints
  // instantly from its last known list while a fresh fetch quietly confirms
  // it in the background — the real fetch below always still runs and wins.
  const cached = notesCache.get(id);
  if (cached) {
    notes = cached;
    renderNotes();
  } else {
    noteListEl.innerHTML = '';
    noteProgressBar.start(); // only for an actual first-time wait — a cached repaint needs no bar
  }
  await loadNotes(id, !cached);
}

function startAddCategory() {
  const li = document.createElement('li');
  li.className = 'notes__categoryItem';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '카테고리 이름';
  input.style.cssText = 'flex:1;background:transparent;border:none;outline:none;color:#fff;font-size:13px;';
  li.appendChild(input);
  categoryListEl.prepend(li);
  input.focus();

  // Removing the input while it's focused fires a synchronous native `blur`,
  // which would otherwise re-enter this same commit path — guard with `done`
  // so Enter/Escape and the resulting blur only ever act once.
  let done = false;
  const finish = async (shouldCreate) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    li.remove();
    if (!shouldCreate || !name) return;
    const res = await window.notesAPI.createCategory(name);
    if (res.ok) {
      categories.push(res.category);
      renderCategories();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

addCategoryBtn.addEventListener('click', startAddCategory);
openDriveBtn.addEventListener('click', () => window.notesAPI.openDriveFolder());

// --- Notes ---

function renderNotes() {
  noteListEl.innerHTML = '';
  if (notes.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'color:#52525f;font-size:12.5px;padding:8px;';
    empty.textContent = '메모 없음';
    noteListEl.appendChild(empty);
    return;
  }
  for (const note of notes) {
    const li = document.createElement('li');
    li.className = 'notes__noteItem' + (note.id === selectedNoteId ? ' is-active' : '');
    li.dataset.id = note.id;
    li.draggable = true;

    const title = document.createElement('div');
    title.className = 'notes__noteTitle';
    title.textContent = displayName(note.name);
    const meta = document.createElement('div');
    meta.className = 'notes__noteMeta';
    meta.textContent = formatTime(note.modifiedTime);

    li.appendChild(title);
    li.appendChild(meta);
    li.addEventListener('click', () => selectNote(note.id));
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openContextMenu('note', note.id, e.clientX, e.clientY);
    });

    li.addEventListener('dragstart', (e) => {
      draggedNoteId = note.id;
      draggedNoteFromCategoryId = selectedCategoryId;
      draggedCategoryId = null;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', note.id);
      li.classList.add('is-dragging');
    });
    li.addEventListener('dragend', async () => {
      li.classList.remove('is-dragging');
      // If it landed in a different category, that drop handler already
      // rebuilt this list (and reset draggedNoteId) — nothing left to commit here.
      if (draggedNoteId === note.id) {
        const orderedIds = [...noteListEl.querySelectorAll('.notes__noteItem')].map((el) => el.dataset.id);
        notes.sort((a, b) => orderedIds.indexOf(a.id) - orderedIds.indexOf(b.id));
        await window.notesAPI.reorderNotes(notes.map((n, i) => ({ id: n.id, order: i * 1000 })));
      }
      draggedNoteId = null;
      draggedNoteFromCategoryId = null;
    });

    noteListEl.appendChild(li);
  }
}

// Reordering notes within the currently-open category: same live push-apart
// preview as the category list, added once since noteListEl persists across renders.
noteListEl.addEventListener('dragover', (e) => {
  if (!draggedNoteId) return;
  e.preventDefault();
  autoScrollWhileDragging(noteListEl, e.clientY);
  const dragging = noteListEl.querySelector('.is-dragging');
  if (!dragging) return;
  const afterElement = getDragAfterElement(noteListEl, e.clientY, '.notes__noteItem');
  if (afterElement == null) noteListEl.appendChild(dragging);
  else noteListEl.insertBefore(dragging, afterElement);
});

async function handleNoteDroppedOnCategory(noteId, fromCategoryId, toCategoryId) {
  draggedNoteId = null;
  draggedNoteFromCategoryId = null;
  if (!fromCategoryId || fromCategoryId === toCategoryId) return;
  const res = await window.notesAPI.moveNote(noteId, fromCategoryId, toCategoryId);
  if (!res.ok) return;

  notes = notes.filter((n) => n.id !== noteId);
  notesCache.set(fromCategoryId, notes);
  renderNotes();
  if (selectedNoteId === noteId) clearEditor();

  const fromCat = findCategory(fromCategoryId);
  if (fromCat) fromCat.noteCount = Math.max(0, fromCat.noteCount - 1);
  const toCat = findCategory(toCategoryId);
  if (toCat) toCat.noteCount += 1;
  renderCategories();
}

async function loadNotes(categoryId, showProgress) {
  const res = await window.notesAPI.listNotes(categoryId);
  if (showProgress) noteProgressBar.finish();
  if (!res.ok) return;
  if (selectedCategoryId !== categoryId) return; // user already moved to a different category
  notes = res.notes;
  notesCache.set(categoryId, notes);
  renderNotes();
}

// The editor stores/loads plain markdown (so the .md file stays portable —
// openable in Drive's preview, Obsidian, etc.) but *edits* as one <div> per
// line inside a contenteditable, so a struck-through line actually renders
// struck through instead of showing raw `~~` markers.

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function markdownToEditorHTML(content) {
  const lines = content.length ? content.split('\n') : [''];
  return lines
    .map((line) => {
      const struck = line.match(/^~~(.*)~~$/);
      const text = struck ? struck[1] : line;
      const cls = struck ? ' note-line note-line--struck' : ' note-line';
      return `<div class="${cls.trim()}">${escapeHtml(text) || '<br>'}</div>`;
    })
    .join('');
}

function editorHTMLToMarkdown() {
  const lines = [];
  for (const child of contentArea.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const text = child.textContent;
      lines.push(child.classList.contains('note-line--struck') ? `~~${text}~~` : text);
    } else if (child.nodeType === Node.TEXT_NODE) {
      lines.push(child.textContent); // stray text before the first Enter creates a line div
    }
  }
  return lines.join('\n');
}

function clearEditor() {
  selectedNoteId = null;
  titleInput.value = '';
  contentArea.innerHTML = '';
  titleInput.disabled = true;
  contentArea.contentEditable = 'false';
  strikeBtn.disabled = true;
  deleteNoteBtn.disabled = true;
  addToCalendarBtn.disabled = true;
  saveStateEl.textContent = '';
  currentAttachments = [];
  attachmentsListEl.innerHTML = '';
}

function paintNote(note) {
  titleInput.value = displayName(note.name);
  contentArea.innerHTML = markdownToEditorHTML(note.content);
  titleInput.disabled = false;
  contentArea.contentEditable = 'true';
  strikeBtn.disabled = false;
  deleteNoteBtn.disabled = false;
  addToCalendarBtn.disabled = false;
  saveStateEl.textContent = `저장됨 ${formatTime(note.modifiedTime)}`;
}

/** Walks up from the selection to the direct line-<div> it's in (a child of contentArea). */
function getCurrentLine() {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  let node = sel.getRangeAt(0).startContainer;
  while (node && node !== contentArea) {
    if (node.parentElement === contentArea) return node;
    node = node.parentNode;
  }
  return null;
}

function updateStrikeBtnState() {
  const line = getCurrentLine();
  strikeBtn.classList.toggle('is-active', !!(line && line.classList && line.classList.contains('note-line--struck')));
}

contentArea.addEventListener('click', updateStrikeBtnState);
contentArea.addEventListener('keyup', updateStrikeBtnState);

// mousedown (not click) + preventDefault keeps focus/selection in contentArea
// instead of losing the cursor position to the button, the standard trick
// toolbar buttons over a contenteditable region use.
strikeBtn.addEventListener('mousedown', (e) => e.preventDefault());
strikeBtn.addEventListener('click', () => {
  const line = getCurrentLine();
  if (!line) return;
  line.classList.toggle('note-line--struck');
  updateStrikeBtnState();
  contentArea.dispatchEvent(new Event('input', { bubbles: true }));
});

async function selectNote(id) {
  selectedNoteId = id;
  renderNotes();
  currentAttachments = [];
  attachmentsListEl.innerHTML = '';

  // Stale-while-revalidate, same idea as category lists: paint instantly if
  // we've opened this note (and its attachments) before this session, then
  // confirm/update for real. The progress bar only shows when something is
  // actually missing from cache — otherwise the still-running real fetch
  // below would make a fully-cached repaint flash a bar for no reason.
  const cachedContent = noteContentCache.get(id);
  const cachedAttachments = attachmentsCache.get(id);
  if (cachedContent) paintNote(cachedContent);
  if (cachedAttachments) {
    currentAttachments = cachedAttachments;
    renderAttachments();
  }
  const bothCached = !!cachedContent && !!cachedAttachments;
  if (!bothCached) editorProgressBar.start();

  // Fetched together (not content-then-attachments) so the progress bar
  // covers both — otherwise attachments would visibly pop in late, after the
  // bar already said "done".
  const [noteRes, attachmentsRes] = await Promise.all([
    window.notesAPI.readNote(id),
    window.notesAPI.listAttachments(id),
  ]);
  if (!bothCached) editorProgressBar.finish();
  if (selectedNoteId !== id) return; // user already opened a different note by the time this resolved

  if (noteRes.ok) {
    noteContentCache.set(id, noteRes.note);
    paintNote(noteRes.note);
  }
  if (attachmentsRes.ok) {
    currentAttachments = attachmentsRes.attachments;
    attachmentsCache.set(id, attachmentsRes.attachments);
    renderAttachments();
  }
}

// --- Attachments: any file dropped or pasted into a note. Tagged by note id
// (see driveService.uploadAttachment), not by file name, so duplicate note
// titles or later renames never break the link.

function isImageAttachment(att) {
  return !!(att.mimeType && att.mimeType.startsWith('image/'));
}

function attachmentIcon(mimeType) {
  return mimeType && mimeType.startsWith('image/') ? '🖼️' : '📎';
}

function renderAttachments() {
  attachmentsListEl.innerHTML = '';
  for (const att of currentAttachments) {
    const chip = document.createElement('div');
    chip.className = 'notes__attachment';
    chip.title = att.name;

    const icon = document.createElement('span');
    icon.className = 'notes__attachmentIcon';
    icon.textContent = attachmentIcon(att.mimeType);

    const name = document.createElement('span');
    name.className = 'notes__attachmentName';
    name.textContent = att.name;

    const remove = document.createElement('span');
    remove.className = 'notes__attachmentRemove';
    remove.textContent = '×';
    remove.title = '첨부파일 삭제';
    remove.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the chip's own download
      removeAttachmentFlow(att.id, chip);
    });

    chip.appendChild(icon);
    chip.appendChild(name);
    chip.appendChild(remove);
    chip.addEventListener('click', (e) => {
      if (isImageAttachment(att)) {
        e.stopPropagation();
        showAttachmentChoice(att, chip, icon);
      } else {
        downloadAttachmentFlow(att, chip, icon);
      }
    });
    attachmentsListEl.appendChild(chip);
  }
}

// A tiny "미리보기 / 다운로드" menu for images only — everything else has just
// one sensible action (download), so it skips straight to that on click.
let openAttachmentMenu = null;

function closeAttachmentMenu() {
  if (openAttachmentMenu) {
    openAttachmentMenu.remove();
    openAttachmentMenu = null;
  }
}

function showAttachmentChoice(att, chip, icon) {
  closeAttachmentMenu();
  const rect = chip.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'notes__contextMenu is-visible';
  menu.style.left = `${rect.left}px`;
  menu.style.top = `${rect.bottom + 4}px`;

  const previewBtn = document.createElement('button');
  previewBtn.className = 'notes__contextMenuItem';
  previewBtn.textContent = '미리보기';
  previewBtn.addEventListener('click', async () => {
    closeAttachmentMenu();
    chip.classList.add('is-downloading');
    const res = await window.notesAPI.previewAttachment(att.id);
    chip.classList.remove('is-downloading');
    if (!res.ok) alert(`미리보기 실패: ${res.error}`);
  });

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'notes__contextMenuItem';
  downloadBtn.textContent = '다운로드';
  downloadBtn.addEventListener('click', () => {
    closeAttachmentMenu();
    downloadAttachmentFlow(att, chip, icon);
  });

  menu.appendChild(previewBtn);
  menu.appendChild(downloadBtn);
  document.body.appendChild(menu);
  openAttachmentMenu = menu;
}

document.addEventListener('click', (e) => {
  if (openAttachmentMenu && !openAttachmentMenu.contains(e.target)) closeAttachmentMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAttachmentMenu();
});

async function removeAttachmentFlow(fileId, chip) {
  const noteId = selectedNoteId;
  chip.classList.add('is-downloading'); // reuse the spinner while the delete is in flight
  const res = await window.notesAPI.deleteAttachment(fileId);
  if (!res.ok) {
    chip.classList.remove('is-downloading');
    alert(`삭제 실패: ${res.error}`);
    return;
  }
  if (selectedNoteId !== noteId) return; // moved to a different note while this was deleting
  currentAttachments = currentAttachments.filter((a) => a.id !== fileId);
  attachmentsCache.set(noteId, currentAttachments);
  renderAttachments();
}

/** Click-to-receive: no save-location prompt, just drops straight into the Downloads folder like a browser download. */
async function downloadAttachmentFlow(att, chip, icon) {
  if (chip.classList.contains('is-downloading')) return;
  chip.classList.add('is-downloading');
  const res = await window.notesAPI.downloadAttachment(att.id);
  chip.classList.remove('is-downloading');
  icon.textContent = res.ok ? '✅' : '⚠️';
  setTimeout(() => {
    icon.textContent = attachmentIcon(att.mimeType);
  }, 1200);
  if (!res.ok) alert(`다운로드 실패: ${res.error}`);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadAttachmentFile(file, name) {
  if (!selectedNoteId || !selectedCategoryId) return;
  const noteId = selectedNoteId;
  const data = await fileToBase64(file);
  const res = await window.notesAPI.uploadAttachment({
    categoryId: selectedCategoryId,
    noteId,
    name,
    mimeType: file.type || 'application/octet-stream',
    data,
  });
  if (selectedNoteId !== noteId) return; // moved to a different note while this was uploading
  if (res.ok) {
    currentAttachments.push(res.attachment);
    attachmentsCache.set(noteId, currentAttachments);
    renderAttachments();
  } else {
    alert(`첨부파일 업로드 실패: ${res.error}`);
  }
}

// Drag-and-drop: real files keep their own name ("그대로 저장") — only a
// clipboard-pasted image (which has no file name of its own) gets one made
// up from the note's title.
['dragenter', 'dragover'].forEach((evt) => {
  editorPane.addEventListener(evt, (e) => {
    if (!selectedNoteId || !e.dataTransfer || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    editorPane.classList.add('is-dragover');
  });
});

editorPane.addEventListener('dragleave', (e) => {
  if (e.target === editorPane) editorPane.classList.remove('is-dragover');
});

editorPane.addEventListener('drop', async (e) => {
  editorPane.classList.remove('is-dragover');
  if (!selectedNoteId || !e.dataTransfer || e.dataTransfer.files.length === 0) return;
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    await uploadAttachmentFile(file, file.name);
  }
});

contentArea.addEventListener('paste', (e) => {
  if (!selectedNoteId || !e.clipboardData) return;
  const imageItem = [...e.clipboardData.items].find((item) => item.type.startsWith('image/'));
  if (!imageItem) return; // not an image — let normal text paste proceed
  e.preventDefault();
  const file = imageItem.getAsFile();
  if (!file) return;
  const ext = imageItem.type.split('/')[1] || 'png';
  const title = titleInput.value.trim() || '제목 없음';
  const index = currentAttachments.length + 1;
  uploadAttachmentFile(file, `${title} (${index}).${ext}`);
});

function startAddNote() {
  if (!selectedCategoryId) return;
  const li = document.createElement('li');
  li.className = 'notes__noteItem';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '메모 제목';
  input.style.cssText = 'width:100%;background:transparent;border:none;outline:none;color:#fff;font-size:13px;';
  li.appendChild(input);
  noteListEl.prepend(li);
  input.focus();

  let done = false;
  const finish = async (shouldCreate) => {
    if (done) return;
    done = true;
    const name = input.value.trim() || '제목 없음';
    li.remove();
    if (!shouldCreate) return;
    const res = await window.notesAPI.createNote(selectedCategoryId, `${name}.md`, '');
    if (res.ok) {
      notes.unshift(res.note);
      const cat = findCategory(selectedCategoryId);
      if (cat) cat.noteCount += 1;
      renderCategories();
      renderNotes();
      selectNote(res.note.id);
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

addNoteBtn.addEventListener('click', startAddNote);

// --- Editor: autosave content, rename on title change ---

const SAVE_DEBOUNCE_MS = 400; // was 800 — halves the pause-before-save-starts delay

contentArea.addEventListener('input', () => {
  if (!selectedNoteId) return;
  const noteId = selectedNoteId;
  saveStateEl.textContent = '입력 중...';
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    saveStateEl.textContent = '저장 중...';
    const content = editorHTMLToMarkdown();
    const res = await window.notesAPI.updateNote(noteId, content);
    if (selectedNoteId !== noteId) return; // moved to a different note while this save was in flight
    if (res.ok) {
      const note = notes.find((n) => n.id === noteId);
      if (note) note.modifiedTime = res.note.modifiedTime;
      const cached = noteContentCache.get(noteId);
      if (cached) noteContentCache.set(noteId, { ...cached, content, modifiedTime: res.note.modifiedTime });
      saveStateEl.textContent = `저장됨 ${formatTime(res.note.modifiedTime)}`;
    } else {
      saveStateEl.textContent = '저장 실패';
    }
  }, SAVE_DEBOUNCE_MS);
});

titleInput.addEventListener('blur', async () => {
  if (!selectedNoteId) return;
  const name = `${titleInput.value.trim() || '제목 없음'}.md`;
  const res = await window.notesAPI.renameNote(selectedNoteId, name);
  if (res.ok) {
    const note = notes.find((n) => n.id === selectedNoteId);
    if (note) note.name = res.note.name;
    renderNotes();
  }
});

titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') contentArea.focus();
});

/** Inline rename from the note-list context menu (as opposed to the editor's own title field). */
function startRenameNote(id) {
  const note = notes.find((n) => n.id === id);
  const li = noteListEl.querySelector(`[data-id="${id}"]`);
  if (!note || !li) return;

  li.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = displayName(note.name);
  input.style.cssText = 'width:100%;background:transparent;border:none;outline:none;color:#fff;font-size:13px;';
  li.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (shouldSave) => {
    if (done) return;
    done = true;
    const nameOnly = input.value.trim() || '제목 없음';
    const fullName = `${nameOnly}.md`;
    if (shouldSave && fullName !== note.name) {
      const res = await window.notesAPI.renameNote(id, fullName);
      if (res.ok) {
        note.name = res.note.name;
        if (selectedNoteId === id) titleInput.value = nameOnly;
      }
    }
    renderNotes();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

async function deleteNoteFlow(id) {
  if (!(await showConfirmDialog('이 메모를 삭제할까요? (Google Drive 휴지통으로 이동합니다)'))) return;
  const res = await window.notesAPI.deleteNote(id);
  if (!res.ok) return;
  notes = notes.filter((n) => n.id !== id);
  notesCache.set(selectedCategoryId, notes);
  noteContentCache.delete(id);
  attachmentsCache.delete(id);
  const cat = findCategory(selectedCategoryId);
  if (cat) cat.noteCount = Math.max(0, cat.noteCount - 1);
  renderCategories();
  renderNotes();
  if (selectedNoteId === id) clearEditor();
}

deleteNoteBtn.addEventListener('click', () => {
  if (!selectedNoteId) return;
  deleteNoteFlow(selectedNoteId);
});

// --- Add-to-calendar popup ---

addToCalendarBtn.addEventListener('click', async () => {
  if (!selectedNoteId) return;
  const payload = await showAddEventPopup({
    title: titleInput.value.trim() || '제목 없음',
    description: editorHTMLToMarkdown(),
  });
  if (!payload) return;

  const res = await window.notesAPI.addEvent(payload);
  if (res.ok) {
    saveStateEl.textContent = '캘린더에 추가됨';
    setTimeout(() => {
      if (selectedNoteId) saveStateEl.textContent = `저장됨 ${formatTime(new Date().toISOString())}`;
    }, 2000);
  } else {
    alert(`일정 추가 실패: ${res.error}`);
  }
});

// --- Search (title + content, across every category) ---

let searchTimeout = null;

function exitSearchMode() {
  if (selectedCategoryId) {
    const cat = findCategory(selectedCategoryId);
    listTitleEl.textContent = cat ? cat.name : '-';
    addNoteBtn.disabled = false;
    renderNotes();
  } else {
    listTitleEl.textContent = '카테고리를 선택하세요';
    addNoteBtn.disabled = true;
    noteListEl.innerHTML = '';
  }
}

function renderSearchResults(term, results) {
  listTitleEl.textContent = `검색 결과 (${results.length})`;
  addNoteBtn.disabled = true;
  noteListEl.innerHTML = '';

  if (results.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'color:#52525f;font-size:12.5px;padding:8px;';
    empty.textContent = '검색 결과 없음';
    noteListEl.appendChild(empty);
    return;
  }

  const lowerTerm = term.toLowerCase();
  for (const note of results) {
    const li = document.createElement('li');
    li.className = 'notes__noteItem' + (note.id === selectedNoteId ? ' is-active' : '');

    const title = document.createElement('div');
    title.className = 'notes__noteTitle';
    title.textContent = displayName(note.name);

    const catId = note.parents && note.parents[0];
    const cat = findCategory(catId);
    const matchTag = note.name.toLowerCase().includes(lowerTerm) ? '제목 일치' : '본문 일치';
    const meta = document.createElement('div');
    meta.className = 'notes__noteMeta';
    meta.textContent = `${cat ? cat.name + ' · ' : ''}${matchTag} · ${formatTime(note.modifiedTime)}`;

    li.appendChild(title);
    li.appendChild(meta);
    li.addEventListener('click', () => {
      if (catId) {
        selectedCategoryId = catId;
        expandAncestors(catId);
        renderCategories();
      }
      selectNote(note.id);
    });
    noteListEl.appendChild(li);
  }
}

async function runSearch(term) {
  const res = await window.notesAPI.search(term);
  if (!res.ok || searchInput.value.trim() !== term) return; // stale response, a newer search superseded it
  renderSearchResults(term, res.results);
}

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const term = searchInput.value.trim();
  if (!term) {
    exitSearchMode();
    return;
  }
  searchTimeout = setTimeout(() => runSearch(term), 300);
});

loadCategories();
