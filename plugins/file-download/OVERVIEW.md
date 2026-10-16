Downloads the file you are previewing in Paseo to your computer with the save shortcut: Cmd+S on macOS, Ctrl+S on Windows and Linux. It works for any file Paseo can preview, including files outside the workspace such as output an agent wrote to `/tmp`, which Paseo's file tree cannot download.

Press the shortcut while a file preview tab is focused. On any other tab, such as an agent or a terminal, the shortcut does nothing, and the browser's own save dialog does not open either. When the cursor is inside Paseo's file editor, the shortcut keeps saving your edits instead. The same action is in the Command Center (Ctrl+K or Cmd+K) as "Download current file"; run there on a tab that is not a file, it says so.

"Open downloads" in the Command Center opens a list of the files downloaded since the page loaded, with their progress and any error. Each entry can be downloaded again, have its path copied, or be removed. The list lives in memory and starts empty after a reload.

The plugin adds no buttons. Paseo's plugin API cannot tell which tab is focused, so the plugin reads the tab layout Paseo keeps in the browser's local storage. A future Paseo version may change that format; the shortcut would then do nothing. To show the shortcut's download and error toasts, the plugin adds an item to the sidebar footer that renders nothing; hiding "Download notices" in Paseo's sidebar settings silences the shortcut's toasts but not the downloads.

Files reach the browser in 4 MB pieces over the existing Paseo connection, so downloads work through relays and reverse proxies. A file is limited to 1 GB. The daemon reads the file with its own user's permissions, the same files Paseo's preview can open. The plugin works in the desktop app and in the browser.
