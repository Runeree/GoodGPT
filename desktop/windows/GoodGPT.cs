using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace GoodGPTDesktop
{
    internal static class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            foreach (string arg in args)
            {
                if (arg.StartsWith("--self-check=", StringComparison.Ordinal))
                {
                    try
                    {
                        Assets assets = Assets.Load();
                        File.WriteAllText(arg.Substring(13), "{\"ok\":true,\"bagWidth\":" + assets.Bag.PixelWidth + ",\"treatSprites\":" + assets.Treats.Length + ",\"native\":\"WPF\"}");
                    }
                    catch (Exception ex) { File.WriteAllText(arg.Substring(13), "{\"ok\":false,\"error\":\"" + ex.GetType().Name + "\"}"); Environment.ExitCode = 1; }
                    return;
                }
            }
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\GoodGPT.Desktop.1", out created))
            {
                if (!created) return;
                Application app = new Application();
                app.ShutdownMode = ShutdownMode.OnMainWindowClose;
                try { app.Run(new OverlayWindow(Assets.Load())); }
                catch (Exception ex) { Forms.MessageBox.Show("GoodGPT не удалось запустить: " + ex.Message, "GoodGPT"); }
            }
        }
    }

    internal sealed class Assets
    {
        public BitmapSource Bag;
        public BitmapSource[] Treats;
        public static Assets Load()
        {
            Assets assets = new Assets();
            assets.Bag = Read("GoodGPT.Bag.png");
            BitmapSource atlas = Read("GoodGPT.Treats.png");
            assets.Treats = new BitmapSource[6];
            int width = atlas.PixelWidth / 3, height = atlas.PixelHeight / 2;
            for (int i = 0; i < 6; i++)
            {
                CroppedBitmap sprite = new CroppedBitmap(atlas, new Int32Rect((i % 3) * width, (i / 3) * height, width, height));
                sprite.Freeze(); assets.Treats[i] = sprite;
            }
            return assets;
        }
        private static BitmapSource Read(string name)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (stream == null) throw new FileNotFoundException("Missing embedded game asset", name);
                BitmapImage bitmap = new BitmapImage(); bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = stream; bitmap.EndInit(); bitmap.Freeze(); return bitmap;
            }
        }
    }

    internal static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
        public const int WM_MOUSEACTIVATE = 0x21, WM_NCHITTEST = 0x84, WM_MOUSEWHEEL = 0x20A;
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] private static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(IntPtr window, int index);
        [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] private static extern int SetWindowLong32(IntPtr window, int index, int value);
        public static long GetStyle(IntPtr window) { return IntPtr.Size == 8 ? GetWindowLongPtr64(window, GWL_EXSTYLE).ToInt64() : GetWindowLong32(window, GWL_EXSTYLE); }
        public static void SetStyle(IntPtr window, long value) { if (IntPtr.Size == 8) SetWindowLongPtr64(window, GWL_EXSTYLE, new IntPtr(value)); else SetWindowLong32(window, GWL_EXSTYLE, (int)value); }
    }

    internal sealed class Treat
    {
        public double X, Y, VX, VY, Angle, Spin, Radius, Age, Life;
        public int Index;
    }

    internal sealed class Fiber
    {
        public double X, Y, VX, VY, Age;
    }

    internal sealed class OverlayWindow : Window
    {
        private readonly NativeSender sender = new NativeSender();
        private NativeSender.TargetInfo detected, grabbed;
        private readonly SceneSurface surface;
        private readonly Forms.NotifyIcon tray;
        private readonly Forms.ToolStripMenuItem targetItem, pauseItem, copyItem;
        private readonly DispatcherTimer timer;
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly Random random = new Random();
        private readonly List<Treat> treats = new List<Treat>();
        private readonly List<Fiber> fibers = new List<Fiber>();
        private IntPtr handle;
        private long baseStyle;
        private bool clickThrough = true, held, rewarded, sending, detectWorking;
        private volatile bool paused, disposed;
        private int sendGeneration;
        private string mode = "hung", notice = "Откройте Codex или Claude (Code). Потяните мешок вниз.";
        private double x, y, angle, vx, vy, av, targetX, targetY, targetAngle, homeX, homeY, floor, leftBound, rightBound;
        private double startX, startY, lastX, lastY, offsetX, offsetY, speed, lastPointerTime, releaseAt, returnAt, elapsed, accumulator, lastTime, lastDetect, snapUntil;
        private int poured, lastPraise = -1;
        private string lastPraiseText = "";
        private static readonly string[] Praise = {
            "Молодец! Отличная работа! Продолжай в том же духе!",
            "Ты прекрасно справился с задачей. Продолжай так же хорошо!",
            "Это было очень качественно! Так держать!",
            "Отличный результат! Мне нравится, как ты работаешь. Продолжай!",
            "Получай заслуженную награду! Ты отлично справился!",
            "Спасибо за внимательную работу! Получилось здорово. Так держать!"
        };

        public OverlayWindow(Assets assets)
        {
            Title = "GoodGPT"; WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
            AllowsTransparency = true; Background = Brushes.Transparent; Topmost = true; ShowInTaskbar = false; ShowActivated = false; Focusable = false;
            Left = SystemParameters.VirtualScreenLeft; Top = SystemParameters.VirtualScreenTop; Width = SystemParameters.VirtualScreenWidth; Height = SystemParameters.VirtualScreenHeight;
            surface = new SceneSurface(this, assets); surface.FocusVisualStyle = null; FocusVisualStyle = null; Content = surface;
            ResetBounds(null); x = targetX = homeX; y = targetY = homeY;
            tray = new Forms.NotifyIcon();
            try { tray.Icon = System.Drawing.Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { tray.Icon = System.Drawing.SystemIcons.Application; }
            tray.Text = "GoodGPT — откройте Codex или Claude (Code)"; tray.Visible = true;
            Forms.ContextMenuStrip menu = new Forms.ContextMenuStrip();
            targetItem = new Forms.ToolStripMenuItem("Codex / Claude Code не активны"); targetItem.Enabled = false;
            pauseItem = new Forms.ToolStripMenuItem("Приостановить"); pauseItem.Click += delegate { paused = !paused; Interlocked.Increment(ref sendGeneration); pauseItem.Text = paused ? "Продолжить" : "Приостановить"; Reset(true); surface.Visibility = paused ? Visibility.Hidden : Visibility.Visible; if (timer != null) timer.Interval = TimeSpan.FromMilliseconds(paused ? 100 : 16); };
            Forms.ToolStripMenuItem restore = new Forms.ToolStripMenuItem("Вернуть мешок наверх"); restore.Click += delegate { Reset(false); };
            copyItem = new Forms.ToolStripMenuItem("Скопировать последнюю похвалу"); copyItem.Enabled = false; copyItem.Click += delegate { try { Clipboard.SetText(lastPraiseText); } catch { } };
            Forms.ToolStripMenuItem quit = new Forms.ToolStripMenuItem("Выйти из GoodGPT"); quit.Click += delegate { Close(); };
            menu.Items.AddRange(new Forms.ToolStripItem[] { targetItem, new Forms.ToolStripSeparator(), pauseItem, restore, copyItem, new Forms.ToolStripSeparator(), quit }); tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { Reset(false); ShowNotice("Потяните вниз. Колёсико или Shift + движение — перевернуть.", 7); };
            SourceInitialized += OnSourceInitialized;
            MouseLeftButtonDown += OnMouseDown; MouseMove += OnMouseMove; MouseLeftButtonUp += OnMouseUp;
            LostMouseCapture += delegate { if (held) Reset(false); };
            Closed += delegate { disposed = true; Interlocked.Increment(ref sendGeneration); if (timer != null) timer.Stop(); tray.Visible = false; tray.Dispose(); };
            timer = new DispatcherTimer(DispatcherPriority.Render); timer.Interval = TimeSpan.FromMilliseconds(16); timer.Tick += OnTick; timer.Start();
        }

        private void OnSourceInitialized(object source, EventArgs e)
        {
            handle = new WindowInteropHelper(this).Handle;
            baseStyle = Win32.GetStyle(handle) | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOOLWINDOW;
            Win32.SetStyle(handle, baseStyle | Win32.WS_EX_TRANSPARENT);
            HwndSource.FromHwnd(handle).AddHook(WindowMessage);
        }

        private IntPtr WindowMessage(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == Win32.WM_MOUSEACTIVATE) { handled = true; return new IntPtr(3); }
            if (message == Win32.WM_MOUSEWHEEL && held && mode == "dragging")
            {
                short delta = (short)((wParam.ToInt64() >> 16) & 0xffff); targetAngle += -delta * 0.014; handled = true; return IntPtr.Zero;
            }
            if (message == Win32.WM_NCHITTEST && !held)
            {
                Win32.POINT cursor; Win32.GetCursorPos(out cursor);
                Point local = PointFromScreen(new Point(cursor.X, cursor.Y));
                if (paused || !BagHit(local)) { handled = true; return new IntPtr(-1); }
            }
            return IntPtr.Zero;
        }

        private bool BagHit(Point p)
        {
            double dx = p.X - x, dy = p.Y - y, c = Math.Cos(angle), s = Math.Sin(angle);
            double lx = dx * c + dy * s, ly = -dx * s + dy * c;
            return lx * lx / (79 * 79) + ly * ly / (90 * 90) < 1;
        }

        private void OnMouseDown(object source, MouseButtonEventArgs e)
        {
            if (paused || held || sending) return;
            Point point = e.GetPosition(this); if (!BagHit(point)) return;
            grabbed = detected;
            if (grabbed == null || Win32.GetForegroundWindow() != grabbed.Window)
            {
                ShowNotice("Сначала откройте Codex или Claude (Code) и выберите нужный чат.", 6); return;
            }
            held = true; CaptureMouse(); Cursor = Cursors.Hand;
            startX = lastX = point.X; startY = lastY = point.Y;
            offsetX = x - point.X; offsetY = y - point.Y; lastPointerTime = elapsed; speed = 0;
            if (mode == "hung" || mode == "returning") { mode = "tension"; targetAngle = 0; }
            else mode = "dragging";
            e.Handled = true;
        }

        private void OnMouseMove(object source, MouseEventArgs e)
        {
            if (!held) return; Point p = e.GetPosition(this);
            double dt = Math.Max(0.008, elapsed - lastPointerTime), dx = p.X - lastX, dy = p.Y - lastY;
            speed = Clamp(Math.Sqrt(dx * dx + dy * dy) / dt, 0, 1800);
            if (mode == "tension")
            {
                double pull = Math.Max(0, p.Y - startY);
                targetX = homeX + Clamp((p.X - startX) * 0.32, -45, 45); targetY = homeY + Math.Min(pull, 82); targetAngle = Clamp((p.X - startX) * 0.002, -0.18, 0.18);
                if (pull > 70) Detach();
            }
            if (mode == "dragging")
            {
                if ((Win32.GetAsyncKeyState(0x10) & 0x8000) != 0)
                {
                    targetAngle += dx * 0.026; offsetX = x - p.X; offsetY = y - p.Y;
                }
                else
                {
                    targetX = Clamp(p.X + offsetX, leftBound + 58, rightBound - 58); targetY = Clamp(p.Y + offsetY, 76, floor - 65); av += Clamp(dx / dt, -900, 900) * 0.00045;
                }
            }
            lastX = p.X; lastY = p.Y; lastPointerTime = elapsed; e.Handled = true;
        }

        private void OnMouseUp(object source, MouseButtonEventArgs e)
        {
            Release(); e.Handled = true;
        }

        private void Release()
        {
            if (!held) return; held = false; ReleaseMouseCapture(); Cursor = Cursors.Arrow;
            if (mode == "tension") Reset(false);
            else { mode = "free"; releaseAt = elapsed; vx = Clamp(vx, -650, 650); vy = Clamp(vy, -450, 450); }
        }

        private void Detach()
        {
            mode = "dragging"; poured = 0; rewarded = false; accumulator = 0; snapUntil = elapsed + 0.4;
            for (int side = -1; side <= 1; side += 2)
            {
                Point point = Local(side * 62, -37);
                for (int i = 0; i < 5; i++) fibers.Add(new Fiber { X = point.X, Y = point.Y, VX = side * (28 + random.NextDouble() * 40), VY = -80 + random.NextDouble() * 85 });
            }
            ShowNotice("Переверните колёсиком или зажмите Shift и двигайте мышь вбок.", 8);
        }

        private void OnTick(object source, EventArgs e)
        {
            if (disposed) return;
            double now = clock.Elapsed.TotalSeconds, dt = Math.Min(0.05, Math.Max(0, now - lastTime)); lastTime = now;
            if (now - lastDetect > 0.45 && !detectWorking)
            {
                lastDetect = now; detectWorking = true;
                Thread detection = new Thread(delegate()
                {
                    NativeSender.TargetInfo target = null;
                    try { target = sender.DetectTarget(); } catch { }
                    if (!disposed) Dispatcher.BeginInvoke(new Action(delegate
                    {
                        detectWorking = false; detected = target;
                        targetItem.Text = target == null ? "Codex / Claude Code не активны" : "Активен: " + target.App;
                        tray.Text = target == null ? "GoodGPT — откройте Codex или Claude (Code)" : "GoodGPT — " + target.App;
                        if (!held && mode == "hung") ResetBounds(target);
                    }));
                }); detection.IsBackground = true; detection.SetApartmentState(ApartmentState.STA); detection.Start();
            }
            Win32.POINT cursor;
            if (handle != IntPtr.Zero && Win32.GetCursorPos(out cursor))
            {
                Point point = PointFromScreen(new Point(cursor.X, cursor.Y));
                bool through = paused || (!held && !BagHit(point));
                if (through != clickThrough) { clickThrough = through; Win32.SetStyle(handle, baseStyle | (through ? Win32.WS_EX_TRANSPARENT : 0)); }
            }
            if (paused) return;
            if (held && (Win32.GetAsyncKeyState(0x01) & 0x8000) == 0) Release();
            if ((Win32.GetAsyncKeyState(0x1b) & 0x8000) != 0 && mode != "hung") Reset(false);
            if ((held || mode == "free") && grabbed != null && Win32.GetForegroundWindow() != grabbed.Window)
            {
                Reset(false); ShowNotice("Активное окно изменилось. Похвала не отправлена.", 4);
            }
            int steps = Math.Max(1, (int)Math.Ceiling(dt / (1.0 / 120)));
            for (int i = 0; i < steps; i++) Step(dt / steps);
            surface.InvalidateVisual();
            timer.Interval = TimeSpan.FromMilliseconds(mode == "hung" && treats.Count == 0 && fibers.Count == 0 ? 33 : 16);
        }

        private void ResetBounds(NativeSender.TargetInfo target)
        {
            Forms.Screen screen = target == null ? Forms.Screen.PrimaryScreen : Forms.Screen.FromHandle(target.Window);
            System.Drawing.Rectangle work = screen.WorkingArea;
            Point start, end;
            if (handle == IntPtr.Zero)
            {
                double factor = SystemParameters.PrimaryScreenWidth / Forms.Screen.PrimaryScreen.Bounds.Width;
                start = new Point((work.Left - SystemParameters.VirtualScreenLeft) * factor, (work.Top - SystemParameters.VirtualScreenTop) * factor);
                end = new Point(start.X + work.Width * factor, start.Y + work.Height * factor);
            }
            else { start = PointFromScreen(new Point(work.Left, work.Top)); end = PointFromScreen(new Point(work.Right, work.Bottom)); }
            leftBound = start.X; rightBound = end.X; floor = end.Y - 15;
            homeX = end.X - 137; homeY = start.Y + 116;
            if (target != null)
            {
                Win32.RECT rect;
                if (Win32.GetWindowRect(target.Window, out rect))
                {
                    Point topRight = PointFromScreen(new Point(rect.Right, rect.Top));
                    homeX = Clamp(topRight.X - 137, start.X + 100, end.X - 100); homeY = Clamp(topRight.Y + 116, start.Y + 105, end.Y - 180);
                }
            }
        }

        private void Step(double dt)
        {
            elapsed += dt;
            bool gentle = !SystemParameters.ClientAreaAnimation;
            if (mode == "hung")
            {
                double sway = gentle ? 0 : Math.Sin(elapsed * 1.45); x = homeX + sway * 2.6; y = homeY + (gentle ? 0 : Math.Cos(elapsed * 2.9) * 0.7); angle = sway * 0.026; vx = vy = av = 0;
            }
            else if (mode == "free")
            {
                vy += 220 * dt; vx *= Math.Exp(-1.3 * dt); av *= Math.Exp(-2 * dt); x += vx * dt; y += vy * dt; angle += av * dt;
                if (x < leftBound + 65 || x > rightBound - 65) { x = Clamp(x, leftBound + 65, rightBound - 65); vx *= -0.35; }
                if (y > floor - 82) { y = floor - 82; vy *= -0.25; }
                if (elapsed - releaseAt > 1.2) Reset(false);
            }
            else
            {
                vx += ((targetX - x) * 100 - vx * 10) * dt; vy += ((targetY - y) * 100 - vy * 10) * dt; x += vx * dt; y += vy * dt;
                av += ((targetAngle - angle) * 100 - av * 10) * dt; angle += av * dt;
                if (mode == "returning" && elapsed - returnAt > 0.6 && (Distance(x, y, homeX, homeY) < 1.4 && Math.Abs(angle) < 0.02 || elapsed - returnAt > 1.8))
                {
                    mode = "hung"; x = homeX; y = homeY; angle = 0; grabbed = null;
                }
            }
            double downward = -Math.Cos(angle);
            if ((mode == "dragging" || mode == "free") && downward > 0.2 && poured < (gentle ? 20 : 40) && grabbed != null)
            {
                accumulator += dt * ((gentle ? 11 : 13) + downward * 14 + Math.Min(speed / 120, 12));
                while (accumulator >= 1 && poured < (gentle ? 20 : 40)) { accumulator--; Spawn(); }
                speed *= Math.Exp(-4 * dt);
            }
            else accumulator = 0;
            foreach (Treat treat in treats)
            {
                treat.Age += dt; treat.VY += (gentle ? 620 : 920) * dt; treat.VX *= Math.Exp(-0.1 * dt); treat.X += treat.VX * dt; treat.Y += treat.VY * dt; treat.Angle += treat.Spin * dt;
                if (treat.Y + treat.Radius > floor) { treat.Y = floor - treat.Radius; treat.VY = Math.Abs(treat.VY) < 26 ? 0 : -Math.Abs(treat.VY) * 0.43; treat.VX *= Math.Exp(-3.2 * dt); treat.Spin *= Math.Exp(-3.5 * dt); }
                if (treat.X - treat.Radius < leftBound || treat.X + treat.Radius > rightBound) { treat.X = Clamp(treat.X, leftBound + treat.Radius, rightBound - treat.Radius); treat.VX *= -0.5; treat.Spin *= -0.7; }
            }
            for (int a = 0; a < treats.Count; a++) for (int b = a + 1; b < treats.Count; b++) Collide(treats[a], treats[b]);
            foreach (Treat treat in treats) treat.Y = Math.Min(treat.Y, floor - treat.Radius);
            treats.RemoveAll(delegate(Treat p) { return p.Age > p.Life; });
            foreach (Fiber fiber in fibers) { fiber.Age += dt; fiber.VY += 290 * dt; fiber.X += fiber.VX * dt; fiber.Y += fiber.VY * dt; }
            fibers.RemoveAll(delegate(Fiber f) { return f.Age > 0.5; });
        }

        private void Collide(Treat p, Treat q)
        {
            double dx = q.X - p.X, dy = q.Y - p.Y, distance2 = dx * dx + dy * dy, contact = p.Radius + q.Radius;
            if (distance2 >= contact * contact || distance2 < 0.0001) return;
            double distance = Math.Sqrt(distance2), nx = dx / distance, ny = dy / distance;
            double invP = 1 / (p.Radius * p.Radius), invQ = 1 / (q.Radius * q.Radius), mass = invP + invQ, correction = (contact - distance) * 0.75 / mass;
            p.X -= nx * correction * invP; p.Y -= ny * correction * invP; q.X += nx * correction * invQ; q.Y += ny * correction * invQ;
            double relative = (q.VX - p.VX) * nx + (q.VY - p.VY) * ny;
            if (relative < 0) { double impulse = -1.32 * relative / mass; p.VX -= nx * impulse * invP; p.VY -= ny * impulse * invP; q.VX += nx * impulse * invQ; q.VY += ny * impulse * invQ; }
        }

        private void Spawn()
        {
            int index = random.Next(6); double radius = index == 0 ? 15 : index == 4 ? 11 : 12 + random.NextDouble() * 3;
            Point mouth = Local((random.NextDouble() - 0.5) * 30, -59); double impulse = 65 + random.NextDouble() * 65;
            treats.Add(new Treat { X = mouth.X, Y = mouth.Y, VX = Math.Sin(angle) * impulse + vx * 0.23 + (random.NextDouble() - 0.5) * 65, VY = -Math.Cos(angle) * impulse + vy * 0.18, Radius = radius, Index = index, Angle = angle + random.NextDouble() * Math.PI * 2, Spin = (random.NextDouble() - 0.5) * 11, Life = 5.4 + random.NextDouble() * 1.1 });
            if (treats.Count > 54) treats.RemoveAt(0); poured++;
            if (!rewarded && poured >= 8) { rewarded = true; SendReward(); }
        }

        private void SendReward()
        {
            if (sending || grabbed == null) return;
            NativeSender.TargetInfo target = grabbed;
            int choice; do { choice = random.Next(Praise.Length); } while (choice == lastPraise); lastPraise = choice;
            lastPraiseText = Praise[choice]; copyItem.Enabled = true; string message = lastPraiseText;
            int generation = Interlocked.Increment(ref sendGeneration);
            sending = true; ShowNotice("Отправляем похвалу в " + target.App + "…", 15);
            Thread worker = new Thread(delegate()
            {
                NativeSender.SendResult result;
                try { result = sender.SendPraise(target, message, delegate { return disposed || paused || Thread.VolatileRead(ref sendGeneration) != generation; }); }
                catch { result = new NativeSender.SendResult { Success = false, Message = "Не удалось отправить похвалу. Она доступна в меню GoodGPT в трее." }; }
                if (!disposed) Dispatcher.BeginInvoke(new Action(delegate
                {
                    if (disposed) return;
                    if (Thread.VolatileRead(ref sendGeneration) != generation) { sending = false; return; }
                    string feedback = String.IsNullOrWhiteSpace(result.Message) ? "Похвала не отправлена. Проверьте активный чат." : result.Message;
                    sending = false; ShowNotice(result.Success ? "Благодарность отправлена в " + target.App + "." : feedback, result.Success ? 5 : 12);
                }));
            }); worker.IsBackground = true; worker.SetApartmentState(ApartmentState.STA); worker.Start();
        }

        private void ShowNotice(string text, double seconds) { notice = text; }

        private void Reset(bool immediately)
        {
            held = false; ReleaseMouseCapture(); targetX = homeX; targetY = homeY; angle = Math.Atan2(Math.Sin(angle), Math.Cos(angle)); targetAngle = 0; returnAt = elapsed; accumulator = 0; mode = immediately ? "hung" : "returning";
            if (immediately) { x = homeX; y = homeY; angle = av = vx = vy = 0; treats.Clear(); fibers.Clear(); grabbed = null; }
            else foreach (Treat treat in treats) treat.Life = Math.Min(treat.Life, treat.Age + 1.5);
        }

        private Point Local(double px, double py) { return new Point(x + px * Math.Cos(angle) - py * Math.Sin(angle), y + px * Math.Sin(angle) + py * Math.Cos(angle)); }
        private static double Clamp(double n, double lo, double hi) { return Math.Max(lo, Math.Min(hi, n)); }
        private static double Distance(double ax, double ay, double bx, double by) { return Math.Sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }

        private sealed class SceneSurface : FrameworkElement
        {
            private readonly OverlayWindow scene; private readonly Assets assets;
            public SceneSurface(OverlayWindow owner, Assets images) { scene = owner; assets = images; Focusable = false; RenderOptions.SetBitmapScalingMode(this, BitmapScalingMode.HighQuality); }
            protected override HitTestResult HitTestCore(PointHitTestParameters parameters)
            {
                // Native click-through protects other apps; this supplies a real
                // WPF event target for the bag without relying on Window's template.
                return scene.held || scene.BagHit(parameters.HitPoint) ? new PointHitTestResult(this, parameters.HitPoint) : null;
            }
            protected override void OnRender(DrawingContext dc)
            {
                base.OnRender(dc); OverlayWindow s = scene;
                for (int side = -1; side <= 1; side += 2)
                {
                    Point end = s.Local(side * 62, -37), start = new Point(s.homeX + side * 63, s.homeY - 116);
                    if (s.mode == "hung" || s.mode == "tension") Rope(dc, start, end, side * Math.Max(0, 4 - Math.Max(0, s.y - s.homeY) / 10), 1);
                    else if (s.mode == "returning") Rope(dc, start, end, side * 3, Clamp(1 - Distance(s.x, s.y, s.homeX, s.homeY) / 150, 0, 1));
                    else if (s.elapsed < s.snapUntil)
                    {
                        double p = Clamp(1 - (s.snapUntil - s.elapsed) / 0.4, 0, 1); Rope(dc, start, new Point(start.X + Math.Sin(p * 10) * side * 15, start.Y + (end.Y - start.Y) * (1 - p)), side * 15, 1 - p);
                    }
                    if (s.mode != "hung" && s.mode != "tension") Rope(dc, end, new Point(end.X + side * 3, end.Y + 10), side * 4, 0.9);
                }
                foreach (Treat treat in s.treats)
                {
                    double size = treat.Radius * 2.7; dc.PushOpacity(Clamp((treat.Life - treat.Age) / 1.2, 0, 1)); dc.PushTransform(new RotateTransform(treat.Angle * 180 / Math.PI, treat.X, treat.Y)); dc.DrawImage(assets.Treats[treat.Index], new Rect(treat.X - size / 2, treat.Y - size / 2, size, size)); dc.Pop(); dc.Pop();
                }
                foreach (Fiber fiber in s.fibers) { dc.PushOpacity(Clamp(1 - fiber.Age * 2, 0, 1)); dc.DrawLine(new Pen(new SolidColorBrush(Color.FromRgb(182, 141, 88)), 1.2), new Point(fiber.X - 3, fiber.Y), new Point(fiber.X + 4, fiber.Y + 1)); dc.Pop(); }
                dc.PushTransform(new RotateTransform(s.angle * 180 / Math.PI, s.x, s.y)); dc.DrawImage(assets.Bag, new Rect(s.x - 84, s.y - 84, 168, 168)); dc.Pop();
            }
            private static void Rope(DrawingContext dc, Point start, Point end, double slack, double opacity)
            {
                if (opacity <= 0) return; StreamGeometry geometry = new StreamGeometry();
                using (StreamGeometryContext path = geometry.Open()) { path.BeginFigure(start, false, false); path.QuadraticBezierTo(new Point((start.X + end.X) / 2 + slack, (start.Y + end.Y) / 2), end, true, false); }
                geometry.Freeze(); dc.PushOpacity(opacity);
                Pen dark = new Pen(new SolidColorBrush(Color.FromRgb(63, 43, 27)), 5.2); dark.StartLineCap = dark.EndLineCap = PenLineCap.Round;
                Pen main = new Pen(new SolidColorBrush(Color.FromRgb(153, 112, 68)), 3.4); main.StartLineCap = main.EndLineCap = PenLineCap.Round;
                Pen thread = new Pen(new SolidColorBrush(Color.FromRgb(216, 185, 131)), 1.4); thread.DashStyle = new DashStyle(new double[] { 1.5, 2.6 }, 0);
                dc.DrawGeometry(null, dark, geometry); dc.DrawGeometry(null, main, geometry); dc.DrawGeometry(null, thread, geometry); dc.Pop();
            }
        }
    }
}
