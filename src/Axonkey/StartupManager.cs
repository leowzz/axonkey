using System;
using Microsoft.Win32;

namespace Axonkey
{
    internal static class StartupManager
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string ValueName = "Axonkey";

        public static void SetEnabled(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
            {
                if (key == null) throw new InvalidOperationException("Windows startup registry key is unavailable.");
                if (enabled)
                {
                    string executable = System.Windows.Forms.Application.ExecutablePath;
                    key.SetValue(ValueName, "\"" + executable + "\" --background", RegistryValueKind.String);
                }
                else
                {
                    key.DeleteValue(ValueName, false);
                }
            }
        }
    }
}
