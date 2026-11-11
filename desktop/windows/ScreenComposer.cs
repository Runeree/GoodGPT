using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;
using Windows.Foundation;
using Forms = System.Windows.Forms;

namespace GoodGPTDesktop
{
    // Windows' built-in OCR is a fallback for Chromium windows with no UIA editor.
    // Images and recognized text stay in memory and are never saved or uploaded.
    internal static class ScreenComposer
    {
        internal sealed class Line { public string Text; public System.Windows.Rect Bounds; }
        internal sealed class Snapshot { public List<Line> Lines = new List<Line>(); public System.Windows.Rect Window; }
        private static string Flat(string value) { return new string((value ?? "").ToLowerInvariant().Where(Char.IsLetterOrDigit).ToArray()); }
        internal static bool IsSteer(string text)
        {
            string value = Flat(text);
            return value == "steer" || value == "steernow" || value == "скорректировать" || value == "скорректироватьпромпт";
        }
        internal static Snapshot Read(IntPtr window)
        {
            Snapshot result = new Snapshot();
            RECT bounds; if (!GetWindowRect(window, out bounds)) return result;
            int width = bounds.Right - bounds.Left, height = bounds.Bottom - bounds.Top;
            if (width < 200 || height < 200 || width > 7000 || height > 7000) return result;
            result.Window = new System.Windows.Rect(bounds.Left, bounds.Top, width, height);
            // Only the composer and queued rows, never an entire desktop capture.
            int top = bounds.Top + height / 2, cropHeight = height - height / 2;
            double scale = Math.Min(1, (double)OcrEngine.MaxImageDimension / Math.Max(width, cropHeight));
            int rasterWidth = Math.Max(1, (int)(width * scale)), rasterHeight = Math.Max(1, (int)(cropHeight * scale));
            using (Bitmap capture = new Bitmap(width, cropHeight, PixelFormat.Format32bppArgb))
            using (Bitmap bitmap = new Bitmap(rasterWidth, rasterHeight, PixelFormat.Format32bppArgb))
            {
                using (Graphics graphics = Graphics.FromImage(capture)) graphics.CopyFromScreen(bounds.Left, top, 0, 0, capture.Size);
                using (Graphics graphics = Graphics.FromImage(bitmap)) graphics.DrawImage(capture, 0, 0, rasterWidth, rasterHeight);
                BitmapData pixels = bitmap.LockBits(new Rectangle(0, 0, rasterWidth, rasterHeight), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                byte[] data = new byte[rasterWidth * rasterHeight * 4];
                try { for (int row = 0; row < rasterHeight; row++) Marshal.Copy(IntPtr.Add(pixels.Scan0, row * pixels.Stride), data, row * rasterWidth * 4, rasterWidth * 4); }
                finally { bitmap.UnlockBits(pixels); }
                OcrEngine engine = null;
                try { if (OcrEngine.IsLanguageSupported(new Language("ru-RU"))) engine = OcrEngine.TryCreateFromLanguage(new Language("ru-RU")); } catch { }
                if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
                if (engine == null) return result;
                using (DataWriter writer = new DataWriter())
                {
                    writer.WriteBytes(data);
                    using (SoftwareBitmap image = SoftwareBitmap.CreateCopyFromBuffer(writer.DetachBuffer(), BitmapPixelFormat.Bgra8, rasterWidth, rasterHeight, BitmapAlphaMode.Ignore))
                    {
                        var operation = engine.RecognizeAsync(image);
                        DateTime deadline = DateTime.UtcNow.AddSeconds(2.5);
                        while (operation.Status == AsyncStatus.Started && DateTime.UtcNow < deadline) Thread.Sleep(20);
                        if (operation.Status != AsyncStatus.Completed) { operation.Cancel(); return result; }
                        foreach (OcrLine line in operation.GetResults().Lines)
                        {
                            if (line.Words.Count == 0) continue;
                            double left = double.MaxValue, right = 0, upper = double.MaxValue, lower = 0;
                            foreach (OcrWord word in line.Words)
                            {
                                var r = word.BoundingRect; left = Math.Min(left, r.X); upper = Math.Min(upper, r.Y); right = Math.Max(right, r.X + r.Width); lower = Math.Max(lower, r.Y + r.Height);
                                // OCR may put the preview and its button on one line.
                                // Keep the button's own word bounds for the actual click.
                                if (IsSteer(word.Text)) result.Lines.Add(new Line { Text = word.Text, Bounds = new System.Windows.Rect(bounds.Left + r.X / scale, top + r.Y / scale, r.Width / scale, r.Height / scale) });
                            }
                            result.Lines.Add(new Line { Text = line.Text, Bounds = new System.Windows.Rect(bounds.Left + left / scale, top + upper / scale, (right - left) / scale, (lower - upper) / scale) });
                        }
                    }
                }
            }
            return result;
        }
        internal static System.Windows.Rect InputBounds(Snapshot snapshot)
        {
            foreach (Line line in snapshot.Lines)
            {
                string value = Flat(line.Text);
                if (!(value.Contains("запроситевнесение") || value.Contains("попроситевнести") || value.Contains("спросите") || value.Contains("спроситьchatgpt") || value.Contains("askforfollow") || value.Contains("askanything") || value.Contains("messageclaude") || value.Contains("replytoclaude") || value.Contains("написатьсообщение") || value.Contains("typeamessage") || value.Contains("работайтенадчем") || value.Contains("askcodex"))) continue;
                if (line.Bounds.Top < snapshot.Window.Top + snapshot.Window.Height * 0.60) continue;
                double left = Math.Max(snapshot.Window.Left + 8, line.Bounds.Left - 16);
                double top = line.Bounds.Top - 12;
                return new System.Windows.Rect(left, top, Math.Max(180, Math.Min(snapshot.Window.Right - left - 16, 740)), Math.Min(110, snapshot.Window.Bottom - top - 8));
            }
            return System.Windows.Rect.Empty;
        }
        internal static bool Click(System.Windows.Rect bounds)
        {
            if (bounds.IsEmpty || bounds.Width < 2 || bounds.Height < 2) return false;
            POINT previous; GetCursorPos(out previous);
            try
            {
                if (!SetCursorPos((int)(bounds.Left + bounds.Width / 2), (int)(bounds.Top + bounds.Height / 2))) return false;
                INPUT[] input = { Mouse(2), Mouse(4) };
                return SendInput(2, input, Marshal.SizeOf(typeof(INPUT))) == 2;
            }
            finally { SetCursorPos(previous.X, previous.Y); }
        }
        internal static NativeSender.SendResult Send(NativeSender.TargetInfo target, string message, Func<bool> cancelled, Func<bool> sameTarget)
        {
            Forms.DataObject saved = null; uint ownedClipboard = 0; bool entered = false;
            try
            {
                if (cancelled() || !sameTarget()) return Failure("Окно изменилось.");
                Snapshot before = Read(target.Window);
                System.Windows.Rect input = InputBounds(before);
                if (input.IsEmpty) input = target.ComposerBounds;
                if (input.IsEmpty) return Failure("Не найдено поле ввода. Выберите нужный диалог.");
                target.ComposerBounds = input;
                if (!NativeSender.WaitForModifiers(cancelled) || cancelled() || !sameTarget()) return Failure("Отправка отменена.");
                if (!Click(new System.Windows.Rect(input.Left + 12, input.Top + 8, Math.Max(80, input.Width / 3), Math.Min(35, input.Height)))) return Failure("Не удалось выбрать поле.");
                Thread.Sleep(100);
                if (cancelled() || !sameTarget()) return Failure("Окно изменилось.");
                saved = NativeSender.SnapshotClipboard();
                // Verify the empty editor through its ordinary Copy command as well.
                string marker = "GoodGPT-empty-" + Guid.NewGuid().ToString("N");
                Forms.Clipboard.SetText(marker); ownedClipboard = GetClipboardSequenceNumber();
                NativeSender.SendChord(0x41); NativeSender.SendChord(0x43); Thread.Sleep(100);
                string copied = Forms.Clipboard.ContainsText() ? Forms.Clipboard.GetText() : "";
                ownedClipboard = GetClipboardSequenceNumber();
                NativeSender.SendKey(0x27);
                if (copied != marker && copied.Trim().Length != 0) return Failure("В поле есть черновик. Он сохранён.");
                if (cancelled() || !sameTarget()) return Failure("Окно изменилось.");
                Forms.Clipboard.SetText(message); ownedClipboard = GetClipboardSequenceNumber();
                if (!NativeSender.SendChord(0x56)) return Failure("Windows не разрешила ввод.");
                // Give a busy renderer time to process paste, then read back the text.
                Thread.Sleep(350);
                if (cancelled() || !sameTarget()) return Failure("Отправка отменена.");
                string probe = "GoodGPT-verify-" + Guid.NewGuid().ToString("N");
                Forms.Clipboard.SetText(probe); ownedClipboard = GetClipboardSequenceNumber();
                NativeSender.SendChord(0x41); NativeSender.SendChord(0x43);
                copied = probe;
                for (int attempt = 0; attempt < 20 && copied == probe; attempt++)
                {
                    Thread.Sleep(60);
                    if (cancelled() || !sameTarget()) return Failure("Отправка отменена.");
                    copied = Forms.Clipboard.ContainsText() ? Forms.Clipboard.GetText() : "";
                }
                ownedClipboard = GetClipboardSequenceNumber(); NativeSender.SendKey(0x27);
                if (copied.Trim() != message.Trim()) return Failure("Вставка не подтверждена. Текст оставлен в поле.");
                if (cancelled() || !sameTarget() || !NativeSender.WaitForModifiers(cancelled)) return Failure("Отправка отменена.");
                entered = NativeSender.SendKey(0x0D);
                if (!entered) return Failure("Windows не подтвердила Enter.");
                string ownText = Flat(message);
                for (int attempt = 0; attempt < 5; attempt++)
                {
                    Thread.Sleep(220);
                    if (cancelled() || !sameTarget()) break;
                    Snapshot after = Read(target.Window);
                    foreach (Line button in after.Lines)
                    {
                        if (!IsSteer(button.Text) || before.Lines.Any(old => IsSteer(old.Text) && Math.Abs(old.Bounds.Top - button.Bounds.Top) < 9 && Math.Abs(old.Bounds.Left - button.Bounds.Left) < 12)) continue;
                        bool ownRow = after.Lines.Any(line => Math.Abs(line.Bounds.Top - button.Bounds.Top) < 85 && Flat(line.Text).Length >= 12 && (ownText.Contains(Flat(line.Text)) || Flat(line.Text).Contains(ownText.Substring(0, Math.Min(20, ownText.Length)))));
                        if (!ownRow || cancelled() || !sameTarget()) continue;
                        if (Click(button.Bounds)) return new NativeSender.SendResult { Success = true, MayHaveSent = true, Message = "Похвала передана через Enter и «Скорректировать»." };
                    }
                }
                return new NativeSender.SendResult { MayHaveSent = true, Message = "Enter выполнен. Похвала отправлена или добавлена в очередь." };
            }
            catch { return new NativeSender.SendResult { MayHaveSent = entered, Message = "Не удалось завершить отправку через поле сообщения." }; }
            finally
            {
                try { if (ownedClipboard != 0 && GetClipboardSequenceNumber() == ownedClipboard) { if (saved != null) Forms.Clipboard.SetDataObject(saved, true); else Forms.Clipboard.Clear(); } } catch { }
            }
        }
        private static NativeSender.SendResult Failure(string reason) { return new NativeSender.SendResult { Message = reason }; }
        [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint Type; public UNION Data; }
        [StructLayout(LayoutKind.Explicit)] private struct UNION { [FieldOffset(0)] public MOUSE Mouse; }
        [StructLayout(LayoutKind.Sequential)] private struct MOUSE { public int X, Y; public uint MouseData, Flags, Time; public UIntPtr Extra; }
        private static INPUT Mouse(uint flags) { return new INPUT { Type = 0, Data = new UNION { Mouse = new MOUSE { Flags = flags } } }; }
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT bounds);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll")] private static extern uint SendInput(uint count, INPUT[] input, int size);
    }
}
