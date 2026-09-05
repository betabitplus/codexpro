import { spawn } from "node:child_process";

export interface ChatGPTExportResult {
  ok: boolean;
  count: number;
  exported: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}

const MAX_OUTPUT_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function exportChatGPTChats(options: {
  chats: string[];
  outputDir?: string;
  command?: string;
  timeoutMs?: number;
}): Promise<ChatGPTExportResult> {
  const chats = options.chats.map((value) => value.trim()).filter(Boolean);
  if (!chats.length) throw new Error("At least one ChatGPT conversation URL or ID is required.");
  if (chats.length > 20) throw new Error("At most 20 ChatGPT conversations can be exported per call.");

  const command = options.command?.trim() || process.env.CODEXPRO_CHATGPT_EXPORTER || "chatgpt-exporter";
  const args: string[] = [];
  if (options.outputDir?.trim()) args.push("--output-dir", options.outputDir.trim());
  args.push(...chats);

  return await new Promise<ChatGPTExportResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finishError(new Error("chatgpt-exporter output exceeded the 2 MB safety limit."));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => {
      finishError(
        new Error(
          `Could not start chatgpt-exporter (${command}): ${error instanceof Error ? error.message : String(error)}`
        )
      );
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = stdout.trim();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        reject(
          new Error(
            `chatgpt-exporter returned invalid JSON (exit=${code ?? "null"}${signal ? `, signal=${signal}` : ""}): ${stderr.trim() || text.slice(0, 1000) || "no output"}`
          )
        );
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(new Error(`chatgpt-exporter returned an unexpected result (exit=${code ?? "null"}).`));
        return;
      }
      const value = parsed as Record<string, unknown>;
      const results = Array.isArray(value.results)
        ? value.results.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
        : [];
      const result: ChatGPTExportResult = {
        ok: value.ok === true,
        count: Number(value.count ?? results.length),
        exported: Number(value.exported ?? results.filter((item) => item.ok === true).length),
        failed: Number(value.failed ?? results.filter((item) => item.ok !== true).length),
        results
      };
      if (code !== 0 && !results.length) {
        reject(new Error(stderr.trim() || String(value.error || `chatgpt-exporter exited ${code}`)));
        return;
      }
      resolve(result);
    });

    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS));
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finishError(new Error(`chatgpt-exporter timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    timer.unref();
  });
}
