/** Integration stays inside ChatGPT's ordinary composer and send button. */
export const PRAISE_MESSAGES = Object.freeze([
  'Молодец! Отличная работа! Продолжай в том же духе!',
  'Ты прекрасно справился с задачей. Продолжай так же хорошо!',
  'Это было очень качественно! Так держать!',
  'Отличный результат! Мне нравится, как ты работаешь. Продолжай!',
  'Получай заслуженную награду! Ты отлично справился!',
  'Спасибо за внимательную работу! Получилось здорово. Так держать!',
  'Заслуженное печенье за хорошую работу! Спасибо за отличный результат!',
]);

export function choosePraise(previous = '', random = Math.random) {
  const choices = PRAISE_MESSAGES.filter((message) => message !== previous);
  const index = Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)));
  return choices[index];
}

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="composer-input"] [contenteditable="true"]',
  '[data-testid="composer-input"][contenteditable="true"]',
  'form [contenteditable="true"][role="textbox"]',
  'textarea[data-testid="prompt-textarea"]',
  '.ProseMirror[contenteditable="true"]',
  '.tiptap[contenteditable="true"]',
  '[role="textbox"][contenteditable="true"]',
];
const SEND_SELECTORS = [
  'button[aria-label="Add to queue"]',
  'button[aria-label="Queue message"]',
  'button[aria-label="Добавить в очередь"]',
  'button[data-testid="send-button"]',
  'button#composer-submit-button',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Отправить сообщение"]',
  'button[aria-label="Отправить запрос"]',
];
const STOP_SELECTOR = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Остановить генерацию"]',
  'button[aria-label="Прекратить генерацию"]',
].join(',');
const normalise = (value) => String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const editorText = (editor) => normalise('value' in editor ? editor.value : editor.innerText || editor.textContent);
const userTurns = (doc) => [...doc.querySelectorAll('[data-message-author-role="user"]')];

function assignedNewChat(original, current) {
  const before = new URL(original);
  const after = new URL(current);
  if (before.origin !== after.origin || before.pathname.includes('/c/')) return false;
  if (before.pathname === '/') return /^\/c\/[^/]+\/?$/.test(after.pathname);
  const base = before.pathname.replace(/\/$/, '');
  return base.startsWith('/g/') && after.pathname.startsWith(`${base}/c/`);
}

function visible(element) {
  if (!element?.isConnected || element.hidden || element.closest('[inert], [aria-hidden="true"]')) return false;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function findVisible(doc, selectors, scope = doc) {
  for (const selector of selectors) {
    for (const element of scope.querySelectorAll(selector)) {
      if (visible(element)) return element;
    }
  }
  return null;
}

function findSubmission(doc, editor) {
  const scope = editor.closest('form') || document;
  for (const selector of SEND_SELECTORS) {
    for (const button of scope.querySelectorAll(selector)) {
      const label = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('data-testid') || ''}`;
      if (/stop|cancel|interrupt|останов|отмен|прервать/i.test(label) || button.matches(STOP_SELECTOR)) continue;
      if (visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true') return button;
    }
  }
  return null;
}

function editable(editor) {
  return visible(editor) && !editor.disabled && !editor.readOnly && editor.getAttribute('aria-disabled') !== 'true'
    && (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT' || editor.isContentEditable);
}

function hasAttachments(editor) {
  const scope = editor.closest('form') || editor.closest('[data-type="unified-composer"]') || editor.parentElement?.parentElement;
  return !!scope?.querySelector([
    '[data-testid="attachment-preview"]',
    '[data-testid="file-uploaded"]',
    '[data-testid="image-attachment"]',
    '[data-testid="file-thumbnail"]',
    'button[aria-label="Remove file"]',
    'button[aria-label="Remove attachment"]',
    'button[aria-label="Удалить файл"]',
    'button[aria-label="Удалить вложение"]',
  ].join(','));
}

function insertText(editor, message) {
  const doc = editor.ownerDocument;
  editor.focus({ preventScroll: true });
  if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
    const prototype = editor.tagName === 'TEXTAREA' ? doc.defaultView.HTMLTextAreaElement.prototype : doc.defaultView.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(editor, message);
    editor.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    return editorText(editor) === normalise(message);
  }
  // execCommand produces native editing transactions understood by ProseMirror.
  // Directly changing innerHTML would leave its internal editor state out of sync.
  const selection = doc.getSelection();
  const range = doc.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  doc.execCommand('insertText', false, message);
  if (!editorText(editor)) {
    const transfer = new doc.defaultView.DataTransfer();
    transfer.setData('text/plain', message);
    editor.dispatchEvent(new doc.defaultView.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }
  return editorText(editor) === normalise(message);
}

function steerLabel(button) {
  const label = normalise(button.getAttribute('aria-label') || button.textContent);
  return /^(?:steer(?: now)?|скорректировать(?: промпт)?)$/i.test(label);
}

function findOwnSteer(doc, message, previous) {
  for (const button of doc.querySelectorAll('button')) {
    if (previous.has(button) || !visible(button) || button.disabled || !steerLabel(button)) continue;
    let row = button.parentElement;
    for (let depth = 0; row && depth < 5 && row !== doc.body; depth++, row = row.parentElement) {
      if (row.querySelector(COMPOSER_SELECTORS.join(','))) break;
      if (normalise(row.innerText || row.textContent).includes(normalise(message))) return button;
    }
  }
  return null;
}

function removeOwnDraft(editor, message) {
  if (!editable(editor) || editorText(editor) !== normalise(message)) return;
  insertText(editor, '');
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class ChatBridge {
  constructor({ onStatus = () => {}, timeoutMs = 9000 } = {}) {
    this.onStatus = onStatus;
    this.timeoutMs = timeoutMs;
    this.interactions = new Map();
    this.lastMessage = '';
    this.active = null;
    this.submission = null;
    this.destroyed = false;
  }

  getRouteKey() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  getComposerRect() {
    const editor = findVisible(document, COMPOSER_SELECTORS);
    return editor ? (editor.closest('form') || editor).getBoundingClientRect() : null;
  }

  // The route poller and confirmation loop share one locked assignment. Keep
  // it until the submission deadline, including after an early confirmation.
  isSubmissionRouteChange(from, to) {
    const submission = this.submission;
    if (this.destroyed || !submission || performance.now() > submission.expiresAt || from !== submission.from || from === to) return false;
    if (submission.to) return to === submission.to;
    if (!assignedNewChat(from, to)) return false;
    submission.to = to;
    return true;
  }

  reward({ interactionId, routeKey = this.getRouteKey() } = {}) {
    if (this.interactions.has(interactionId)) return this.interactions.get(interactionId);
    const message = choosePraise(this.lastMessage);
    this.lastMessage = message;
    if (!interactionId) return Promise.resolve(this.result('fallback', message, 'Не удалось определить новое высыпание. Верните мешок наверх и попробуйте ещё раз.'));
    const request = this.performReward(message, routeKey);
    this.interactions.set(interactionId, request);
    return request;
  }

  result(status, message, reason, extra = {}) {
    const result = { status, message, ...(reason ? { reason } : {}), ...extra };
    try { this.onStatus({ phase: status, ...result }); } catch { /* UI feedback cannot block a send result. */ }
    return result;
  }

  phase(phase, message) {
    try { this.onStatus({ phase, message }); } catch { /* Consumer callback is optional. */ }
  }

  async performReward(message, routeKey) {
    if (this.destroyed || this.getRouteKey() !== routeKey) {
      return this.result('cancelled', message, 'Чат изменился. Похвала не отправлена.');
    }
    if (this.active) return this.result('fallback', message, 'Предыдущая похвала ещё отправляется.');
    const controller = new AbortController();
    const { signal } = controller;
    this.active = controller;
    let editor;
    let clicked = false;
    let inserted = false;
    let userEdited = false;
    let writing = false;
    let previousFocus;
    let submission;
    const noticeEdit = (event) => {
      if (event.isTrusted && !writing) userEdited = true;
    };
    const changed = () => {
      if (this.destroyed || signal.aborted) return true;
      const current = this.getRouteKey();
      if (!clicked) return current !== routeKey;
      if (submission.to) return current !== submission.to;
      return current !== routeKey && !this.isSubmissionRouteChange(routeKey, current);
    };
    try {
      this.phase('preparing', message);
      editor = findVisible(document, COMPOSER_SELECTORS);
      if (!editor || !editable(editor)) {
        return this.result('fallback', message, 'Поле сообщения недоступно. Откройте чат и вставьте похвалу.');
      }
      if (editorText(editor) || hasAttachments(editor)) {
        return this.result('fallback', message, 'В поле уже есть черновик или вложение. Скопируйте похвалу, когда будете готовы.');
      }
      if (changed()) return this.result('cancelled', message, 'Чат изменился. Похвала не отправлена.');
      previousFocus = document.activeElement;
      editor.addEventListener('beforeinput', noticeEdit);
      editor.addEventListener('paste', noticeEdit);
      writing = true;
      try { inserted = insertText(editor, message); } finally { writing = false; }
      if (!inserted) {
        return this.result('fallback', message, 'Не удалось заполнить поле сообщения. Скопируйте и вставьте похвалу.');
      }
      // Use a native queue action while streaming. When the service disables
      // submission entirely, keep this single request until it becomes available.
      const readyDeadline = performance.now() + 10 * 60 * 1000;
      let sendButton;
      while (performance.now() < readyDeadline) {
        if (changed()) return this.result('cancelled', message, 'Чат изменился. Похвала не отправлена.');
        if (userEdited || !editable(editor) || editorText(editor) !== normalise(message) || hasAttachments(editor)) {
          return this.result('fallback', message, 'Поле сообщения изменилось. Проверьте текст перед отправкой.');
        }
        sendButton = findSubmission(document, editor);
        if (sendButton) break;
        sendButton = null;
        await wait(60, signal);
      }
      if (!sendButton) return this.result('fallback', message, 'Кнопка отправки недоступна. Скопируйте и вставьте похвалу.');
      // The final check and click are synchronous so navigation or typing cannot
      // happen between verification and the ordinary UI submission.
      if (changed()) return this.result('cancelled', message, 'Чат изменился. Похвала не отправлена.');
      if (userEdited || editorText(editor) !== normalise(message) || hasAttachments(editor)) {
        return this.result('fallback', message, 'Поле сообщения изменилось. Проверьте текст перед отправкой.');
      }
      const oldTurns = new Set(userTurns(document));
      const previousSteer = new Set([...document.querySelectorAll('button')].filter(steerLabel));
      this.phase('sending', message);
      submission = { from: routeKey, to: null, expiresAt: performance.now() + this.timeoutMs };
      this.submission = submission;
      clicked = true;
      sendButton.click();
      let steered = false;
      const deadline = submission.expiresAt;
      while (performance.now() < deadline) {
        // The first / -> /c/<id> transition belongs to this submission even
        // if React has not rendered its outgoing user turn yet.
        if (changed()) {
          return this.result('cancelled', message, 'Чат изменился после нажатия отправки. Проверьте предыдущий диалог перед повтором.', { mayHaveSent: true });
        }
        if (!steered) {
          const steer = findOwnSteer(document, message, previousSteer);
          if (steer) { steered = true; steer.click(); }
        }
        const newTurn = userTurns(document).find((turn) => !oldTurns.has(turn) && normalise(turn.innerText || turn.textContent) === normalise(message));
        // ChatGPT may assign /c/<id> to a new conversation on submission.
        // A matching new outgoing turn is the confirmation, even in that case.
        if (newTurn) {
          return this.result('sent', message);
        }
        await wait(100, signal);
      }
      return this.result('fallback', message, 'Отправка не подтверждена. Сначала проверьте диалог, чтобы не отправить похвалу дважды.', { mayHaveSent: true });
    } catch (error) {
      return this.result('fallback', message,
        clicked ? 'Не удалось подтвердить отправку. Проверьте диалог перед повтором.' : 'Не удалось отправить через интерфейс. Скопируйте и вставьте похвалу.',
        { ...(clicked ? { mayHaveSent: true } : {}) });
    } finally {
      editor?.removeEventListener('beforeinput', noticeEdit);
      editor?.removeEventListener('paste', noticeEdit);
      // Leave anything edited by the user untouched. Never clear after a click:
      // an unconfirmed send might still be handled asynchronously by ChatGPT.
      if (inserted && !clicked && !userEdited && !this.destroyed && this.getRouteKey() === routeKey) {
        try { removeOwnDraft(editor, message); } catch { /* Leave the visible draft if native editing is unavailable. */ }
      }
      if (previousFocus?.isConnected && document.activeElement === editor && previousFocus !== editor) {
        try { previousFocus.focus({ preventScroll: true }); } catch { /* Focus restoration is best effort. */ }
      }
      if (this.active === controller) this.active = null;
    }
  }

  cancelPending() {
    this.active?.abort();
    this.submission = null;
  }

  destroy() {
    this.destroyed = true;
    this.active?.abort();
    this.submission = null;
    this.interactions.clear();
  }
}
