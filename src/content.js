import { GoodGPTScene } from './scene.js';
import { ChatBridge } from './chat-bridge.js';

// Isolated content script. No page globals, network requests or API credentials.
const HOST_ID = 'goodgpt-extension';
const runtime = globalThis.chrome?.runtime;
const storage = globalThis.chrome?.storage;
const localPreview = ['localhost', '127.0.0.1'].includes(location.hostname);
const allowed = ['chatgpt.com', 'chat.openai.com'].includes(location.hostname);
if ((allowed || localPreview) && !document.getElementById(HOST_ID)) start();

async function start() {
  const defaults = { enabled: true, tutorialSeen: false, gentle: false };
  let settings = { ...defaults };
  try { if (storage?.local) Object.assign(settings, await storage.local.get(defaults)); } catch { /* Unloaded extension. */ }
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;display:block;color-scheme:light;';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { --ink:#332b22; --muted:#786c5d; --paper:#faf5ea; --ease-out:cubic-bezier(.23,1,.32,1); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
    * { box-sizing:border-box; }
    .hint { position:fixed; right:40px; top:221px; width:235px; padding:8px 11px; border:1px solid #d4c3a787; border-radius:10px; background:#faf5eaf5; text-align:center; color:#705637; font:12px/1.55 system-ui,sans-serif; box-shadow:0 3px 12px #0001; pointer-events:none; opacity:0; transform:translateY(-4px); transition:opacity 180ms var(--ease-out),transform 180ms var(--ease-out); }
    .hint.visible { opacity:1; transform:translateY(0); }
    .notice { position:fixed; left:50%; bottom:30px; width:max-content; max-width:min(440px,calc(100vw - 32px)); border:1px solid #dfd3bd; border-radius:15px; padding:15px 18px; background:var(--paper); color:var(--ink); box-shadow:0 8px 32px #0002; opacity:0; transform:translate(-50%,10px); transition:opacity 200ms var(--ease-out),transform 200ms var(--ease-out); pointer-events:none; visibility:hidden; font:13px/1.5 system-ui,sans-serif; }
    .notice.visible { opacity:1; transform:translate(-50%,0); pointer-events:auto; visibility:visible; }
    .notice[data-state="sent"] { border-color:#bac5a4; background:#f3f6eb; }
    .notice-title { margin:0; font-weight:650; letter-spacing:-.1px; }
    .notice-detail { margin:4px 0 0; color:var(--muted); font-size:12px; }
    .notice-quote { margin:10px 0 0; padding:9px 11px; border-left:2px solid #c2a170; color:#55432d; background:#efe7d84d; user-select:text; }
    .actions { display:flex; gap:14px; align-items:center; margin-top:12px; }
    button { appearance:none; border:0; padding:0; font:600 12px/1.4 system-ui,sans-serif; background:transparent; color:#72502c; cursor:pointer; text-underline-offset:3px; }
    button:focus-visible { outline:2px solid #ad8351; outline-offset:4px; border-radius:2px; }
    .dismiss { color:#877c6d; font-weight:400; }
    @media(hover:hover) and (pointer:fine) { button:hover { text-decoration:underline; } }
    [hidden] { display:none !important; }
    @media(max-width:600px) { .hint { top:184px; right:10px; width:185px; } .notice { bottom:18px; } }
    @media(prefers-reduced-motion:reduce) { .hint,.notice { transition:opacity 150ms var(--ease-out); } .hint,.hint.visible { transform:none; } .notice,.notice.visible { transform:translateX(-50%); } }
  `;
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Немного благодарности. Потяните мешок вниз и переверните колёсиком.';
  const notice = document.createElement('div');
  notice.className = 'notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const title = document.createElement('p'); title.className = 'notice-title';
  const detail = document.createElement('p'); detail.className = 'notice-detail';
  const quote = document.createElement('p'); quote.className = 'notice-quote'; quote.hidden = true;
  const actions = document.createElement('div'); actions.className = 'actions'; actions.hidden = true;
  const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Скопировать похвалу';
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'dismiss'; dismiss.textContent = 'Закрыть';
  actions.append(copy, dismiss); notice.append(title, detail, quote, actions);
  // The scene contains only the bag, ropes and sweets. No visible text overlays.
  hint.hidden = true; notice.hidden = true;
  root.append(style);
  document.documentElement.append(host);
  let hintTimer, noticeTimer, fallbackMessage = '', interactionRoute = location.origin + location.pathname;
  let generation = 0, enabled = Boolean(settings.enabled), destroyed = false;

  function showHint(text, ms = 6500) {
    // Instructions live in the extension popup.
  }
  function hideNotice() {
    clearTimeout(noticeTimer);
    notice.classList.remove('visible');
  }
  function showNotice(heading, body, state, message = '') {
    if (!enabled || destroyed) return;
    clearTimeout(noticeTimer);
    notice.dataset.state = state;
    title.textContent = heading; detail.textContent = body;
    quote.hidden = !message; quote.textContent = message;
    actions.hidden = state !== 'fallback';
    fallbackMessage = message;
    copy.textContent = 'Скопировать похвалу';
    // Keep failure details available to local diagnostics without displaying a panel.
  }
  copy.addEventListener('click', async () => {
    if (!fallbackMessage) return;
    try {
      await navigator.clipboard.writeText(fallbackMessage);
      copy.textContent = 'Скопировано';
      detail.textContent = 'Вставьте текст в нужный чат и нажмите кнопку отправки.';
    } catch {
      const range = document.createRange(); range.selectNodeContents(quote);
      const selection = root.getSelection?.() || document.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      detail.textContent = 'Выделите текст, скопируйте его и вставьте в чат.';
    }
  });
  dismiss.addEventListener('click', hideNotice);
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  const bridge = new ChatBridge();
  const assetURL = (path) => runtime?.id ? runtime.getURL(path) : `/extension/${path}`;
  const scene = new GoodGPTScene({
    root,
    assets: { bag: assetURL('assets/bag.png'), treats: assetURL('assets/treats.png') },
    reducedMotion: settings.gentle || media.matches,
    onFirstInteraction() {
      if (!settings.tutorialSeen) {
        settings.tutorialSeen = true;
        storage?.local?.set({ tutorialSeen: true }).catch(() => {});
      }
    },
    onStatus(event) {
      if (event.type === 'grab') {
        interactionRoute = bridge.getRouteKey();
        showHint(event.text, 10000);
      } else if (event.type === 'pour') {
        hint.classList.remove('visible');
      } else if (event.type === 'hint') {
        showHint(event.text);
      } else if (event.type === 'asset-error') {
        showNotice('Не удалось загрузить угощения', event.text, 'error');
      } else if (event.type === 'reset') {
        hint.classList.remove('visible');
      }
    },
    async onReward({ interactionId }) {
      const token = generation;
      showNotice('Тёплые слова уже в пути', 'Передаём поощрение через поле сообщения…', 'sending');
      const result = await bridge.reward({ interactionId, routeKey: interactionRoute });
      if (token !== generation || !enabled || destroyed) return;
      if (result.status === 'sent') {
        showNotice('Благодарность доставлена', 'Похвала отправлена в этот диалог.', 'sent');
        celebrate();
      } else if (result.status === 'fallback') {
        const text = result.mayHaveSent ? 'Не удалось подтвердить отправку' : 'Похвала готова';
        showNotice(text, result.reason || 'Скопируйте текст и отправьте его через поле сообщения.', 'fallback', result.message);
      } else hideNotice();
    },
  });

  function celebrate() {
    // Quiet success: a brief warm halo around the bag, no extra overlay or confetti layer.
    if (!settings.gentle && !media.matches) scene.bagImage.animate([
      { filter: 'drop-shadow(0 8px 8px #20100533)' },
      { filter: 'drop-shadow(0 0 16px #f3cf8499)' },
      { filter: 'drop-shadow(0 8px 8px #20100533)' },
    ], { duration: 700, easing: 'ease-out' });
  }
  function applySettings(changes) {
    Object.assign(settings, changes);
    if ('enabled' in changes) {
      enabled = Boolean(settings.enabled); generation++;
      scene.setEnabled(enabled); hideNotice(); hint.classList.remove('visible');
      // Cancels any queued preparation; a button click already made is never retried.
      bridge.cancelPending?.();
    }
    if ('gentle' in changes) scene.setReducedMotion(settings.gentle || media.matches);
    if ('resetAt' in changes) { generation++; bridge.cancelPending?.(); scene.reset(); hideNotice(); }
  }
  const onStorage = (changes, area) => {
    if (area !== 'local') return;
    applySettings(Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.newValue])));
  };
  storage?.onChanged?.addListener(onStorage);
  const onMotion = () => scene.setReducedMotion(settings.gentle || media.matches);
  media.addEventListener('change', onMotion);
  let route = bridge.getRouteKey();
  const routeTimer = setInterval(() => {
    const next = bridge.getRouteKey();
    if (next === route) return;
    const ownSubmission = bridge.isSubmissionRouteChange?.(route, next);
    route = next;
    scene.reset({ immediate: true }); hint.classList.remove('visible');
    if (!ownSubmission) {
      generation++; hideNotice(); bridge.cancelPending?.();
    }
  }, 250);
  const onPageHide = (event) => { if (!event.persisted) destroy(); };
  window.addEventListener('pagehide', onPageHide);
  function destroy() {
    destroyed = true; generation++;
    clearInterval(routeTimer); clearTimeout(hintTimer); clearTimeout(noticeTimer);
    storage?.onChanged?.removeListener(onStorage); media.removeEventListener('change', onMotion);
    window.removeEventListener('pagehide', onPageHide);
    scene.destroy(); bridge.destroy(); host.remove();
  }
  scene.setEnabled(enabled);
  scene.bag.addEventListener('focus', () => { if (scene.mode === 'hung') showHint('Потяните вниз. Колёсико — перевернуть. Клавиатура: пробел, стрелки, Escape.'); });
  scene.bag.addEventListener('pointerenter', () => { if (scene.mode === 'hung') showHint('Потяните вниз · колёсико или Shift + движение — перевернуть', 3500); });
  scene.bagImage.addEventListener('error', () => showNotice('Не удалось загрузить мешок', 'Обновите расширение и перезагрузите страницу.', 'error'));
  if (!settings.tutorialSeen) showHint(hint.textContent, 12000);
}
