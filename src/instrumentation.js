// Next.js instrumentation hook — runs ONCE at server startup, before any request,
// in the standalone server too. This guarantees app bootstrap fires (watchdog,
// tunnel/tailscale auto-resume, MITM auto-start, and local proxy autostart e.g.
// morph-proxy on :8790 that the Hermes auxiliary models depend on).
//
// Needed because bootstrap was only imported by the root layout, which the
// standalone server never executes for statically prerendered pages — so on a
// fresh boot nothing triggered initializeApp until a dynamic page happened to
// render. bootstrap.js has its own global guard, so this is safe alongside it.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./shared/services/bootstrap.js");
}
