// netlify/functions/tasks.js — Dashboard Admin Yannick v5
// GET  -> liste les tâches de la base Notion
// POST -> { page_id, action: "statut"|"changeprio"|"changeproject", value: "..." }

const DATA_SOURCE_ID = "182186c5-80ba-438f-874d-03e52b826bab";
const API = "https://api.notion.com/v1";

const STATUS_FOR_ACTION = {
  attente: "En attente",
  encours: "En cours",
  verif: "À vérifier",
  fait: "Fait",
  done: "Fait",
  in_progress: "En cours",
  verify: "En attente de vérification",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

async function notion(path, opts, token, version) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      "Notion-Version": version,
      "Content-Type": "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function queryAll(token) {
  let endpoint = `/data_sources/${DATA_SOURCE_ID}/query`;
  let version = "2025-09-03";
  let cursor;
  let triedFallback = false;
  const results = [];
  for (;;) {
    const body = cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 };
    const { res, data } = await notion(endpoint, { method: "POST", body: JSON.stringify(body) }, token, version);
    if (res.status === 401) throw { code: "NOTION_TOKEN_INVALID", message: "Token Notion refusé (401)." };
    if (!res.ok) {
      if (!triedFallback) {
        triedFallback = true;
        endpoint = `/databases/${DATA_SOURCE_ID}/query`;
        version = "2022-06-28";
        cursor = undefined;
        results.length = 0;
        continue;
      }
      throw { code: "NOTION_HTTP_" + res.status, message: data.message || ("Erreur Notion HTTP " + res.status) };
    }
    results.push(...(data.results || []));
    if (data.has_more && data.next_cursor) cursor = data.next_cursor;
    else break;
  }
  return results;
}

const plain = (arr) => (arr || []).map((x) => x.plain_text || "").join("");

function mapPage(p) {
  const props = p.properties || {};
  const get = (name) => props[name] || {};
  const uid = get("N°").unique_id;
  return {
    id: p.id,
    url: p.url || null,
    num: uid
      ? (uid.prefix ? uid.prefix + "-" : "") + (uid.number != null ? uid.number : "?")
      : null,
    tache: plain(get("Tâche").title),
    statut: (get("Statut").select || {}).name || null,
    priorite: (get("Priorité").select || {}).name || null,
    echeance: (get("Échéance").date || {}).start || null,
    source: (get("Source").select || {}).name || null,
    contexte: (get("Contexte").multi_select || []).map((o) => o.name),
    creee_le: get("Créée le").created_time || p.created_time || null,
    fait_le: (get("Fait le").date || {}).start || null,
    notes: plain(get("Notes").rich_text),
  };
}

exports.handler = async (event) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return json(500, {
      ok: false,
      error: "NOTION_TOKEN_MISSING",
      message: "La variable d'environnement NOTION_TOKEN n'est pas configurée dans Netlify.",
    });
  }

  try {
    if (event.httpMethod === "GET") {
      const pages = await queryAll(token);
      const tasks = pages.map(mapPage).filter((t) => t.statut !== "Abandonné");
      return json(200, {
        ok: true,
        generated_at: new Date().toISOString(),
        count: tasks.length,
        tasks,
      });
    }

    if (event.httpMethod === "POST") {
      let body = {};
      try { body = JSON.parse(event.body || "{}"); } catch (_) {}
      const { page_id, action, value } = body;

      if (!page_id || !action) {
        return json(400, {
          ok: false,
          error: "BAD_REQUEST",
          message: "page_id et action sont requis.",
        });
      }

      const properties = {};

      // Gestion des statuts (ancien format pour compatibilité)
      if (["done", "in_progress", "verify"].includes(action)) {
        const statut = STATUS_FOR_ACTION[action];
        properties["Statut"] = { select: { name: statut } };
        if (action === "done") {
          properties["Fait le"] = { date: { start: new Date().toISOString().slice(0, 10) } };
        }
      }
      // Gestion des changements de statut (nouveau format v5)
      else if (["attente", "encours", "verif", "fait"].includes(action)) {
        const statut = STATUS_FOR_ACTION[action];
        properties["Statut"] = { select: { name: statut } };
        if (action === "fait") {
          properties["Fait le"] = { date: { start: new Date().toISOString().slice(0, 10) } };
        }
      }
      // Changement de priorité
      else if (action === "changeprio" && value) {
        properties["Priorité"] = { select: { name: value } };
      }
      // Changement de projet
      else if (action === "changeproject" && value) {
        properties["Projet"] = { select: { name: value } };
      }
      else {
        return json(400, {
          ok: false,
          error: "UNKNOWN_ACTION",
          message: "Action non reconnue: " + action,
        });
      }

      const { res, data } = await notion(
        `/pages/${page_id}`,
        { method: "PATCH", body: JSON.stringify({ properties }) },
        token,
        "2022-06-28"
      );
      if (res.status === 401) throw { code: "NOTION_TOKEN_INVALID", message: "Token Notion refusé (401)." };
      if (!res.ok) throw { code: "NOTION_HTTP_" + res.status, message: data.message || ("Erreur Notion HTTP " + res.status) };
      return json(200, { ok: true, page_id, action, value });
    }

    return json(405, { ok: false, error: "METHOD_NOT_ALLOWED", message: "Méthode non autorisée." });
  } catch (e) {
    return json(502, { ok: false, error: e.code || "UNKNOWN", message: e.message || String(e) });
  }
};
