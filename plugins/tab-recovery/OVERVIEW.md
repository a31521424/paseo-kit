Brings back agents whose tab you closed by mistake, with one press.

Closing an agent's tab, for example with Ctrl+W or Cmd+W, archives the agent and stops its process; Paseo only asks first when the agent is running. This plugin adds a **Closed agents** panel that lists the archived top-level agents of the current workspace, most recently closed first. Open it from the Command Center (Ctrl+K or Cmd+K, then "Reopen a closed agent") or place it in the Explorer sidebar.

Press an agent to reopen it. The plugin unarchives the agent, resumes its session with the full history, and opens its tab again once the app shows the agent as running. This is the same request as the Unarchive button in an archived agent's tab. Subagents are not listed, because closing a subagent's tab only hides it.

Paseo's plugin SDK has no unarchive call, so the daemon side runs `paseo agent reload <id>`. The `paseo` CLI must be on the daemon's PATH, which it is for a standard install. The plugin only reloads agents that are archived and belong to the workspace the panel shows, so it never restarts an agent that is still open.

Without the plugin you can restore an agent from **History** in the sidebar: open the archived agent, then press Unarchive in its tab. To stop closing tabs by accident, rebind or unassign "Close current tab" in Paseo's keyboard shortcut settings.
