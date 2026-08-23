using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;

namespace Axonkey
{
    internal sealed class RemoteKeyEventArgs : EventArgs
    {
        internal RemoteKeyEventArgs(SourceKeyDefinition source, bool keyUp)
        {
            Source = source;
            KeyUp = keyUp;
        }

        public SourceKeyDefinition Source { get; private set; }
        public bool KeyUp { get; private set; }
    }

    internal sealed class MappingExecutedEventArgs : EventArgs
    {
        internal MappingExecutedEventArgs(SourceKeyDefinition source, string actionDisplay)
        {
            Source = source;
            ActionDisplay = actionDisplay;
        }

        public SourceKeyDefinition Source { get; private set; }
        public string ActionDisplay { get; private set; }
    }

    internal sealed class InterceptionInputService : IDisposable
    {
        private const string TargetVid = "VID_2717";
        private const string TargetPid = "PID_32B8";
        private const uint WaitTimeoutMilliseconds = 100;
        private const long DeviceProbeIntervalTicks = TimeSpan.TicksPerSecond;

        private readonly object _gate = new object();
        private readonly Dictionary<string, ActiveMapping> _activeMappings =
            new Dictionary<string, ActiveMapping>(StringComparer.OrdinalIgnoreCase);

        private AppSettings _settings;
        private Thread _worker;
        private bool _stopRequested;
        private bool _disposed;
        private IntPtr _context;
        private int _targetDevice;
        private bool _driverAvailable;
        private bool _deviceConnected;
        private string _deviceHardwareId = string.Empty;
        private bool _stateReported;

        public InterceptionInputService(AppSettings settings)
        {
            _settings = CopyAndNormalize(settings);
        }

        public event EventHandler DeviceStateChanged;
        public event EventHandler<RemoteKeyEventArgs> RemoteKeyObserved;
        public event EventHandler<MappingExecutedEventArgs> MappingExecuted;

        public bool DeviceConnected
        {
            get { lock (_gate) return _deviceConnected; }
        }

        public string DeviceHardwareId
        {
            get { lock (_gate) return _deviceHardwareId; }
        }

        public bool DriverAvailable
        {
            get { lock (_gate) return _driverAvailable; }
        }

        public void Start(IntPtr windowHandle)
        {
            lock (_gate)
            {
                ThrowIfDisposed();
                if (_worker != null) return;

                _stopRequested = false;
                _worker = new Thread(WorkerLoop);
                _worker.IsBackground = true;
                _worker.Name = "Axonkey Interception input";
                _worker.Start();
            }
        }

        public void UpdateSettings(AppSettings settings)
        {
            AppSettings normalized = CopyAndNormalize(settings);
            lock (_gate)
            {
                ThrowIfDisposed();

                // A mapping may contain modifiers. Release its current snapshot before
                // swapping settings, then consume the physical key-up when it arrives.
                ReleaseActiveOutputsLocked(false);
                _settings = normalized;
            }
        }

        public void Dispose()
        {
            Thread worker;
            lock (_gate)
            {
                if (_disposed) return;
                _disposed = true;
                _stopRequested = true;
                worker = _worker;
            }

            if (worker != null && worker != Thread.CurrentThread)
            {
                worker.Join();
            }
        }

        private void WorkerLoop()
        {
            try
            {
                IntPtr context = InterceptionNative.interception_create_context();
                if (context == IntPtr.Zero)
                    throw new InvalidOperationException("Interception could not create an input context.");

                lock (_gate)
                {
                    _context = context;
                }

                long nextProbe = 0;
                while (!ShouldStop())
                {
                    long now = DateTime.UtcNow.Ticks;
                    if (now >= nextProbe)
                    {
                        ProbeDevices(context);
                        nextProbe = now + DeviceProbeIntervalTicks;
                    }

                    int device = InterceptionNative.interception_wait_with_timeout(
                        context,
                        WaitTimeoutMilliseconds);
                    if (device <= 0) continue;

                    InterceptionNative.KeyStroke nativeStroke = new InterceptionNative.KeyStroke();
                    if (InterceptionNative.interception_receive(context, device, ref nativeStroke, 1) != 1)
                        continue;

                    int target;
                    lock (_gate) target = _targetDevice;
                    if (device != target)
                    {
                        SendNative(context, device, ref nativeStroke);
                        continue;
                    }

                    ProcessTargetStroke(context, device, nativeStroke);
                }
            }
            catch (DllNotFoundException ex)
            {
                DiagnosticsLog.Write("Interception DLL not found: " + ex.Message);
                SetDriverAndDeviceState(false, false, 0, string.Empty);
            }
            catch (BadImageFormatException ex)
            {
                DiagnosticsLog.Write("Interception DLL architecture mismatch: " + ex.Message);
                SetDriverAndDeviceState(false, false, 0, string.Empty);
            }
            catch (EntryPointNotFoundException ex)
            {
                DiagnosticsLog.Write("Interception DLL is incompatible: " + ex.Message);
                SetDriverAndDeviceState(false, false, 0, string.Empty);
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Interception input stopped: " + ex.GetType().Name + " " + ex.Message);
                SetDriverAndDeviceState(false, false, 0, string.Empty);
            }
            finally
            {
                CleanupWorker();
            }
        }

        private void ProbeDevices(IntPtr context)
        {
            int foundDevice = 0;
            string foundHardwareId = string.Empty;
            bool sawKeyboard = false;

            for (int device = 1; device <= InterceptionNative.MaxKeyboard; device++)
            {
                string allHardwareIds;
                string hardwareId = GetHardwareId(context, device, out allHardwareIds);
                if (allHardwareIds.Length == 0) continue;
                sawKeyboard = true;

                if (IsTargetHardwareId(allHardwareIds))
                {
                    foundDevice = device;
                    foundHardwareId = hardwareId;
                    break;
                }
            }

            int oldTarget;
            lock (_gate) oldTarget = _targetDevice;
            if (oldTarget != foundDevice)
            {
                if (oldTarget != 0)
                    SetDeviceFilter(context, oldTarget, InterceptionNative.FilterKeyNone);
                if (foundDevice != 0)
                    SetDeviceFilter(context, foundDevice, InterceptionNative.FilterKeyAll);

                lock (_gate)
                {
                    ReleaseActiveOutputsLocked(true);
                    _activeMappings.Clear();
                }
                DiagnosticsLog.Write(foundDevice == 0
                    ? "RC003 disconnected"
                    : "RC003 connected on Interception keyboard " + foundDevice + ": " + foundHardwareId);
            }

            SetDriverAndDeviceState(sawKeyboard, foundDevice != 0, foundDevice, foundHardwareId);
        }

        private void ProcessTargetStroke(
            IntPtr context,
            int device,
            InterceptionNative.KeyStroke nativeStroke)
        {
            bool keyUp = (nativeStroke.State & InterceptionNative.KeyUp) != 0;
            bool extended = (nativeStroke.State & InterceptionNative.KeyE0) != 0;
            KeyboardStroke stroke = new KeyboardStroke
            {
                ScanCode = nativeStroke.Code,
                Extended = extended,
                KeyUp = keyUp,
                VirtualKey = ScanCodeToVirtualKey(nativeStroke.Code, extended),
                TimestampTicks = DateTime.UtcNow.Ticks
            };

            SourceKeyDefinition source = KeyCatalog.FindSource(stroke);
            if (source == null)
            {
                SendNative(context, device, ref nativeStroke);
                return;
            }

            RaiseRemoteKeyObserved(source, keyUp);

            MappingExecutedEventArgs executed = null;
            lock (_gate)
            {
                ActiveMapping active;
                if (keyUp)
                {
                    if (_activeMappings.TryGetValue(source.Id, out active))
                    {
                        if (!active.OutputsReleased) ReleaseOutputsLocked(active);
                        _activeMappings.Remove(source.Id);
                        return;
                    }

                    SendNative(context, device, ref nativeStroke);
                    return;
                }

                if (_activeMappings.TryGetValue(source.Id, out active))
                {
                    if (!active.OutputsReleased && active.Outputs.Count > 0)
                    {
                        InterceptionNative.KeyStroke repeat = active.Outputs[active.Outputs.Count - 1];
                        SendNative(context, device, ref repeat);
                    }
                    return;
                }

                ParsedAction action = GetActionLocked(source);
                if (action.Kind == ActionKind.Original)
                {
                    if (SendNative(context, device, ref nativeStroke))
                    {
                        ActiveMapping original = new ActiveMapping(device, source, action);
                        original.PassThrough = true;
                        original.Outputs.Add(nativeStroke);
                        _activeMappings[source.Id] = original;
                    }
                }
                else if (action.Kind == ActionKind.Disabled)
                {
                    _activeMappings[source.Id] = new ActiveMapping(device, source, action);
                }
                else
                {
                    ActiveMapping mapping = new ActiveMapping(device, source, action);
                    if (!PressOutputsLocked(mapping))
                    {
                        SendNative(context, device, ref nativeStroke);
                        action = OriginalAction();
                    }
                    else
                    {
                        _activeMappings[source.Id] = mapping;
                    }
                }

                DiagnosticsLog.Write("Remote key " + source.Id + " -> " +
                    action.CanonicalText + " (" + action.DisplayText + ")");
                executed = new MappingExecutedEventArgs(source, action.DisplayText);
            }

            if (executed != null) RaiseMappingExecuted(executed);
        }

        private ParsedAction GetActionLocked(SourceKeyDefinition source)
        {
            if (!_settings.RemappingEnabled)
                return OriginalAction();

            ButtonMapping mapping = _settings.FindMapping(source.Id);
            if (mapping == null || !mapping.Enabled)
                return OriginalAction();

            ParsedAction parsed;
            if (!KeyCatalog.TryParseAction(mapping.Action, out parsed))
                return OriginalAction();
            return parsed;
        }

        private bool PressOutputsLocked(ActiveMapping mapping)
        {
            foreach (int virtualKey in mapping.Action.Keys)
            {
                InterceptionNative.KeyStroke output;
                if (!TryCreateOutputStroke(virtualKey, false, out output))
                {
                    DiagnosticsLog.Write("Cannot map virtual key 0x" + virtualKey.ToString("X2"));
                    ReleaseOutputsLocked(mapping);
                    return false;
                }

                if (!SendNative(_context, mapping.Device, ref output))
                {
                    ReleaseOutputsLocked(mapping);
                    return false;
                }
                mapping.Outputs.Add(output);
            }
            return true;
        }

        private void ReleaseOutputsLocked(ActiveMapping mapping)
        {
            for (int index = mapping.Outputs.Count - 1; index >= 0; index--)
            {
                InterceptionNative.KeyStroke output = mapping.Outputs[index];
                output.State = (ushort)(output.State | InterceptionNative.KeyUp);
                SendNative(_context, mapping.Device, ref output);
            }
            mapping.OutputsReleased = true;
        }

        private void ReleaseActiveOutputsLocked(bool includePassThrough)
        {
            foreach (ActiveMapping mapping in _activeMappings.Values)
            {
                if (mapping.PassThrough && !includePassThrough) continue;
                if (!mapping.OutputsReleased) ReleaseOutputsLocked(mapping);
            }
        }

        private void CleanupWorker()
        {
            IntPtr context;
            int device;
            lock (_gate)
            {
                context = _context;
                device = _targetDevice;
                ReleaseActiveOutputsLocked(true);
                _activeMappings.Clear();
            }

            if (context != IntPtr.Zero)
            {
                if (device != 0)
                    SetDeviceFilter(context, device, InterceptionNative.FilterKeyNone);
                InterceptionNative.interception_destroy_context(context);
            }

            lock (_gate)
            {
                _context = IntPtr.Zero;
                _targetDevice = 0;
                _worker = null;
            }
            SetDriverAndDeviceState(false, false, 0, string.Empty);
        }

        private void SetDriverAndDeviceState(
            bool driverAvailable,
            bool deviceConnected,
            int targetDevice,
            string hardwareId)
        {
            bool changed;
            lock (_gate)
            {
                changed = !_stateReported ||
                    _driverAvailable != driverAvailable ||
                    _deviceConnected != deviceConnected ||
                    _targetDevice != targetDevice ||
                    !string.Equals(_deviceHardwareId, hardwareId, StringComparison.Ordinal);
                _driverAvailable = driverAvailable;
                _deviceConnected = deviceConnected;
                _targetDevice = targetDevice;
                _deviceHardwareId = hardwareId ?? string.Empty;
                _stateReported = true;
            }
            if (changed) RaiseDeviceStateChanged();
        }

        private static void SetDeviceFilter(IntPtr context, int device, ushort filter)
        {
            InterceptionNative.DevicePredicate predicate = delegate(int candidate)
            {
                return candidate == device ? 1 : 0;
            };
            InterceptionNative.interception_set_filter(context, predicate, filter);
            GC.KeepAlive(predicate);
        }

        private static string GetHardwareId(IntPtr context, int device, out string allHardwareIds)
        {
            byte[] buffer = new byte[2048];
            uint length = InterceptionNative.interception_get_hardware_id(
                context,
                device,
                buffer,
                (uint)buffer.Length);
            if (length < 2 || length > buffer.Length)
            {
                allHardwareIds = string.Empty;
                return string.Empty;
            }

            int byteLength = (int)length;
            while (byteLength >= 2 && buffer[byteLength - 1] == 0 && buffer[byteLength - 2] == 0)
                byteLength -= 2;
            allHardwareIds = Encoding.Unicode.GetString(buffer, 0, byteLength);
            return GetFirstHardwareId(allHardwareIds);
        }

        internal static string GetFirstHardwareId(string hardwareIds)
        {
            if (string.IsNullOrEmpty(hardwareIds)) return string.Empty;
            string[] entries = hardwareIds.Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string entry in entries)
            {
                if (!string.IsNullOrWhiteSpace(entry)) return entry.Trim();
            }
            return string.Empty;
        }

        internal static bool IsTargetHardwareId(string hardwareId)
        {
            if (string.IsNullOrEmpty(hardwareId)) return false;
            bool vidMatches = hardwareId.IndexOf(TargetVid, StringComparison.OrdinalIgnoreCase) >= 0 ||
                hardwareId.IndexOf("VID&012717", StringComparison.OrdinalIgnoreCase) >= 0;
            bool pidMatches = hardwareId.IndexOf(TargetPid, StringComparison.OrdinalIgnoreCase) >= 0 ||
                hardwareId.IndexOf("PID&32B8", StringComparison.OrdinalIgnoreCase) >= 0;
            return vidMatches && pidMatches;
        }

        internal static int ScanCodeToVirtualKey(ushort scanCode, bool extended)
        {
            uint encoded = (uint)scanCode | (extended ? 0xE000u : 0u);
            return (int)(InterceptionNative.MapVirtualKey(encoded, 3) & 0xFFFFu);
        }

        internal static bool TryCreateOutputStroke(
            int virtualKey,
            bool keyUp,
            out InterceptionNative.KeyStroke stroke)
        {
            uint scan = InterceptionNative.MapVirtualKey((uint)virtualKey, 4);
            if (scan == 0) scan = GetMediaScanCode(virtualKey);

            ushort code = (ushort)(scan & 0xFFu);
            bool extended = (scan & 0xFF00u) == 0xE000u ||
                KeyCatalog.IsExtendedTargetKey(virtualKey);
            stroke = new InterceptionNative.KeyStroke
            {
                Code = code,
                State = (ushort)((extended ? InterceptionNative.KeyE0 : 0) |
                    (keyUp ? InterceptionNative.KeyUp : 0)),
                Information = 0
            };
            return code != 0;
        }

        private static uint GetMediaScanCode(int virtualKey)
        {
            switch (virtualKey)
            {
                case 0xAD: return 0xE020; // Volume mute
                case 0xAE: return 0xE02E; // Volume down
                case 0xAF: return 0xE030; // Volume up
                case 0xB3: return 0xE022; // Media play/pause
                default: return 0;
            }
        }

        private static bool SendNative(
            IntPtr context,
            int device,
            ref InterceptionNative.KeyStroke stroke)
        {
            if (context == IntPtr.Zero || device == 0) return false;
            int sent = InterceptionNative.interception_send(context, device, ref stroke, 1);
            if (sent == 1) return true;
            DiagnosticsLog.Write("Interception send failed for keyboard " + device);
            return false;
        }

        private static AppSettings CopyAndNormalize(AppSettings settings)
        {
            AppSettings copy = settings == null ? AppSettings.CreateDefault() : settings.Copy();
            SettingsStore.Normalize(copy);
            return copy;
        }

        private static ParsedAction OriginalAction()
        {
            ParsedAction action;
            KeyCatalog.TryParseAction("original", out action);
            return action;
        }

        private bool ShouldStop()
        {
            lock (_gate) return _stopRequested;
        }

        private void ThrowIfDisposed()
        {
            if (_disposed) throw new ObjectDisposedException("InterceptionInputService");
        }

        private void RaiseDeviceStateChanged()
        {
            EventHandler handler = DeviceStateChanged;
            if (handler == null) return;
            try { handler(this, EventArgs.Empty); }
            catch (Exception ex) { DiagnosticsLog.Write("DeviceStateChanged handler failed: " + ex.Message); }
        }

        private void RaiseRemoteKeyObserved(SourceKeyDefinition source, bool keyUp)
        {
            EventHandler<RemoteKeyEventArgs> handler = RemoteKeyObserved;
            if (handler == null) return;
            try { handler(this, new RemoteKeyEventArgs(source, keyUp)); }
            catch (Exception ex) { DiagnosticsLog.Write("RemoteKeyObserved handler failed: " + ex.Message); }
        }

        private void RaiseMappingExecuted(MappingExecutedEventArgs args)
        {
            EventHandler<MappingExecutedEventArgs> handler = MappingExecuted;
            if (handler == null) return;
            try { handler(this, args); }
            catch (Exception ex) { DiagnosticsLog.Write("MappingExecuted handler failed: " + ex.Message); }
        }

        private sealed class ActiveMapping
        {
            internal ActiveMapping(int device, SourceKeyDefinition source, ParsedAction action)
            {
                Device = device;
                Source = source;
                Action = action;
                Outputs = new List<InterceptionNative.KeyStroke>();
            }

            internal int Device { get; private set; }
            internal SourceKeyDefinition Source { get; private set; }
            internal ParsedAction Action { get; private set; }
            internal List<InterceptionNative.KeyStroke> Outputs { get; private set; }
            internal bool OutputsReleased { get; set; }
            internal bool PassThrough { get; set; }
        }
    }
}
