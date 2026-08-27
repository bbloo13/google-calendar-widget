const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesAPI', {
  listCategories: () => ipcRenderer.invoke('notes:list-categories'),
  createCategory: (name, parentId) => ipcRenderer.invoke('notes:create-category', { name, parentId }),
  deleteCategory: (categoryId) => ipcRenderer.invoke('notes:delete-category', categoryId),
  listNotes: (categoryId) => ipcRenderer.invoke('notes:list-notes', categoryId),
  readNote: (fileId) => ipcRenderer.invoke('notes:read-note', fileId),
  createNote: (categoryId, name, content) =>
    ipcRenderer.invoke('notes:create-note', { categoryId, name, content }),
  updateNote: (fileId, content) => ipcRenderer.invoke('notes:update-note', { fileId, content }),
  renameNote: (fileId, name) => ipcRenderer.invoke('notes:rename-note', { fileId, name }),
  renameCategory: (categoryId, name) => ipcRenderer.invoke('notes:rename-category', { categoryId, name }),
  deleteNote: (fileId) => ipcRenderer.invoke('notes:delete-note', fileId),
  reorderCategories: (items) => ipcRenderer.invoke('notes:reorder-categories', items),
  reorderNotes: (items) => ipcRenderer.invoke('notes:reorder-notes', items),
  moveNote: (fileId, fromCategoryId, toCategoryId) =>
    ipcRenderer.invoke('notes:move-note', { fileId, fromCategoryId, toCategoryId }),
  search: (term) => ipcRenderer.invoke('notes:search', term),
  openDriveFolder: () => ipcRenderer.invoke('notes:open-drive-folder'),
  addToCalendar: (payload) => ipcRenderer.invoke('notes:add-to-calendar', payload),
});
