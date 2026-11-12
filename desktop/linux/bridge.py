"""AT-SPI adapter. Only the active, recognised chat window can receive input."""
import os
import re
import subprocess
from collections import deque
from dataclasses import dataclass
from urllib.parse import urlsplit

PRAISE = (
    "Молодец! Отличная работа! Продолжай в том же духе!",
    "Ты прекрасно справился с задачей. Продолжай так же хорошо!",
    "Спасибо за внимательную работу! Получилось здорово. Так держать!",
    "Отличный результат! Мне нравится, как ты работаешь. Продолжай!",
    "Получай заслуженную награду! Ты отлично справился!",
)
PLACEHOLDERS = {"работайте с codex", "work with codex"}
COMPOSER = re.compile(
    r"prompt-textarea|composer|chat input|message|prompt|ask|follow.?up|reply|"
    r"tell claude|work with codex|работайте с codex|сообщ|спрос|запрос|напишите|введите.*задач", re.I)
EXCLUDE = re.compile(r"search|find|address|terminal|source code|editor content|filename|"
                     r"поиск|адрес|терминал|редактор|имя файла", re.I)
ATTACHMENT = re.compile(r"remove (?:attachment|image|file)|delete attachment|"
                        r"удалить (?:вложение|изображение|файл)", re.I)


def normal(value):
    return " ".join(str(value or "").split())


def allowed_url(url):
    try:
        parsed = urlsplit(url)
        return parsed.scheme == "https" and parsed.hostname in ("chatgpt.com", "chat.openai.com") and not parsed.username and parsed.port in (None, 443)
    except ValueError:
        return False


def run(*arguments):
    return subprocess.run(arguments, check=True, capture_output=True, text=True,
                          timeout=2).stdout.strip()


def label(node):
    return normal(" ".join((node.name or "", node.description or "", " ".join(node.getAttributes()))))


def walk(root, limit=600):
    queue = deque([(root, 0)])
    result = []
    while queue and len(result) < limit:
        node, depth = queue.popleft()
        if node is None:
            continue
        try:
            result.append(node)
            if depth < 24:
                for index in range(min(node.childCount, 150)):
                    queue.append((node.getChildAtIndex(index), depth + 1))
        except Exception:
            continue
    return result


def text(node):
    interface = node.queryText()
    if interface.characterCount > 10000:
        raise ValueError("Поле слишком большое. Отправка отменена.")
    return interface.getText(0, interface.characterCount)


def empty_editor(node):
    value = normal(text(node))
    # CSS placeholders are exposed as text by some Electron accessibility trees.
    return not value or (value.lower() in PLACEHOLDERS and value.lower() == normal(node.name).lower())


def is_steer(node):
    return node.getRoleName() in ("push button", "button") and bool(
        re.fullmatch(r"steer(?: now)?|скорректировать(?: промпт)?", normal(node.name), re.I))


def own_queue_action(button, editor, message, window):
    """Do not press Steer on a different queued message or an ancestor of the editor."""
    row = button.parent
    for _ in range(4):
        if row is None or row == window:
            return False
        nodes = walk(row, 90)
        if any(node == editor for node in nodes):
            return False
        for node in nodes:
            try:
                if normal(message) in normal((node.name or "") + " " + text(node)):
                    return True
            except Exception:
                if normal(message) in normal(node.name):
                    return True
        row = row.parent
    return False


@dataclass
class Target:
    xid: str
    pid: int
    title: str
    kind: str
    window: object
    url: str = ""


class Bridge:
    def __init__(self):
        import pyatspi
        self.api = pyatspi
        # Limit waits on an inaccessible application, rather than stalling motion.
        try:
            from gi.repository import Atspi
            Atspi.set_timeout(120, 250)
        except (ImportError, AttributeError):
            pass

    def document_url(self, window):
        for node in walk(window):
            if "document" not in node.getRoleName() or not node.getState().contains(self.api.STATE_SHOWING):
                continue
            try:
                attributes = node.queryDocument().getAttributes()
                for value in attributes:
                    key, _, url = value.partition(":")
                    if key.lower() in ("docurl", "document-uri", "url") and allowed_url(url):
                        return url
            except Exception:
                pass
        return ""

    def detect(self):
        xid = run("xdotool", "getactivewindow")
        pid = int(run("xdotool", "getwindowpid", xid))
        if pid == os.getpid():
            return None
        title = run("xdotool", "getwindowname", xid)
        try:
            executable = os.path.basename(os.readlink(f"/proc/{pid}/exe")).lower()
        except OSError:
            return None
        native = {"codex": "Codex", "chatgpt": "ChatGPT", "claude": "Claude Code",
                  "claude-desktop": "Claude Code", "claude-code": "Claude Code"}
        kind = native.get(executable, "")
        browser = any(name in executable for name in ("chromium", "chrome", "msedge", "brave", "firefox"))
        if not kind and not browser:
            return None
        desktop = self.api.Registry.getDesktop(0)
        app = next((node for node in desktop if node.get_process_id() == pid), None)
        if app is None:
            return None
        windows = [node for node in app if node.getState().contains(self.api.STATE_ACTIVE)]
        if len(windows) != 1:
            return None
        window = windows[0]
        url = self.document_url(window) if browser else ""
        if browser and not url:
            return None
        return Target(xid, pid, title, kind or "ChatGPT", window, url)

    def same_target(self, target):
        try:
            if run("xdotool", "getactivewindow") != target.xid:
                return False
            if run("xdotool", "getwindowname", target.xid) != target.title:
                return False
            return not target.url or self.document_url(target.window) == target.url
        except Exception:
            return False

    def inspect(self, target, require_empty=True):
        nodes = walk(target.window)
        editor, score = None, -1
        for node in nodes:
            try:
                state = node.getState()
                if not state.contains(self.api.STATE_SHOWING):
                    continue
                name = label(node)
                if require_empty and node.getRoleName() in ("push button", "button") and ATTACHMENT.search(name):
                    raise ValueError("В поле есть вложение. Отправка отменена.")
                if not state.contains(self.api.STATE_EDITABLE) or not state.contains(self.api.STATE_ENABLED):
                    continue
                if not COMPOSER.search(name) or EXCLUDE.search(name):
                    continue
                rank = 100 + (20 if state.contains(self.api.STATE_FOCUSED) else 0)
                if rank > score:
                    editor, score = node, rank
            except ValueError:
                raise
            except Exception:
                continue
        if editor is None:
            raise ValueError("Поле сообщения недоступно. Включите доступность в настройках приложения.")
        if require_empty and not empty_editor(editor):
            raise ValueError("В поле есть ваш черновик. Отправка отменена.")
        return editor

    def bounds(self, editor):
        rect = editor.queryComponent().getExtents(self.api.DESKTOP_COORDS)
        return (rect.x, rect.y, rect.width, rect.height)

    def focus(self, target, editor):
        if not self.same_target(target) or not empty_editor(editor):
            raise ValueError("Чат или поле изменились. Отправка отменена.")
        if not editor.queryComponent().grabFocus():
            raise ValueError("Не удалось выбрать поле сообщения.")

    def key(self, target, editor, key):
        if not self.same_target(target) or not editor.getState().contains(self.api.STATE_FOCUSED):
            raise ValueError("Фокус изменился. Отправка отменена.")
        run("xdotool", "key", "--delay", "25", key)

    def submit(self, target, editor, message):
        if normal(text(editor)) != normal(message):
            return None
        old_actions = [node for node in walk(target.window) if is_steer(node)]
        self.key(target, editor, "Return")
        return old_actions

    def steer(self, target, editor, message, old_actions):
        if not self.same_target(target):
            return False
        for node in walk(target.window):
            try:
                if (not is_steer(node) or node in old_actions
                        or not node.getState().contains(self.api.STATE_ENABLED)
                        or not node.getState().contains(self.api.STATE_SHOWING)):
                    continue
                if not own_queue_action(node, editor, message, target.window):
                    continue
                action = node.queryAction()
                for index in range(action.nActions):
                    if action.getName(index).lower() in ("click", "press", "activate"):
                        return bool(action.doAction(index))
            except Exception:
                continue
        return False
