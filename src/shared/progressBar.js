/**
 * Drives a `.progressBar` element that already sits in the page (inside a
 * `.progressBarTrack`, right where the loading content itself will appear —
 * a bar living at the window's outer edge turned out too easy to miss).
 * There's no real progress to report for a single API call, so this fakes it
 * the way YouTube/GitHub's loading bars do: jump quickly, then crawl and
 * wait, then snap to 100% and fade out on finish().
 */
function createProgressBar(bar) {
  let timer = null;
  let width = 0;

  function start() {
    clearInterval(timer);
    width = 0;
    bar.style.transition = 'none';
    bar.style.opacity = '1';
    bar.style.width = '0%';
    void bar.offsetWidth; // force reflow so the transition below re-applies from 0
    bar.style.transition = 'width 0.2s ease-out, opacity 0.3s ease-out';

    timer = setInterval(() => {
      const cap = 90; // never reaches 100% on its own — only finish() does that
      width += (cap - width) * 0.15;
      bar.style.width = `${width}%`;
    }, 200);
  }

  function finish() {
    clearInterval(timer);
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.opacity = '0';
    }, 200);
  }

  return { start, finish };
}
