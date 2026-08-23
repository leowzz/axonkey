using System;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace Axonkey
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length > 0 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                string resultPath = args.Length > 1 ? args[1] : Path.Combine(Path.GetTempPath(), "axonkey-self-test.txt");
                return SelfTests.Run(resultPath);
            }

            bool startHidden = HasArgument(args, "--background");
            bool createdNew;
            using (Mutex singleInstance = new Mutex(true, "Local\\Axonkey.SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    if (!startHidden)
                    {
                        MessageBox.Show(
                            "Axonkey 已经在运行。请从任务栏通知区域打开它。",
                            "Axonkey",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Information);
                    }
                    return 0;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += OnThreadException;
                AppDomain.CurrentDomain.UnhandledException += OnUnhandledException;

                DiagnosticsLog.Write("Axonkey starting version=" + typeof(Program).Assembly.GetName().Version);
                SettingsStore store = new SettingsStore();
                AppSettings settings = store.Load();
                using (InterceptionInputService input = new InterceptionInputService(settings))
                using (MainForm form = new MainForm(settings, store, input, startHidden))
                {
                    Application.Run(form);
                }
                DiagnosticsLog.Write("Axonkey stopped");
            }
            return 0;
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (string argument in args)
            {
                if (string.Equals(argument, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static void OnThreadException(object sender, ThreadExceptionEventArgs e)
        {
            DiagnosticsLog.Write("UI exception: " + e.Exception);
            MessageBox.Show(
                "Axonkey 遇到错误，映射已停止。请重新打开应用。\r\n\r\n" + e.Exception.Message,
                "Axonkey",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Application.Exit();
        }

        private static void OnUnhandledException(object sender, UnhandledExceptionEventArgs e)
        {
            DiagnosticsLog.Write("Unhandled exception: " + e.ExceptionObject);
        }
    }
}
