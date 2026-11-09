import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Previewing an invite never consumes it or creates a membership. */
export async function showProjectInvite(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  store: Store,
  publicUrl: string,
) {
  let title = "Invite unavailable";
  let description =
    "This invite has expired or was already used. Ask the project owner for a new invite.";
  let content = "";
  if (!["GET", "HEAD"].includes(req.method ?? "")) {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    description = "Open the original project invite in your browser.";
  } else {
    const token = url.pathname.match(/^\/join\/([a-f0-9]{48})$/)?.[1];
    if (!token || url.search) {
      res.statusCode = 400;
      description =
        "This invite link is invalid. Ask the project owner for a new invite.";
    } else {
      const project = await store.pool.query<{ name: string }>(
        `select p.name from orka.invites i join orka.projects p on p.id=i.project_id
         where i.token_hash=$1 and i.expires_at>now() and p.archived_at is null`,
        [createHash("sha256").update(token).digest("hex")],
      );
      if (!project.rowCount) res.statusCode = 410;
      else {
        title = `Join ${project.rows[0].name}`;
        description =
          "Open Orka to sign in, review what to share from this Mac, and join the project.";
        const desktop = new URL(`orka://join/${token}`);
        desktop.searchParams.set("server", publicUrl);
        const browser = `${publicUrl}/join/${token}`;
        content = `<a class="button" href="${escape(desktop.href)}">Open Orka</a><p>Don’t have Orka? Install it on your Mac, then return to this page.</p><label for="invite">Invite link</label><textarea id="invite" rows="3" readonly spellcheck="false">${escape(browser)}</textarea><p class="hint">If Orka doesn’t open, copy this link and paste it into Join project in the app. Invites work once and expire after 24 hours.</p><p class="hint">Service: ${escape(publicUrl)}</p>`;
      }
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)} · Orka</title><style>body{margin:0;background:#0a0a0a;color:#ededed;font:16px/1.5 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{box-sizing:border-box;width:min(480px,calc(100% - 32px));margin:24px 0;padding:28px;background:#121212;border:1px solid #292929;border-radius:16px}h1{font-size:24px;overflow-wrap:anywhere;margin:0 0 12px}p{color:#b3b3b3;overflow-wrap:anywhere}.button{display:block;text-align:center;padding:12px;border-radius:9px;background:#f5f5f5;color:#121212;text-decoration:none}label{display:block;margin-bottom:8px}textarea{box-sizing:border-box;width:100%;resize:vertical;background:#1c1c1c;color:#ededed;border:1px solid #444;border-radius:8px;padding:10px;font:14px/1.5 system-ui,sans-serif}.button:focus-visible,textarea:focus-visible{outline:2px solid #fff;outline-offset:4px}.hint{font-size:14px}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(description)}</p>${content}</main></body></html>`,
  );
}
