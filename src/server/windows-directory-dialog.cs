using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class GameGraphDirectoryDialog
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr binding, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    public static string Pick(string initialPath, string title)
    {
        // 在创建任何窗口前启用逐显示器 DPI V2，避免高缩放显示器上的位图拉伸。
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpi == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IFileDialog dialog = null;
        IShellItem initialFolder = null;
        IShellItem selected = null;
        IntPtr selectedPath = IntPtr.Zero;
        try
        {
            dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
            uint options;
            dialog.GetOptions(out options);
            // 系统文件夹模式：只返回真实且已存在的目录，不改变工作目录或系统最近文档。
            dialog.SetOptions(options | 0x20 | 0x40 | 0x800 | 0x8 | 0x02000000);
            dialog.SetTitle(title);
            if (!String.IsNullOrEmpty(initialPath))
            {
                Guid shellItemId = typeof(IShellItem).GUID;
                SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemId, out initialFolder);
                dialog.SetFolder(initialFolder);
            }
            int result = dialog.Show(IntPtr.Zero);
            if (result == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out selected);
            selected.GetDisplayName(0x80058000, out selectedPath);
            return Marshal.PtrToStringUni(selectedPath);
        }
        finally
        {
            if (selectedPath != IntPtr.Zero) Marshal.FreeCoTaskMem(selectedPath);
            if (selected != null) Marshal.ReleaseComObject(selected);
            if (initialFolder != null) Marshal.ReleaseComObject(initialFolder);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
            SetThreadDpiAwarenessContext(previousDpi);
        }
    }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    // 方法顺序必须与 Windows SDK 的 IFileDialog COM 虚表完全一致。
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int location);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint kind, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }
}
