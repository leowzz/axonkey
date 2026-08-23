using System;
using System.Runtime.InteropServices;

namespace Axonkey
{
    internal static class InterceptionNative
    {
        internal const int MaxKeyboard = 10;
        internal const ushort FilterKeyNone = 0x0000;
        internal const ushort FilterKeyAll = 0xFFFF;

        internal const ushort KeyUp = 0x0001;
        internal const ushort KeyE0 = 0x0002;
        internal const ushort KeyE1 = 0x0004;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        internal delegate int DevicePredicate(int device);

        [StructLayout(LayoutKind.Sequential)]
        internal struct KeyStroke
        {
            internal ushort Code;
            internal ushort State;
            internal uint Information;
        }

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr interception_create_context();

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void interception_destroy_context(IntPtr context);

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void interception_set_filter(
            IntPtr context,
            DevicePredicate predicate,
            ushort filter);

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int interception_wait_with_timeout(IntPtr context, uint milliseconds);

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int interception_receive(
            IntPtr context,
            int device,
            ref KeyStroke stroke,
            uint strokeCount);

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int interception_send(
            IntPtr context,
            int device,
            ref KeyStroke stroke,
            uint strokeCount);

        [DllImport("interception.dll", CallingConvention = CallingConvention.Cdecl)]
        internal static extern uint interception_get_hardware_id(
            IntPtr context,
            int device,
            [Out] byte[] hardwareIdBuffer,
            uint bufferSize);

        [DllImport("user32.dll")]
        internal static extern uint MapVirtualKey(uint code, uint mapType);
    }
}
