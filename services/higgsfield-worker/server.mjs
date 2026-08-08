import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.HIGGSFIELD_WORKER_PORT ?? process.env.PORT ?? 8788);
const HOST = process.env.HIGGSFIELD_WORKER_HOST ?? "127.0.0.1";
const CLI = process.env.HIGGSFIELD_CLI ?? "higgsfield";
const WORKER_SECRET = process.env.HIGGSFIELD_WORKER_SECRET ?? "";
const WORKSPACE_ID = process.env.HIGGSFIELD_WORKSPACE_ID ?? "";
const MODEL = process.env.HIGGSFIELD_MODEL ?? "kling3_0";
const MODE = process.env.HIGGSFIELD_MODE ?? "pro";
const ASPECT_RATIO = process.env.HIGGSFIELD_ASPECT_RATIO ?? "9:16";
const DURATION = Number(process.env.HIGGSFIELD_DURATION ?? 10);
const SOUND = process.env.HIGGSFIELD_SOUND === "off" ? "off" : "on";
const WAIT_TIMEOUT = process.env.HIGGSFIELD_WAIT_TIMEOUT ?? "15m";
const COMMAND_TIMEOUT_MS = Number(process.env.HIGGSFIELD_COMMAND_TIMEOUT_MS ?? 20 * 60 * 1000);
const MAX_BODY_BYTES = 64 * 1024;

if (!WORKER_SECRET) {
  console.error("HIGGSFIELD_WORKER_SECRET is required");
  process.exit(1);
}

let activeJob = false;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function isAuthorized(request) {
  const supplied = request.headers["x-higgsfield-worker-secret"];
  if (typeof supplied !== "string") return false;
  const expected = Buffer.from(WORKER_SECRET);
  const actual = Buffer.from(supplied);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body);
}

function runCli(args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Higgsfield CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start Higgsfield CLI: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(-2000);
        reject(new Error(`Higgsfield CLI failed (${code ?? signal}): ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function configureAccountContext() {
  if (WORKSPACE_ID) {
    await runCli(["workspace", "set", WORKSPACE_ID], 30_000);
  }
}

function parseCliJson(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Be tolerant of a progress line before the final --json response.
    for (const line of text.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line.trim());
      } catch {
        // Keep looking for the final JSON object.
      }
    }
  }
  return null;
}

function findResultUrl(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findResultUrl(item);
      if (found) return found;
    }
    return null;
  }

  const object = value;
  for (const key of ["result_url", "video_url", "download_url"]) {
    if (typeof object[key] === "string" && object[key].startsWith("http")) return object[key];
  }
  for (const [key, child] of Object.entries(object)) {
    if (key === "url" && typeof child === "string" && child.startsWith("http")) return child;
    const found = findResultUrl(child);
    if (found) return found;
  }
  return null;
}

function findJobId(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJobId(item);
      if (found) return found;
    }
    return null;
  }
  const object = value;
  for (const key of ["job_id", "id", "generation_id"]) {
    if (typeof object[key] === "string") return object[key];
  }
  for (const child of Object.values(object)) {
    const found = findJobId(child);
    if (found) return found;
  }
  return null;
}

function imageExtension(contentType, sourceUrl) {
  const fromMime = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  }[contentType];
  if (fromMime) return fromMime;
  const pathname = new URL(sourceUrl).pathname;
  const extension = pathname.split(".").pop()?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "gif"].includes(extension ?? "") ? extension : "png";
}

async function downloadSourceImage(body, directory) {
  if (typeof body.image_url !== "string" || !body.image_url.startsWith("http")) {
    throw new Error("image_url must be an HTTP(S) URL");
  }
  const response = await fetch(body.image_url);
  if (!response.ok) throw new Error(`Source image download failed (${response.status})`);
  const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/png";
  if (!contentType.startsWith("image/")) {
    throw new Error(`Source URL did not return an image (${contentType})`);
  }
  const filename = `source-${randomUUID()}.${imageExtension(contentType, body.image_url)}`;
  const path = join(directory, filename);
  await fs.writeFile(path, Buffer.from(await response.arrayBuffer()));
  return path;
}

async function generate(body) {
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new Error("prompt is required");
  }

  const model = typeof body.model === "string" && body.model ? body.model : MODEL;
  const duration = Number(body.duration ?? DURATION);
  const mode = typeof body.mode === "string" && body.mode ? body.mode : MODE;
  const aspectRatio =
    typeof body.aspect_ratio === "string" && body.aspect_ratio ? body.aspect_ratio : ASPECT_RATIO;
  const sound = typeof body.sound === "string" && body.sound ? body.sound : SOUND;

  if (!/^kling3_0(?:_turbo)?$/.test(model)) {
    throw new Error(`Unsupported Higgsfield video model: ${model}`);
  }
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) {
    throw new Error("duration must be an integer between 3 and 15 seconds");
  }
  if (!["16:9", "9:16", "1:1"].includes(aspectRatio)) {
    throw new Error(`Unsupported aspect ratio: ${aspectRatio}`);
  }
  if (!["on", "off"].includes(sound)) {
    throw new Error(`Unsupported sound setting: ${sound}`);
  }

  const directory = await fs.mkdtemp(join(tmpdir(), "higgsfield-worker-"));
  try {
    const imagePath = await downloadSourceImage(body, directory);
    const args = [
      "generate",
      "create",
      model,
      "--prompt",
      body.prompt.trim(),
      "--start-image",
      imagePath,
      "--duration",
      String(duration),
      "--aspect_ratio",
      aspectRatio,
      "--mode",
      mode,
      "--sound",
      sound,
      "--wait",
      "--wait-timeout",
      WAIT_TIMEOUT,
      "--json",
      "--no-color",
    ];
    const { stdout } = await runCli(args);
    const result = parseCliJson(stdout);
    const resultUrl = findResultUrl(result);
    if (!resultUrl) {
      throw new Error("Higgsfield returned no result URL");
    }
    return { video_url: resultUrl, job_id: findJobId(result), status: "completed" };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function deliverCallback(callbackUrl, payload) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-higgsfield-worker-secret": WORKER_SECRET,
        },
        body: JSON.stringify(payload),
      });
      if (response.ok) return;
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`Callback failed (${response.status}): ${detail}`);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw lastError;
}

async function runAsyncGeneration(body) {
  try {
    await configureAccountContext();
    const result = await generate(body);
    await deliverCallback(body.callback_url, {
      status: "completed",
      video_url: result.video_url,
      context: body.callback_context,
    });
  } catch (error) {
    console.error("[higgsfield-worker] async generation failed:", error);
    try {
      await deliverCallback(body.callback_url, {
        status: "failed",
        error: error instanceof Error ? error.message : "Higgsfield generation failed",
        context: body.callback_context,
      });
    } catch (callbackError) {
      console.error("[higgsfield-worker] failure callback could not be delivered:", callbackError);
    }
  } finally {
    activeJob = false;
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, {
      ok: true,
      provider: "higgsfield",
      model: MODEL,
      workspaceConfiguredByEnv: Boolean(WORKSPACE_ID),
    });
  }

  const isSynchronous = request.method === "POST" && request.url === "/generate";
  const isAsynchronous = request.method === "POST" && request.url === "/generate-async";
  if (!isSynchronous && !isAsynchronous) {
    return sendJson(response, 404, { error: "Not found" });
  }
  if (!isAuthorized(request)) return sendJson(response, 401, { error: "Unauthorized" });
  if (activeJob)
    return sendJson(response, 429, { error: "A Higgsfield generation is already running" });

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid request body",
    });
  }

  if (isAsynchronous) {
    try {
      const callbackUrl = new URL(body.callback_url);
      if (!["http:", "https:"].includes(callbackUrl.protocol)) {
        throw new Error("callback_url must be HTTP(S)");
      }
      if (!body.callback_context || typeof body.callback_context !== "object") {
        throw new Error("callback_context is required");
      }
    } catch (error) {
      return sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid callback",
      });
    }
    activeJob = true;
    sendJson(response, 202, { status: "accepted", job_id: randomUUID() });
    void runAsyncGeneration(body);
    return;
  }

  activeJob = true;
  try {
    await configureAccountContext();
    const result = await generate(body);
    return sendJson(response, 200, result);
  } catch (error) {
    console.error("[higgsfield-worker] generation failed:", error);
    return sendJson(response, 502, {
      error: error instanceof Error ? error.message : "Higgsfield generation failed",
    });
  } finally {
    activeJob = false;
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[higgsfield-worker] listening on http://${HOST}:${PORT}`);
  if (!WORKSPACE_ID) {
    console.warn(
      "[higgsfield-worker] No workspace ID configured. Select one with `higgsfield workspace set <id>` or set HIGGSFIELD_WORKSPACE_ID.",
    );
  }
});
