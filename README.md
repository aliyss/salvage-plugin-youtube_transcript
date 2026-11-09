# YouTube transcript for Salvage

A [Salvage](https://github.com/aliyss/salvage-web) plugin that reads the captions
of a YouTube link and stores them next to the entry, so a video can be searched,
read, and quoted like a note.

The transcript is fetched by the **Salvage Helper** on your own computer. Nothing
is sent anywhere except YouTube, and the helper only runs the plugin for canvases
you grant it.

## What it adds

When an entry links to a YouTube video, the note page gets a **Read transcript**
action. The plugin asks YouTube for the caption track, cleans it into plain text,
and the result is stored as `youtube-transcript` data on that entry. A second
visit reads the stored copy; it does not fetch again unless the entry is asked
to refresh.

## Requirements

- Salvage with the desktop helper paired
- Plugin API version 1 (the helper tells you if a plugin is too new)

## Install

Open **Settings → Plugins → Browse store** and find this repository, or drop a
folder containing `manifest.json` and `dist/plugin.js` into the helper's plugins
folder and press **Rescan**.

The store installs the assets from the repository's newest GitHub release:

| Asset | Purpose |
| --- | --- |
| `manifest.json` | Plugin id, version, settings, and what it provides |
| `plugin.js` | The bundled plugin, run by the helper |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Caption language | English | Language track to ask YouTube for |
| Use auto-generated captions | on | Fall back to YouTube's generated track |
| Maximum lines | 0 (all) | Truncate long transcripts |

## Development

```sh
bun install
bun run typecheck
bun test
bun run build     # writes dist/plugin.js
```

The plugin talks to the helper over stdin/stdout using the small SDK in
`src/sdk.ts`; `bun run dev` runs it directly.

## Releasing

Push a tag such as `v0.1.1`. The **Release plugin** workflow builds the bundle,
runs the tests, and publishes a GitHub release with `plugin.js` and
`manifest.json` attached. The store reads that release, so keep the version in
`manifest.json` in step with the tag.

Repositories tagged with the GitHub topic **`salvage-plugin`** appear in the
store automatically, sorted by stars.

## License

MIT
