# Read-only check of Windows' HID-to-scan-code translation for known RC003 usages.
# These usages come from the project's macOS HID backend, not a live Windows capture.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if (-not ('AxonkeyHidTranslation' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AxonkeyHidTranslation
{
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate byte ReceiveCodes(IntPtr context, IntPtr codes, uint count);

    [DllImport("hid.dll")]
    private static extern int HidP_TranslateUsagesToI8042ScanCodes(
        ushort[] usages, uint count, int direction, ref uint modifiers,
        ReceiveCodes receiver, IntPtr context);

    public sealed class Result
    {
        public string UsagePage = "0x0007";
        public string Usage;
        public string Status;
        public string ScanBytes;
    }

    public static Result Translate(ushort usage)
    {
        var bytes = new List<byte>();
        // The callback only copies bytes. It does NOT inject them into the keyboard stack.
        ReceiveCodes receiver = delegate(IntPtr context, IntPtr codes, uint count) {
            var buffer = new byte[count];
            Marshal.Copy(codes, buffer, 0, buffer.Length);
            bytes.AddRange(buffer);
            return 1;
        };
        uint modifiers = 0;
        int status = HidP_TranslateUsagesToI8042ScanCodes(
            new[] { usage }, 1, 1, ref modifiers, receiver, IntPtr.Zero);
        GC.KeepAlive(receiver);
        return new Result {
            Usage = "0x" + usage.ToString("X4"),
            Status = "0x" + status.ToString("X8"),
            ScanBytes = bytes.Count == 0 ? "(none)" : BitConverter.ToString(bytes.ToArray()).Replace('-', ' ')
        };
    }
}
'@
}

$knownUsages = @(
    @{ Button = 'Confirm'; Usage = 0x28 },
    @{ Button = 'Right'; Usage = 0x4f },
    @{ Button = 'Back'; Usage = 0xf1 },
    @{ Button = 'VolumeUp'; Usage = 0x80 },
    @{ Button = 'VolumeDown'; Usage = 0x81 }
)
foreach ($item in $knownUsages) {
    $result = [AxonkeyHidTranslation]::Translate([uint16]$item.Usage)
    [pscustomobject]@{
        Button = $item.Button
        UsagePage = $result.UsagePage
        Usage = $result.Usage
        Status = $result.Status
        ScanBytes = $result.ScanBytes
    }
}
