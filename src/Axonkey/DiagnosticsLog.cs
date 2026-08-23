using System;
using System.IO;
using System.Text;

namespace Axonkey
{
    internal static class DiagnosticsLog
    {
        private static readonly object Sync = new object();
        private static string _path;

        public static string DirectoryPath
        {
            get
            {
                string root = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "Axonkey");
                Directory.CreateDirectory(root);
                return root;
            }
        }

        public static string PathValue
        {
            get
            {
                EnsureInitialized();
                return _path;
            }
        }

        public static void Write(string message)
        {
            try
            {
                EnsureInitialized();
                lock (Sync)
                {
                    File.AppendAllText(
                        _path,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + message + Environment.NewLine,
                        Encoding.UTF8);
                }
            }
            catch
            {
                // Diagnostics must never interrupt input processing.
            }
        }

        private static void EnsureInitialized()
        {
            if (!string.IsNullOrEmpty(_path)) return;
            lock (Sync)
            {
                if (!string.IsNullOrEmpty(_path)) return;
                _path = Path.Combine(DirectoryPath, "axonkey.log");
            }
        }
    }
}
