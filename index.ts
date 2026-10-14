/**
 * opencode-session-transcript
 *
 * Write the current session out as a readable Markdown file.
 *
 * OpenCode keeps everything — titles, directories, message bodies — in a
 * SQLite database, and the desktop app can already browse all of it. What it
 * does not offer is a way to get a conversation *out* as something a person
 * can read: `/export` and `opencode session export` both produce JSON.
 *
 * This writes Markdown instead. One command, no archiving, no database writes:
 * it only ever reads.
 *
 * The command prints the path and nothing else. An earlier version also
 * previewed the conversation inline, but the desktop app does not reliably
 * render synthetic messages, so a preview is the one thing that can silently
 * fail to appear. The file is the artefact; the path is the receipt.
 *
 * Output is a Markdown file in ~/Documents named after the current session's
 * title, so the file is recognisable in a file manager. The title is read at
 * run time from the session the command was invoked in — nothing is hardcoded.
 * Two sessions sharing a title would overwrite each other; pass an explicit
 * path to keep both.
 */

import { SessionStore } from "./src/db.ts"
import { slug, toMarkdown } from "./src/markdown.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Minimal structural types for the slice of the plugin context used here.
 * Declared locally rather than imported from `@opencode/plugin` so the package
 * installs with zero dependencies — a local-path plugin cannot rely on that
 * module resolving.
 */
interface CommandEditor {
  add(def: {
    name: string
    description?: string
    execute(input: { sessionID: string; prompt?: { text?: string } }): Promise<void>
  }): void
}
interface PluginContext {
  app: { version?: string }
  command: { transform(cb: (e: CommandEditor) => void): Promise<unknown> }
  session: { synthetic(input: { sessionID: string; text: string }): Promise<unknown> }
}

/** Where transcripts land. Override with OPENCODE_TRANSCRIPT_DIR. */
function transcriptDir(): string {
  const custom = process.env.OPENCODE_TRANSCRIPT_DIR
  if (custom) return custom
  return join(homedir(), "Documents")
}

/**
 * Human-readable form of the default output directory, for the command
 * description. Uses `~` rather than an expanded home path so the popup reads
 * the same on every machine rather than naming one user's account.
 */
function displayDir(): string {
  const dir = transcriptDir()
  const home = homedir()
  return dir === home ? "~" : dir.startsWith(home + "/") ? `~/${dir.slice(home.length + 1)}` : dir
}

export default {
  id: "opencode-session-transcript",

  async setup(ctx: PluginContext) {
    const say = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text })

    const defaultDir = transcriptDir()

    await ctx.command.transform((editor) => {
      editor.add({
        name: "save",
        // Deliberately not "export" or "export_updated": a name that prefixes
        // the built-in `/export` risks the autocomplete completing to it, and
        // Enter would then run the wrong command. The description carries the
        // relationship instead, and stays to one line so it does not wrap and
        // push the neighbouring commands down the popup.
        description:
          `Export the whole session to ${displayDir()}/<title>.md — ` +
          "like /export, but flushes all messages",
        execute: async ({ sessionID, prompt }) => {
          try {
            const store = await SessionStore.open()
            const meta = await store.get(sessionID)

            const markdown = await toMarkdown(store, sessionID)

            // An argument is taken as an explicit output path, so
            // `/save ~/Desktop/today.md` works without configuration.
            const asked = (prompt?.text ?? "")
              .trim()
              .split(/\s+/)
              .filter((t) => t && !t.startsWith("/"))

            const explicit = asked.find((a) => a.endsWith(".md"))
            const dir = explicit ? null : defaultDir
            mkdirSync(dir!, { recursive: true })

            // Named from the current session's own title, read at run time — nothing
            // about the session is baked in.
            const target = explicit
              ? explicit.replace(/^~(?=\/)/, homedir())
              : join(dir!, `${slug(meta?.title ?? "session")}.md`)

            writeFileSync(target, markdown, "utf8")

            const headings = markdown.split("\n").filter((l) => l.startsWith("### "))

            await say(
              sessionID,
              [
                `\`${target}\``,
                "",
                `${headings.length} messages · ${Math.round(markdown.length / 1024)} KB`,
              ].join("\n"),
            )
          } catch (err) {
            await say(
              sessionID,
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        },
      })
    })
  },
}

export { slug, toMarkdown }