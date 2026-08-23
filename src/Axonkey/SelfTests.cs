using System;
using System.IO;
using System.Text;

namespace Axonkey
{
    internal static class SelfTests
    {
        public static int Run(string resultPath)
        {
            StringBuilder output = new StringBuilder();
            try
            {
                Assert(KeyCatalog.Sources.Count == 10, "expected ten supported RC003 source keys");

                KeyboardStroke f5 = new KeyboardStroke
                {
                    VirtualKey = 0x74,
                    ScanCode = 0x3F,
                    Extended = false
                };
                SourceKeyDefinition f5Source = KeyCatalog.FindSource(f5);
                Assert(f5Source != null && f5Source.Id == "voice", "F5 source detection");

                KeyboardStroke power = new KeyboardStroke
                {
                    VirtualKey = 0,
                    ScanCode = 0x5E,
                    Extended = true
                };
                SourceKeyDefinition powerSource = KeyCatalog.FindSource(power);
                Assert(powerSource != null && powerSource.Id == "power", "extended 0x015E source detection");
                power.Extended = false;
                Assert(KeyCatalog.FindSource(power) == null, "power must require E0 state");

                ParsedAction chord;
                Assert(KeyCatalog.TryParseAction("Ctrl+Shift+P", out chord), "shortcut parser");
                Assert(chord.Kind == ActionKind.Chord && chord.Keys.Count == 3, "shortcut key count");
                Assert(chord.CanonicalText == "Ctrl+Shift+P", "shortcut canonical form");
                Assert(!KeyCatalog.TryParseAction("Ctrl+NoSuchKey", out chord), "invalid shortcut rejection");

                AppSettings settings = AppSettings.CreateDefault();
                Assert(settings.FindMapping("voice").Action == "RAlt", "default F5 mapping");
                Assert(settings.FindMapping("power").Action == "Esc", "default power mapping");
                settings.Mappings.Remove(settings.FindMapping("confirm"));
                SettingsStore.Normalize(settings);
                Assert(settings.FindMapping("confirm") != null, "missing mapping recovery");

                output.AppendLine("AXONKEY_SELF_TEST_OK");
                output.AppendLine("sources=" + KeyCatalog.Sources.Count);
                output.AppendLine("defaults=F5->RAlt,0x015E->Esc");
                File.WriteAllText(resultPath, output.ToString(), new UTF8Encoding(false));
                return 0;
            }
            catch (Exception ex)
            {
                output.AppendLine("AXONKEY_SELF_TEST_FAILED");
                output.AppendLine(ex.ToString());
                File.WriteAllText(resultPath, output.ToString(), new UTF8Encoding(false));
                return 1;
            }
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException("Self-test assertion failed: " + message);
        }
    }
}
