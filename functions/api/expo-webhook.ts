export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;

  if (env.EXPO_WEBHOOK_SECRET) {
    const raw = await request.clone().text();
    const hdr = request.headers.get('expo-signature') || '';
    const ok = await verifyHmacSha1Base64(raw, env.EXPO_WEBHOOK_SECRET, hdr);
    if (!ok) return json({ error: 'Invalid signature' }, 401);
  }

  const body: any = await request.json().catch(() => ({}));
  const status = body?.status || body?.event || 'unknown';
  const buildUrl = body?.buildDetailsPageUrl || body?.build?.detailsPageUrl || '';
  const gitRef = body?.gitRef || body?.metadata?.gitRef || body?.metadata?.appVersion || '';
  const commitMessage = body?.metadata?.commitMessage || '';

  const TASK_RE = /\b(?:SPR|TASK)-\d+\b/i;
  const hit = `${gitRef} ${commitMessage}`.match(TASK_RE);
  const taskId = (hit ? hit[0] : '').toUpperCase();

  let notionUrl = '';
  if (taskId && env.NOTION_TOKEN) {
    const r = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: taskId, filter: { value: 'page', property: 'object' } }),
    });
    if (r.ok) {
      const j = await r.json();
      const pageId = j?.results?.[0]?.id as string | undefined;
      if (pageId) notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;
    }
  }

  const hook = env.SLACK_WEBHOOK_URL;
  if (!hook) return json({ error: 'SLACK_WEBHOOK_URL missing' }, 500);

  let text = `🚀 *Preview build* ${status}`;
  if (gitRef) text += ` on \`${gitRef}\``;
  if (buildUrl) text += `\n📱 ${buildUrl}`;
  if (taskId)  text += `\n🔗 Task: ${taskId}${notionUrl ? ` • ${notionUrl}` : ''}`;
  if (commitMessage) text += `\n📝 ${commitMessage}`;

  const slack = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!slack.ok) return json({ error: 'Slack error', detail: await slack.text() }, 500);

  return json({ ok: true }, 200);
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
async function verifyHmacSha1Base64(bodyText: string, secret: string, header: string) {
  try {
    const provided = header.includes('=') ? header.split('=')[1] : header;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyText));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return timingSafeEqualB64(provided, expected);
  } catch { return false; }
}
function timingSafeEqualB64(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i=0;i<a.length;i++) r |= a.charCodeAt(i)^b.charCodeAt(i); return r===0; }

type Env = {
  SLACK_WEBHOOK_URL: string;
  EXPO_WEBHOOK_SECRET?: string;
  NOTION_TOKEN?: string;
};

