using System;
using System.Drawing;
using System.Windows.Forms;

namespace Axonkey
{
    internal sealed class MappingEditorDialog : Form
    {
        private readonly Label _capturedLabel;
        private readonly Button _acceptButton;
        private string _capturedAction;

        public MappingEditorDialog(SourceKeyDefinition source, string currentAction)
        {
            if (source == null) throw new ArgumentNullException("source");

            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.White;
            ClientSize = new Size(430, 226);
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            KeyPreview = true;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowIcon = false;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.CenterParent;
            Text = "录入快捷键";

            Label title = new Label();
            title.AutoSize = false;
            title.Font = new Font(Font.FontFamily, 13F, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(27, 31, 36);
            title.Location = new Point(28, 24);
            title.Size = new Size(374, 30);
            title.Text = "为“" + source.DisplayName + "”录入快捷键";
            Controls.Add(title);

            Label hint = new Label();
            hint.AutoSize = false;
            hint.ForeColor = Color.FromArgb(87, 96, 106);
            hint.Location = new Point(30, 61);
            hint.Size = new Size(370, 24);
            hint.Text = "直接按下一个按键或组合键";
            Controls.Add(hint);

            Panel capturePanel = new Panel();
            capturePanel.BackColor = Color.FromArgb(246, 248, 250);
            capturePanel.Location = new Point(30, 91);
            capturePanel.Size = new Size(370, 56);
            Controls.Add(capturePanel);

            _capturedLabel = new Label();
            _capturedLabel.Dock = DockStyle.Fill;
            _capturedLabel.Font = new Font(Font.FontFamily, 12F, FontStyle.Bold);
            _capturedLabel.ForeColor = Color.FromArgb(31, 111, 235);
            _capturedLabel.TextAlign = ContentAlignment.MiddleCenter;
            capturePanel.Controls.Add(_capturedLabel);

            Button cancelButton = new Button();
            cancelButton.DialogResult = DialogResult.Cancel;
            cancelButton.FlatStyle = FlatStyle.System;
            cancelButton.Location = new Point(224, 171);
            cancelButton.Size = new Size(82, 32);
            cancelButton.Text = "取消";
            Controls.Add(cancelButton);

            _acceptButton = new Button();
            _acceptButton.DialogResult = DialogResult.OK;
            _acceptButton.Enabled = false;
            _acceptButton.FlatStyle = FlatStyle.System;
            _acceptButton.Location = new Point(314, 171);
            _acceptButton.Size = new Size(86, 32);
            _acceptButton.Text = "应用";
            Controls.Add(_acceptButton);

            CancelButton = cancelButton;
            AcceptButton = _acceptButton;

            ParsedAction parsed;
            if (KeyCatalog.TryParseAction(currentAction, out parsed) && parsed.Kind == ActionKind.Chord)
            {
                _capturedLabel.Text = parsed.DisplayText;
            }
            else
            {
                _capturedLabel.Text = "等待按键…";
            }
        }

        public string CapturedAction
        {
            get { return _capturedAction; }
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (_acceptButton.Focused && keyData == Keys.Enter)
                return base.ProcessCmdKey(ref msg, keyData);

            Keys keyCode = keyData & Keys.KeyCode;
            if (keyCode == Keys.None || IsModifier(keyCode)) return base.ProcessCmdKey(ref msg, keyData);

            bool control = (keyData & Keys.Control) == Keys.Control;
            bool shift = (keyData & Keys.Shift) == Keys.Shift;
            bool alt = (keyData & Keys.Alt) == Keys.Alt;
            string candidate = KeyCatalog.FormatCapturedChord((int)keyCode, control, shift, alt);

            ParsedAction parsed;
            if (!KeyCatalog.TryParseAction(candidate, out parsed) || parsed.Kind != ActionKind.Chord)
            {
                System.Media.SystemSounds.Beep.Play();
                return true;
            }

            _capturedAction = parsed.CanonicalText;
            _capturedLabel.Text = parsed.DisplayText;
            _acceptButton.Enabled = true;
            _acceptButton.Focus();
            return true;
        }

        private static bool IsModifier(Keys key)
        {
            return key == Keys.ControlKey || key == Keys.LControlKey || key == Keys.RControlKey ||
                key == Keys.ShiftKey || key == Keys.LShiftKey || key == Keys.RShiftKey ||
                key == Keys.Menu || key == Keys.LMenu || key == Keys.RMenu ||
                key == Keys.LWin || key == Keys.RWin;
        }
    }
}
