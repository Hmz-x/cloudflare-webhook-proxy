// Cloudflare Worker: Expo → (Slack or GitHub) with optional Notion URL lookup
// Runtime: Modules syntax

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405);
    }

    // 1) Optional signature verification (recommended)
    if (env.EXPO_WEBHOOK_SECRET) {
      const bodyText = await request.clone().text();
      const sigHeader = request.headers.get("expo-signature") || "";
      const ok = await verifyHmacSha1Base64(bodyText, env.EXPO_WEBHOOK_SECRET, sigHeader);
      if (!ok) return json({ error: "Invalid signature" }, 401);
    }

    // 2) Parse Expo payload
    const body = (await safeJson(request)) as any;
    const status: string = body?.status || body?.event || "unknown";
    const buildUrl: string =
      body?.buildDetailsPageUrl || body?.build?.detailsPageUrl || "";
    const gitRef: string =
      body?.gitRef || body?.metadata?.gitRef || body?.metadata?.appVersion || "";
    const commitMessage: string = body?.metadata?.commitMessage || "";

    // 3) Extract Task ID (SPR-#### / TASK-####)
    const TASK_REGEX = /\b(?:SPR|TASK)-\d+\b/i;
    const idMatch = `${gitRef} ${commitMessage}`.match(TASK_REGEX);
    const taskId = idMatch ? idMatch[0].toUpperCase() : "";

    // 4) (Optional) Resolve Notion URL
    let notionUrl = "";
    if (taskId && env.NOTION_TOKEN) {
      try {
        const r = await fetch("https://api.notion.com/v1/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: taskId,
            filter: { value: "page", property: "object" },
          }),
        });
        if (r.ok) {
          const j = await r.json();
          const pageId = j?.results?.[0]?.id as string | undefined;
          if (pageId) notionUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
        }
      } catch {
        // ignore; we'll still post without a Notion URL
      }
    }

    // 5) Either Slack or GitHub repository_dispatch
    const useDispatch = (env.DISPATCH_TO_GITHUB || "").toLowerCase() === "true";

    if (useDispatch) {
      const owner = env.GH_OWNER || "SuperAppLabsCo";
      const repo  = env.GH_REPO  || "axon-ui";
      const token = env.GH_REPO_DISPATCH_TOKEN; // required if dispatching

      if (!token) return json({ error: "GH_REPO_DISPATCH_TOKEN missing" }, 500);

      const payload = {
        event_type: "expo-build",
        client_payload: {
          status, buildUrl, branch: gitRef, commitMessage, taskId, notionUrl,
        },
      };

      const gh = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!gh.ok) {
        const t = await gh.text();
        return json({ error: "GitHub dispatch failed", detail: t }, gh.status);
      }
      return json({ ok: true, mode: "github" }, 200);
    } else {
      const hook = env.SLACK_WEBHOOK_URL; // required for Slack mode
      if (!hook) return json({ error: "SLACK_WEBHOOK_URL missing" }, 500);

      let text = `🚀 *Preview build* ${status}`;
      if (gitRef)        text += ` on \`${gitRef}\``;
      if (buildUrl)      text += `\n📱 ${buildUrl}`;
      if (taskId)        text += `\n🔗 Task: ${taskId}${notionUrl ? ` • ${notionUrl}` : ""}`;
      if (commitMessage) text += `\n📝 ${commitMessage}`;

      const slack = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!slack.ok) {
        const t = await slack.text();
        return json({ error: "Slack error", detail: t }, 500);
      }
      return json({ ok: true, mode: "slack" }, 200);
    }
  },
};

async function verifyHmacSha1Base64(bodyText: string, secret: string, header: string): Promise<boolean> {
  try {
    // Expo commonly sends "sha1=<base64Hmac>" — accept either with or without the "sha1=" prefix
    const provided = header.includes("=") ? header.split("=")[1] : header;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bodyText));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return timingSafeEqualB64(provided, expected);
  } catch {
    return false;
  }
}

function timingSafeEqualB64(a: string, b: string): boolean {
  // simple constant-time compare for base64 strings (best-effort)
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function safeJson(request: Request) {
  try { return await request.json(); } catch { return {}; }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Env = {
  SLACK_WEBHOOK_URL?: string;
  NOTION_TOKEN?: string;
  EXPO_WEBHOOK_SECRET?: string;
  DISPATCH_TO_GITHUB?: string;       // "true" to use GH dispatch mode
  GH_OWNER?: string;                  // default: SuperAppLabsCo
  GH_REPO?: string;                   // default: axon-ui
  GH_REPO_DISPATCH_TOKEN?: string;    // PAT with Actions write (if DISPATCH_TO_GITHUB=true)
};
