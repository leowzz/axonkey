using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Axonkey.KeycodeDemo
{
    // Observe the keyboard-class scan codes before Windows converts them to virtual keys.
    // Only the matched RC003 slot is filtered. Every received stroke is sent back unchanged.
    internal sealed class InterceptionCapture : IDisposable
    {
        [StructLayout(LayoutKind.Explicit, Size = 20)]
        internal struct Stroke
        {
            [FieldOffset(0)] internal ushort Code;
            [FieldOffset(2)] internal ushort State;
            [FieldOffset(4)] internal uint Information;
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int Predicate(int device);

        internal class Driver
        {
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern IntPtr interception_create_context();
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern void interception_destroy_context(IntPtr context);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern uint interception_get_hardware_id(IntPtr context, int device, [Out] byte[] data, uint size);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern void interception_set_filter(IntPtr context, Predicate predicate, ushort filter);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern ushort interception_get_filter(IntPtr context, int device);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern int interception_wait_with_timeout(IntPtr context, uint milliseconds);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern int interception_receive(IntPtr context, int device, out Stroke stroke, uint count);
            [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
            private static extern int interception_send(IntPtr context, int device, ref Stroke stroke, uint count);

            internal virtual IntPtr Create() { return interception_create_context(); }
            internal virtual void Destroy(IntPtr context) { interception_destroy_context(context); }
            internal virtual string HardwareId(IntPtr context, int device)
            {
                var data = new byte[2048];
                uint copied = interception_get_hardware_id(context, device, data, (uint)data.Length);
                return Encoding.Unicode.GetString(data, 0, (int)Math.Min(copied, (uint)data.Length)).TrimEnd('\0').Replace('\0', '|');
            }
            internal virtual void Filter(IntPtr context, Predicate predicate, ushort filter) { interception_set_filter(context, predicate, filter); }
            internal virtual ushort GetFilter(IntPtr context, int device) { return interception_get_filter(context, device); }
            internal virtual int Wait(IntPtr context) { return interception_wait_with_timeout(context, 50); }
            internal virtual int Receive(IntPtr context, int device, out Stroke stroke) { return interception_receive(context, device, out stroke, 1); }
            internal virtual int Send(IntPtr context, int device, ref Stroke stroke) { return interception_send(context, device, ref stroke, 1); }
        }

        private readonly Action<string, string> log;
        private readonly Action<int, Stroke, int> onStroke;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private Thread worker;
        internal volatile string Status = "Interception：暂停";
        internal int Events;

        internal InterceptionCapture(Action<string, string> log, Action<int, Stroke, int> onStroke)
        {
            this.log = log;
            this.onStroke = onStroke;
        }

        internal static string Format(int slot, Stroke stroke, int sent)
        {
            return String.Format("{0} scan=0x{1:X4} E0={2} E1={3} state=0x{4:X4} information=0x{5:X8} forwarded={6} device=RC003 slot={7}",
                (stroke.State & 1) != 0 ? "UP" : "DOWN", stroke.Code,
                (stroke.State & 2) != 0 ? 1 : 0, (stroke.State & 4) != 0 ? 1 : 0,
                stroke.State, stroke.Information, sent, slot);
        }

        internal void Start()
        {
            if (worker != null && worker.IsAlive) return;
            if (Process.GetProcessesByName("axonkey").Length != 0)
            {
                Status = "Interception：请先从托盘退出 Axonkey，再点击采集";
                log("INTERCEPTION_STATUS", Status);
                return;
            }
            stop.Reset();
            Status = "Interception：正在连接 RC003";
            worker = new Thread(delegate() { Run(new Driver()); }) { IsBackground = true, Name = "RC003 scan-code capture" };
            worker.Start();
        }

        // Kept synchronous so tests can feed unknown scan codes and verify lossless forwarding.
        internal void Run(Driver api)
        {
            IntPtr context = IntPtr.Zero;
            Predicate selected = null;
            try
            {
                context = api.Create();
                if (context == IntPtr.Zero) throw new InvalidOperationException("无法打开驱动（未安装或正在被占用）");
                int target = 0;
                for (int slot = 1; slot <= 10; slot++)
                {
                    string id = api.HardwareId(context, slot);
                    if (id.Length != 0) log("INTERCEPTION_DEVICE", "slot=" + slot + " hardware_id=" + id);
                    if (Decode.IsRemote(id)) { target = slot; break; }
                }
                if (target == 0) throw new InvalidOperationException("驱动中没有 RC003 槽位；先检查连接，或排查驱动重连故障");
                selected = delegate(int slot) { return slot == target ? 1 : 0; };
                api.Filter(context, selected, 0xffff);
                ushort readback = api.GetFilter(context, target);
                // The API has no error result for SetFilter/GetFilter. A zero readback alone
                // is not enough to decide whether input can be received. Observe the events.
                Status = "Interception：等待 RC003 扫描码，槽位 " + target;
                log("INTERCEPTION_STATUS", Status + "; filter_readback=0x" + readback.ToString("X4") +
                    "; all received strokes are forwarded unchanged before logging");
                var nextProbe = Stopwatch.StartNew();
                while (!stop.WaitOne(0))
                {
                    int device = api.Wait(context);
                    if (device > 0)
                    {
                        Stroke stroke;
                        if (api.Receive(context, device, out stroke) != 1)
                            throw new InvalidOperationException("读取驱动事件失败；已停止驱动采集，请重新点击采集");
                        // Send before any observer code. Unknown and zero scan codes are retained.
                        int sent = api.Send(context, device, ref stroke);
                        if (device == target)
                        {
                            Status = "Interception：已收到 RC003 扫描码，槽位 " + target;
                            Interlocked.Increment(ref Events);
                            onStroke(device, stroke, sent);
                        }
                        if (sent != 1) throw new InvalidOperationException("驱动事件转发失败；已停止驱动采集");
                    }
                    if (nextProbe.ElapsedMilliseconds >= 1000)
                    {
                        if (!Decode.IsRemote(api.HardwareId(context, target)))
                            throw new InvalidOperationException("RC003 已断开或设备槽位变化，请唤醒后重新点击采集");
                        nextProbe.Restart();
                    }
                }
            }
            catch (DllNotFoundException) { Status = "Interception：运行库缺失，Windows 事件监听仍可用"; log("INTERCEPTION_STATUS", Status); }
            catch (Exception error) { Status = "Interception：" + error.Message; log("INTERCEPTION_STATUS", Status); }
            finally
            {
                if (context != IntPtr.Zero)
                {
                    try
                    {
                        if (selected != null)
                        {
                            api.Filter(context, selected, 0);
                            // Forward input already queued when Pause was clicked.
                            int device;
                            while ((device = api.Wait(context)) > 0)
                            {
                                Stroke stroke;
                                if (api.Receive(context, device, out stroke) != 1) break;
                                if (api.Send(context, device, ref stroke) != 1) break;
                            }
                        }
                    }
                    finally { api.Destroy(context); }
                    log("INTERCEPTION_STATUS", "RC003 filter cleared; driver context released.");
                }
                GC.KeepAlive(selected);
            }
        }

        internal void Stop()
        {
            stop.Set();
            if (worker != null && !worker.Join(2000))
                log("INTERCEPTION_STATUS", "Driver thread is still stopping; wait before starting a new capture.");
            Status = "Interception：暂停";
        }

        public void Dispose() { Stop(); if (worker == null || !worker.IsAlive) stop.Dispose(); }
    }
}
