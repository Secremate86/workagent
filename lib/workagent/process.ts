import { spawn } from "node:child_process";
import { OfficeError } from "./workspace";

/** Credentials are unnecessary for deterministic office work; pass only runtime/OS variables. */
function workerEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "SYSTEMDRIVE",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR",
    "UV_PYTHON", "UV_OFFLINE", "UV_NATIVE_TLS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())).concat([
    ["PYTHONUTF8", "1"], ["PYTHONIOENCODING", "utf-8"], ["PYTHONUNBUFFERED", "1"],
  ])), NODE_ENV: process.env.NODE_ENV ?? "development" };
}

export async function runBoundedProcess(command: string, args: string[], options: {
  cwd: string;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (options.signal?.aborted) throw new OfficeError("CANCELLED", "办公操作已取消", 499);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: workerEnvironment(), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let failure: OfficeError | undefined;
    let killFallback: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: OfficeError) => {
      if (failure) return;
      failure = error;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore", env: workerEnvironment() });
        killer.on("error", () => child.kill());
        killer.on("close", (code) => { if (code !== 0) child.kill(); });
        killer.unref();
        killFallback = setTimeout(() => { child.kill(); killer.kill(); }, 2000);
        killFallback.unref();
      } else child.kill("SIGKILL");
    };
    const onAbort = () => stop(new OfficeError("CANCELLED", "办公操作已取消", 499));
    const timer = setTimeout(() => stop(new OfficeError("TIMEOUT", "办公处理超时，请缩小输入后重试", 504)), options.timeoutMs ?? 60_000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.maxOutputBytes ?? 1_048_576)) stop(new OfficeError("OUTPUT_LIMIT", "办公处理输出超过限制", 502));
      else target.push(chunk);
    };
    child.stdout.on("data", capture(chunks));
    child.stderr.on("data", capture(errors));
    child.stdin.on("error", () => { /* A failed worker may close stdin before reading. */ });
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killFallback);
      options.signal?.removeEventListener("abort", onAbort);
      reject(new OfficeError("WORKER_UNAVAILABLE", `无法启动办公执行器：${error.message}`, 503));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killFallback);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else resolve({ stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8"), exitCode: exitCode ?? -1 });
    });
    child.stdin.end(options.input ?? "");
  });
}
