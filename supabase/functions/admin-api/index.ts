// Supabase Edge Function: admin-api
// Secrets: ничего сверх service role (автоматически)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Нет Authorization (войдите в админку)" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Сессия недействительна" }, 401);

    const { data: adm } = await admin.from("hub_admins").select("user_id").eq("user_id", userData.user.id).maybeSingle();
    if (!adm) return json({ error: "Нет прав администратора. Добавьте user_id в hub_admins." }, 403);

    const body = await req.json();
    const action = body.action as string;

    if (action === "bootstrap_admin") {
      // только если таблица админов пуста — первый пользователь становится админом
      const { count } = await admin.from("hub_admins").select("*", { count: "exact", head: true });
      if ((count || 0) > 0) return json({ error: "Админ уже есть" }, 400);
      await admin.from("hub_admins").insert({ user_id: userData.user.id, email: userData.user.email });
      return json({ ok: true, msg: "Вы назначены первым админом" });
    }

    if (action === "list_projects") {
      const { data, error } = await admin.from("llm_projects").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return json({ ok: true, projects: data });
    }

    if (action === "create_project") {
      const name = String(body.name || "app").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "app";
      const display_name = String(body.display_name || name);
      const { data: keyRow } = await admin.rpc("llm_generate_api_key");
      const api_key = typeof keyRow === "string" ? keyRow : (keyRow as string);
      const key = api_key || (`orb_live_` + crypto.randomUUID().replace(/-/g, ""));
      const { data, error } = await admin.from("llm_projects").insert({
        name,
        display_name,
        api_key: key,
        rate_limit_day: Number(body.rate_limit_day) || 500,
        notes: body.notes || "",
        enabled: true,
      }).select().single();
      if (error) throw error;
      if (body.provider) {
        await admin.from("llm_project_providers").upsert({
          project_id: data.id,
          provider: body.provider,
          secret_label: body.secret_label || "default",
        });
      }
      return json({ ok: true, project: data });
    }

    if (action === "set_enabled") {
      const { error } = await admin.from("llm_projects").update({
        enabled: !!body.enabled,
        updated_at: new Date().toISOString(),
      }).eq("id", body.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "delete_project") {
      const { error } = await admin.from("llm_projects").delete().eq("id", body.id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "rotate_key") {
      const { data: keyRow } = await admin.rpc("llm_generate_api_key");
      const key = (typeof keyRow === "string" ? keyRow : null) || (`orb_live_` + crypto.randomUUID().replace(/-/g, ""));
      const { data, error } = await admin.from("llm_projects").update({
        api_key: key,
        updated_at: new Date().toISOString(),
      }).eq("id", body.id).select().single();
      if (error) throw error;
      return json({ ok: true, project: data });
    }

    if (action === "list_usage") {
      let q = admin.from("llm_usage").select("*, llm_projects(name, display_name)").order("created_at", { ascending: false }).limit(Number(body.limit) || 100);
      if (body.project_id) q = q.eq("project_id", body.project_id);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, usage: data });
    }

    if (action === "stats") {
      const { data, error } = await admin.rpc("hub_stats_summary", { p_days: Number(body.days) || 7 });
      if (error) throw error;
      return json({ ok: true, stats: data });
    }

    if (action === "list_secrets_meta") {
      // без client_secret / api_key значений
      const { data, error } = await admin.from("llm_provider_secrets").select("id, provider, label, scope, base_url, default_model, enabled, created_at, updated_at, client_id");
      if (error) throw error;
      return json({ ok: true, secrets: data });
    }

    if (action === "upsert_secret") {
      const row = {
        provider: String(body.provider || ""),
        label: String(body.label || "default"),
        client_id: body.client_id ?? null,
        client_secret: body.client_secret ?? null,
        auth_key: body.auth_key ?? null,
        scope: body.scope || "GIGACHAT_API_PERS",
        api_key: body.api_key ?? null,
        base_url: body.base_url ?? null,
        default_model: body.default_model ?? null,
        enabled: body.enabled !== false,
        updated_at: new Date().toISOString(),
      };
      if (!row.provider) return json({ error: "provider required" }, 400);
      const { data, error } = await admin.from("llm_provider_secrets").upsert(row, { onConflict: "provider,label" }).select("id, provider, label, enabled").single();
      if (error) throw error;
      return json({ ok: true, secret: data });
    }

    return json({ error: "unknown action: " + action }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
