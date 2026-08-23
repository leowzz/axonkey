using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace Axonkey
{
    internal sealed class MainForm : Form
    {
        private readonly AppSettings _settings;
        private readonly SettingsStore _settingsStore;
        private readonly InterceptionInputService _inputService;
        private readonly bool _startHidden;
        private readonly Dictionary<string, ComboBox> _actionSelectors = new Dictionary<string, ComboBox>();
        private readonly Dictionary<string, CheckBox> _mappingToggles = new Dictionary<string, CheckBox>();

        private readonly Label _deviceStatus;
        private readonly Label _deviceDetail;
        private readonly Button _installDriverButton;
        private readonly Label _activityLabel;
        private readonly CheckBox _masterToggle;
        private readonly CheckBox _startupToggle;
        private readonly NotifyIcon _trayIcon;
        private bool _loading;
        private bool _serviceStarted;
        private bool _exitRequested;
        private bool _shownInTray;

        public MainForm(
            AppSettings settings,
            SettingsStore settingsStore,
            InterceptionInputService inputService,
            bool startHidden)
        {
            if (settings == null) throw new ArgumentNullException("settings");
            if (settingsStore == null) throw new ArgumentNullException("settingsStore");
            if (inputService == null) throw new ArgumentNullException("inputService");

            _settings = settings;
            _settingsStore = settingsStore;
            _inputService = inputService;
            _startHidden = startHidden;

            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(246, 248, 250);
            ClientSize = new Size(748, 690);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimumSize = new Size(764, 729);
            StartPosition = FormStartPosition.CenterScreen;
            Text = "Axonkey";

            Panel header = new Panel();
            header.BackColor = Color.White;
            header.Dock = DockStyle.Top;
            header.Height = 132;
            Controls.Add(header);

            Label brand = new Label();
            brand.AutoSize = false;
            brand.Font = new Font(Font.FontFamily, 21F, FontStyle.Bold);
            brand.ForeColor = Color.FromArgb(27, 31, 36);
            brand.Location = new Point(28, 21);
            brand.Size = new Size(220, 42);
            brand.Text = "Axonkey";
            header.Controls.Add(brand);

            Label subtitle = new Label();
            subtitle.AutoSize = false;
            subtitle.ForeColor = Color.FromArgb(87, 96, 106);
            subtitle.Location = new Point(30, 65);
            subtitle.Size = new Size(330, 24);
            subtitle.Text = "小米 RC003 遥控器按键映射";
            header.Controls.Add(subtitle);

            Panel statusDot = new Panel();
            statusDot.BackColor = Color.FromArgb(139, 148, 158);
            statusDot.Location = new Point(31, 101);
            statusDot.Size = new Size(9, 9);
            statusDot.Tag = "statusDot";
            header.Controls.Add(statusDot);

            _deviceStatus = new Label();
            _deviceStatus.AutoSize = false;
            _deviceStatus.Font = new Font(Font, FontStyle.Bold);
            _deviceStatus.ForeColor = Color.FromArgb(87, 96, 106);
            _deviceStatus.Location = new Point(48, 95);
            _deviceStatus.Size = new Size(184, 24);
            _deviceStatus.Text = "正在检查设备…";
            header.Controls.Add(_deviceStatus);

            _deviceDetail = new Label();
            _deviceDetail.AutoEllipsis = true;
            _deviceDetail.ForeColor = Color.FromArgb(110, 119, 129);
            _deviceDetail.Location = new Point(236, 96);
            _deviceDetail.Size = new Size(294, 22);
            header.Controls.Add(_deviceDetail);

            _installDriverButton = new Button();
            _installDriverButton.FlatStyle = FlatStyle.System;
            _installDriverButton.Location = new Point(434, 91);
            _installDriverButton.Size = new Size(96, 30);
            _installDriverButton.Text = "安装驱动";
            _installDriverButton.Visible = false;
            _installDriverButton.Click += InstallDriverButtonClick;
            header.Controls.Add(_installDriverButton);

            Label masterCaption = new Label();
            masterCaption.AutoSize = false;
            masterCaption.Font = new Font(Font, FontStyle.Bold);
            masterCaption.ForeColor = Color.FromArgb(36, 41, 47);
            masterCaption.Location = new Point(566, 28);
            masterCaption.Size = new Size(145, 22);
            masterCaption.Text = "按键映射";
            masterCaption.TextAlign = ContentAlignment.MiddleRight;
            header.Controls.Add(masterCaption);

            _masterToggle = new CheckBox();
            _masterToggle.Appearance = Appearance.Button;
            _masterToggle.FlatAppearance.BorderSize = 0;
            _masterToggle.FlatStyle = FlatStyle.Flat;
            _masterToggle.Font = new Font(Font, FontStyle.Bold);
            _masterToggle.Location = new Point(599, 57);
            _masterToggle.Size = new Size(112, 36);
            _masterToggle.TextAlign = ContentAlignment.MiddleCenter;
            _masterToggle.CheckedChanged += MasterToggleCheckedChanged;
            header.Controls.Add(_masterToggle);

            Label mappingsTitle = new Label();
            mappingsTitle.AutoSize = false;
            mappingsTitle.Font = new Font(Font.FontFamily, 12F, FontStyle.Bold);
            mappingsTitle.ForeColor = Color.FromArgb(36, 41, 47);
            mappingsTitle.Location = new Point(28, 153);
            mappingsTitle.Size = new Size(300, 30);
            mappingsTitle.Text = "按键映射";
            Controls.Add(mappingsTitle);

            TableLayoutPanel mappingsTable = BuildMappingsTable();
            mappingsTable.Location = new Point(28, 190);
            mappingsTable.Size = new Size(692, 444);
            Controls.Add(mappingsTable);

            Panel footer = new Panel();
            footer.BackColor = Color.White;
            footer.Dock = DockStyle.Bottom;
            footer.Height = 48;
            Controls.Add(footer);

            _startupToggle = new CheckBox();
            _startupToggle.AutoSize = false;
            _startupToggle.Location = new Point(28, 13);
            _startupToggle.Size = new Size(126, 24);
            _startupToggle.Text = "开机自动启动";
            _startupToggle.CheckedChanged += StartupToggleCheckedChanged;
            footer.Controls.Add(_startupToggle);

            Button openLogButton = new Button();
            openLogButton.FlatStyle = FlatStyle.System;
            openLogButton.Location = new Point(160, 9);
            openLogButton.Size = new Size(92, 30);
            openLogButton.Text = "打开日志";
            openLogButton.Click += OpenLogButtonClick;
            footer.Controls.Add(openLogButton);

            _activityLabel = new Label();
            _activityLabel.AutoEllipsis = true;
            _activityLabel.ForeColor = Color.FromArgb(87, 96, 106);
            _activityLabel.Location = new Point(276, 13);
            _activityLabel.Size = new Size(444, 23);
            _activityLabel.Text = "等待遥控器按键";
            _activityLabel.TextAlign = ContentAlignment.MiddleRight;
            footer.Controls.Add(_activityLabel);

            ContextMenuStrip trayMenu = new ContextMenuStrip();
            trayMenu.Font = Font;
            trayMenu.Items.Add("打开 Axonkey", null, delegate { RestoreFromTray(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("退出", null, delegate { ExitApplication(); });

            _trayIcon = new NotifyIcon();
            _trayIcon.ContextMenuStrip = trayMenu;
            _trayIcon.Icon = SystemIcons.Application;
            _trayIcon.Text = "Axonkey";
            _trayIcon.Visible = true;
            _trayIcon.DoubleClick += delegate { RestoreFromTray(); };

            _inputService.DeviceStateChanged += InputServiceDeviceStateChanged;
            _inputService.RemoteKeyObserved += InputServiceRemoteKeyObserved;
            _inputService.MappingExecuted += InputServiceMappingExecuted;

            LoadSettingsIntoControls();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            StartInputService();
            if (_startHidden)
            {
                BeginInvoke(new Action(HideToTray));
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_exitRequested && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            _inputService.DeviceStateChanged -= InputServiceDeviceStateChanged;
            _inputService.RemoteKeyObserved -= InputServiceRemoteKeyObserved;
            _inputService.MappingExecuted -= InputServiceMappingExecuted;
            base.OnFormClosed(e);
        }

        private TableLayoutPanel BuildMappingsTable()
        {
            TableLayoutPanel table = new TableLayoutPanel();
            table.BackColor = Color.White;
            table.CellBorderStyle = TableLayoutPanelCellBorderStyle.Single;
            table.ColumnCount = 4;
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 205F));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 328F));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 83F));
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            table.RowCount = KeyCatalog.Sources.Count + 1;
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, 32F));
            for (int index = 0; index < KeyCatalog.Sources.Count; index++)
                table.RowStyles.Add(new RowStyle(SizeType.Absolute, 40F));

            table.Controls.Add(CreateHeaderLabel("遥控器按键"), 0, 0);
            table.Controls.Add(CreateHeaderLabel("执行动作"), 1, 0);
            table.Controls.Add(CreateHeaderLabel("快捷键"), 2, 0);
            table.Controls.Add(CreateHeaderLabel("启用"), 3, 0);

            int row = 1;
            foreach (SourceKeyDefinition source in KeyCatalog.Sources)
            {
                Label sourceLabel = new Label();
                sourceLabel.AutoEllipsis = true;
                sourceLabel.Dock = DockStyle.Fill;
                sourceLabel.Margin = new Padding(12, 0, 6, 0);
                sourceLabel.Text = source.DisplayName + "   " + source.NativeName;
                sourceLabel.TextAlign = ContentAlignment.MiddleLeft;
                table.Controls.Add(sourceLabel, 0, row);

                ComboBox selector = new ComboBox();
                selector.Dock = DockStyle.Fill;
                selector.DropDownStyle = ComboBoxStyle.DropDownList;
                selector.Margin = new Padding(10, 7, 10, 6);
                selector.Tag = source.Id;
                selector.SelectedIndexChanged += ActionSelectorSelectedIndexChanged;
                _actionSelectors[source.Id] = selector;
                table.Controls.Add(selector, 1, row);

                Button captureButton = new Button();
                captureButton.Dock = DockStyle.Fill;
                captureButton.FlatStyle = FlatStyle.System;
                captureButton.Margin = new Padding(8, 6, 8, 5);
                captureButton.Tag = source.Id;
                captureButton.Text = "录入";
                captureButton.Click += CaptureButtonClick;
                table.Controls.Add(captureButton, 2, row);

                CheckBox mappingToggle = new CheckBox();
                mappingToggle.CheckAlign = ContentAlignment.MiddleCenter;
                mappingToggle.Dock = DockStyle.Fill;
                mappingToggle.Margin = Padding.Empty;
                mappingToggle.Tag = source.Id;
                mappingToggle.CheckedChanged += MappingToggleCheckedChanged;
                _mappingToggles[source.Id] = mappingToggle;
                table.Controls.Add(mappingToggle, 3, row);
                row++;
            }
            return table;
        }

        private static Label CreateHeaderLabel(string text)
        {
            Label label = new Label();
            label.BackColor = Color.FromArgb(246, 248, 250);
            label.Dock = DockStyle.Fill;
            label.Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Bold);
            label.ForeColor = Color.FromArgb(87, 96, 106);
            label.Margin = Padding.Empty;
            label.Padding = new Padding(10, 0, 0, 0);
            label.Text = text;
            label.TextAlign = ContentAlignment.MiddleLeft;
            return label;
        }

        private void LoadSettingsIntoControls()
        {
            _loading = true;
            try
            {
                SettingsStore.Normalize(_settings);
                _masterToggle.Checked = _settings.RemappingEnabled;
                UpdateMasterToggleAppearance();
                _startupToggle.Checked = _settings.StartWithWindows;

                foreach (SourceKeyDefinition source in KeyCatalog.Sources)
                {
                    ButtonMapping mapping = _settings.FindMapping(source.Id);
                    ComboBox selector = _actionSelectors[source.Id];
                    PopulateActionSelector(selector, mapping.Action);
                    _mappingToggles[source.Id].Checked = mapping.Enabled;
                }
            }
            finally
            {
                _loading = false;
            }
        }

        private static void PopulateActionSelector(ComboBox selector, string action)
        {
            selector.BeginUpdate();
            try
            {
                selector.Items.Clear();
                int selectedIndex = -1;
                foreach (ActionOption option in KeyCatalog.CommonActions)
                {
                    selector.Items.Add(option);
                    if (string.Equals(option.Value, action, StringComparison.OrdinalIgnoreCase))
                        selectedIndex = selector.Items.Count - 1;
                }
                if (selectedIndex < 0)
                {
                    selector.Items.Add(new ActionOption(action, KeyCatalog.GetActionDisplay(action)));
                    selectedIndex = selector.Items.Count - 1;
                }
                selector.SelectedIndex = selectedIndex;
            }
            finally
            {
                selector.EndUpdate();
            }
        }

        private void MasterToggleCheckedChanged(object sender, EventArgs e)
        {
            UpdateMasterToggleAppearance();
            if (_loading) return;
            _settings.RemappingEnabled = _masterToggle.Checked;
            SaveAndApplySettings();
        }

        private void UpdateMasterToggleAppearance()
        {
            if (_masterToggle.Checked)
            {
                _masterToggle.BackColor = Color.FromArgb(31, 111, 235);
                _masterToggle.ForeColor = Color.White;
                _masterToggle.Text = "已开启";
            }
            else
            {
                _masterToggle.BackColor = Color.FromArgb(218, 223, 230);
                _masterToggle.ForeColor = Color.FromArgb(57, 65, 73);
                _masterToggle.Text = "已关闭";
            }
        }

        private void MappingToggleCheckedChanged(object sender, EventArgs e)
        {
            if (_loading) return;
            CheckBox toggle = (CheckBox)sender;
            ButtonMapping mapping = _settings.FindMapping((string)toggle.Tag);
            if (mapping == null) return;
            mapping.Enabled = toggle.Checked;
            SaveAndApplySettings();
        }

        private void ActionSelectorSelectedIndexChanged(object sender, EventArgs e)
        {
            if (_loading) return;
            ComboBox selector = (ComboBox)sender;
            ActionOption action = selector.SelectedItem as ActionOption;
            ButtonMapping mapping = _settings.FindMapping((string)selector.Tag);
            if (action == null || mapping == null) return;
            mapping.Action = action.Value;
            SaveAndApplySettings();
        }

        private void CaptureButtonClick(object sender, EventArgs e)
        {
            Button button = (Button)sender;
            string sourceId = (string)button.Tag;
            SourceKeyDefinition source = KeyCatalog.FindSource(sourceId);
            ButtonMapping mapping = _settings.FindMapping(sourceId);
            if (source == null || mapping == null) return;

            using (MappingEditorDialog dialog = new MappingEditorDialog(source, mapping.Action))
            {
                if (dialog.ShowDialog(this) != DialogResult.OK || string.IsNullOrEmpty(dialog.CapturedAction)) return;
                mapping.Action = dialog.CapturedAction;
                _loading = true;
                try { PopulateActionSelector(_actionSelectors[sourceId], mapping.Action); }
                finally { _loading = false; }
                SaveAndApplySettings();
            }
        }

        private void StartupToggleCheckedChanged(object sender, EventArgs e)
        {
            if (_loading) return;
            bool previous = _settings.StartWithWindows;
            try
            {
                StartupManager.SetEnabled(_startupToggle.Checked);
                _settings.StartWithWindows = _startupToggle.Checked;
                SaveAndApplySettings();
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Startup option failed: " + ex.Message);
                _loading = true;
                _startupToggle.Checked = previous;
                _loading = false;
                MessageBox.Show(this, "无法修改开机启动设置。\r\n\r\n" + ex.Message,
                    "Axonkey", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void SaveAndApplySettings()
        {
            try
            {
                _settingsStore.Save(_settings);
                _inputService.UpdateSettings(_settings.Copy());
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Settings update failed: " + ex.Message);
                MessageBox.Show(this, "设置未能保存。\r\n\r\n" + ex.Message,
                    "Axonkey", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void StartInputService()
        {
            if (_serviceStarted) return;
            try
            {
                _inputService.UpdateSettings(_settings.Copy());
                _inputService.Start(Handle);
                _serviceStarted = true;
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Input service start failed: " + ex.Message);
            }
            UpdateDeviceState();
        }

        private void InputServiceDeviceStateChanged(object sender, EventArgs e)
        {
            RunOnUiThread(UpdateDeviceState);
        }

        private void InputServiceRemoteKeyObserved(object sender, RemoteKeyEventArgs e)
        {
            if (e == null || e.Source == null || e.KeyUp) return;
            RunOnUiThread(delegate { _activityLabel.Text = "检测到：" + e.Source.DisplayName; });
        }

        private void InputServiceMappingExecuted(object sender, MappingExecutedEventArgs e)
        {
            if (e == null || e.Source == null) return;
            RunOnUiThread(delegate
            {
                _activityLabel.Text = e.Source.DisplayName + "  →  " + e.ActionDisplay;
            });
        }

        private void UpdateDeviceState()
        {
            Panel dot = null;
            foreach (Control control in _deviceStatus.Parent.Controls)
            {
                if (string.Equals(control.Tag as string, "statusDot", StringComparison.Ordinal))
                {
                    dot = control as Panel;
                    break;
                }
            }

            if (!_inputService.DriverAvailable)
            {
                _deviceStatus.Text = "Interception 驱动缺失";
                _deviceStatus.ForeColor = Color.FromArgb(180, 83, 9);
                _deviceDetail.Text = "安装后请重启 Windows";
                _deviceDetail.Size = new Size(190, 22);
                _installDriverButton.Visible = true;
                if (dot != null) dot.BackColor = Color.FromArgb(217, 119, 6);
            }
            else if (_inputService.DeviceConnected)
            {
                _deviceStatus.Text = "RC003 已就绪";
                _deviceStatus.ForeColor = Color.FromArgb(26, 127, 55);
                _deviceDetail.Text = string.IsNullOrWhiteSpace(_inputService.DeviceHardwareId)
                    ? "按键监听已开启"
                    : _inputService.DeviceHardwareId;
                _deviceDetail.Size = new Size(294, 22);
                _installDriverButton.Visible = false;
                if (dot != null) dot.BackColor = Color.FromArgb(31, 136, 61);
            }
            else
            {
                _deviceStatus.Text = "未找到 RC003";
                _deviceStatus.ForeColor = Color.FromArgb(207, 34, 46);
                _deviceDetail.Text = "请在 Windows 蓝牙设置中配对并唤醒遥控器";
                _deviceDetail.Size = new Size(294, 22);
                _installDriverButton.Visible = false;
                if (dot != null) dot.BackColor = Color.FromArgb(207, 34, 46);
            }
        }

        private void InstallDriverButtonClick(object sender, EventArgs e)
        {
            string installer = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "install-driver.cmd");
            if (!File.Exists(installer))
            {
                MessageBox.Show(this,
                    "没有找到驱动安装脚本：\r\n" + installer + "\r\n\r\n请重新下载完整的 Axonkey 安装包。",
                    "Axonkey", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                Process.Start(new ProcessStartInfo(installer)
                {
                    UseShellExecute = true,
                    WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory
                });
            }
            catch (Exception ex)
            {
                DiagnosticsLog.Write("Driver installer launch failed: " + ex.Message);
                MessageBox.Show(this, "无法启动驱动安装程序。\r\n\r\n" + ex.Message,
                    "Axonkey", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void OpenLogButtonClick(object sender, EventArgs e)
        {
            try
            {
                string path = DiagnosticsLog.PathValue;
                if (!File.Exists(path)) DiagnosticsLog.Write("Log opened from UI");
                Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "无法打开日志。\r\n\r\n" + ex.Message,
                    "Axonkey", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void HideToTray()
        {
            Hide();
            ShowInTaskbar = false;
            if (_shownInTray || _startHidden) return;
            _trayIcon.ShowBalloonTip(1800, "Axonkey", "Axonkey 仍在后台运行", ToolTipIcon.Info);
            _shownInTray = true;
        }

        private void RestoreFromTray()
        {
            ShowInTaskbar = true;
            Show();
            WindowState = FormWindowState.Normal;
            Activate();
        }

        private void ExitApplication()
        {
            _exitRequested = true;
            Close();
        }

        private void RunOnUiThread(Action action)
        {
            if (IsDisposed || Disposing) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(action); }
                catch (InvalidOperationException) { }
                return;
            }
            action();
        }
    }
}
