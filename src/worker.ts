// Cloudflare Worker: Expo → (Slack or GitHub) with optional Notion URL lookup
// Runtime: Modules syntax

const HANDLED_PATHS = new Set<string>(['/', '/api/expo-webhook']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Health check / wrong path handling
    if (!HANDLED_PATHS.has(pathname)) {
      return json({ error: 'Not Found', path: pathname }, 404);
    }
    if (request.method === 'GET') {
      return json({ ok: true, route: pathname }, 200);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method Not Allowed' }, 405);
    }

    // Read RAW body FIRST (needed for signature)
    const rawBody = await request.text();
    log('[WEBHOOK] path=', pathname);
    log('[WEBHOOK] headers=', Object.fromEntries(request.headers));
    log('[WEBHOOK] body sample=', rawBody.slice(0, 1000));

    // 1) Signature verification (debug-friendly)
    if (env.EXPO_WEBHOOK_SECRET) {
      const sigHeader =
        request.headers.get('expo-signature') ||
        request.headers.get('Expo-Signature') ||
        '';

      const provided = sigHeader.includes('=') ? sigHeader.split('=')[1] : sigHeader;

      const exp = await computeHmacs(rawBody, env.EXPO_WEBHOOK_SECRET);
      const ok =
        timingSafeEq(provided, exp.sha1.b64) ||
        timingSafeEq(provided, exp.sha1.hex) ||
        timingSafeEq(provided, exp.sha256.b64) ||
        timingSafeEq(provided, exp.sha256.hex);

      log('[SIG] provided=', provided);
      log('[SIG] expected sha1 b64=', exp.sha1.b64);
      log('[SIG] expected sha1 hex=', exp.sha1.hex);
      log('[SIG] expected sha256 b64=', exp.sha256.b64);
      log('[SIG] expected sha256 hex=', exp.sha256.hex);
      log('[SIG] match=', ok);

      if (!ok) return json({ error: 'Invalid signature' }, 401);
    } else {
      log('[SIG] EXPO_WEBHOOK_SECRET not set — skipping verification');
    }

    // 2) Parse Expo payload (after sig verify)
    const body = safeParseJson(rawBody) as any;
    const status: string = body?.status || body?.event || 'unknown';
    const buildUrl: string =
      body?.buildDetailsPageUrl || body?.build?.detailsPageUrl || '';
    const gitRef: string =
      body?.gitRef || body?.metadata?.gitRef || body?.metadata?.appVersion || '';
    const commitMessage: string =
      body?.metadata?.commitMessage || body?.metadata?.gitCommitMessage || '';

    const profile: string =
      body?.metadata?.buildProfile ||
      body?.metadata?.appBuildProfile ||
      body?.metadata?.profile ||
      'unknown';

    log('[PAYLOAD] status=', status, 'profile=', profile, 'gitRef=', gitRef);

    // 3) Only act on preview builds (adjust if you want all)
    if (profile.toLowerCase() !== 'preview') {
      log('[SKIP] non-preview build, profile=', profile);
      return new Response(null, { status: 204 });
    }

    // 4) Extract Task ID (SPR-#### / TASK-####) from git ref or commit
    const TASK_REGEX = /\b(?:SPR|TASK)-\d+\b/i;
    const joined = `${gitRef ?? ''} ${commitMessage ?? ''}`;
    const idMatch = joined.match(TASK_REGEX);
    const taskId = idMatch ? idMatch[0].toUpperCase() : '';
    log('[TASK] taskId=', taskId, 'source=', joined);

    // 5) (Optional) Resolve Notion URL
    let notionUrl = '';
    if (taskId && env.NOTION_TOKEN) {
      try {
        const r = await fetch('https://api.notion.com/v1/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: taskId,
            filter: { value: 'page', property: 'object' },
          }),
        });
        const j = await r.json().catch(() => ({}));
        const pageId = j?.results?.[0]?.id as string | undefined;
        if (pageId) {
          notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;
          log('[NOTION] resolved pageId=', pageId, 'url=', notionUrl);
        } else {
          log('[NOTION] no results for', taskId);
        }
      } catch (e) {
        log('[NOTION] lookup error=', String(e));
      }
    } else {
      if (!taskId) log('[NOTION] skip — no taskId found');
      if (!env.NOTION_TOKEN) log('[NOTION] skip — NOTION_TOKEN missing');
    }

    // 6) Either Slack or GitHub repository_dispatch
    const useDispatch = (env.DISPATCH_TO_GITHUB || '').toLowerCase() === 'true';

    if (useDispatch) {
      // GitHub dispatch mode
      const owner = env.GH_OWNER || 'SuperAppLabsCo';
      const repo = env.GH_REPO || 'axon-ui';
      const token = env.GH_REPO_DISPATCH_TOKEN;
      if (!token) return json({ error: 'GH_REPO_DISPATCH_TOKEN missing' }, 500);

      const payload = {
        event_type: 'expo-build',
        client_payload: {
          status,
          buildUrl,
          branch: gitRef,
          commitMessage,
          taskId,
          notionUrl,
          profile,
        },
      };

      const gh = await fetch(`https://api.github.com/repos/${owner}/${repo}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const respText = await gh.text();
      log('[GITHUB] status=', gh.status, 'body=', respText.slice(0, 1000));

      if (!gh.ok) return json({ error: 'GitHub dispatch failed', detail: respText }, gh.status);
      return json({ ok: true, mode: 'github' }, 200);
    } else {
      // Slack mode
      const hook = env.SLACK_WEBHOOK_URL;
      if (!hook) return json({ error: 'SLACK_WEBHOOK_URL missing' }, 500);

      let text = `🚀 Preview build ${status}`;
      if (gitRef) text += ` on \`${gitRef}\``;
      if (buildUrl) text += `\n📱 ${buildUrl}`;
      if (taskId) text += `\n🔗 Task: ${taskId}${notionUrl ? ` • ${notionUrl}` : ''}`;
      if (commitMessage) text += `\n📝 ${commitMessage}`;
      text += `\n🧪 Profile: ${profile}`;

      const slack = await fetch(hook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      const respText = await slack.text();
      log('[SLACK] status=', slack.status, 'body=', respText.slice(0, 1000));

      if (!slack.ok) return json({ error: 'Slack error', detail: respText }, 500);
      return json({ ok: true, mode: 'slack' }, 200);
    }
  },
};

// ----- helpers -----

function log(...args: any[]) {
  try {
    // Cloudflare/Workers supports console.log
    // Keep verbose until stable; then trim.
    // @ts-ignore
    console.log(...args);
  } catch {}
}

function safeParseJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function computeHmacs(body: string, secret: string) {
  const enc = new TextEncoder();
  const keySha1 = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const keySha256 = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig1 = new Uint8Array(await crypto.subtle.sign('HMAC', keySha1, enc.encode(body)));
  const sig256 = new Uint8Array(await crypto.subtle.sign('HMAC', keySha256, enc.encode(body)));

  return {
    sha1: {
      b64: bytesToB64(sig1),
      hex: bytesToHex(sig1),
    },
    sha256: {
      b64: bytesToB64(sig256),
      hex: bytesToHex(sig256),
    },
  };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToB64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  // btoa available in Workers
  // @ts-ignore
  return btoa(s);
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

