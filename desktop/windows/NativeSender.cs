using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
using Forms = System.Windows.Forms;

namespace GoodGPTDesktop
{
    // Uses accessibility and ordinary input for Codex, Claude Code and ChatGPT.
    public sealed class NativeSender
    {
        public sealed class TargetInfo
        {
            public IntPtr Window;
            public int ProcessId;
            public string App;
            public string Title;
            public string Address;
            public System.Windows.Rect ComposerBounds = System.Windows.Rect.Empty;
        }

        public sealed class SendResult
        {
            public bool Success;
            public string Message;
            public bool MayHaveSent;
        }

        private const int VK_CONTROL = 0x11, VK_SHIFT = 0x10, VK_MENU = 0x12;
        private TargetInfo lastTarget;
        private readonly int ownProcessId = Process.GetCurrentProcess().Id;

        public TargetInfo DetectTarget()
        {
            IntPtr window = GetForegroundWindow();
            if (window == IntPtr.Zero || !IsWindow(window) || IsIconic(window)) return null;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == ownProcessId) return lastTarget;
            try
            {
                using (Process process = Process.GetProcessById((int)processId))
                {
                    string name = process.ProcessName.ToLowerInvariant();
                    string title = WindowTitle(window);
                    string app = null;
                    string address = null;
                    if (name == "chatgpt") app = "ChatGPT";
                    else if (name == "codex") app = "Codex";
                    else if (name == "claude" || name == "claude-code" || name == "claudecode") app = "Claude Code";
                    else if (name == "chrome" || name == "msedge" || name == "brave" || name == "vivaldi")
                    {
                        address = BrowserAddress(AutomationElement.FromHandle(window));
                        if (address == null) return null;
                        app = "ChatGPT · " + process.ProcessName;
                    }
                    else return null;
                    lastTarget = new TargetInfo { Window = window, ProcessId = (int)processId, App = app, Title = title, Address = address };
                    return lastTarget;
                }
            }
            catch { return null; }
        }

        public SendResult SendPraise(TargetInfo target, string message)
        {
            return SendPraise(target, message, delegate { return false; });
        }

        public SendResult SendPraise(TargetInfo target, string message, Func<bool> cancelled)
        {
            Forms.DataObject savedClipboard = null;
            uint clipboardSequenceAfterSet = 0;
            bool changedClipboard = false, inserted = false, clicked = false;
            AutomationElement editor = null;
            ValuePattern valuePattern = null;
            try
            {
                if (cancelled == null) cancelled = delegate { return false; };
                if (cancelled()) return Fail("Отправка отменена.");
                if (target == null || String.IsNullOrWhiteSpace(message)) return Fail("Откройте Codex или вкладку Code в Claude и повторите высыпание.");
                if (!SameTarget(target)) return Fail("Активное окно изменилось. Похвала не отправлена.");
                AutomationElement window = AutomationElement.FromHandle(target.Window);
                if (!AddressUnchanged(target, window)) return Fail("Открыт другой диалог. Похвала не отправлена.");
                if (HasAttachments(window)) return Fail("В поле есть вложение. Оно сохранено; похвала не отправлена.");
                editor = FindComposer(window, target);
                if (editor == null) return ScreenComposer.Send(target, message, cancelled, delegate { return SameTarget(target) && AddressUnchanged(target, window); });
                string current;
                if (!TryReadEditor(editor, out current)) return ScreenComposer.Send(target, message, cancelled, delegate { return SameTarget(target) && AddressUnchanged(target, window); });
                if (Clean(current).Length != 0) return Fail("В поле уже есть черновик. Он сохранён; похвала не отправлена.");
                if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window)) return Fail("Окно изменилось. Похвала не отправлена.");

                // The overlay never activates; nevertheless focus the precise composer,
                // then verify it belongs to the captured target before synthesising input.
                try { editor.SetFocus(); } catch { return ScreenComposer.Send(target, message, cancelled, delegate { return SameTarget(target) && AddressUnchanged(target, window); }); }
                target.ComposerBounds = editor.Current.BoundingRectangle;
                Thread.Sleep(70);
                if (cancelled() || !SameTarget(target) || !BelongsTo(AutomationElement.FocusedElement, target.Window)) return Fail("Не удалось сфокусировать поле сообщения.");
                if (!TryReadEditor(editor, out current) || Clean(current).Length != 0) return Fail("Поле изменилось. Черновик оставлен нетронутым.");
                object rawPattern;
                if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out rawPattern))
                {
                    valuePattern = rawPattern as ValuePattern;
                    if (valuePattern != null && valuePattern.Current.IsReadOnly) return Fail("Поле сообщения доступно только для чтения.");
                }
                if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window) || !FocusIsComposer(editor)) return Fail("Поле потеряло фокус. Похвала не отправлена.");
                if (HasAttachments(window) || !TryReadEditor(editor, out current) || Clean(current).Length != 0 || !FocusIsComposer(editor)) return Fail("В поле появился черновик, вложение или другой фокус. Похвала не отправлена.");

                // Native paste updates Electron's editor state and input handlers.
                // UIA SetValue can change the visible text without notifying the app.
                if (!inserted)
                {
                    if (!WaitForModifiers(cancelled)) return Fail("Отпустите клавиши Shift, Ctrl и Alt, затем повторите высыпание.");
                    if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window) || !FocusIsComposer(editor)) return Fail("Поле потеряло фокус. Похвала не отправлена.");
                    if (!TryReadEditor(editor, out current) || Clean(current).Length != 0) return Fail("Поле сообщения изменилось. Похвала не отправлена.");
                    savedClipboard = SnapshotClipboard();
                    Forms.Clipboard.SetText(message, Forms.TextDataFormat.UnicodeText);
                    clipboardSequenceAfterSet = GetClipboardSequenceNumber();
                    changedClipboard = true;
                    if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window) || !FocusIsComposer(editor)) return Fail("Поле потеряло фокус. Похвала не отправлена.");
                    if (!TryReadEditor(editor, out current) || Clean(current).Length != 0 || HasAttachments(window)) return Fail("Поле изменилось. Черновик и вложения сохранены.");
                    if (cancelled() || !SameTarget(target) || !FocusIsComposer(editor)) return Fail("Поле потеряло фокус. Похвала не отправлена.");
                    if (!SendChord(0x56)) return Fail("Windows не разрешила ввод в это окно. Запустите приложения с одинаковыми правами.");
                    inserted = true;
                }
                for (int pasteAttempt = 0; pasteAttempt < 24; pasteAttempt++)
                {
                    if (cancelled() || !SameTarget(target)) break;
                    string pasted; if (TryReadEditor(editor, out pasted) && Clean(pasted) == Clean(message)) break;
                    Thread.Sleep(75);
                }
                if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window)) return Fail("Отправка отменена. Проверьте поле сообщения.");
                if (!TryReadEditor(editor, out current) || Clean(current) != Clean(message)) return Fail("Вставка текста не подтверждена. Проверьте поле сообщения.");
                if (HasAttachments(window)) return Fail("Появилось вложение. Похвала не отправлена.");

                HashSet<string> previousMessages = MatchingMessages(window, editor, message);
                HashSet<string> oldSteer = SteerIds(window);
                if (!WaitForModifiers(cancelled) || cancelled() || !SameTarget(target) || !FocusIsComposer(editor)) return Fail("Отправка отменена.");
                if (!TryReadEditor(editor, out current) || Clean(current) != Clean(message)) return Fail("Текст изменился. Он сохранён.");
                clicked = true;
                if (!SendKey(0x0D)) return new SendResult { MayHaveSent = true, Message = "Windows не подтвердила Enter." };
                // Enter may queue the message while Codex is running. Apply only
                // the new queued row containing this exact praise.
                for (int attempt = 0; attempt < 28; attempt++)
                {
                    Thread.Sleep(100);
                    if (cancelled() || !SameTarget(target) || !AddressUnchanged(target, window)) break;
                    AutomationElement steer = FindOwnSteer(window, editor, message, oldSteer);
                    if (steer == null) continue;
                    object action;
                    if (steer.TryGetCurrentPattern(InvokePattern.Pattern, out action))
                    {
                        if (cancelled() || !SameTarget(target)) break;
                        ((InvokePattern)action).Invoke();
                        break;
                    }
                }
                // Never equate clearing an input or pressing Enter with delivery.
                for (int attempt = 0; attempt < 12; attempt++)
                {
                    Thread.Sleep(120);
                    if (cancelled() || !SameTarget(target)) break;
                    HashSet<string> after = MatchingMessages(window, editor, message);
                    foreach (string id in after)
                    {
                        if (!previousMessages.Contains(id)) return new SendResult { Success = true, Message = "Похвала появилась в диалоге." };
                    }
                }
                return new SendResult { Message = "Команда отправки выполнена. Проверьте диалог: приложение не предоставило подтверждение через специальные возможности.", MayHaveSent = true };
            }
            catch (Exception)
            {
                return new SendResult { Message = clicked ? "Не удалось подтвердить отправку. Проверьте диалог перед повтором." : "Не удалось отправить через интерфейс. Проверьте доступность поля сообщения.", MayHaveSent = clicked };
            }
            finally
            {
                // Keep an inserted draft visible when submission was unavailable.
                if (changedClipboard)
                {
                    try
                    {
                        // A copy made by the user after our paste takes precedence.
                        if (GetClipboardSequenceNumber() == clipboardSequenceAfterSet && Forms.Clipboard.ContainsText(Forms.TextDataFormat.UnicodeText) && Forms.Clipboard.GetText(Forms.TextDataFormat.UnicodeText) == message)
                        {
                            if (savedClipboard != null) Forms.Clipboard.SetDataObject(savedClipboard, true);
                            else Forms.Clipboard.Clear();
                        }
                    }
                    catch { }
                }
            }
        }

        private bool SameTarget(TargetInfo target)
        {
            if (target == null || !IsWindow(target.Window) || IsIconic(target.Window) || GetForegroundWindow() != target.Window) return false;
            uint id;
            GetWindowThreadProcessId(target.Window, out id);
            if (id != target.ProcessId) return false;
            if (target.Address == null && !String.IsNullOrEmpty(target.Title) && WindowTitle(target.Window) != target.Title) return false;
            return true;
        }

        private static bool AddressUnchanged(TargetInfo target, AutomationElement window)
        {
            return target.Address == null || BrowserAddress(window) == target.Address;
        }

        private static string BrowserAddress(AutomationElement window)
        {
            if (window == null) return null;
            AutomationElementCollection edits = window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit));
            foreach (AutomationElement edit in edits)
            {
                try
                {
                    if (edit.Current.IsOffscreen || !IsBrowserChromeControl(edit, window)) continue;
                    string label = (edit.Current.Name + " " + edit.Current.AutomationId).ToLowerInvariant();
                    if (!(label.Contains("address") || label.Contains("omnibox") || label.Contains("адрес") || label.Contains("search or enter") || label.Contains("поисков") || label.Contains("location"))) continue;
                    object pattern;
                    if (!edit.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) continue;
                    string value = ((ValuePattern)pattern).Current.Value.Trim();
                    Uri uri;
                    if (!value.Contains("://")) value = "https://" + value;
                    if (!Uri.TryCreate(value, UriKind.Absolute, out uri)) continue;
                    if (uri.Scheme != "https" || !(uri.Host.Equals("chatgpt.com", StringComparison.OrdinalIgnoreCase) || uri.Host.Equals("chat.openai.com", StringComparison.OrdinalIgnoreCase))) continue;
                    return uri.GetLeftPart(UriPartial.Path) + uri.Query;
                }
                catch { }
            }
            return null;
        }

        private static bool IsBrowserChromeControl(AutomationElement element, AutomationElement browser)
        {
            // A web page may name an input "Address". Only browser chrome outside
            // every web Document can establish the actual current-tab origin.
            try
            {
                for (int depth = 0; element != null && depth < 40; depth++)
                {
                    if (Automation.Compare(element, browser)) return true;
                    if (element.Current.ControlType == ControlType.Document) return false;
                    element = TreeWalker.RawViewWalker.GetParent(element);
                }
            }
            catch { }
            return false;
        }

        private static AutomationElement FindComposer(AutomationElement window, TargetInfo target)
        {
            AutomationElement best = null;
            int bestScore = 0;
            try
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                if (focused != null && BelongsTo(focused, target.Window))
                {
                    int score = ComposerScore(focused);
                    if (score > 0) { best = focused; bestScore = score + 15; }
                }
            }
            catch { }
            Condition types = new OrCondition(new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit), new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document));
            foreach (AutomationElement element in window.FindAll(TreeScope.Descendants, types))
            {
                int score = ComposerScore(element);
                if (score > bestScore) { best = element; bestScore = score; }
            }
            return best;
        }

        private static int ComposerScore(AutomationElement element)
        {
            try
            {
                if (element.Current.IsOffscreen || !element.Current.IsEnabled) return 0;
                ControlType type = element.Current.ControlType;
                if (type != ControlType.Edit && type != ControlType.Document) return 0;
                string id = (element.Current.AutomationId ?? "").ToLowerInvariant();
                string name = (element.Current.Name ?? "").Trim().ToLowerInvariant();
                string all = id + " " + name + " " + (element.Current.HelpText ?? "").ToLowerInvariant() + " " + (element.Current.ClassName ?? "").ToLowerInvariant();
                if (all.Contains("terminal") || all.Contains("терминал") || all.Contains("search") || all.Contains("поиск") || all.Contains("address") || all.Contains("адрес") || all.Contains("monaco") || all.Contains("source editor") || all.Contains("редактор кода")) return 0;
                if (all.Contains("prosemirror") || all.Contains("tiptap")) return 135;
                if (id.Contains("prompt-textarea") || id.Contains("claude-textarea") || id == "chat-input") return 140;
                if (id.Contains("composer") || id.Contains("chat-input")) return 120;
                if (name.Contains("ask codex") || name.Contains("message codex") || name.Contains("ask chatgpt") || name.Contains("message chatgpt") || name.Contains("сообщение chatgpt") || name.Contains("сообщение codex")) return 110;
                if (name.Contains("reply to claude") || name.Contains("message claude") || name.Contains("ask claude") || name.Contains("tell claude") || name.Contains("сообщение claude") || name.Contains("ответить claude")) return 110;
                if (name.Contains("ask anything") || name.Contains("спросите что") || name.Contains("describe a task") || name.Contains("опишите задачу")) return 90;
                if (all.Contains("follow up") || all.Contains("follow-up") || all.Contains("write a message") || all.Contains("ask a question") || all.Contains("ответьте") || all.Contains("дополнить") || name.Contains("what would you like to build") || name.Contains("what do you want to build") || name.Contains("how can i help") || name.Contains("type a message")) return 90;
                if (name == "message" || name == "prompt" || name == "reply" || name == "reply..." || name == "reply…" || name == "сообщение" || name == "запрос" || name == "send a message" || name == "написать сообщение") return 75;
            }
            catch { }
            return 0;
        }

        public System.Windows.Rect LocateComposerBounds(TargetInfo target)
        {
            try
            {
                if (!SameTarget(target)) return System.Windows.Rect.Empty;
                AutomationElement window = AutomationElement.FromHandle(target.Window);
                AutomationElement editor = FindComposer(window, target);
                System.Windows.Rect bounds = editor != null ? editor.Current.BoundingRectangle : ScreenComposer.InputBounds(ScreenComposer.Read(target.Window));
                if (SameTarget(target)) target.ComposerBounds = bounds;
                return bounds;
            }
            catch { return System.Windows.Rect.Empty; }
        }

        private static string Identity(AutomationElement element)
        {
            try { return String.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int value) { return value.ToString(); })); } catch { return ""; }
        }
        private static bool SteerLabel(AutomationElement element)
        {
            try { return element.Current.IsEnabled && !element.Current.IsOffscreen && ScreenComposer.IsSteer(element.Current.Name); } catch { return false; }
        }
        private static HashSet<string> SteerIds(AutomationElement window)
        {
            HashSet<string> ids = new HashSet<string>();
            foreach (AutomationElement button in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
                if (SteerLabel(button)) ids.Add(Identity(button));
            return ids;
        }
        private static AutomationElement FindOwnSteer(AutomationElement window, AutomationElement editor, string message, HashSet<string> before)
        {
            foreach (AutomationElement button in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
            {
                if (!SteerLabel(button) || before.Contains(Identity(button))) continue;
                AutomationElement row = TreeWalker.RawViewWalker.GetParent(button);
                for (int depth = 0; row != null && depth < 5 && !Automation.Compare(row, window); depth++, row = TreeWalker.RawViewWalker.GetParent(row))
                {
                    if (Inside(editor, row)) break;
                    if (Clean(row.Current.Name).Contains(Clean(message))) return button;
                    foreach (AutomationElement text in row.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)))
                        if (Clean(text.Current.Name).Contains(Clean(message))) return button;
                }
            }
            return null;
        }

        private static bool TryReadEditor(AutomationElement editor, out string text)
        {
            text = "";
            if (editor == null) return false;
            object pattern;
            if (editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) { text = ((ValuePattern)pattern).Current.Value; return true; }
            if (editor.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) { text = ((TextPattern)pattern).DocumentRange.GetText(-1); return true; }
            return false;
        }

        private static bool HasAttachments(AutomationElement window)
        {
            foreach (AutomationElement button in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
            {
                try
                {
                    if (button.Current.IsOffscreen) continue;
                    string name = button.Current.Name.Trim().ToLowerInvariant();
                    string id = button.Current.AutomationId.ToLowerInvariant();
                    if (id.Contains("remove-attachment") || id.Contains("delete-attachment") || id.Contains("remove-file") || id.Contains("remove-image") || id.Contains("deleteattachment")) return true;
                    if (name.Contains("remove attachment") || name.Contains("delete attachment") || name.Contains("remove file") || name.Contains("remove image") || name.Contains("delete file") || name.Contains("delete image") || name.Contains("удалить вложение") || name.Contains("удалить файл") || name.Contains("удалить изображение") || name.Contains("убрать вложение") || name.Contains("убрать файл")) return true;
                }
                catch { }
            }
            return false;
        }

        private static bool FocusIsComposer(AutomationElement editor)
        {
            try { return editor != null && Inside(AutomationElement.FocusedElement, editor); }
            catch { return false; }
        }

        private static AutomationElement FindSendButton(AutomationElement window, AutomationElement editor)
        {
            AutomationElement best = null;
            int high = 0;
            foreach (AutomationElement button in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button)))
            {
                try
                {
                    if (button.Current.IsOffscreen || !button.Current.IsEnabled) continue;
                    string name = button.Current.Name.Trim().ToLowerInvariant();
                    string id = button.Current.AutomationId.ToLowerInvariant();
                    int score = 0;
                    // A busy composer may expose Queue/Steer alongside Stop.
                    // Stop is never a send action, including when it reuses an ID.
                    if (name.Contains("stop") || name.Contains("cancel") || name.Contains("interrupt") || name.Contains("останов") || name.Contains("отмен") || name.Contains("прервать") || id.Contains("stop")) continue;
                    System.Windows.Rect editorBounds = editor.Current.BoundingRectangle;
                    System.Windows.Rect buttonBounds = button.Current.BoundingRectangle;
                    if (Math.Abs(buttonBounds.Top - editorBounds.Bottom) > 300) continue;
                    if (name.Contains("add to queue") || name.Contains("queue message") || name == "queue" || name.Contains("send follow-up") || name == "steer" || name.Contains("в очередь")) score = 150;
                    if (id.Contains("send-button") || id.Contains("composer-submit")) score = Math.Max(score, 100);
                    if (name == "send message" || name == "send prompt" || name == "отправить сообщение" || name == "отправить запрос") score = Math.Max(score, 90);
                    if (name == "send" || name == "отправить") score = Math.Max(score, 60);
                    if (score > high) { best = button; high = score; }
                }
                catch { }
            }
            return best;
        }

        private static HashSet<string> MatchingMessages(AutomationElement window, AutomationElement editor, string message)
        {
            HashSet<string> ids = new HashSet<string>();
            try
            {
                foreach (AutomationElement element in window.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, message)))
                {
                    try
                    {
                        if (element.Current.IsOffscreen || Inside(element, editor)) continue;
                        ControlType type = element.Current.ControlType;
                        if (type != ControlType.Text && type != ControlType.Document && type != ControlType.ListItem && type != ControlType.Group) continue;
                        ids.Add(String.Join(".", Array.ConvertAll(element.GetRuntimeId(), delegate(int number) { return number.ToString(); })));
                    }
                    catch { }
                }
            }
            catch { }
            return ids;
        }

        private static bool Inside(AutomationElement element, AutomationElement ancestor)
        {
            if (ancestor == null) return false;
            for (int depth = 0; element != null && depth < 40; depth++)
            {
                if (Automation.Compare(element, ancestor)) return true;
                element = TreeWalker.RawViewWalker.GetParent(element);
            }
            return false;
        }

        private static bool BelongsTo(AutomationElement element, IntPtr window)
        {
            try
            {
                for (int depth = 0; element != null && depth < 45; depth++)
                {
                    if (new IntPtr(element.Current.NativeWindowHandle) == window) return true;
                    element = TreeWalker.RawViewWalker.GetParent(element);
                }
            }
            catch { }
            return false;
        }

        internal static Forms.DataObject SnapshotClipboard()
        {
            Forms.IDataObject source = Forms.Clipboard.GetDataObject();
            if (source == null) return null;
            Forms.DataObject snapshot = new Forms.DataObject();
            foreach (string format in source.GetFormats(false))
            {
                try
                {
                    object value = source.GetData(format, false);
                    if (value == null) continue;
                    byte[] bytes = value as byte[];
                    MemoryStream stream = value as MemoryStream;
                    System.Drawing.Image image = value as System.Drawing.Image;
                    if (bytes != null) value = bytes.Clone();
                    else if (stream != null) value = new MemoryStream(stream.ToArray());
                    else if (image != null) value = image.Clone();
                    snapshot.SetData(format, false, value);
                }
                catch { }
            }
            return snapshot;
        }

        internal static bool WaitForModifiers(Func<bool> cancelled)
        {
            for (int attempt = 0; attempt < 35; attempt++)
            {
                if (cancelled()) return false;
                if ((GetAsyncKeyState(VK_CONTROL) & 0x8000) == 0 && (GetAsyncKeyState(VK_SHIFT) & 0x8000) == 0 && (GetAsyncKeyState(VK_MENU) & 0x8000) == 0 && (GetAsyncKeyState(0x5B) & 0x8000) == 0 && (GetAsyncKeyState(0x5C) & 0x8000) == 0) return true;
                Thread.Sleep(40);
            }
            return false;
        }

        private static SendResult Fail(string message) { return new SendResult { Message = message }; }
        private static string Clean(string text) { return (text ?? "").Replace("\u200B", "").Replace("\uFEFF", "").Trim(); }
        private static string WindowTitle(IntPtr window) { System.Text.StringBuilder text = new System.Text.StringBuilder(1024); GetWindowText(window, text, text.Capacity); return text.ToString(); }

        internal static bool SendChord(ushort key)
        {
            INPUT[] inputs = { Keyboard(VK_CONTROL, false), Keyboard(key, false), Keyboard(key, true), Keyboard(VK_CONTROL, true) };
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
        }
        internal static bool SendKey(ushort key)
        {
            INPUT[] inputs = { Keyboard(key, false), Keyboard(key, true) };
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) == inputs.Length;
        }
        private static INPUT Keyboard(ushort key, bool up)
        {
            INPUT input = new INPUT(); input.type = 1; input.union.keyboard.wVk = key; input.union.keyboard.dwFlags = up ? 2u : 0u; return input;
        }
        [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public INPUTUNION union; }
        [StructLayout(LayoutKind.Explicit)] private struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public HARDWAREINPUT hardware; }
        [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, System.Text.StringBuilder text, int max);
        [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
        [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    }
}
