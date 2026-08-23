using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Axonkey
{
    internal sealed class SettingsStore
    {
        private readonly JavaScriptSerializer _serializer = new JavaScriptSerializer();

        public string SettingsPath
        {
            get { return Path.Combine(DiagnosticsLog.DirectoryPath, "settings.json"); }
        }

        public AppSettings Load()
        {
            AppSettings settings = null;
            try
            {
                if (File.Exists(SettingsPath))
                {
                    settings = _serializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath, Encoding.UTF8));
                }
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Settings load failed: " + ex.GetType().Name + " " + ex.Message);
            }

            if (settings == null) settings = AppSettings.CreateDefault();
            Normalize(settings);
            return settings;
        }

        public void Save(AppSettings settings)
        {
            Normalize(settings);
            string json = _serializer.Serialize(settings);
            string temporary = SettingsPath + ".tmp";
            File.WriteAllText(temporary, json, new UTF8Encoding(false));
            if (File.Exists(SettingsPath))
            {
                string backup = SettingsPath + ".bak";
                File.Replace(temporary, SettingsPath, backup, true);
            }
            else
            {
                File.Move(temporary, SettingsPath);
            }
            DiagnosticsLog.Write("Settings saved");
        }

        internal static void Normalize(AppSettings settings)
        {
            if (settings.Mappings == null) settings.Mappings = new List<ButtonMapping>();
            foreach (SourceKeyDefinition source in KeyCatalog.Sources)
            {
                ButtonMapping mapping = settings.FindMapping(source.Id);
                if (mapping == null)
                {
                    settings.Mappings.Add(new ButtonMapping
                    {
                        SourceId = source.Id,
                        Enabled = true,
                        Action = source.DefaultAction
                    });
                    continue;
                }
                ParsedAction parsed;
                if (!KeyCatalog.TryParseAction(mapping.Action, out parsed)) mapping.Action = source.DefaultAction;
                else mapping.Action = parsed.CanonicalText;
            }
        }
    }
}
