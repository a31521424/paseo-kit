Review the images, video and audio your agents make without leaving Paseo. Built for editing work where an agent cuts, renders and mixes with ffmpeg or other tools, and you check every result and send it notes.

## In the chat

Agents get a `preview_media` tool. When an agent renders a cut, extracts a frame or mixes audio, it can show the file in the chat right away: a card with a player, a filmstrip and an audio waveform. After each turn, one card below the agent's reply collects the media the turn showed and any media files it created or changed in the agent's folder, so nothing is missed even when the agent forgets to show a file.

## The player

Video and audio stream from the daemon while you watch, so a large file starts playing in about a second and seeking jumps straight there. H.264 video plays as it is. Many renders put a keyframe only every few seconds, and playing from the keyframe before the point you jump to would mean waiting while the browser decodes up to it; instead, the stretch from that point to the next keyframe is encoded on the fly at near-original quality and the original takes over from there, so a jump plays in about a second. Other formats (HEVC, ProRes, MXF and so on) are converted to a 720p proxy on the fly, with VideoToolbox on a Mac or NVENC on an NVIDIA GPU when one works. The timeline shows timecode, a filmstrip, a waveform and what is buffered. Hover to see the frame under the pointer, drag to scrub, step frame by frame, set in and out points, loop and change speed.

The player remembers where each file was left: playhead, in and out points, loop and speed. Switching to another tab and back, reloading the page, or an agent writing a new version of the file over the old one picks up at the same moment (a new version says so), and a file that was playing keeps playing when its tab comes back. To compare versions, open one cut and then the other: the swap button (or B) flips between the two at the same moment, still playing. Click the timecode, press T, or just type numbers to jump to a timecode (01:23:10:12, 1:30, 90, or +5 and -2 to move relative to the playhead). The guides button (G) shows action and title safe areas; on vertical video also the areas short-video apps cover with captions and buttons, and on horizontal video the 9:16, 4:5 and 1:1 crops. The details list the audio's integrated loudness, true peak and loudness range, and say when a cut is louder or quieter than the −14 LUFS most platforms normalize to or would clip after their re-encode.

Keys, after you click the player or the list: Space or K play and pause, Left and Right step one frame (with Shift, one second), J jumps back five seconds, L plays at 2×, I and O set in and out, X clears them, F is full screen, T or a digit jumps to a timecode, G shows guides, B flips to the file shown before, Up and Down move to the previous or next file, and / filters the list by name. The keyboard button in the player lists them all.

## Notes to the agent

Under the player, write a note and send it to an agent of the workspace with the send button or Cmd+Enter (Ctrl+Enter). The note carries the file, the timecode, the in and out range and the frame rate, and the current frame is attached as an image the agent can see. Notes can be sent while the agent is working: they join its current task instead of stopping it, so you can keep reviewing while it renders. The frame is also saved as a PNG in the workspace (`.media-studio/frames` by default).

Sent notes are kept per file on the daemon host, listed with the player and pinned on the timeline, a point for a timecode or a bar for a range. Click one to jump back to it. A note made on an earlier version of the file is marked as such. The copy button puts all notes on the clipboard as a timecoded list, for a client, a colleague or another agent. In a wide panel the notes, the composer and the file details sit in a column beside the player.

## The Media panel

A workspace panel, also available in the Explorer, lists recent media files under the workspace, newest first, or browses folders; linked files and folders (footage linked in from a shared drive) are included. Upload files from your computer with the Upload button or by dropping them on the panel; they go to the folder you are browsing, or to `uploads` from the Recent view. Uploads resume: when the connection drops or the plugin reloads, an upload waits and continues by itself; after a page reload the panel lists unfinished uploads, and picking or dropping the same file again continues where it stopped. Uploads can be paused, and unfinished ones are kept on the host for three days. Downloads of large files are written to disk as they arrive in Chrome, Edge and the desktop app, and a dropped piece is fetched again. Transfers move in 4 MB pieces over the Paseo connection, so they work through direct connections, reverse proxies and tunnels, with no extra port.

Video, audio and images that Paseo's own image viewer does not open (TIFF, EXR, DPX, HEIC and others) also open in the file tab from the Explorer. Type `/media path` in the composer to show a file in the panel.

## Files on a GPU server

When agents render on another machine over SSH, write remote files as `alias:/path`, using an alias from the daemon user's `~/.ssh/config` (for example `gpu1:/data/renders/cut.mp4`). Probing, frames and playback then run with that machine's ffmpeg and only the results travel back, so a small daemon host stays light. Browse a remote folder from the panel's location bar, and upload or download there the same way; those transfers pass through the daemon host, so they run at the speed of the slower link.

The SSH key must work without a password prompt. All commands for a host share one SSH connection, opened once, because some servers refuse several connections at a time. ffmpeg is looked for on PATH, in the usual folders and in the copy the imageio-ffmpeg Python package ships, which machines running ComfyUI or similar often have; otherwise set its path per host in the settings. A path found by searching is remembered, so later sessions start without searching again.

## Setup and limits

- Needs ffmpeg on the daemon host (and on any SSH host whose files you preview), with libx264 for converting. ffprobe is used when present. Set paths in the plugin settings if ffmpeg is not on PATH.
- Playback needs the desktop app or a browser. On the iOS and Android apps you can scrub frames, read the timeline and send notes, but not play.
- Uploads need the desktop app or a browser.
- Behind a Cloudflare Tunnel, cloudflared's default QUIC transport can cap uploads at about 3 MB/s per connection; running it with `TUNNEL_TRANSPORT_PROTOCOL=http2` (or `--protocol http2`) raised uploads to about 16 MB/s in testing.
- The tool is given to Claude, Codex and OpenCode agents by default; change the providers or turn it off in settings. Turning it on or off applies when sessions reopen.
- Thumbnails, filmstrips and waveforms are cached under `~/.cache/paseo-media-studio` on the host, up to 1 GB.
- The card after a turn lives in the daemon's memory and is gone after a daemon restart; the files are not.
