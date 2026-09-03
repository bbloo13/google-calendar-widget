const { google } = require('googleapis');
const { Readable } = require('stream');

const ROOT_FOLDER_NAME = 'Calendar Widget 메모';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const NOTE_MIME = 'text/markdown';

// The client wrapper is cached too, but keyed to the specific auth object it
// was built from — after a dead-token self-heal (see withAuthRetry in
// googleAuth.js) a fresh auth object shows up and this rebuilds instead of
// reusing the old dead one.
let cachedDrive = null;
let cachedDriveAuth = null;
function driveClient(auth) {
  if (!cachedDrive || cachedDriveAuth !== auth) {
    cachedDrive = google.drive({ version: 'v3', auth });
    cachedDriveAuth = auth;
  }
  return cachedDrive;
}

function textToStream(text) {
  return Readable.from([text]);
}

/** Reads back the app-private drag order we stamp on each file/folder (missing = sorts last). */
function orderOf(file) {
  const raw = file.appProperties && file.appProperties.order;
  return raw === undefined ? Number.MAX_SAFE_INTEGER : Number(raw);
}

function sortByOrder(files) {
  return [...files].sort((a, b) => orderOf(a) - orderOf(b));
}

// Cached across calls so two near-simultaneous requests (e.g. the double-fire
// that used to happen on Enter) can't race into creating duplicate root folders.
let rootFolderPromise = null;

/** Finds (or lazily creates) the single app-owned root folder that holds all note categories. */
function ensureRootFolder(auth) {
  if (rootFolderPromise) return rootFolderPromise;

  rootFolderPromise = (async () => {
    const drive = driveClient(auth);
    const res = await drive.files.list({
      q: `name='${ROOT_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
      fields: 'files(id,name)',
      spaces: 'drive',
    });
    if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;

    const created = await drive.files.create({
      resource: { name: ROOT_FOLDER_NAME, mimeType: FOLDER_MIME },
      fields: 'id',
    });
    return created.data.id;
  })().catch((err) => {
    rootFolderPromise = null; // let a failed attempt be retried
    throw err;
  });

  return rootFolderPromise;
}

/**
 * Lists every category folder as a tree (categories can hold sub-categories),
 * each with its own direct note count. Drive has no "descendant of" query, so
 * this pulls every folder the app owns in one call and builds the tree
 * client-side — still just two requests total, regardless of nesting depth.
 */
async function listCategories(auth) {
  const drive = driveClient(auth);
  const rootId = await ensureRootFolder(auth);

  const foldersRes = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,parents,appProperties)',
    spaces: 'drive',
    pageSize: 1000,
  });
  const allFolders = (foldersRes.data.files || []).filter((f) => f.id !== rootId);
  if (allFolders.length === 0) return { rootId, categories: [] };

  // One combined query for every category's note count instead of one round
  // trip per category — this was the main thing making the window feel slow.
  const parentClauses = allFolders.map((f) => `'${f.id}' in parents`).join(' or ');
  const notesRes = await drive.files.list({
    q: `(${parentClauses}) and mimeType!='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,parents)',
    spaces: 'drive',
    pageSize: 1000,
  });
  const countByParent = {};
  for (const file of notesRes.data.files || []) {
    const parent = file.parents && file.parents[0];
    if (parent) countByParent[parent] = (countByParent[parent] || 0) + 1;
  }

  const byParent = {};
  for (const folder of allFolders) {
    const parent = (folder.parents && folder.parents[0]) || rootId;
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push(folder);
  }

  function buildTree(parentId) {
    return sortByOrder(byParent[parentId] || []).map((folder) => ({
      id: folder.id,
      name: folder.name,
      noteCount: countByParent[folder.id] || 0,
      children: buildTree(folder.id),
    }));
  }

  return { rootId, categories: buildTree(rootId) };
}

/** Lists the notes inside one category folder. */
async function listNotes(auth, categoryId) {
  const drive = driveClient(auth);
  const res = await drive.files.list({
    q: `'${categoryId}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,modifiedTime,appProperties)',
    spaces: 'drive',
  });
  return sortByOrder(res.data.files || []);
}

/** Creates a category folder — under another category if `parentId` is given, otherwise at the top level. */
async function createCategory(auth, name, parentId) {
  const drive = driveClient(auth);
  const parent = parentId || (await ensureRootFolder(auth));
  const created = await drive.files.create({
    resource: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parent],
      appProperties: { order: String(Date.now()) },
    },
    fields: 'id,name',
  });
  return { id: created.data.id, name: created.data.name, noteCount: 0, children: [] };
}

async function readNote(auth, fileId) {
  const drive = driveClient(auth);
  const [meta, content] = await Promise.all([
    drive.files.get({ fileId, fields: 'id,name,modifiedTime' }),
    drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' }),
  ]);
  return { id: meta.data.id, name: meta.data.name, modifiedTime: meta.data.modifiedTime, content: content.data || '' };
}

async function createNote(auth, categoryId, name, content) {
  const drive = driveClient(auth);
  const created = await drive.files.create({
    resource: {
      name,
      mimeType: NOTE_MIME,
      parents: [categoryId],
      appProperties: { order: String(Date.now()) },
    },
    media: { mimeType: NOTE_MIME, body: textToStream(content) },
    fields: 'id,name,modifiedTime',
  });
  return created.data;
}

async function updateNote(auth, fileId, content) {
  const drive = driveClient(auth);
  const updated = await drive.files.update({
    fileId,
    media: { mimeType: NOTE_MIME, body: textToStream(content) },
    fields: 'id,name,modifiedTime',
  });
  return updated.data;
}

/** Renames a note or a category folder — Drive's rename call is identical for both. */
async function renameItem(auth, fileId, name) {
  const drive = driveClient(auth);
  const updated = await drive.files.update({ fileId, resource: { name }, fields: 'id,name' });
  return updated.data;
}

/** Soft-deletes (moves to Drive trash) — recoverable from drive.google.com trash. */
async function trashFile(auth, fileId) {
  const drive = driveClient(auth);
  await drive.files.update({ fileId, resource: { trashed: true } });
}

/** Persists a new drag order for a set of notes or categories (order values only need relative rank). */
async function reorderItems(auth, items) {
  const drive = driveClient(auth);
  await Promise.all(
    items.map(({ id, order }) =>
      drive.files.update({ fileId: id, resource: { appProperties: { order: String(order) } } })
    )
  );
}

/** Moves a note into a different category folder (changes its Drive parent). */
async function moveNote(auth, fileId, fromCategoryId, toCategoryId) {
  const drive = driveClient(auth);
  await drive.files.update({
    fileId,
    addParents: toCategoryId,
    removeParents: fromCategoryId,
    resource: { appProperties: { order: String(Date.now()) } },
    fields: 'id,parents',
  });
}

/** Searches note titles and content across every category (Drive's fullText index covers both). */
async function searchNotes(auth, term) {
  const drive = driveClient(auth);
  const escaped = term.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `fullText contains '${escaped}' and mimeType!='${FOLDER_MIME}' and trashed=false`,
    fields: 'files(id,name,modifiedTime,parents)',
    orderBy: 'modifiedTime desc',
    spaces: 'drive',
    pageSize: 50,
  });
  return res.data.files || [];
}

async function getRootFolderUrl(auth) {
  const rootId = await ensureRootFolder(auth);
  return `https://drive.google.com/drive/folders/${rootId}`;
}

module.exports = {
  listCategories,
  listNotes,
  createCategory,
  readNote,
  createNote,
  updateNote,
  renameItem,
  trashFile,
  reorderItems,
  moveNote,
  searchNotes,
  getRootFolderUrl,
};
