/* GoodGPT macOS: AppKit overlay, local images, ordinary Accessibility input.
 * Run only as the packaged .app (or osascript -l JavaScript GoodGPT.js Resources).
 * No browser debugging ports, service APIs, network calls or model credentials.
 */
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
ObjC.import('CoreFoundation');
// Use object-aware signatures for the toll-free CF/AX references. These explicit
// signatures also avoid JXA treating AXChildren's output as an untyped buffer.
ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);

function run(argv) {
  'use strict';
  var resources = argv[0];
  if (!resources) throw new Error('GoodGPT: Resources directory was not provided.');
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // Accessory app: menu bar, no Dock tile.
  var ownPID = Number($.NSProcessInfo.processInfo.processIdentifier);
  var bagImage = $.NSImage.alloc.initWithContentsOfFile($(resources + '/bag.png'));
  var atlas = $.NSImage.alloc.initWithContentsOfFile($(resources + '/treats.png'));
  if (!bagImage || !atlas || !bagImage.isValid || !atlas.isValid) {
    var errorAlert = $.NSAlert.alloc.init;
    errorAlert.messageText = $('GoodGPT: не найдены изображения');
    errorAlert.informativeText = $('Распакуйте приложение целиком и откройте GoodGPT.app заново.');
    errorAlert.runModal;
    return;
  }
  var defaults = $.NSUserDefaults.standardUserDefaults;
  var state = {
    paused: false, gentle: Boolean(defaults.boolForKey('goodgpt.gentle')), systemGentle: false,
    mode: 'hung', x: 0, y: 121, tx: 0, ty: 121,
    angle: 0, targetAngle: 0, vx: 0, vy: 0, av: 0, elapsed: 0,
    treats: [], fibers: [], poured: 0, rewarded: false, accumulator: 0,
    pointer: null, frozenTarget: null, currentTarget: null,
    notice: '', noticeUntil: 0, lastPraise: '', send: null,
    sink: null, nextDetect: 0, lastTick: Date.now() / 1000, frame: 0,
    screen: null, width: 0, height: 0, homeX: 0, homeY: 121,
    lastPermissionPrompt: 0, escapeWasDown: false
  };
  var panel, view, timer, controller, statusItem, targetMenu, pauseMenu, gentleMenu;
  try { state.systemGentle = Boolean($.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion); } catch (_) {}
  var praise = [
    'Молодец! Отличная работа! Продолжай в том же духе!',
    'Ты прекрасно справился с задачей. Продолжай так же хорошо!',
    'Это было очень качественно! Так держать!',
    'Отличный результат! Мне нравится, как ты работаешь. Продолжай!',
    'Получай заслуженную награду! Ты отлично справился!',
    'Спасибо за внимательную работу! Получилось здорово. Так держать!'
  ];
  var STEP = 1 / 120;
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function normal(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function unwrap(value) { try { return ObjC.unwrap(value); } catch (_) { return null; } }
  function str(value) {
    if (value === null || value === undefined) return '';
    try { if ($.CFGetTypeID(value) === $.CFURLGetTypeID()) return String(unwrap($.CFURLGetString(value)) || ''); } catch (_) {}
    var text = unwrap(value);
    return typeof text === 'string' || typeof text === 'number' ? String(text) : '';
  }
  function attribute(element, name) {
    if (!element) return null;
    try {
      var out = Ref();
      return $.AXUIElementCopyAttributeValue(element, $(name), out) === 0 ? out[0] : null;
    } catch (_) { return null; }
  }
  function attrText(element, name) { return str(attribute(element, name)); }
  function boolAttribute(element, name, fallback) {
    var value = attribute(element, name);
    if (value === null) return fallback;
    var unwrapped = unwrap(value);
    return typeof unwrapped === 'boolean' ? unwrapped : Number(unwrapped) !== 0;
  }
  function sameElement(a, b) {
    if (!a || !b) return false;
    try { return Boolean($.CFEqual(a, b)); } catch (_) { return false; }
  }
  function children(element) {
    var value = attribute(element, 'AXChildren');
    if (!value) return [];
    try {
      var count = Number(value.count), list = [];
      for (var i = 0; i < count; i++) list.push(value.objectAtIndex(i));
      return list;
    } catch (_) {
      try { return ObjC.deepUnwrap(value) || []; } catch (__) { return []; }
    }
  }
  // Bounded breadth-first traversal. Nothing is read from background apps.
  function walk(root, limit) {
    var queue = [{ element: root, depth: 0 }], result = [], visited = 0;
    while (queue.length && visited < (limit || 240)) {
      var entry = queue.shift();
      if (!entry.element) continue;
      visited++; result.push(entry.element);
      if (entry.depth >= 13) continue;
      var next = children(entry.element);
      for (var i = 0; i < next.length && queue.length < 400; i++) queue.push({ element: next[i], depth: entry.depth + 1 });
    }
    return result;
  }
  function description(element) {
    return [attrText(element, 'AXIdentifier'), attrText(element, 'AXTitle'), attrText(element, 'AXDescription'), attrText(element, 'AXHelp'), attrText(element, 'AXPlaceholderValue')].join(' ').toLowerCase();
  }
  function trusted(prompt) {
    try {
      return Boolean(prompt ? $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true })) : $.AXIsProcessTrusted());
    } catch (_) { return false; }
  }
  function requestPermission() {
    if (trusted(false)) { notice('Доступ разрешён. Откройте Codex или Claude (Code).', 5); return; }
    state.lastPermissionPrompt = state.elapsed;
    trusted(true);
    notice('Разрешите Accessibility для GoodGPT (или osascript) в настройках macOS.', 12);
  }
  function browserURL(windowElement) {
    var queue = [{ element: windowElement, depth: 0 }], visited = 0, fallback = '';
    while (queue.length && visited++ < 220) {
      var entry = queue.shift(), element = entry.element;
      if (!element) continue;
      var role = attrText(element, 'AXRole');
      if (role === 'AXWebArea') {
        var url = attrText(element, 'AXURL');
        if (url) return url;
      }
      if (role === 'AXTextField' && /address|search or enter|адрес|поиск.*адрес/.test(description(element))) {
        fallback = attrText(element, 'AXValue');
      }
      if (entry.depth < 13) {
        var next = children(element);
        for (var n = 0; n < next.length && queue.length < 400; n++) queue.push({ element: next[n], depth: entry.depth + 1 });
      }
    }
    return /^(?:chatgpt\.com|chat\.openai\.com)(?:[\/?#]|$)/i.test(fallback) ? 'https://' + fallback : fallback;
  }
  function isChatURL(url) { return /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:[\/?#]|$)/i.test(url); }
  function detectTarget() {
    try {
      var running = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!running) return null;
      var pid = Number(running.processIdentifier);
      if (pid === ownPID) return state.currentTarget;
      var bundle = str(running.bundleIdentifier).toLowerCase();
      var name = str(running.localizedName);
      var lower = name.toLowerCase();
      var kind = bundle === 'com.openai.chat' || lower === 'chatgpt' ? 'ChatGPT' :
        (bundle === 'com.openai.codex' || lower === 'codex' ? 'Codex' :
        (/^com\.anthropic\.(?:claudefordesktop|claude|claudecode)$/.test(bundle) || /^(?:claude|claude code|claude-code|claudecode)$/.test(lower) ? 'Claude Code' : ''));
      var browser = /^(?:com\.google\.chrome(?:\.canary)?|com\.microsoft\.edgemac|com\.brave\.browser|com\.apple\.safari|org\.mozilla\.firefox)$/.test(bundle);
      if (!kind && !browser) return null;
      var ax = $.AXUIElementCreateApplication(pid);
      $.AXUIElementSetMessagingTimeout(ax, 0.12);
      // Electron exposes its ordinary accessibility tree after this standard request.
      if (kind) {
        try { $.AXUIElementSetAttributeValue(ax, $('AXManualAccessibility'), $.kCFBooleanTrue); } catch (_) {}
      }
      var win = attribute(ax, 'AXFocusedWindow');
      if (!win) return kind ? { pid: pid, name: kind, bundle: bundle, app: ax, window: null, url: '', title: '', native: true } : null;
      var url = browser ? browserURL(win) : '';
      if (browser && !isChatURL(url)) return null;
      return { pid: pid, name: kind || 'ChatGPT · ' + name, bundle: bundle, app: ax, window: win, url: url, title: attrText(win, 'AXTitle'), native: Boolean(kind) };
    } catch (_) { return null; }
  }
  function stillTarget(target) {
    if (!target) return false;
    try {
      var running = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      if (!running || Number(running.processIdentifier) !== target.pid) return false;
      var win = attribute(target.app, 'AXFocusedWindow');
      if (!sameElement(win, target.window)) return false;
      if (target.url && browserURL(win) !== target.url) return false;
      var title = attrText(win, 'AXTitle');
      return !target.title || !title || title === target.title;
    } catch (_) { return false; }
  }
  function composerScore(element, focused, target) {
    var role = attrText(element, 'AXRole');
    if (role !== 'AXTextArea' && role !== 'AXTextField') return -1;
    if (!boolAttribute(element, 'AXEnabled', true)) return -1;
    var label = description(element);
    if (/search|find|address|terminal|editor content|source code|filename|file name|поиск|терминал|редактор|имя файла/.test(label)) return -1;
    var known = /prompt-textarea|claude-textarea|composer|message|prompt|ask|follow.?up|reply|tell claude|chat input|what.*(?:like|want).*build|how can i help|сообщ|спрос|запрос|напишите|введите.*задач/.test(label);
    if (known) return 100 + (sameElement(element, focused) ? 20 : 0) + (role === 'AXTextArea' ? 5 : 0);
    // ChatGPT has no source editor: its focused text area is also a safe composer.
    if (target.name === 'ChatGPT' && sameElement(element, focused) && role === 'AXTextArea') return 50;
    return -1;
  }
  function inspectComposer(target) {
    var nodes = walk(target.window, 350);
    var focused = attribute(target.app, 'AXFocusedUIElement');
    if (focused) nodes.unshift(focused);
    var best = null, score = -1;
    for (var i = 0; i < nodes.length; i++) {
      var label = description(nodes[i]);
      var role = attrText(nodes[i], 'AXRole');
      if (role === 'AXButton' && /remove attachment|remove file|remove image|delete attachment|удалить вложение|удалить файл|удалить изображение/.test(label)) {
        return { reason: 'В сообщении есть вложение. Похвала не добавлена к вашему черновику.' };
      }
      var candidate = composerScore(nodes[i], focused, target);
      if (candidate > score) { best = nodes[i]; score = candidate; }
    }
    if (!best) return { reason: 'Откройте поле сообщения Codex или Claude (Code) и попробуйте снова.' };
    state.sink = composerBounds(best);
    var raw = attribute(best, 'AXValue');
    if (raw === null) return { reason: 'Не удалось прочитать поле сообщения. Ничего не отправлено.' };
    if (normal(str(raw))) return { reason: 'В поле есть ваш черновик. GoodGPT оставил его без изменений.' };
    return { editor: best, nodes: nodes };
  }
  function isSteer(element) {
    if (attrText(element, 'AXRole') !== 'AXButton' || !boolAttribute(element, 'AXEnabled', true)) return false;
    return /^(?:steer(?: now)?|скорректировать(?: промпт)?)$/i.test(normal(attrText(element, 'AXTitle') || attrText(element, 'AXDescription')));
  }
  function composerBounds(editor) {
    try {
      var p = Ref($.NSMakePoint(0, 0)), z = Ref($.NSMakeSize(0, 0));
      if (!$.AXValueGetValue(attribute(editor, 'AXPosition'), 1, p) || !$.AXValueGetValue(attribute(editor, 'AXSize'), 2, z)) return null;
      var point = p[0], size = z[0], main = $.NSScreen.screens.objectAtIndex(0).frame;
      return { left: point.x - state.screen.minX, top: point.y + state.screen.maxY - main.origin.y - main.size.height, width: size.width, height: size.height };
    } catch (_) { return null; }
  }
  function key(code, flags) {
    var down = $.CGEventCreateKeyboardEvent(null, code, true);
    var up = $.CGEventCreateKeyboardEvent(null, code, false);
    if (!down || !up) return false;
    $.CGEventSetFlags(down, flags || 0); $.CGEventSetFlags(up, flags || 0);
    $.CGEventPost(0, down); $.CGEventPost(0, up);
    $.CFRelease(down); $.CFRelease(up);
    return true;
  }
  function snapshotClipboard(pb) {
    var saved = [], items = pb.pasteboardItems;
    if (!items) return saved;
    for (var i = 0; i < Number(items.count); i++) {
      var item = items.objectAtIndex(i), copy = $.NSPasteboardItem.alloc.init, types = item.types;
      for (var t = 0; t < Number(types.count); t++) {
        var type = types.objectAtIndex(t), data = item.dataForType(type);
        if (data) copy.setDataForType(data.copy, type);
      }
      saved.push(copy);
    }
    return saved;
  }
  function restoreClipboard(job) {
    if (!job || !job.clipboard || Number(job.clipboard.changeCount) !== job.clipCount) return;
    try {
      job.clipboard.clearContents;
      if (job.savedClipboard.length) job.clipboard.writeObjects($(job.savedClipboard));
    } catch (_) {}
  }
  function countMessage(nodes, message, editor) {
    var count = 0;
    for (var i = 0; i < nodes.length; i++) {
      var role = attrText(nodes[i], 'AXRole');
      if (role !== 'AXStaticText' || normal(attrText(nodes[i], 'AXValue')) !== normal(message)) continue;
      var parent = nodes[i], insideEditor = false;
      for (var p = 0; parent && p < 9; p++) {
        if (sameElement(parent, editor)) { insideEditor = true; break; }
        parent = attribute(parent, 'AXParent');
      }
      if (!insideEditor) count++;
    }
    return count;
  }
  function choosePraise() {
    var options = praise.filter(function (message) { return message !== state.lastPraise; });
    state.lastPraise = options[Math.floor(Math.random() * options.length)];
    return state.lastPraise;
  }
  function beginPraise() {
    if (state.send) { notice('Предыдущая похвала ещё отправляется.', 4); return; }
    var target = state.frozenTarget;
    if (!target) { notice('Откройте Codex или Claude (Code). Обычные редакторы кода не получают сообщения.', 6); return; }
    if (!trusted(false)) { requestPermission(); return; }
    if (!stillTarget(target)) { notice('Активный чат изменился. Ничего не отправлено.', 5); return; }
    var inspected = inspectComposer(target);
    if (!inspected.editor) { notice(inspected.reason, 6); return; }
    var editor = inspected.editor;
    if ($.AXUIElementSetAttributeValue(editor, $('AXFocused'), $.kCFBooleanTrue) !== 0) {
      notice('Не удалось выбрать поле сообщения. Ничего не отправлено.', 5); return;
    }
    // Never select-all or replace a draft. Paste only after an empty-field check.
    if (!stillTarget(target) || !sameElement(attribute(target.app, 'AXFocusedUIElement'), editor) || normal(attrText(editor, 'AXValue'))) { notice('Поле изменилось. Похвала отменена.', 5); return; }
    var message = choosePraise(), pb = $.NSPasteboard.generalPasteboard;
    var job = { target: target, editor: editor, message: message, phase: 'pasted', at: state.elapsed, deadline: state.elapsed + 4,
      clipboard: pb, savedClipboard: snapshotClipboard(pb), clipCount: 0, oldCount: countMessage(inspected.nodes, message, editor), clicked: false };
    try {
      pb.clearContents;
      if (!pb.setStringForType($(message), $('public.utf8-plain-text'))) throw new Error('clipboard');
      job.clipCount = Number(pb.changeCount);
      if (!key(9, 1048576)) throw new Error('paste'); // Command+V.
      state.send = job;
      notice('Передаём добрые слова в ' + target.name + '…', 5);
    } catch (_) { restoreClipboard(job); notice('Не удалось вставить похвалу. Ничего не отправлено.', 5); }
  }
  function advanceSend() {
    var job = state.send;
    if (!job) return;
    if (!stillTarget(job.target)) {
      restoreClipboard(job); state.send = null;
      notice(job.clicked ? 'Чат изменился после отправки. Проверьте предыдущий диалог.' : 'Чат изменился. Отправка отменена.', 6); return;
    }
    if (job.phase === 'pasted' && state.elapsed - job.at > 0.13) {
      if (normal(attrText(job.editor, 'AXValue')) !== normal(job.message)) {
        if (state.elapsed - job.at < 2) return;
        restoreClipboard(job); state.send = null; notice('Вставка не подтверждена. Проверьте поле сообщения.', 6); return;
      }
      if (!stillTarget(job.target) || !sameElement(attribute(job.target.app, 'AXFocusedUIElement'), job.editor)) {
        restoreClipboard(job); state.send = null; return;
      }
      job.oldSteer = walk(job.target.window, 350).filter(function (node) { return isSteer(node); });
      job.clicked = key(36, 0);
      job.phase = 'queued'; job.at = state.elapsed; job.lastProbe = 0;
      job.deadline = state.elapsed + 5;
      restoreClipboard(job);
    } else if (job.phase === 'queued') {
      if (state.elapsed - job.lastProbe < 0.15) return;
      job.lastProbe = state.elapsed;
      var candidates = walk(job.target.window, 350);
      for (var n = 0; n < candidates.length; n++) {
        var button = candidates[n];
        if (!isSteer(button) || job.oldSteer.some(function (old) { return sameElement(old, button); })) continue;
        var row = attribute(button, 'AXParent'), own = false;
        for (var depth = 0; row && depth < 5 && !sameElement(row, job.target.window); depth++, row = attribute(row, 'AXParent')) {
          var values = walk(row, 70);
          if (values.some(function (node) { return sameElement(node, job.editor); })) break;
          if (values.some(function (node) { return normal(attrText(node, 'AXValue') + ' ' + attrText(node, 'AXTitle') + ' ' + attrText(node, 'AXDescription')).indexOf(normal(job.message)) >= 0; })) { own = true; break; }
        }
        if (own && stillTarget(job.target) && $.AXUIElementPerformAction(button, $('AXPress')) === 0) {
          job.phase = 'confirm'; job.at = state.elapsed; job.deadline = state.elapsed + 2; return;
        }
      }
      if (state.elapsed >= job.deadline) { state.send = null; notice('Enter выполнен. Проверьте диалог или очередь.', 5); }
    } else if (job.phase === 'confirm' && state.elapsed - job.at > 0.35) {
      var after = walk(job.target.window, 350);
      if (countMessage(after, job.message, job.editor) > job.oldCount) {
        state.send = null; notice('Благодарность доставлена в ' + job.target.name + '.', 4); return;
      }
      if (state.elapsed >= job.deadline) {
        state.send = null; notice('Команда отправки передана. Подтверждение недоступно — проверьте чат.', 7);
      }
    }
  }
  function notice(text, duration) { state.notice = text; state.noticeUntil = state.elapsed + (duration || 5); if (view) view.needsDisplay = true; }
  function cancelSend() {
    if (!state.send) return;
    restoreClipboard(state.send);
    // A message already submitted is never sent again or deleted.
    state.send = null;
  }
  function updateScreens() {
    var screens = $.NSScreen.screens, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < Number(screens.count); i++) {
      var frame = screens.objectAtIndex(i).frame;
      minX = Math.min(minX, frame.origin.x); minY = Math.min(minY, frame.origin.y);
      maxX = Math.max(maxX, frame.origin.x + frame.size.width); maxY = Math.max(maxY, frame.origin.y + frame.size.height);
    }
    if (!isFinite(minX)) return;
    if (state.screen && state.screen.minX === minX && state.screen.minY === minY && state.width === maxX - minX && state.height === maxY - minY) return;
    state.screen = { minX: minX, minY: minY, maxY: maxY };
    state.width = maxX - minX; state.height = maxY - minY;
    // Hang on the screen containing the mouse, rather than in a gap between monitors.
    var mouse = $.NSEvent.mouseLocation, active = $.NSScreen.mainScreen.frame;
    for (var n = 0; n < Number(screens.count); n++) {
      var s = screens.objectAtIndex(n).frame;
      if (mouse.x >= s.origin.x && mouse.x <= s.origin.x + s.size.width && mouse.y >= s.origin.y && mouse.y <= s.origin.y + s.size.height) { active = s; break; }
    }
    state.homeX = active.origin.x - minX + active.size.width - 147;
    state.homeY = maxY - (active.origin.y + active.size.height) + 121;
    state.floor = maxY - active.origin.y - 17;
    if (panel) panel.setFrameDisplay($.NSMakeRect(minX, minY, state.width, state.height), true);
    reset(true);
  }
  function mousePoint() {
    var p = $.NSEvent.mouseLocation;
    return { x: p.x - state.screen.minX, y: state.screen.maxY - p.y };
  }
  function localPoint(x, y) {
    var c = Math.cos(state.angle), s = Math.sin(state.angle);
    return { x: state.x + x * c - y * s, y: state.y + x * s + y * c };
  }
  function hitBag(point) {
    var dx = point.x - state.x, dy = point.y - state.y;
    var x = dx * Math.cos(state.angle) + dy * Math.sin(state.angle), y = -dx * Math.sin(state.angle) + dy * Math.cos(state.angle);
    return x * x / (77 * 77) + y * y / (89 * 89) < 1;
  }
  function reset(immediate) {
    state.pointer = null; state.tx = state.homeX; state.ty = state.homeY;
    state.angle = Math.atan2(Math.sin(state.angle), Math.cos(state.angle)); state.targetAngle = 0;
    state.mode = immediate ? 'hung' : 'returning'; state.returnAt = state.elapsed;
    if (immediate) { state.x = state.homeX; state.y = state.homeY; state.angle = state.av = state.vx = state.vy = 0; state.treats = []; state.fibers = []; }
    else state.treats.forEach(function (treat) { treat.life = Math.min(treat.life, treat.age + 1.5); });
  }
  function detach() {
    state.mode = 'dragging'; state.poured = 0; state.rewarded = false; state.accumulator = 0;
    state.snapAt = state.elapsed;
    [-1, 1].forEach(function (side) {
      var p = localPoint(side * 62, -37);
      for (var i = 0; i < 5; i++) state.fibers.push({ x: p.x, y: p.y, vx: side * (30 + Math.random() * 35), vy: -70 + Math.random() * 75, age: 0 });
    });
    notice('Переверните мешок колёсиком или с Shift. Escape — вернуть.', 7);
  }
  function mouseDown(event) {
    if (state.paused || state.send) return;
    var point = mousePoint();
    if (!hitBag(point)) return;
    state.frozenTarget = detectTarget();
    state.sink = state.frozenTarget ? composerBounds(attribute(state.frozenTarget.app, 'AXFocusedUIElement')) : null;
    state.pointer = { x: point.x, y: point.y, startX: point.x, startY: point.y, offsetX: state.x - point.x, offsetY: state.y - point.y, last: state.elapsed, speed: 0 };
    if (state.mode === 'hung' || state.mode === 'returning') state.mode = 'tension'; else state.mode = 'dragging';
    panel.ignoresMouseEvents = false;
  }
  function mouseDragged(event) {
    var p = state.pointer;
    if (!p) return;
    var next = mousePoint(), dx = next.x - p.x, dy = next.y - p.y, dt = Math.max(state.elapsed - p.last, 0.008);
    p.speed = Math.min(Math.hypot(dx, dy) / dt, 1800);
    if (state.mode === 'tension') {
      var pull = Math.max(0, next.y - p.startY);
      state.tx = state.homeX + clamp((next.x - p.startX) * 0.32, -45, 45);
      state.ty = state.homeY + Math.min(pull, 82);
      state.targetAngle = clamp((next.x - p.startX) * 0.002, -0.18, 0.18);
      if (pull > 70) detach();
    }
    if (state.mode === 'dragging') {
      if ((Number(event.modifierFlags) & 131072) !== 0) {
        state.targetAngle += dx * 0.026;
        p.offsetX = state.x - next.x; p.offsetY = state.y - next.y;
      } else {
        state.tx = clamp(next.x + p.offsetX, 64, state.width - 64);
        state.ty = clamp(next.y + p.offsetY, 78, state.height - 82);
        state.av += clamp(dx / dt, -900, 900) * 0.00045;
      }
    }
    p.x = next.x; p.y = next.y; p.last = state.elapsed;
  }
  function mouseUp() {
    if (!state.pointer) return;
    state.pointer = null;
    if (state.mode === 'tension') reset(false);
    else { state.mode = 'free'; state.releaseAt = state.elapsed; }
  }
  function spawnTreat() {
    var index = Math.floor(Math.random() * 6), r = index === 0 ? 15 : 11 + Math.random() * 4;
    var mouth = localPoint((Math.random() - 0.5) * 30, -59), impulse = 65 + Math.random() * 65;
    state.treats.push({ x: mouth.x, y: mouth.y, vx: Math.sin(state.angle) * impulse + state.vx * 0.23 + (Math.random() - 0.5) * 60,
      vy: -Math.cos(state.angle) * impulse + state.vy * 0.18, radius: r, index: index, angle: state.angle + Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 11, age: 0, life: gentle() ? 3.5 : 5.4 + Math.random() });
    if (state.treats.length > 54) state.treats.shift();
    state.poured++;
    if (!state.rewarded && state.poured >= 8) { state.rewarded = true; beginPraise(); }
  }
  function gentle() {
    return state.gentle || state.systemGentle;
  }
  function physics(dt) {
    state.elapsed += dt;
    if (state.mode === 'hung') {
      var sway = gentle() ? 0 : Math.sin(state.elapsed * 1.45);
      state.x = state.homeX + sway * 2.6; state.y = state.homeY + (gentle() ? 0 : Math.cos(state.elapsed * 2.9) * 0.7);
      state.angle = sway * 0.026; state.vx = state.vy = state.av = 0;
    } else if (state.mode === 'free') {
      state.vy += (gentle() ? 70 : 220) * dt; state.vx *= Math.exp(-1.3 * dt); state.av *= Math.exp(-2 * dt);
      state.x += state.vx * dt; state.y += state.vy * dt; state.angle += state.av * dt;
      if (state.x < 65 || state.x > state.width - 65) { state.x = clamp(state.x, 65, state.width - 65); state.vx *= -0.35; }
      if (state.y > state.floor - 65) { state.y = state.floor - 65; state.vy *= -0.25; }
      if (state.elapsed - state.releaseAt > (gentle() ? 0.75 : 1.2)) reset(false);
    } else {
      state.vx += ((state.tx - state.x) * 100 - state.vx * 10) * dt;
      state.vy += ((state.ty - state.y) * 100 - state.vy * 10) * dt;
      state.av += ((state.targetAngle - state.angle) * 100 - state.av * 10) * dt;
      state.x += state.vx * dt; state.y += state.vy * dt; state.angle += state.av * dt;
      if (state.mode === 'returning' && state.elapsed - state.returnAt > 1.4) { state.mode = 'hung'; state.x = state.homeX; state.y = state.homeY; state.angle = state.targetAngle = 0; }
    }
    var downward = -Math.cos(state.angle), max = gentle() ? 20 : 40;
    if ((state.mode === 'dragging' || state.mode === 'free') && downward > 0.2 && state.poured < max) {
      state.accumulator += dt * ((gentle() ? 11 : 13) + downward * 14 + Math.min((state.pointer ? state.pointer.speed : 0) / 120, 12));
      while (state.accumulator >= 1 && state.poured < max) { state.accumulator--; spawnTreat(); }
      if (state.pointer) state.pointer.speed *= Math.exp(-4 * dt);
    } else state.accumulator = 0;
    var floor = state.floor;
    state.treats.forEach(function (t) {
      t.age += dt; t.vy += (gentle() ? 620 : 920) * dt; t.x += t.vx * dt; t.y += t.vy * dt; t.angle += t.spin * dt;
      if (t.y + t.radius > floor) { t.y = floor - t.radius; t.vy = Math.abs(t.vy) < 26 ? 0 : -Math.abs(t.vy) * 0.43; t.vx *= Math.exp(-3.2 * dt); t.spin *= Math.exp(-3.5 * dt); }
      if (t.x - t.radius < 0 || t.x + t.radius > state.width) { t.x = clamp(t.x, t.radius, state.width - t.radius); t.vx *= -0.5; }
    });
    if (state.sink) state.treats = state.treats.filter(function (t) { var r = state.sink; return t.x + t.radius < r.left || t.x - t.radius > r.left + r.width || t.y + t.radius < r.top || t.y - t.radius > r.top + r.height; });
    for (var a = 0; a < state.treats.length; a++) for (var b = a + 1; b < state.treats.length; b++) {
      var p = state.treats[a], q = state.treats[b], dx = q.x - p.x, dy = q.y - p.y, d = Math.sqrt(dx * dx + dy * dy), contact = p.radius + q.radius;
      if (d < 0.001 || d >= contact) continue;
      var nx = dx / d, ny = dy / d, ip = 1 / (p.radius * p.radius), iq = 1 / (q.radius * q.radius), mass = ip + iq;
      var correction = (contact - d) * 0.75 / mass;
      p.x -= nx * correction * ip; p.y -= ny * correction * ip; q.x += nx * correction * iq; q.y += ny * correction * iq;
      var velocity = (q.vx - p.vx) * nx + (q.vy - p.vy) * ny;
      if (velocity < 0) { var impulse = -(1.32) * velocity / mass; p.vx -= nx * impulse * ip; p.vy -= ny * impulse * ip; q.vx += nx * impulse * iq; q.vy += ny * impulse * iq; }
    }
    state.treats = state.treats.filter(function (t) { t.y = Math.min(t.y, floor - t.radius); t.x = clamp(t.x, t.radius, state.width - t.radius); return t.age < t.life; });
    state.fibers.forEach(function (f) { f.age += dt; f.vy += 290 * dt; f.x += f.vx * dt; f.y += f.vy * dt; });
    state.fibers = state.fibers.filter(function (f) { return f.age < 0.5; });
  }
  function color(r, g, b, a) { return $.NSColor.colorWithCalibratedRedGreenBlueAlpha(r / 255, g / 255, b / 255, a === undefined ? 1 : a); }
  function line(x1, y1, x2, y2, width, c) {
    c.setStroke;
    var path = $.NSBezierPath.bezierPath; path.lineWidth = width; path.lineCapStyle = 1;
    path.moveToPoint($.NSMakePoint(x1, y1)); path.lineToPoint($.NSMakePoint(x2, y2)); path.stroke;
  }
  function rope(x1, y1, x2, y2, alpha) {
    if (alpha <= 0) return;
    line(x1, y1, x2, y2, 5.2, color(63, 43, 27, alpha));
    line(x1, y1, x2, y2, 3.4, color(153, 112, 68, alpha));
    var dx = x2 - x1, dy = y2 - y1, length = Math.max(1, Math.sqrt(dx * dx + dy * dy)), ux = dx / length, uy = dy / length;
    for (var p = 4; p < length; p += 6) line(x1 + ux * p - uy, y1 + uy * p + ux, x1 + ux * (p + 2) + uy, y1 + uy * (p + 2) - ux, 1, color(216, 185, 131, alpha));
  }
  function drawSprite(image, x, y, angle, w, h, source, alpha) {
    $.NSGraphicsContext.saveGraphicsState;
    var transform = $.NSAffineTransform.transform;
    transform.translateXByYBy(x, y); transform.rotateByRadians(angle); transform.concat;
    image.drawInRectFromRectOperationFractionRespectFlippedHints($.NSMakeRect(-w / 2, -h / 2, w, h), source, 2, alpha, true, null);
    $.NSGraphicsContext.restoreGraphicsState;
  }
  function text(value, rect, size, c) {
    var attrs = $.NSMutableDictionary.alloc.init;
    attrs.setObjectForKey($.NSFont.systemFontOfSize(size), $.NSFontAttributeName);
    attrs.setObjectForKey(c, $.NSForegroundColorAttributeName);
    $(value).drawInRectWithAttributes(rect, attrs);
  }
  function draw() {
    $.NSColor.clearColor.setFill;
    $.NSRectFillUsingOperation($.NSMakeRect(0, 0, state.width, state.height), 1); // Clear alpha.
    [-1, 1].forEach(function (side) {
      var end = localPoint(side * 62, -37), startX = state.homeX + side * 63;
      if (state.mode === 'hung' || state.mode === 'tension') rope(startX, state.homeY - 125, end.x, end.y, 1);
      else if (state.mode === 'returning') rope(startX, state.homeY - 125, end.x, end.y, clamp(1 - Math.hypot(state.x - state.homeX, state.y - state.homeY) / 150, 0, 1));
      else if (state.elapsed - state.snapAt < 0.4) { var t = (state.elapsed - state.snapAt) / 0.4; rope(startX, state.homeY - 125, startX + Math.sin(t * 10) * side * 15, (state.homeY - 37) * (1 - t), 1 - t); }
    });
    var atlasSize = atlas.size, cw = atlasSize.width / 3, ch = atlasSize.height / 2;
    state.treats.forEach(function (t) {
      var size = t.radius * 2.7, source = $.NSMakeRect((t.index % 3) * cw, atlasSize.height - (Math.floor(t.index / 3) + 1) * ch, cw, ch);
      drawSprite(atlas, t.x, t.y, t.angle, size, size, source, clamp((t.life - t.age) / 1.2, 0, 1));
    });
    state.fibers.forEach(function (f) { line(f.x - 3, f.y, f.x + 4, f.y + 1, 1.2, color(182, 141, 88, 1 - f.age * 2)); });
    drawSprite(bagImage, state.x, state.y, state.angle, 168, 168, $.NSMakeRect(0, 0, bagImage.size.width, bagImage.size.height), 1);
  }
  function tick() {
    try {
      var now = Date.now() / 1000, dt = Math.min(0.05, Math.max(0, now - state.lastTick)); state.lastTick = now;
      if (state.paused) return;
      state.frame++;
      var steps = Math.max(1, Math.round(dt / STEP));
      for (var i = 0; i < steps; i++) physics(dt / steps);
      if (state.elapsed > state.nextDetect) {
        state.nextDetect = state.elapsed + 0.85; updateScreens(); state.currentTarget = detectTarget();
        try { state.systemGentle = Boolean($.NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion); } catch (_) {}
        if (targetMenu) targetMenu.title = $(state.currentTarget ? 'Активен: ' + state.currentTarget.name : 'Откройте Codex или Claude (Code)');
      }
      advanceSend();
      if (!state.pointer) panel.ignoresMouseEvents = !hitBag(mousePoint());
      var escape = Boolean($.CGEventSourceKeyState(0, 53));
      if (escape && !state.escapeWasDown && state.mode !== 'hung') { cancelSend(); reset(false); }
      state.escapeWasDown = escape;
      if (state.mode !== 'hung' || state.treats.length || state.frame % 2 === 0 || (state.notice && state.elapsed < state.noticeUntil)) view.needsDisplay = true;
    } catch (error) {
      cancelSend(); reset(true); notice('GoodGPT приостановил действие: ' + String(error.message || error).slice(0, 110), 7);
    }
  }
  ObjC.registerSubclass({ name: 'GoodGPTPanel', superclass: 'NSPanel', methods: {
    canBecomeKeyWindow: { types: ['bool', []], implementation: function () { return false; } },
    canBecomeMainWindow: { types: ['bool', []], implementation: function () { return false; } }
  } });
  ObjC.registerSubclass({ name: 'GoodGPTView', superclass: 'NSView', methods: {
    isFlipped: { types: ['bool', []], implementation: function () { return true; } },
    'acceptsFirstMouse:': { types: ['bool', ['id']], implementation: function () { return true; } },
    'drawRect:': { types: ['void', ['NSRect']], implementation: function () { draw(); } },
    'mouseDown:': { types: ['void', ['id']], implementation: function (e) { mouseDown(e); } },
    'mouseDragged:': { types: ['void', ['id']], implementation: function (e) { mouseDragged(e); } },
    'mouseUp:': { types: ['void', ['id']], implementation: function () { mouseUp(); } },
    'scrollWheel:': { types: ['void', ['id']], implementation: function (e) {
      if (state.mode === 'dragging') state.targetAngle += clamp(Number(e.scrollingDeltaY), -180, 180) * 0.025;
    } }
  } });
  ObjC.registerSubclass({ name: 'GoodGPTController', superclass: 'NSObject', methods: {
    'tick:': { types: ['void', ['id']], implementation: function () { tick(); } },
    'resetBag:': { types: ['void', ['id']], implementation: function () { cancelSend(); reset(false); notice('Мешок возвращается наверх.', 3); } },
    'togglePause:': { types: ['void', ['id']], implementation: function () {
      state.paused = !state.paused; cancelSend(); reset(true);
      pauseMenu.title = $(state.paused ? 'Показать мешочек' : 'Скрыть мешочек');
      if (state.paused) panel.orderOut(null); else { state.lastTick = Date.now() / 1000; panel.orderFrontRegardless; }
    } },
    'toggleGentle:': { types: ['void', ['id']], implementation: function () {
      state.gentle = !state.gentle; defaults.setBoolForKey(state.gentle, 'goodgpt.gentle'); gentleMenu.state = state.gentle ? 1 : 0;
    } },
    'permissions:': { types: ['void', ['id']], implementation: function () { requestPermission(); } },
    'quitGoodGPT:': { types: ['void', ['id']], implementation: function () {
      cancelSend(); if (timer) timer.invalidate; panel.close; app.terminate(null);
    } }
  } });
  controller = $.GoodGPTController.alloc.init;
  updateScreens();
  panel = $.GoodGPTPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(state.screen.minX, state.screen.minY, state.width, state.height), 128, 2, false);
  panel.opaque = false; panel.backgroundColor = $.NSColor.clearColor; panel.hasShadow = false;
  panel.level = 25; panel.hidesOnDeactivate = false; panel.ignoresMouseEvents = true;
  panel.collectionBehavior = 1 | 16 | 64 | 256; panel.releasedWhenClosed = false;
  panel.title = $('GoodGPT');
  view = $.GoodGPTView.alloc.initWithFrame($.NSMakeRect(0, 0, state.width, state.height));
  view.autoresizingMask = 2 | 16; panel.contentView = view;
  statusItem = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
  statusItem.button.title = $('GoodGPT');
  statusItem.button.toolTip = $('Мешочек с благодарностью для Codex и Claude Code');
  var menu = $.NSMenu.alloc.init;
  function addMenu(title, selector) {
    var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(title), selector || null, $(''));
    if (selector) item.target = controller; else item.enabled = false;
    menu.addItem(item); return item;
  }
  targetMenu = addMenu('Откройте Codex или Claude (Code)', null);
  menu.addItem($.NSMenuItem.separatorItem);
  addMenu('Вернуть мешок наверх', 'resetBag:');
  pauseMenu = addMenu('Скрыть мешочек', 'togglePause:');
  gentleMenu = addMenu('Меньше движения', 'toggleGentle:'); gentleMenu.state = state.gentle ? 1 : 0;
  addMenu('Разрешить управление приложениями', 'permissions:');
  menu.addItem($.NSMenuItem.separatorItem);
  addMenu('Выйти из GoodGPT', 'quitGoodGPT:');
  statusItem.menu = menu;
  panel.orderFrontRegardless;
  notice('Потяните мешок вниз. Переверните колёсиком или с Shift.', 9);
  // Common modes keep physics running during a mouse drag and status-menu tracking.
  timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(1 / 60, controller, 'tick:', null, true);
  $.NSRunLoop.mainRunLoop.addTimerForMode(timer, $.NSRunLoopCommonModes);
  app.finishLaunching;
  app.run;
}
