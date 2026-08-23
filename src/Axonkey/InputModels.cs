using System;
using System.Collections.Generic;

namespace Axonkey
{
    internal sealed class AppSettings
    {
        public bool RemappingEnabled { get; set; }
        public bool StartWithWindows { get; set; }
        public List<ButtonMapping> Mappings { get; set; }

        public static AppSettings CreateDefault()
        {
            AppSettings settings = new AppSettings();
            settings.RemappingEnabled = true;
            settings.StartWithWindows = false;
            settings.Mappings = new List<ButtonMapping>();
            foreach (SourceKeyDefinition source in KeyCatalog.Sources)
            {
                settings.Mappings.Add(new ButtonMapping
                {
                    SourceId = source.Id,
                    Enabled = true,
                    Action = source.DefaultAction
                });
            }
            return settings;
        }

        public AppSettings Copy()
        {
            AppSettings copy = new AppSettings();
            copy.RemappingEnabled = RemappingEnabled;
            copy.StartWithWindows = StartWithWindows;
            copy.Mappings = new List<ButtonMapping>();
            if (Mappings != null)
            {
                foreach (ButtonMapping mapping in Mappings)
                {
                    copy.Mappings.Add(new ButtonMapping
                    {
                        SourceId = mapping.SourceId,
                        Enabled = mapping.Enabled,
                        Action = mapping.Action
                    });
                }
            }
            return copy;
        }

        public ButtonMapping FindMapping(string sourceId)
        {
            if (Mappings == null) return null;
            foreach (ButtonMapping mapping in Mappings)
            {
                if (string.Equals(mapping.SourceId, sourceId, StringComparison.OrdinalIgnoreCase))
                    return mapping;
            }
            return null;
        }
    }

    internal sealed class ButtonMapping
    {
        public string SourceId { get; set; }
        public bool Enabled { get; set; }
        public string Action { get; set; }
    }

    internal sealed class SourceKeyDefinition
    {
        public string Id { get; set; }
        public string DisplayName { get; set; }
        public string NativeName { get; set; }
        public int VirtualKey { get; set; }
        public int ScanCode { get; set; }
        public bool? Extended { get; set; }
        public string DefaultAction { get; set; }

        public bool Matches(KeyboardStroke stroke)
        {
            if (VirtualKey != 0 && stroke.VirtualKey != VirtualKey) return false;
            if (ScanCode >= 0 && stroke.ScanCode != ScanCode) return false;
            if (Extended.HasValue && stroke.Extended != Extended.Value) return false;
            return true;
        }
    }

    internal sealed class KeyboardStroke
    {
        public int VirtualKey { get; set; }
        public int ScanCode { get; set; }
        public bool Extended { get; set; }
        public bool KeyUp { get; set; }
        public long TimestampTicks { get; set; }

        public string DiagnosticName
        {
            get
            {
                return "vk=0x" + VirtualKey.ToString("X2") +
                    " scan=0x" + (ScanCode | (Extended ? 0x100 : 0)).ToString("X4") +
                    (KeyUp ? " up" : " down");
            }
        }
    }

    internal enum ActionKind
    {
        Original,
        Disabled,
        Chord
    }

    internal sealed class ParsedAction
    {
        public ActionKind Kind { get; set; }
        public List<int> Keys { get; set; }
        public string CanonicalText { get; set; }
        public string DisplayText { get; set; }
    }

    internal sealed class ActionOption
    {
        public ActionOption(string value, string display)
        {
            Value = value;
            Display = display;
        }

        public string Value { get; private set; }
        public string Display { get; private set; }

        public override string ToString()
        {
            return Display;
        }
    }
}
