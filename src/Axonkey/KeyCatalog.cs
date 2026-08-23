using System;
using System.Collections.Generic;

namespace Axonkey
{
    internal static class KeyCatalog
    {
        private static readonly Dictionary<string, int> NameToKey = BuildNameToKey();
        private static readonly Dictionary<int, string> KeyToName = BuildKeyToName();

        public static readonly IList<SourceKeyDefinition> Sources = new List<SourceKeyDefinition>
        {
            NewSource("voice", "语音键", "F5", 0x74, 0x3F, false, "RAlt"),
            NewSource("power", "电源键", "0x015E", 0, 0x5E, true, "Esc"),
            NewSource("home", "主页键", "Home", 0x24, 0x47, null, "original"),
            NewSource("tv", "电视键", "`", 0xC0, 0x29, null, "original"),
            NewSource("menu", "功能键", "Menu", 0x5D, 0x5D, null, "original"),
            NewSource("confirm", "确认键", "Enter", 0x0D, 0x1C, null, "original"),
            NewSource("up", "方向上", "Up", 0x26, 0x48, null, "original"),
            NewSource("down", "方向下", "Down", 0x28, 0x50, null, "original"),
            NewSource("left", "方向左", "Left", 0x25, 0x4B, null, "original"),
            NewSource("right", "方向右", "Right", 0x27, 0x4D, null, "original")
        }.AsReadOnly();

        public static readonly IList<ActionOption> CommonActions = new List<ActionOption>
        {
            new ActionOption("original", "保留原按键"),
            new ActionOption("Esc", "Esc"),
            new ActionOption("Enter", "Enter"),
            new ActionOption("Space", "Space"),
            new ActionOption("Tab", "Tab"),
            new ActionOption("Backspace", "Backspace"),
            new ActionOption("RAlt", "右 Alt"),
            new ActionOption("Ctrl+C", "复制 · Ctrl + C"),
            new ActionOption("Ctrl+V", "粘贴 · Ctrl + V"),
            new ActionOption("Ctrl+Shift+P", "Ctrl + Shift + P"),
            new ActionOption("Win+D", "显示桌面 · Win + D"),
            new ActionOption("VolumeUp", "音量增大"),
            new ActionOption("VolumeDown", "音量减小"),
            new ActionOption("VolumeMute", "静音"),
            new ActionOption("MediaPlayPause", "播放 / 暂停")
        }.AsReadOnly();

        public static SourceKeyDefinition FindSource(KeyboardStroke stroke)
        {
            foreach (SourceKeyDefinition source in Sources)
            {
                if (source.Matches(stroke)) return source;
            }
            return null;
        }

        public static SourceKeyDefinition FindSource(string id)
        {
            foreach (SourceKeyDefinition source in Sources)
            {
                if (string.Equals(source.Id, id, StringComparison.OrdinalIgnoreCase)) return source;
            }
            return null;
        }

        public static bool TryParseAction(string value, out ParsedAction action)
        {
            action = null;
            string text = (value ?? string.Empty).Trim();
            if (text.Length == 0 || text.Equals("original", StringComparison.OrdinalIgnoreCase))
            {
                action = new ParsedAction
                {
                    Kind = ActionKind.Original,
                    Keys = new List<int>(),
                    CanonicalText = "original",
                    DisplayText = "保留原按键"
                };
                return true;
            }
            if (text.Equals("disabled", StringComparison.OrdinalIgnoreCase))
            {
                action = new ParsedAction
                {
                    Kind = ActionKind.Disabled,
                    Keys = new List<int>(),
                    CanonicalText = "disabled",
                    DisplayText = "不执行任何操作"
                };
                return true;
            }

            string[] parts = text.Split(new char[] { '+' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) return false;
            List<int> keys = new List<int>();
            List<string> names = new List<string>();
            foreach (string rawPart in parts)
            {
                string part = rawPart.Trim();
                int key;
                if (!NameToKey.TryGetValue(part, out key)) return false;
                if (keys.Contains(key)) continue;
                keys.Add(key);
                names.Add(GetKeyName(key));
            }
            if (keys.Count == 0 || keys.Count > 4) return false;
            action = new ParsedAction
            {
                Kind = ActionKind.Chord,
                Keys = keys,
                CanonicalText = string.Join("+", names.ToArray()),
                DisplayText = DisplayChord(names)
            };
            return true;
        }

        public static string GetActionDisplay(string value)
        {
            foreach (ActionOption option in CommonActions)
            {
                if (string.Equals(option.Value, value, StringComparison.OrdinalIgnoreCase)) return option.Display;
            }
            ParsedAction parsed;
            return TryParseAction(value, out parsed) ? parsed.DisplayText : "无效映射";
        }

        public static string GetKeyName(int key)
        {
            string name;
            if (KeyToName.TryGetValue(key, out name)) return name;
            return "VK_" + key.ToString("X2");
        }

        public static string FormatCapturedChord(int keyCode, bool control, bool shift, bool alt)
        {
            List<string> parts = new List<string>();
            if (control && !IsControlKey(keyCode)) parts.Add("Ctrl");
            if (shift && !IsShiftKey(keyCode)) parts.Add("Shift");
            if (alt && !IsAltKey(keyCode)) parts.Add("Alt");
            parts.Add(GetKeyName(keyCode));
            return string.Join("+", parts.ToArray());
        }

        public static bool IsModifierKey(int key)
        {
            return IsControlKey(key) || IsShiftKey(key) || IsAltKey(key) || key == 0x5B || key == 0x5C;
        }

        public static bool IsExtendedTargetKey(int key)
        {
            return key == 0xA3 || key == 0xA5 || key == 0x5B || key == 0x5C ||
                key == 0x21 || key == 0x22 || key == 0x23 || key == 0x24 ||
                key == 0x25 || key == 0x26 || key == 0x27 || key == 0x28 ||
                key == 0x2D || key == 0x2E || key == 0x5D ||
                key == 0xAD || key == 0xAE || key == 0xAF || key == 0xB3;
        }

        private static SourceKeyDefinition NewSource(
            string id,
            string display,
            string nativeName,
            int virtualKey,
            int scan,
            bool? extended,
            string defaultAction)
        {
            return new SourceKeyDefinition
            {
                Id = id,
                DisplayName = display,
                NativeName = nativeName,
                VirtualKey = virtualKey,
                ScanCode = scan,
                Extended = extended,
                DefaultAction = defaultAction
            };
        }

        private static Dictionary<string, int> BuildNameToKey()
        {
            Dictionary<string, int> keys = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            Add(keys, "Ctrl", 0x11); Add(keys, "Control", 0x11);
            Add(keys, "LCtrl", 0xA2); Add(keys, "RCtrl", 0xA3);
            Add(keys, "Shift", 0x10); Add(keys, "LShift", 0xA0); Add(keys, "RShift", 0xA1);
            Add(keys, "Alt", 0x12); Add(keys, "LAlt", 0xA4); Add(keys, "RAlt", 0xA5);
            Add(keys, "Win", 0x5B); Add(keys, "LWin", 0x5B); Add(keys, "RWin", 0x5C);
            Add(keys, "Esc", 0x1B); Add(keys, "Escape", 0x1B);
            Add(keys, "Enter", 0x0D); Add(keys, "Space", 0x20); Add(keys, "Tab", 0x09);
            Add(keys, "Backspace", 0x08); Add(keys, "Delete", 0x2E); Add(keys, "Insert", 0x2D);
            Add(keys, "Home", 0x24); Add(keys, "End", 0x23); Add(keys, "PageUp", 0x21); Add(keys, "PageDown", 0x22);
            Add(keys, "Up", 0x26); Add(keys, "Down", 0x28); Add(keys, "Left", 0x25); Add(keys, "Right", 0x27);
            Add(keys, "VolumeMute", 0xAD); Add(keys, "VolumeDown", 0xAE); Add(keys, "VolumeUp", 0xAF);
            Add(keys, "MediaPlayPause", 0xB3);
            for (int letter = 'A'; letter <= 'Z'; letter++) Add(keys, ((char)letter).ToString(), letter);
            for (int digit = '0'; digit <= '9'; digit++) Add(keys, ((char)digit).ToString(), digit);
            for (int f = 1; f <= 24; f++) Add(keys, "F" + f, 0x6F + f);
            return keys;
        }

        private static Dictionary<int, string> BuildKeyToName()
        {
            Dictionary<int, string> result = new Dictionary<int, string>();
            foreach (KeyValuePair<string, int> pair in NameToKey)
            {
                if (!result.ContainsKey(pair.Value)) result[pair.Value] = pair.Key;
            }
            result[0x11] = "Ctrl"; result[0x10] = "Shift"; result[0x12] = "Alt";
            result[0x5B] = "Win"; result[0x1B] = "Esc";
            return result;
        }

        private static void Add(Dictionary<string, int> dictionary, string name, int value)
        {
            dictionary[name] = value;
        }

        private static bool IsControlKey(int key) { return key == 0x11 || key == 0xA2 || key == 0xA3; }
        private static bool IsShiftKey(int key) { return key == 0x10 || key == 0xA0 || key == 0xA1; }
        private static bool IsAltKey(int key) { return key == 0x12 || key == 0xA4 || key == 0xA5; }

        private static string DisplayChord(List<string> names)
        {
            List<string> display = new List<string>();
            foreach (string name in names)
            {
                if (name == "RAlt") display.Add("右 Alt");
                else if (name == "LAlt") display.Add("左 Alt");
                else if (name == "VolumeUp") display.Add("音量增大");
                else if (name == "VolumeDown") display.Add("音量减小");
                else if (name == "VolumeMute") display.Add("静音");
                else if (name == "MediaPlayPause") display.Add("播放 / 暂停");
                else display.Add(name);
            }
            return string.Join(" + ", display.ToArray());
        }
    }
}
