// Публичный шлюз для приложений: заголовок X-Orbit-Key: orb_live_...
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-orbit-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const t0 = Date.now();
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    const orbitKey = req.headers.get("x-orbit-key") || "";
    if (!orbitKey.startsWith("orb_live_")) {
      return json({ error: "Нужен заголовок X-Orbit-Key" }, 401);
    }

    const { data: authRows, error: authErr } = await admin.rpc("llm_auth_project", { p_key: orbitKey });
    if (authErr) throw authErr;
    const auth = Array.isArray(authRows) ? authRows[0] : authRows;
    if (!auth?.project_id) return json({ error: "Неверный ключ проекта" }, 401);
    if (!auth.enabled) return json({ error: "Ключ отключён" }, 403);
    if (Number(auth.used_today) >= Number(auth.rate_limit_day)) {
      return json({ error: "Дневной лимит запросов исчерпан" }, 429);
    }

    const body = await req.json();
    const provider = String(body.provider || "giga");
    const messages = body.messages || [];
    const model = body.model;

    const { data: secRows } = await admin.rpc("llm_get_secret", {
      p_project_id: auth.project_id,
      p_provider: provider,
    });
    const sec = Array.isArray(secRows) ? secRows[0] : secRows;
    if (!sec) return json({ error: "Провайдер не настроен для этого проекта" }, 400);

    let result: { ok: boolean; status: number; text: string; usage?: Record<string, number> };

    if (provider === "giga") {
      result = await callGiga(sec, messages, model);
    } else {
      result = await callOpenAICompat(sec, messages, model, provider);
    }

    const preview = JSON.stringify(messages).slice(0, 300);
    await admin.from("llm_usage").insert({
      project_id: auth.project_id,
      provider,
      model: model || sec.default_model,
      ok: result.ok,
      status_code: result.status,
      error_brief: result.ok ? null : result.text.slice(0, 200),
      request_preview: preview,
      tokens_prompt: result.usage?.prompt_tokens || 0,
      tokens_completion: result.usage?.completion_tokens || 0,
      tokens_total: result.usage?.total_tokens || 0,
      latency_ms: Date.now() - t0,
    });

    if (!result.ok) return json({ error: result.text }, result.status || 502);
    return json({ ok: true, content: result.text, usage: result.usage, project: auth.project_name });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

async function callGiga(sec: Record<string, string>, messages: unknown[], model?: string) {
  const basic = sec.auth_key || btoa(`${sec.client_id}:${sec.client_secret}`);
  const oauth = await fetch("https://ngw.devices.sberbank.ru:9443/api/v2/oauth", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: crypto.randomUUID(),
      Authorization: "Basic " + basic.replace(/^Basic\s+/i, ""),
    },
    body: "scope=" + encodeURIComponent(sec.scope || "GIGACHAT_API_PERS"),
  });
  const oauthText = await oauth.text();
  if (!oauth.ok) return { ok: false, status: oauth.status, text: "Giga OAuth: " + oauthText.slice(0, 300) };
  let tok: { access_token?: string };
  try { tok = JSON.parse(oauthText); } catch { return { ok: false, status: 502, text: "OAuth JSON error" }; }

  const chat = await fetch("https://api.giga.chat/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: "Bearer " + tok.access_token,
    },
    body: JSON.stringify({
      model: model || sec.default_model || "GigaChat",
      messages,
    }),
  });
  const chatText = await chat.text();
  if (!chat.ok) return { ok: false, status: chat.status, text: chatText.slice(0, 400) };
  const data = JSON.parse(chatText);
  const content = data?.choices?.[0]?.message?.content || "";
  return { ok: true, status: 200, text: content, usage: data.usage };
}

async function callOpenAICompat(sec: Record<string, string>, messages: unknown[], model: string | undefined, provider: string) {
  const url = (sec.base_url || defaultBase(provider)).replace(/\/$/, "") + "/chat/completions";
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + sec.api_key,
    },
    body: JSON.stringify({ model: model || sec.default_model, messages }),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: t.slice(0, 400) };
  const data = JSON.parse(t);
  return {
    ok: true,
    status: 200,
    text: data?.choices?.[0]?.message?.content || "",
    usage: data.usage,
  };
}

function defaultBase(p: string) {
  if (p === "grok") return "https://api.x.ai/v1";
  if (p === "deepseek") return "https://api.deepseek.com";
  if (p === "openai") return "https://api.openai.com/v1";
  return "https://api.openai.com/v1";
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
