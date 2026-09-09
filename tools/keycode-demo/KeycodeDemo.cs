// Standalone .NET Framework / WinForms diagnostic with optional Interception passthrough.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace Axonkey.KeycodeDemo
{
    internal static class Native
    {
        internal const uint Error = 0xffffffff;
        internal const uint DeviceName = 0x20000007, DeviceInfo = 0x2000000b, PreparsedData = 0x20000005;
        internal const int Input = 0x00ff, DeviceChange = 0x00fe, AppCommand = 0x0319;
        internal const uint SinkNotify = 0x00000100 | 0x00002000;
        internal const int HidSuccess = 0x00110000;

        [StructLayout(LayoutKind.Sequential)]
        internal struct RawDevice { internal ushort Page, Usage; internal uint Flags; internal IntPtr Target; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct DeviceList { internal IntPtr Handle; internal uint Type; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct RawHeader { internal uint Type, Size; internal IntPtr Device, WParam; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct HookData { internal uint Vk, Scan, Flags, Time; internal UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)]
        internal struct UsageAndPage { internal ushort Usage, Page; }
        internal delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool RegisterRawInputDevices([In] RawDevice[] devices, uint count, uint size);
        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint GetRawInputDeviceList([Out] DeviceList[] devices, ref uint count, uint size);
        [DllImport("user32.dll", EntryPoint = "GetRawInputDeviceInfoW", SetLastError = true)]
        internal static extern uint GetDeviceInfo(IntPtr device, uint command, IntPtr data, ref uint size);
        [DllImport("user32.dll", SetLastError = true)]
        internal static extern uint GetRawInputData(IntPtr input, uint command, IntPtr data, ref uint size, uint headerSize);
        [DllImport("user32.dll", EntryPoint = "SetWindowsHookExW", SetLastError = true)]
        internal static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint threadId);
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")]
        internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern IntPtr GetModuleHandle(string module);
        [DllImport("user32.dll")]
        internal static extern int GetMessageTime();
        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
        [DllImport("hid.dll")]
        internal static extern uint HidP_MaxUsageListLength(int reportType, ushort page, IntPtr preparsed);
        [DllImport("hid.dll")]
        internal static extern int HidP_GetUsagesEx(int reportType, ushort collection,
            [Out] UsageAndPage[] usages, ref uint count, IntPtr preparsed, byte[] report, uint length);
    }

    internal static class Decode
    {
        internal static bool IsRemote(string name)
        {
            string upper = name.ToUpperInvariant();
            return (upper.Contains("VID_2717") || upper.Contains("VID&012717")) &&
                (upper.Contains("PID_32B8") || upper.Contains("PID&32B8"));
        }

        internal static string Key(uint key)
        {
            return "0x" + key.ToString("X4") + "(" + ((Keys)key).ToString() + ")";
        }

        internal static string Keyboard(byte[] body)
        {
            if (body.Length < 16) throw new InvalidDataException("Truncated RAWKEYBOARD");
            ushort scan = BitConverter.ToUInt16(body, 0), flags = BitConverter.ToUInt16(body, 2);
            return String.Format("{0} vk={1} scan=0x{2:X4} E0={3} E1={4} flags=0x{5:X4} message=0x{6:X4} extra=0x{7:X8}",
                (flags & 1) != 0 ? "UP" : "DOWN", Key(BitConverter.ToUInt16(body, 6)), scan,
                (flags & 2) != 0 ? 1 : 0, (flags & 4) != 0 ? 1 : 0, flags,
                BitConverter.ToUInt32(body, 8), BitConverter.ToUInt32(body, 12));
        }

        internal static List<byte[]> Reports(byte[] body)
        {
            if (body.Length < 8) throw new InvalidDataException("Truncated RAWHID header");
            uint size = BitConverter.ToUInt32(body, 0), count = BitConverter.ToUInt32(body, 4);
            if (size == 0 || count > 4096 || (ulong)size * count > (ulong)(body.Length - 8))
                throw new InvalidDataException("Invalid RAWHID report size/count");
            var reports = new List<byte[]>();
            for (uint i = 0; i < count; i++)
            {
                byte[] report = new byte[size];
                Buffer.BlockCopy(body, checked(8 + (int)(i * size)), report, 0, report.Length);
                reports.Add(report);
            }
            return reports;
        }

        internal static string Command(long parameter)
        {
            uint high = (uint)((parameter >> 16) & 0xffff);
            uint command = high & 0x0fff, origin = high & 0xf000;
            string name = command == 1 ? "BROWSER_BACKWARD" : command == 8 ? "VOLUME_MUTE" :
                command == 9 ? "VOLUME_DOWN" : command == 10 ? "VOLUME_UP" : "OTHER";
            string source = origin == 0 ? "KEY" : origin == 0x8000 ? "MOUSE" : origin == 0x1000 ? "OEM" : "UNKNOWN";
            return String.Format("command={0}(0x{0:X4},{1}) origin={2} keys=0x{3:X4} device=UNKNOWN", command, name, source, parameter & 0xffff);
        }
    }

    internal sealed class Device : IDisposable
    {
        internal string Name = "UNKNOWN", Source = "UNKNOWN";
        internal uint Type, Vendor, Product;
        internal ushort Page, Usage;
        internal IntPtr Preparsed;
        public void Dispose() { if (Preparsed != IntPtr.Zero) Marshal.FreeHGlobal(Preparsed); Preparsed = IntPtr.Zero; }
    }

    internal sealed class Demo : Form, IMessageFilter
    {
        private readonly TextBox output = new TextBox();
        private readonly Label status = new Label();
        private readonly Label inputStatus = new Label();
        private readonly ConcurrentQueue<string> pending = new ConcurrentQueue<string>();
        private readonly Dictionary<IntPtr, Device> devices = new Dictionary<IntPtr, Device>();
        private readonly HashSet<uint> registrations = new HashSet<uint>();
        private readonly Timer timer = new Timer();
        private readonly Native.HookProc hookCallback;
        private readonly StreamWriter log;
        private readonly string logPath;
        private readonly bool preview;
        private readonly bool captureOnOpen;
        private readonly InterceptionCapture interception;
        private readonly FridaCapture frida;
        private IntPtr hook;
        private volatile string stage = "PAUSED";
        private volatile bool recording;
        private bool initialized, stopped;
        private int dropped;
        private int captureStartCount;
        private DateTime captureStarted;
        internal int EventCount;

        internal Demo(string path, bool preview = false, bool captureOnOpen = false, bool fridaMode = false)
        {
            logPath = path;
            this.preview = preview;
            this.captureOnOpen = captureOnOpen;
            interception = new InterceptionCapture(Write, delegate(int slot, InterceptionCapture.Stroke stroke, int sent) {
                if (!recording) return;
                Interlocked.Increment(ref EventCount);
                Write("INTERCEPTION", InterceptionCapture.Format(slot, stroke, sent));
            });
            if (fridaMode) frida = new FridaCapture(delegate(string kind, string text) {
                if (recording || (kind != "FRIDA_HID" && kind != "FRIDA_KEY")) Write(kind, text);
            }, delegate { if (recording) Interlocked.Increment(ref EventCount); });
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            log = new StreamWriter(path, false, new UTF8Encoding(true));
            hookCallback = OnHook;
            Text = "RC003 按键码诊断 · Axonkey" + (fridaMode ? " · Frida HID 实验" : "");
            Font = new Font("Microsoft YaHei UI", 10);
            ClientSize = new Size(1180, 710);
            MinimumSize = new Size(1000, 560);
            StartPosition = FormStartPosition.CenterScreen;
            if (preview)
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                ShowInTaskbar = false;
            }
            var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(16), ColumnCount = 1, RowCount = 6 };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 66));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 32));
            layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = fridaMode ?
                "Frida HID 原始报告实验：先看下方连接状态，再测试返回、音量加减，也可按确认键作对照。\n完整报告和按下／松开事件会自动保存；此 Demo 仅观察，按键原有功能仍可能执行。" :
                "先从托盘退出 Axonkey。先点“全部按键”测试确认键和普通键盘，再分别测试返回、音量加减。\n按键会继续执行原功能；保持窗口在前台。观察下方驱动状态与事件计数，日志会自动保存。", AutoSize = false }, 0, 0);
            var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = false };
            AddButton(buttons, "全部按键 / 对照", delegate { StartCapture("ALL / 全部按键对照"); });
            AddButton(buttons, "1. 返回", delegate { StartCapture("BACK / 返回"); });
            AddButton(buttons, "2. 音量加", delegate { StartCapture("VOLUME_UP / 音量加"); });
            AddButton(buttons, "3. 音量减", delegate { StartCapture("VOLUME_DOWN / 音量减"); });
            AddButton(buttons, "暂停采集", delegate { PauseCapture(); });
            AddButton(buttons, "复制日志", delegate {
                PauseCapture();
                try { Clipboard.SetText(File.ReadAllText(logPath)); }
                catch (Exception error) { MessageBox.Show(this, error.Message, "复制失败"); }
            });
            AddButton(buttons, "日志目录", delegate {
                PauseCapture();
                Process.Start("explorer.exe", "/select,\"" + logPath + "\"");
            });
            layout.Controls.Add(buttons, 0, 1);
            status.Dock = DockStyle.Fill;
            status.Text = "已暂停 · 点击一个测试按钮开始；按键会继续执行原来的系统功能。";
            layout.Controls.Add(status, 0, 2);
            inputStatus.Dock = DockStyle.Fill;
            inputStatus.Text = fridaMode ? "Frida HID：暂停 · 报告 0 / 全部事件 0" : "Interception：暂停 · 驱动事件 0 / 全部事件 0";
            layout.Controls.Add(inputStatus, 0, 3);
            output.Multiline = true;
            output.ReadOnly = true;
            output.WordWrap = false;
            output.ScrollBars = ScrollBars.Both;
            output.Dock = DockStyle.Fill;
            output.Font = new Font("Consolas", 10);
            layout.Controls.Add(output, 0, 4);
            layout.Controls.Add(new Label { Dock = DockStyle.Fill, Text = "日志自动保存：" + path, AutoEllipsis = true, TextAlign = ContentAlignment.MiddleLeft }, 0, 5);
            Controls.Add(layout);
            Application.AddMessageFilter(this);
            timer.Interval = 100;
            timer.Tick += delegate {
                if (frida != null) frida.RefreshStatus();
                inputStatus.Text = frida != null ? frida.Status + " · 报告 " + frida.Events + " / 全部事件 " + EventCount :
                    interception.Status + " · 驱动事件 " + interception.Events + " / 全部事件 " + EventCount;
                if (recording && EventCount == captureStartCount && (DateTime.Now - captureStarted).TotalSeconds >= 8)
                    status.Text = "本阶段尚无按键事件。请先按遥控器确认键，再按普通键盘 A 作对照。";
                FlushPending();
            };
            timer.Start();
            Write("INFO", "Started " + DateTimeOffset.Now.ToString("o") + "; OS=" + Environment.OSVersion + "; pointerBytes=" + IntPtr.Size);
            Write("INFO", "RAW_KEYBOARD / RAW_HID have device identity when Windows provides it; LL_KEYBOARD / APP_COMMAND do not.");
            Write("INFO", "Stage is a manual label, NOT proof of device origin. Interception forwards original strokes unchanged; no remapping.");
            if (fridaMode) Write("INFO", "FRIDA MODE: Interception capture is disabled. Native HID usage values are recorded before keyboard translation.");
        }

        private static void AddButton(FlowLayoutPanel panel, string text, EventHandler handler)
        {
            var button = new Button { Text = text, Size = new Size(124, 36), Margin = new Padding(0, 0, 8, 0) };
            button.Click += handler;
            panel.Controls.Add(button);
        }

        protected override bool ShowWithoutActivation { get { return preview; } }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            try { InitializeCapture(); if (captureOnOpen) StartCapture("ALL / 全部按键对照"); }
            catch (Exception error) { Write("ERROR", error.Message); status.Text = "初始化失败，请查看日志。"; }
        }

        internal void InitializeCapture()
        {
            if (initialized) return;
            Register(0x01, 0x06, false); // Generic Desktop / Keyboard
            Register(0x0c, 0, true);      // Every Consumer-page top-level collection
            Register(0x01, 0x80, false); // System Control
            EnumerateDevices();
            hook = Native.SetWindowsHookEx(13, hookCallback, Native.GetModuleHandle(null), 0);
            if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Keyboard hook failed");
            initialized = true;
            Write("INFO", "Raw Input and keyboard hook ready. Waiting for a capture button.");
        }

        private void Register(ushort page, ushort usage, bool wholePage)
        {
            uint key = ((uint)page << 16) | usage;
            if (registrations.Contains(key)) return;
            var request = new Native.RawDevice { Page = page, Usage = usage,
                Flags = Native.SinkNotify | (wholePage ? 0x20u : 0), Target = Handle };
            if (!Native.RegisterRawInputDevices(new[] { request }, 1, (uint)Marshal.SizeOf(typeof(Native.RawDevice))))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Raw Input registration failed: " + key.ToString("X8"));
            registrations.Add(key);
        }

        private void EnumerateDevices()
        {
            uint count = 0, size = (uint)Marshal.SizeOf(typeof(Native.DeviceList));
            if (Native.GetRawInputDeviceList(null, ref count, size) == Native.Error)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            for (int attempt = 0; attempt < 3; attempt++)
            {
                var list = new Native.DeviceList[count];
                uint found = Native.GetRawInputDeviceList(list, ref count, size);
                if (found == Native.Error) continue; // Device count can change between calls.
                for (int i = 0; i < found; i++) if (list[i].Type != 0) ResolveDevice(list[i].Handle);
                return;
            }
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Device enumeration failed");
        }

        private Device ResolveDevice(IntPtr handle)
        {
            Device device;
            if (devices.TryGetValue(handle, out device)) return device;
            device = new Device();
            if (handle != IntPtr.Zero)
            {
                uint characters = 0;
                if (Native.GetDeviceInfo(handle, Native.DeviceName, IntPtr.Zero, ref characters) != Native.Error && characters > 0)
                {
                    IntPtr buffer = Marshal.AllocHGlobal(checked((int)characters * 2));
                    try {
                        uint copied = Native.GetDeviceInfo(handle, Native.DeviceName, buffer, ref characters);
                        if (copied != Native.Error) device.Name = Marshal.PtrToStringUni(buffer, (int)copied).TrimEnd('\0');
                    } finally { Marshal.FreeHGlobal(buffer); }
                }
                uint infoSize = 32; // RID_DEVICE_INFO: cbSize, dwType, 24-byte union
                IntPtr info = Marshal.AllocHGlobal((int)infoSize);
                try {
                    Marshal.WriteInt32(info, (int)infoSize);
                    if (Native.GetDeviceInfo(handle, Native.DeviceInfo, info, ref infoSize) != Native.Error)
                    {
                        device.Type = (uint)Marshal.ReadInt32(info, 4);
                        if (device.Type == 2)
                        {
                            device.Vendor = (uint)Marshal.ReadInt32(info, 8);
                            device.Product = (uint)Marshal.ReadInt32(info, 12);
                            device.Page = (ushort)Marshal.ReadInt16(info, 20);
                            device.Usage = (ushort)Marshal.ReadInt16(info, 22);
                        }
                    }
                } finally { Marshal.FreeHGlobal(info); }
                device.Source = Decode.IsRemote(device.Name) || (device.Vendor == 0x2717 && device.Product == 0x32b8)
                    ? "RC003" : device.Name == "UNKNOWN" ? "UNKNOWN" : "OTHER";
                if (device.Type == 2)
                {
                    uint bytes = 0;
                    if (Native.GetDeviceInfo(handle, Native.PreparsedData, IntPtr.Zero, ref bytes) != Native.Error && bytes > 0)
                    {
                        device.Preparsed = Marshal.AllocHGlobal(checked((int)bytes));
                        if (Native.GetDeviceInfo(handle, Native.PreparsedData, device.Preparsed, ref bytes) == Native.Error) device.Dispose();
                    }
                }
            }
            devices.Add(handle, device);
            if (device.Type == 1 || device.Page == 0x0c || device.Source == "RC003" || device.Name == "UNKNOWN")
                Write("DEVICE", Describe(handle, device));
            // Also observe any vendor-defined RC003 HID collection exposed by Windows.
            if (device.Source == "RC003" && device.Type == 2 && device.Page != 0 && device.Usage != 0 && device.Page != 0x0c)
            {
                try { Register(device.Page, device.Usage, false); }
                catch (Exception error) { Write("ERROR", error.Message); }
            }
            return device;
        }

        private static string Describe(IntPtr handle, Device device)
        {
            return String.Format("device={0} handle=0x{1:X} type={2} tlc={3:X4}:{4:X4} vid={5:X4} pid={6:X4} path={7}",
                device.Source, handle.ToInt64(), device.Type, device.Page, device.Usage, device.Vendor, device.Product, device.Name);
        }

        internal void StartCapture(string label)
        {
            if (!initialized) { status.Text = "输入监听尚未就绪，请查看日志并重新打开 Demo。"; return; }
            stage = label;
            recording = true;
            captureStartCount = EventCount;
            captureStarted = DateTime.Now;
            Write("MARK", "Capture started. Press and release only the button named in this stage.");
            if (!preview) { if (frida != null) frida.Start(); else interception.Start(); }
            status.Text = "正在采集：" + label + " · 每个按键按 2–3 次，再切换到下一项。";
            output.Focus();
        }

        internal void PauseCapture()
        {
            if (recording) Write("MARK", "Capture paused.");
            recording = false;
            interception.Stop();
            if (frida != null) frida.Stop();
            stage = "PAUSED";
            status.Text = "已暂停 · 日志已保存，可复制或切换测试按键继续。";
            FlushPending();
        }

        private IntPtr OnHook(int code, IntPtr wParam, IntPtr lParam)
        {
            // Hook callbacks must return quickly. File and UI writes happen on the timer.
            if (code >= 0 && recording)
            {
                try {
                    var data = (Native.HookData)Marshal.PtrToStructure(lParam, typeof(Native.HookData));
                    Interlocked.Increment(ref EventCount);
                    Write("LL_KEYBOARD", String.Format("{0} vk={1} scan=0x{2:X4} E0={3} injected={4} lowerIL={5} flags=0x{6:X2} tick={7} message=0x{8:X4} device=UNKNOWN",
                        (data.Flags & 0x80) != 0 ? "UP" : "DOWN", Decode.Key(data.Vk), data.Scan,
                        (data.Flags & 1) != 0 ? 1 : 0, (data.Flags & 0x10) != 0 ? 1 : 0,
                        (data.Flags & 2) != 0 ? 1 : 0, data.Flags, data.Time, wParam.ToInt64()));
                } catch (Exception error) { Write("ERROR", "Hook: " + error.Message); }
            }
            return Native.CallNextHookEx(hook, code, wParam, lParam);
        }

        protected override void WndProc(ref Message message)
        {
            try
            {
                if (message.Msg == Native.Input && recording) ReadInput(message.LParam);
                else if (message.Msg == Native.AppCommand && recording)
                {
                    Interlocked.Increment(ref EventCount);
                    Write("APP_COMMAND", Decode.Command(message.LParam.ToInt64()) + " tick=" + (uint)Native.GetMessageTime());
                }
                else if (message.Msg == Native.DeviceChange)
                {
                    Device removed;
                    if (devices.TryGetValue(message.LParam, out removed))
                    {
                        Write("DEVICE_CHANGE", "change=" + message.WParam + " " + Describe(message.LParam, removed));
                        removed.Dispose();
                        devices.Remove(message.LParam);
                    }
                    if (message.WParam.ToInt64() == 1) ResolveDevice(message.LParam);
                }
            }
            catch (Exception error) { Write("ERROR", error.Message); }
            // DefWindowProc performs foreground WM_INPUT cleanup and normal media-key handling.
            base.WndProc(ref message);
        }

        public bool PreFilterMessage(ref Message message)
        {
            if (recording && (message.Msg == 0x100 || message.Msg == 0x101 || message.Msg == 0x104 || message.Msg == 0x105))
            {
                long bits = message.LParam.ToInt64();
                Interlocked.Increment(ref EventCount);
                Write("WINDOW_KEY", String.Format("{0} vk={1} scan=0x{2:X2} E0={3} repeat={4} device=UNKNOWN",
                    (bits & 0x80000000L) != 0 ? "UP" : "DOWN", Decode.Key((uint)message.WParam.ToInt64()),
                    (bits >> 16) & 0xff, (bits >> 24) & 1, bits & 0xffff));
            }
            return false; // Observe messages delivered to this process; never consume them.
        }

        private void ReadInput(IntPtr input)
        {
            uint bytes = 0, headerSize = (uint)Marshal.SizeOf(typeof(Native.RawHeader));
            if (Native.GetRawInputData(input, 0x10000003, IntPtr.Zero, ref bytes, headerSize) == Native.Error)
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (bytes < headerSize || bytes > 1024 * 1024) throw new InvalidDataException("Invalid Raw Input size");
            IntPtr buffer = Marshal.AllocHGlobal((int)bytes);
            try
            {
                uint copied = Native.GetRawInputData(input, 0x10000003, buffer, ref bytes, headerSize);
                if (copied == Native.Error) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (copied < headerSize) throw new InvalidDataException("Truncated Raw Input header");
                var header = (Native.RawHeader)Marshal.PtrToStructure(buffer, typeof(Native.RawHeader));
                if (header.Size < headerSize || header.Size > copied) throw new InvalidDataException("Invalid Raw Input header length");
                Device device = ResolveDevice(header.Device);
                byte[] body = new byte[header.Size - headerSize];
                Marshal.Copy(IntPtr.Add(buffer, (int)headerSize), body, 0, body.Length);
                string identity = " tick=" + (uint)Native.GetMessageTime() + " " + Describe(header.Device, device);
                if (header.Type == 1) { Interlocked.Increment(ref EventCount); Write("RAW_KEYBOARD", Decode.Keyboard(body) + identity); }
                else if (header.Type == 2)
                {
                    foreach (byte[] report in Decode.Reports(body))
                    {
                        Interlocked.Increment(ref EventCount);
                        Write("RAW_HID", "hex=" + BitConverter.ToString(report).Replace('-', ' ') + " " + ButtonUsages(device, report) + identity);
                    }
                }
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        private static string ButtonUsages(Device device, byte[] report)
        {
            if (device.Preparsed == IntPtr.Zero) return "buttons=UNAVAILABLE(no descriptor)";
            uint count = Native.HidP_MaxUsageListLength(0, 0, device.Preparsed);
            if (count == 0) return "buttons=NONE_IN_DESCRIPTOR(use hex; report may contain values)";
            if (count > 65536) return "buttons=UNAVAILABLE(invalid descriptor capacity)";
            var usages = new Native.UsageAndPage[count];
            int result = Native.HidP_GetUsagesEx(0, 0, usages, ref count, device.Preparsed, report, (uint)report.Length);
            if (result != Native.HidSuccess) return "buttons=UNAVAILABLE(status=0x" + result.ToString("X8") + ")";
            var text = new StringBuilder("buttons=[");
            for (int i = 0; i < count; i++)
            {
                if (i != 0) text.Append(',');
                text.AppendFormat("0x{0:X4}:0x{1:X4}", usages[i].Page, usages[i].Usage);
            }
            return text.Append(']').ToString();
        }

        private void Write(string channel, string value)
        {
            if (pending.Count >= 10000) { Interlocked.Increment(ref dropped); return; }
            pending.Enqueue(DateTime.Now.ToString("HH:mm:ss.fff") + " [" + stage + "] [" + channel + "] " + value);
        }

        private void FlushPending()
        {
            if (pending.Count == 0 && dropped == 0) return;
            int lost = Interlocked.Exchange(ref dropped, 0);
            if (lost > 0) pending.Enqueue("[ERROR] Log queue overflow: dropped=" + lost);
            var batch = new StringBuilder();
            string line;
            while (pending.TryDequeue(out line)) batch.AppendLine(line);
            string text = batch.ToString();
            try { log.Write(text); log.Flush(); }
            catch (IOException error) { recording = false; interception.Stop(); if (frida != null) frida.Stop(); status.Text = "日志写入失败，采集已暂停：" + error.Message; }
            if (output.TextLength > 500000) output.Clear(); // Full history stays in the file.
            output.AppendText(text);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && !stopped)
            {
                stopped = true;
                recording = false;
                interception.Dispose();
                if (frida != null) frida.Dispose();
                Application.RemoveMessageFilter(this);
                if (hook != IntPtr.Zero) Native.UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
                foreach (uint key in registrations)
                {
                    var remove = new Native.RawDevice { Page = (ushort)(key >> 16), Usage = (ushort)key, Flags = 1, Target = IntPtr.Zero };
                    Native.RegisterRawInputDevices(new[] { remove }, 1, (uint)Marshal.SizeOf(typeof(Native.RawDevice)));
                }
                foreach (Device device in devices.Values) device.Dispose();
                devices.Clear();
                timer.Stop();
                timer.Dispose();
                Write("INFO", "Stopped; input observation released.");
                FlushPending();
                log.Dispose();
            }
            base.Dispose(disposing);
        }

        // Exercise the real native callback without injecting any system-wide keystrokes.
        internal void TestHook()
        {
            var data = new Native.HookData { Vk = 0xaf, Scan = 0x30, Flags = 0x91, Time = 12345 };
            IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.HookData)));
            try { Marshal.StructureToPtr(data, buffer, false); OnHook(0, new IntPtr(0x101), buffer); }
            finally { Marshal.FreeHGlobal(buffer); }
        }

    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            try
            {
                string folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Axonkey", "diagnostics", "keycodes");
                string path = Path.Combine(folder, DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + "-" + Process.GetCurrentProcess().Id + ".log");
                using (var demo = new Demo(path, false, Array.IndexOf(args, "--capture") >= 0,
                    Array.IndexOf(args, "--frida") >= 0)) Application.Run(demo);
                return 0;
            }
            catch (Exception error) { MessageBox.Show(error.ToString(), "RC003 按键诊断启动失败"); return 1; }
        }

        private static void Check(bool passed, string description)
        {
            if (!passed) throw new Exception("FAIL: " + description);
        }

        private sealed class DriverFixture : InterceptionCapture.Driver
        {
            internal readonly Queue<InterceptionCapture.Stroke> Input = new Queue<InterceptionCapture.Stroke>();
            internal readonly List<InterceptionCapture.Stroke> Forwarded = new List<InterceptionCapture.Stroke>();
            internal readonly List<string> Calls = new List<string>();
            internal Action OnEmpty;
            internal bool FailSend, OnlyTarget = true, Destroyed;
            internal ushort ActiveFilter;
            internal override IntPtr Create() { return new IntPtr(1); }
            internal override string HardwareId(IntPtr context, int slot) { return slot == 5 ? "HID#VID_2717&PID_32B8" : "HID#VID_1234&PID_5678"; }
            internal override void Filter(IntPtr context, InterceptionCapture.Predicate predicate, ushort filter)
            {
                for (int slot = 1; slot <= 20; slot++) OnlyTarget &= predicate(slot) == (slot == 5 ? 1 : 0);
                ActiveFilter = filter;
                Calls.Add("filter:" + filter);
            }
            internal override ushort GetFilter(IntPtr context, int slot) { return 0; }
            internal override int Wait(IntPtr context) { if (Input.Count == 0) { if (ActiveFilter != 0) OnEmpty(); return 0; } return 5; }
            internal override int Receive(IntPtr context, int device, out InterceptionCapture.Stroke stroke) { stroke = Input.Dequeue(); return 1; }
            internal override int Send(IntPtr context, int device, ref InterceptionCapture.Stroke stroke) { Forwarded.Add(stroke); Calls.Add("send"); return FailSend ? 0 : 1; }
            internal override void Destroy(IntPtr context) { Destroyed = true; Calls.Add("destroy"); }
        }

        private static void TestInterception()
        {
            Check(Marshal.SizeOf(typeof(InterceptionCapture.Stroke)) == 20, "Interception stroke union ABI");
            var driver = new DriverFixture();
            driver.Input.Enqueue(new InterceptionCapture.Stroke { Code = 0, State = 0, Information = 0x12345678 });
            driver.Input.Enqueue(new InterceptionCapture.Stroke { Code = 0xf1, State = 7, Information = 0x87654321 });
            int observed = 0;
            bool forwardedFirst = true;
            using (var capture = new InterceptionCapture(delegate { }, delegate(int slot, InterceptionCapture.Stroke stroke, int sent) {
                observed++;
                forwardedFirst &= driver.Forwarded.Count == observed;
            }))
            {
                driver.OnEmpty = capture.Stop;
                capture.Run(driver);
            }
            Check(driver.OnlyTarget, "ordinary keyboards and mice never enter the Interception filter");
            Check(observed == 2 && forwardedFirst, "each event is forwarded before observation");
            Check(observed == 2, "zero filter readback does not prematurely stop real event observation");
            Check(driver.Forwarded[0].Code == 0 && driver.Forwarded[0].Information == 0x12345678 &&
                driver.Forwarded[1].Code == 0xf1 && driver.Forwarded[1].State == 7 && driver.Forwarded[1].Information == 0x87654321,
                "zero/unknown scans, extension/release flags and extra info are preserved");
            Check(driver.ActiveFilter == 0 && driver.Destroyed, "stop clears filter and destroys context");
            var failure = new DriverFixture { FailSend = true };
            failure.Input.Enqueue(new InterceptionCapture.Stroke { Code = 0x1c });
            using (var capture = new InterceptionCapture(delegate { }, delegate { }))
            {
                failure.OnEmpty = capture.Stop;
                capture.Run(failure);
                Check(capture.Status.Contains("转发失败"), "send failure is visible");
            }
            Check(failure.ActiveFilter == 0 && failure.Destroyed, "send failure also releases the filter and context");
        }

        private static int SelfTest()
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            try
            {
                TestInterception();
                Check(Marshal.SizeOf(typeof(Native.RawHeader)) == 24, "x64 RAWINPUTHEADER layout");
                Check(Marshal.SizeOf(typeof(Native.RawDevice)) == 16, "x64 RAWINPUTDEVICE layout");
                Check(Marshal.SizeOf(typeof(Native.HookData)) == 24, "x64 KBDLLHOOKSTRUCT layout");
                Check(Decode.IsRemote(@"\\?\HID#VID_2717&PID_32B8#test"), "USB identity");
                Check(Decode.IsRemote(@"HID\RC003_DEV_VID&012717_PID&32B8"), "Bluetooth identity");
                Check(!Decode.IsRemote("HID#VID_2717&PID_0001"), "different product is not RC003");
                byte[] keyboard = { 0x30, 0, 3, 0, 0, 0, 0xaf, 0, 1, 1, 0, 0, 0, 0, 0, 0 };
                string decoded = Decode.Keyboard(keyboard);
                Check(decoded.StartsWith("UP vk=0x00AF") && decoded.Contains("scan=0x0030 E0=1 E1=0"), "extended key-up scan/VK offsets");
                keyboard[0] = 0; keyboard[2] = 0;
                Check(Decode.Keyboard(keyboard).Contains("scan=0x0000"), "zero scan code is preserved, never guessed");
                byte[] hid = { 2, 0, 0, 0, 2, 0, 0, 0, 1, 0xe9, 1, 0 };
                var reports = Decode.Reports(hid);
                Check(reports.Count == 2 && reports[0][1] == 0xe9 && reports[1][1] == 0, "multiple HID reports retain press/release bytes");
                hid[4] = 3;
                bool rejected = false;
                try { Decode.Reports(hid); } catch (InvalidDataException) { rejected = true; }
                Check(rejected, "truncated HID batch rejected");
                Check(Decode.Command(unchecked((int)0x800A0004)).Contains("command=10(0x000A,VOLUME_UP) origin=MOUSE keys=0x0004"), "APPCOMMAND masks source bits and signed lParam");
                string logPath = Path.Combine(folder, "self-test-events.log");
                using (var demo = new Demo(logPath, true))
                {
                    // Render off-screen without activation; install/release actual registrations/hooks.
                    demo.Show();
                    demo.InitializeCapture();
                    demo.TestHook();
                    Check(demo.EventCount == 0, "paused mode records no keyboard input");
                    demo.StartCapture("SELF_TEST / synthetic fixture");
                    demo.TestHook();
                    Check(demo.EventCount == 1, "hook callback records while capturing");
                    // Queue a key message only to our own window. This is not a system input injection.
                    Check(Native.PostMessage(demo.Handle, 0x100, new IntPtr(0x87), new IntPtr(1)), "post test window key");
                    Application.DoEvents();
                    Check(demo.EventCount >= 2, "real message loop delivers window keyboard messages");
                    demo.PauseCapture();
                    demo.PerformLayout();
                    using (var bitmap = new Bitmap(demo.Width, demo.Height))
                    {
                        demo.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
                        bitmap.Save(Path.Combine(folder, "self-test-window.png"));
                    }
                }
                string saved = File.ReadAllText(logPath);
                Check(saved.Contains("injected=1") && saved.Contains("device=UNKNOWN"), "injection and unknown source preserved");
                Check(saved.Contains("[WINDOW_KEY] DOWN vk=0x0087"), "window keyboard fallback is captured");
                Check(saved.Contains("Stopped; input observation released."), "shutdown flushes log and releases listeners");
                Check(!saved.Contains("[ERROR]"), "native registration/device enumeration completed without errors");
                File.WriteAllText(Path.Combine(folder, "self-test.txt"), "PASS: decoding, source identity, native registration/hook lifecycle, paused capture, logging, window rendering, Interception target isolation, lossless forwarding and failure cleanup.\r\nPhysical RC003 button values still require manual capture.\r\n");
                return 0;
            }
            catch (Exception error)
            {
                File.WriteAllText(Path.Combine(folder, "self-test.txt"), error.ToString());
                return 1;
            }
        }
    }
}
