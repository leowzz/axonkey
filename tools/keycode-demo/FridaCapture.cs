using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace Axonkey.KeycodeDemo
{
    // The Python helper owns the verified Gadget and the device-scoped receiver.
    // It writes diagnostics only; no key injection or Interception calls.
    internal sealed class FridaCapture : IDisposable
    {
        private readonly Action<string, string> log;
        private readonly Action onEvent;
        private Process helper;
        internal volatile string Status = "Frida HID：暂停";
        internal int Events;

        internal FridaCapture(Action<string, string> log, Action onEvent)
        {
            this.log = log;
            this.onEvent = onEvent;
        }

        internal void Start()
        {
            if (helper != null)
            {
                if (!helper.HasExited) return;
                helper.Dispose();
                helper = null;
            }
            try
            {
                string folder = AppDomain.CurrentDomain.BaseDirectory;
                string python = File.ReadAllText(Path.Combine(folder, "python-path.txt")).Trim();
                if (!Path.IsPathRooted(python) || !File.Exists(python))
                    throw new FileNotFoundException("请使用 scripts/keycode-demo.ps1 -Frida 准备 Python 运行环境");
                var info = new ProcessStartInfo(python, "-u -m rc003_hid --capture") {
                    WorkingDirectory = folder, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                };
                info.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
                info.EnvironmentVariables["PYTHONDONTWRITEBYTECODE"] = "1";
                helper = new Process { StartInfo = info };
                helper.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                    if (e.Data == null) return;
                    int separator = e.Data.IndexOf('\t');
                    string kind = separator < 0 ? "FRIDA_INFO" : e.Data.Substring(0, separator);
                    string text = separator < 0 ? e.Data : e.Data.Substring(separator + 1);
                    if (kind == "FRIDA_STATUS" || kind == "FRIDA_ERROR") Status = "Frida HID：" + text;
                    if (kind == "FRIDA_HID") { Interlocked.Increment(ref Events); onEvent(); }
                    log(kind, text);
                };
                helper.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                    if (!String.IsNullOrEmpty(e.Data)) { Status = "Frida HID：采集异常，请查看日志"; log("FRIDA_ERROR", e.Data); }
                };
                helper.Start();
                helper.BeginOutputReadLine();
                helper.BeginErrorReadLine();
                Status = "Frida HID：正在连接 RC003";
                log("FRIDA_INFO", "helper_pid=" + helper.Id + "; observing reports only; no remapping");
            }
            catch (Exception error) { Status = "Frida HID：" + error.Message; log("FRIDA_ERROR", error.Message); }
        }

        internal void RefreshStatus()
        {
            if (helper != null && helper.HasExited && helper.ExitCode != 0 && !Status.Contains("退出"))
                Status = "Frida HID：采集进程退出 code=" + helper.ExitCode + "，请查看日志";
        }

        internal void Stop()
        {
            if (helper == null) return;
            try
            {
                if (!helper.HasExited)
                {
                    try { helper.StandardInput.WriteLine("stop"); helper.StandardInput.Flush(); }
                    catch (IOException) { }
                    if (!helper.WaitForExit(4500))
                    {
                        // This is our diagnostic subprocess, never WUDFHost.
                        helper.Kill();
                        helper.WaitForExit(1000);
                        log("FRIDA_STATUS", "helper_stopped_after_timeout");
                    }
                }
                if (helper.HasExited) helper.WaitForExit(); // Drain redirected event callbacks.
            }
            catch (InvalidOperationException) { }
            finally
            {
                helper.Dispose(); helper = null;
                Status = "Frida HID：暂停";
                log("FRIDA_STATUS", "receiver_closed; host hook detaches on disconnect; Gadget DLL remains resident");
            }
        }

        public void Dispose() { Stop(); }
    }
}
