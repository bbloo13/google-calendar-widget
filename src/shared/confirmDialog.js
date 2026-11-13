/**
 * Dark-themed confirm dialog matching the app's own look, in place of the
 * OS-styled `window.confirm()` popup. Shared by the widget and notes windows
 * (each loads this file directly via a <script> tag before its own renderer.js).
 */
function showConfirmDialog(message, { confirmLabel = '삭제', cancelLabel = '취소' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirmDialog__overlay';

    const box = document.createElement('div');
    box.className = 'confirmDialog__box';

    const messageEl = document.createElement('div');
    messageEl.className = 'confirmDialog__message';
    messageEl.textContent = message;

    const btns = document.createElement('div');
    btns.className = 'confirmDialog__btns';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirmDialog__btn';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirmDialog__btn confirmDialog__btn--danger';
    confirmBtn.textContent = confirmLabel;

    btns.appendChild(cancelBtn);
    btns.appendChild(confirmBtn);
    box.appendChild(messageEl);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finish = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };

    document.addEventListener('keydown', onKeydown);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    confirmBtn.focus();
  });
}
