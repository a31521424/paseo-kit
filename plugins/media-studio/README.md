# media-studio

Review the images, video and audio your agents make: cards in the chat, a streaming player with a
filmstrip and waveform timeline, timecoded notes back to the agent, and uploads and downloads of
large files. Files on SSH hosts, such as a GPU render box, work too.

See [OVERVIEW.md](OVERVIEW.md) for what it does and its limits.

## Install

```bash
paseo plugin install github:a31521424/paseo-kit:plugins/media-studio
```

Or from a local clone of [paseo-kit](../../README.md):

```bash
cd plugins/media-studio && npm install
paseo plugin install "$PWD"
```

Requires Paseo 0.15.3 or later (daemon and app) with plugins enabled, and ffmpeg on the daemon host.

## How it works

| Piece | Where |
| --- | --- |
| Playback | `server/stream.ts` runs one ffmpeg per session writing fragmented MP4 from a start time; `client/web.ts` (`StreamPlayer`) appends it to a MediaSource and opens a new session when you seek outside the buffer. H.264 is copied from the keyframe at or before the seek point, or, when that keyframe is far back, a near-lossless "bridge" is encoded from the seek point to the next keyframe (keyframe index from `-skip_frame nokey`) and the copy continues there; everything else is converted. Each session reports its first sample's time, which becomes the SourceBuffer `timestampOffset`. |
| Frames, filmstrip, waveform | `server/stills.ts`, cached on disk by `server/cache.ts`. |
| Hosts | `server/hosts.ts`: the daemon host, or `alias:/path` over multiplexed SSH, where the remote ffmpeg does the work. |
| Transfers | `server/transfer.ts` and `client/transfers.ts`: 1 MB upload and 4 MB download pieces over plugin RPC, out of order, into a hidden part file renamed when complete. Uploads resume: the upload ID is derived from folder, name, size and modification time, received ranges are saved under `~/.cache/paseo-media-studio/uploads`, and `upload.begin` returns them. The client retries with backoff, pauses, and hands unfinished uploads to the next copy of itself when Paseo reloads the plugin. |
| Agent tool and turn cards | `server/agent.ts`: `preview_media` through `agent.open.before`; a card appended after each turn's reply. `index.client.tsx` turns the tool call into the same card while it runs. |

Paseo 0.15 plugin RPC carries JSON only, so bytes travel as base64. Paseo 0.16 adds binary RPC and
subscriptions, which would remove that overhead and the polling reads; the transport is kept behind
`StreamSource` and the transfer functions so it can move over later.

## Develop

```bash
npm run typecheck
paseo plugin reload media-studio
paseo plugin logs media-studio
```
