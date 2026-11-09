/**
 * The plugin side of the wire contract. Copied rather than published, the same
 * way the web app copies the helper's types: one plugin does not justify a
 * package yet.
 */

export type Subject = {
  canvasId?: string;
  entryId?: string;
  link?: {
    url?: string;
    provider?: string;
    host?: string;
    title?: string | null;
  } | null;
  attachments?: string[];
  media?: { present?: boolean };
  data?: Record<string, string>;
};

export type Request = {
  id: string;
  command: string;
  params: {
    subject?: Subject;
    settings?: Record<string, unknown>;
    view?: string;
  };
};

export type Data = { kind: string; text: string };

/** A failure the user can read, with a code the app knows. */
export class PluginError extends Error {
  constructor(
    readonly code: "no_data" | "refused" | "bad_subject" | "unsupported" | "internal",
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

function answer(id: string, payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ id, ...payload })}\n`);
}

/**
 * One JSON line in, one JSON line out, then exit. Handled failures exit 0 and
 * carry their code; a thrown error is reported the same way, so the helper
 * always has a message to show.
 */
export async function serve(
  handler: (request: Request) => Promise<Data>,
): Promise<void> {
  let request: Request | null = null;
  try {
    const input = await new Response(Bun.stdin.stream()).text();
    const line = input
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .pop();
    request = line ? (JSON.parse(line) as Request) : null;
  } catch {
    request = null;
  }

  if (!request || typeof request.command !== "string") {
    process.stdout.write(
      `${JSON.stringify({ id: "0", error: { code: "internal", message: "The request could not be read." } })}\n`,
    );
    return;
  }

  try {
    const data = await handler(request);
    answer(request.id, { data });
  } catch (error) {
    const failure =
      error instanceof PluginError
        ? { code: error.code, message: error.message }
        : {
            code: "internal",
            message: error instanceof Error ? error.message : "The plugin failed.",
          };
    answer(request.id, { error: failure });
  }
}
