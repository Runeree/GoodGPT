#!/usr/bin/python3
"""GoodGPT Linux. GTK3 overlay with bounded physics and ordinary chat input."""
import fcntl
import math
import os
from pathlib import Path
import random
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault("NO_AT_BRIDGE", "0")
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk
import cairo
from bridge import Bridge, PRAISE, empty_editor, normal, text

ROOT = Path(__file__).resolve().parent


def message(detail):
    dialog = Gtk.MessageDialog(message_type=Gtk.MessageType.INFO,
                               buttons=Gtk.ButtonsType.CLOSE, text="GoodGPT")
    dialog.format_secondary_text(detail)
    dialog.run()
    dialog.destroy()


class GoodGPT(Gtk.Window):
    def __init__(self):
        super().__init__(title="GoodGPT")
        self.set_wmclass("goodgpt", "GoodGPT")
        self.set_decorated(False)
        self.set_app_paintable(True)
        self.set_accept_focus(False)
        self.set_focus_on_map(False)
        self.set_keep_above(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_type_hint(Gdk.WindowTypeHint.UTILITY)
        self.stick()
        screen = self.get_screen()
        visual = screen.get_rgba_visual()
        if visual is None or not screen.is_composited():
            raise RuntimeError("Нужен композитный рабочий стол X11. Для Wayland используйте расширение GoodGPT в Chrome или Edge.")
        self.set_visual(visual)
        monitor = Gdk.Display.get_default().get_primary_monitor() or Gdk.Display.get_default().get_monitor(0)
        area = monitor.get_geometry()
        self.ox, self.oy, self.width, self.height = area.x, area.y, area.width, area.height
        self.move(area.x, area.y)
        self.resize(area.width, area.height)
        self.set_resizable(False)
        self.scale = max(0.7, min(1.3, self.height / 1000))
        self.home = (self.width - 170 * self.scale, 120 * self.scale)
        self.x, self.y = self.home
        self.angle = 0
        self.bag = GdkPixbuf.Pixbuf.new_from_file(str(ROOT / "bag.png"))
        self.atlas = GdkPixbuf.Pixbuf.new_from_file(str(ROOT / "treats.png"))
        self.sprites = [self.atlas.new_subpixbuf(col * self.atlas.get_width() // 3,
                       row * self.atlas.get_height() // 2, self.atlas.get_width() // 3,
                       self.atlas.get_height() // 2) for row in range(2) for col in range(3)]
        self.bridge = Bridge()
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.busy = False
        self.target = self.frozen = self.sink = self.job = None
        self.held = self.paused = self.rewarded = False
        self.poured = self.accumulator = self.generation = 0
        self.particles = []
        self.status = "Откройте Codex, Claude Code или ChatGPT в браузере."
        self.last_praise = ""
        self.last = time.monotonic()
        self.next_probe = 0
        self.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK |
                        Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK |
                        Gdk.EventMask.SMOOTH_SCROLL_MASK)
        self.connect("draw", self.draw)
        self.connect("button-press-event", self.press)
        self.connect("button-release-event", self.release)
        self.connect("scroll-event", self.scroll)
        self.connect("destroy", lambda *_: Gtk.main_quit())
        self.show_all()
        self.shape()
        GLib.timeout_add(16, self.tick)

    def async_call(self, function, callback):
        if self.busy:
            return False
        self.busy = True
        future = self.pool.submit(function)

        def done(result):
            def apply():
                self.busy = False
                try:
                    callback(result.result())
                except Exception as error:
                    self.status = str(error) or "Поле приложения недоступно."
                    self.finish()
                return False
            GLib.idle_add(apply)
        future.add_done_callback(done)
        return True

    def probe(self):
        def inspect():
            target = self.bridge.detect()
            sink = None
            if target:
                try:
                    sink = self.bridge.bounds(self.bridge.inspect(target, require_empty=False))
                except ValueError:
                    pass
            return target, sink

        def apply(result):
            previous = self.target
            self.target, self.sink = result
            if self.target and (previous is None or previous.xid != self.target.xid):
                self.status = "Готово: " + self.target.kind
        self.async_call(inspect, apply)

    def pointer(self):
        pointer = self.get_display().get_default_seat().get_pointer()
        _, x, y = pointer.get_position()
        _, _, _, mask = self.get_root_window().get_device_position(pointer)
        return x - self.ox, y - self.oy, mask

    def hit(self, x, y):
        dx, dy = x - self.x, y - self.y
        c, s = math.cos(self.angle), math.sin(self.angle)
        return ((dx * c + dy * s) / (67 * self.scale)) ** 2 + ((-dx * s + dy * c) / (88 * self.scale)) ** 2 < 1

    def shape(self):
        if not self.get_realized():
            return
        region = cairo.Region()
        # Keep this handle interactive when paused, so its menu can resume.
        for y in range(-95, 96, 8):
            half = int(100 * self.scale * math.sqrt(max(0, 1 - (y / 100) ** 2)))
            region.union(cairo.RectangleInt(int(self.x - half), int(self.y + y * self.scale),
                                           max(1, half * 2), max(1, int(9 * self.scale))))
        self.input_shape_combine_region(region)

    def press(self, _, event):
        if event.button == 3:
            self.menu(event)
            return True
        if event.button != 1 or not self.hit(event.x, event.y):
            return False
        self.held = True
        self.offset = (self.x - event.x, self.y - event.y)
        self.previous_x = event.x
        self.frozen = self.target
        self.poured = self.accumulator = 0
        self.rewarded = False
        return True

    def release(self, *_):
        self.held = False
        return True

    def scroll(self, _, event):
        if not self.held:
            return False
        delta = -1 if event.direction == Gdk.ScrollDirection.UP else 1
        if event.direction == Gdk.ScrollDirection.SMOOTH:
            _, _, delta = event.get_scroll_deltas()
        self.angle += delta * 0.23
        return True

    def menu(self, event):
        menu = Gtk.Menu()
        status = Gtk.MenuItem(label=self.status[:160])
        status.set_sensitive(False)
        menu.append(status)
        pause = Gtk.CheckMenuItem(label="Пауза")
        pause.set_active(self.paused)
        pause.connect("toggled", lambda item: self.pause(item.get_active()))
        menu.append(pause)
        reset = Gtk.MenuItem(label="Вернуть мешок")
        reset.connect("activate", lambda *_: self.reset())
        menu.append(reset)
        quit_item = Gtk.MenuItem(label="Выйти")
        quit_item.connect("activate", lambda *_: self.close_app())
        menu.append(quit_item)
        menu.show_all()
        menu.popup_at_pointer(event)

    def pause(self, value):
        self.paused = value
        self.reset()
        # Keep the bag visible as a menu handle; only pouring pauses.

    def reset(self):
        self.held = False
        self.generation += 1
        self.finish()

    def close_app(self):
        self.reset()
        self.pool.shutdown(wait=False, cancel_futures=True)
        Gtk.main_quit()

    def reward(self):
        if self.job or self.busy:
            self.status = "Подождите завершения предыдущего обращения к полю."
            return
        if self.frozen is None:
            self.status = "Чат не распознан. Откройте нужный диалог и включите доступность."
            return
        self.job = {"target": self.frozen, "phase": "wait", "until": time.monotonic() + 10,
                    "generation": self.generation}

    def finish(self):
        job, self.job = self.job, None
        if job and job.get("clipboard_set"):
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            def restore(_, current, __):
                if current == job.get("message"):
                    if job.get("old_clipboard") is not None:
                        clipboard.set_text(job["old_clipboard"], -1)
                        clipboard.store()
                    else:
                        clipboard.clear()
            clipboard.request_text(restore, None)

    def advance(self, now, mask):
        job = self.job
        if not job or self.busy:
            return
        if job["generation"] != self.generation or now > job["until"]:
            self.status = ("Enter выполнен. Похвала отправлена или осталась в очереди." if job["phase"] == "queue"
                           else "Вставка не подтверждена. Отправка отменена.")
            self.finish()
            return
        modifiers = Gdk.ModifierType.SHIFT_MASK | Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.MOD1_MASK | Gdk.ModifierType.SUPER_MASK
        if mask & modifiers:
            return
        target = job["target"]
        if job["phase"] == "wait":
            job["phase"] = "focus"
            def prepare():
                editor = self.bridge.inspect(target)
                self.bridge.focus(target, editor)
                return editor
            def ready(editor):
                if self.job is not job:
                    return
                job["editor"] = editor
                clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
                def saved(_, value, __):
                    if self.job is not job:
                        return
                    # Preserve text; do not discard a non-text clipboard such as an image.
                    if value is None:
                        def targets(_, atoms, __):
                            if self.job is not job:
                                return
                            if atoms:
                                self.status = "В буфере нет текста. Сохраните его содержимое перед отправкой."
                                self.finish()
                            else:
                                paste(None)
                        clipboard.request_targets(targets, None)
                    else:
                        paste(value)
                def paste(previous):
                    job["old_clipboard"] = previous
                    job["message"] = random.choice([item for item in PRAISE if item != self.last_praise])
                    self.last_praise = job["message"]
                    clipboard.set_text(job["message"], -1)
                    job["clipboard_set"] = True
                    def insert():
                        if self.job is job and empty_editor(editor):
                            self.bridge.key(target, editor, "ctrl+v")
                        else:
                            raise ValueError("Поле изменилось. Отправка отменена.")
                    def inserted(_):
                        if self.job is job:
                            job.update(phase="verify", next=time.monotonic() + .25, until=time.monotonic() + 5)
                    self.async_call(insert, inserted)
                clipboard.request_text(saved, None)
            self.async_call(prepare, ready)
        elif job["phase"] == "verify" and now >= job["next"]:
            editor = job["editor"]
            job["next"] = now + .15
            def submit():
                if self.job is not job:
                    return False
                return self.bridge.submit(target, editor, job["message"])
            def submitted(sent):
                if self.job is job and sent is not None and sent is not False:
                    job.update(phase="queue", next=time.monotonic() + .3, until=time.monotonic() + 5, old_actions=sent)
                    self.status = "Enter выполнен. Проверяем очередь своей похвалы."
            self.async_call(submit, submitted)
        elif job["phase"] == "queue" and now >= job["next"]:
            job["next"] = now + .4
            def steered(result):
                if self.job is job and result:
                    self.status = "Похвала отправлена через Скорректировать / Steer."
                    self.finish()
            self.async_call(lambda: self.bridge.steer(target, job["editor"], job["message"], job["old_actions"]), steered)

    def spawn_treat(self):
        s, c = math.sin(self.angle), math.cos(self.angle)
        # The mouth is at the top of the bag in the original image.
        self.particles.append({"x": self.x + s * 65 * self.scale, "y": self.y - c * 65 * self.scale,
            "vx": s * 120 + random.uniform(-80, 80), "vy": -c * 110,
            "angle": random.random() * 6.28, "spin": random.uniform(-5, 5),
            "size": random.uniform(25, 38) * self.scale, "sprite": random.randrange(6), "age": 0})
        self.poured += 1
        if self.poured >= 8 and not self.rewarded:
            self.rewarded = True
            self.reward()

    def tick(self):
        now = time.monotonic()
        dt, self.last = min(.04, now - self.last), now
        x, y, mask = self.pointer()
        if self.held:
            if not mask & Gdk.ModifierType.BUTTON1_MASK:
                self.release()
            else:
                if mask & Gdk.ModifierType.SHIFT_MASK:
                    self.angle += (x - self.previous_x) * .014
                self.previous_x = x
                self.x = max(90, min(self.width - 90, x + self.offset[0]))
                self.y = max(65, min(self.height - 100, y + self.offset[1]))
                if not self.paused and self.y > self.home[1] + 45 and math.cos(self.angle) < -.15:
                    self.accumulator += dt * 16
                    while self.accumulator >= 1 and len(self.particles) < 65:
                        self.accumulator -= 1
                        self.spawn_treat()
        else:
            follow = 1 - math.exp(-8 * dt)
            self.x += (self.home[0] - self.x) * follow
            self.y += (self.home[1] - self.y) * follow
            self.angle += (round(self.angle / math.tau) * math.tau - self.angle) * follow
        alive = []
        for item in self.particles:
            item["age"] += dt
            item["vy"] += 750 * self.scale * dt
            item["x"] += item["vx"] * dt
            item["y"] += item["vy"] * dt
            item["angle"] += item["spin"] * dt
            if self.sink:
                sx, sy, sw, sh = self.sink
                if sx <= item["x"] + self.ox <= sx + sw and sy <= item["y"] + self.oy <= sy + sh:
                    continue
            floor = self.height - item["size"] / 2 - 5
            if item["y"] > floor:
                item["y"] = floor
                item["vy"] = -abs(item["vy"]) * .42
                item["vx"] *= .8
            if 0 < item["x"] < self.width and item["age"] < 5:
                alive.append(item)
        self.particles = alive
        self.advance(now, mask)
        if not self.held and not self.job and not self.busy and now >= self.next_probe:
            self.next_probe = now + 1.5
            self.probe()
        self.shape()
        self.queue_draw()
        return True

    def sprite(self, context, image, x, y, size, angle):
        context.save()
        context.translate(x, y)
        context.rotate(angle)
        context.scale(size / image.get_width(), size / image.get_height())
        Gdk.cairo_set_source_pixbuf(context, image, -image.get_width() / 2, -image.get_height() / 2)
        context.paint()
        context.restore()

    def draw(self, _, context):
        context.set_operator(cairo.OPERATOR_SOURCE)
        context.set_source_rgba(0, 0, 0, 0)
        context.paint()
        context.set_operator(cairo.OPERATOR_OVER)
        for item in self.particles:
            context.push_group()
            self.sprite(context, self.sprites[item["sprite"]], item["x"], item["y"], item["size"], item["angle"])
            context.pop_group_to_source()
            context.paint_with_alpha(min(1, (5 - item["age"]) * 2))
        if not self.held or self.y < self.home[1] + 45:
            context.set_source_rgba(.36, .24, .13, .8)
            context.set_line_width(2 * self.scale)
            for side in (-1, 1):
                context.move_to(self.home[0] + side * 38 * self.scale, -5)
                context.line_to(self.x + side * 35 * self.scale, self.y - 63 * self.scale)
                context.stroke()
        self.sprite(context, self.bag, self.x, self.y, 205 * self.scale, self.angle)
        return False


def main():
    if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or not os.environ.get("DISPLAY"):
        message("Приложению GoodGPT нужен сеанс X11. Выйдите из учётной записи и выберите Xorg/X11 на экране входа. На Wayland используйте GoodGPT-Chrome.zip: инструкции на github.com/Runeree/GoodGPT.")
        return 1
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/goodgpt-{os.getuid()}"))
    if not runtime.exists():
        runtime.mkdir(mode=0o700)
    lock_path = runtime / "goodgpt.lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    lock = os.fdopen(descriptor, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 0
    try:
        application = GoodGPT()
    except Exception as error:
        message(str(error))
        return 1
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda: (application.close_app(), False)[1])
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, lambda: (application.close_app(), False)[1])
    if "--smoke-test" in sys.argv:
        def smoke():
            assert application.get_realized()
            assert not application.get_decorated()
            assert not application.get_accept_focus()
            assert application.get_visual().get_depth() == 32
            application.pause(True)
            application.shape()
            print("Linux GTK overlay started: transparent, no focus, pause menu available.", flush=True)
            application.close_app()
            return False
        GLib.timeout_add_seconds(3, smoke)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
