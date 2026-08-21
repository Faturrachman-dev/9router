// Next.js instrumentation hook — runs ONCE at server startup, before any request,
// in the standalone server too. This guarantees app bootstrap fires (watchdog,
// tunnel/tailscale auto-resume, MITM auto-start, and local proxy autostart).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initConsoleLogCapture } = await import("./lib/consoleLogBuffer.js");
  initConsoleLogCapture();
  await import("./shared/services/bootstrap.js");
}