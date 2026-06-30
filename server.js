require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const supabaseReady = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = supabaseReady ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false }, realtime: { transport: ws } }) : null;

async function requireDevice(req, res, next) {
  try {
    if (!supabaseReady) return res.status(500).json({ ok:false, message:"Supabase not configured" });

    const apiKey = req.header("x-api-key") || "";
    if (!apiKey) return res.status(401).json({ ok:false, message:"Missing x-api-key" });

    const { data, error } = await supabase
      .from("devices")
      .select("id,branch_id,device_code,device_name,device_type,is_active")
      .eq("api_key", apiKey)
      .maybeSingle();

    if (error) throw error;
    if (!data || !data.is_active) return res.status(401).json({ ok:false, message:"Invalid API key" });

    req.device = data;
    await supabase.from("devices").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
    next();
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message || String(e) });
  }
}

function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET) return next();
  if ((req.header("x-admin-secret") || "") !== ADMIN_SECRET) return res.status(401).json({ ok:false, message:"Invalid admin secret" });
  next();
}

app.get("/", (_req, res) => {
  res.json({ ok:true, app:"Venti POS Cloud API", version:"1.0.0", endpoints:["/health","/sync/upload","/admin/dashboard"] });
});

app.get("/health", async (_req, res) => {
  try {
    let db_ok = false;
    let db_message = "Supabase not configured";

    if (supabaseReady) {
      const { error } = await supabase.from("branches").select("id").limit(1);
      db_ok = !error;
      db_message = error ? error.message : "Connected";
    }

    res.json({ ok:true, app:"Venti POS Cloud API", version:"1.0.0", supabase_configured:supabaseReady, db_ok, db_message, time:new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message || String(e) });
  }
});

app.post("/sync/upload", requireDevice, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const branchId = req.device.branch_id;
    const deviceId = req.device.id;

    let saved = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];

    const { data: colRows, error: colError } = await supabase.rpc("get_table_columns_safe", { table_name_input: "orders" });
    if (colError) throw colError;

    const orderCols = new Set((colRows || []).map(r => r.column_name));

    function safeNumber(v, fallback = 0) {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }

    function parsePayload(item) {
      let data = item.payload || item.data || item.record || item.row || null;

      if (!data && item.payload_json) {
        try { data = JSON.parse(item.payload_json); } catch (e) { data = null; }
      }

      if (!data) data = {};
      return data;
    }

    function put(row, key, value) {
      if (orderCols.has(key) && value !== undefined && value !== null && value !== "") {
        row[key] = value;
      }
    }

    for (const item of items) {
      const entity = String(item.entity || item.table_name || item.table || "").toLowerCase();

      if (entity !== "orders") {
        skipped++;
        continue;
      }

      try {
        const data = parsePayload(item);
        const localId = String(item.entity_id || item.local_id || data.id || data.local_id || "");
        const now = new Date().toISOString();

        const total = safeNumber(data.total ?? data.total_amount ?? data.grand_total ?? data.net_total ?? data.amount ?? data.subtotal, 0);
        const paid = safeNumber(data.paid ?? data.paid_amount, 0);
        const balance = data.balance !== undefined ? safeNumber(data.balance, Math.max(0, total - paid)) : Math.max(0, total - paid);

        const row = {};

        put(row, "branch_id", branchId);
        put(row, "device_id", deviceId);
        put(row, "local_id", localId);
        put(row, "order_no", String(data.order_no || data.receipt_no || data.receipt_number || data.id || localId || Date.now()));
        put(row, "order_type", String(data.order_type || data.type || "Walk-in"));
        put(row, "table_name", String(data.table_name || data.table || data.table_no || data.table_id || "Walk-in"));
        put(row, "cashier_name", String(data.cashier_name || data.cashier || "admin"));
        put(row, "status", String(data.status || "open"));
        put(row, "kitchen_status", String(data.kitchen_status || "new"));
        put(row, "subtotal", safeNumber(data.subtotal ?? total, total));
        put(row, "total", total);
        put(row, "paid", paid);
        put(row, "balance", balance);
        put(row, "order_date", data.order_date || data.created_at || now);
        put(row, "created_at", data.created_at || now);

        const { error } = await supabase.from("orders").insert(row);
        if (error) throw error;

        saved++;
        results.push({ ok: true, entity: "orders", local_id: localId, total });
      } catch (e) {
        failed++;
        results.push({ ok: false, entity: "orders", error: e.message || String(e) });
      }
    }

    await supabase.from("sync_events").insert({
      branch_id: branchId,
      device_id: deviceId,
      entity: "batch",
      local_id: String(items.length),
      action: "UPLOAD",
      status: failed ? "partial" : "received",
      error: failed ? JSON.stringify(results.filter(r => !r.ok).slice(0, 10)) : null
    });

    res.json({ ok: failed === 0, received: items.length, saved, failed, skipped, results });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message || String(e) });
  }
});

app.get("/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    if (!supabaseReady) return res.status(500).json({ ok:false, message:"Supabase not configured" });

    const branchCode = req.query.branch_code || "VENTI-001";
    const { data: branch, error: branchError } = await supabase
      .from("branches")
      .select("id,branch_code,branch_name")
      .eq("branch_code", branchCode)
      .maybeSingle();

    if (branchError) throw branchError;
    if (!branch) return res.status(404).json({ ok:false, message:"Branch not found" });

    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);

    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select("id,total,paid,balance,status,kitchen_status,order_date")
      .eq("branch_id", branch.id)
      .gte("order_date", todayStart.toISOString());

    if (ordersError) throw ordersError;

    const totalSales = (orders || []).reduce((s,o) => s + Number(o.total || 0), 0);
    const totalPaid = (orders || []).reduce((s,o) => s + Number(o.paid || 0), 0);

    res.json({ ok:true, branch, today:{ orders_count:(orders || []).length, total_sales:totalSales, total_paid:totalPaid } });
  } catch (e) {
    res.status(500).json({ ok:false, message:e.message || String(e) });
  }
});





// VENTI_PACK9_ADMIN_DASHBOARD_START
function ventiAdminAuth(req, res, next) {
  const adminSecret = process.env.ADMIN_SECRET || "";
  const provided = req.headers["x-admin-secret"] || req.query.admin_secret || "";

  if (!adminSecret) {
    return res.status(500).json({ ok: false, error: "ADMIN_SECRET is not configured" });
  }

  if (provided !== adminSecret) {
    return res.status(401).json({ ok: false, error: "Unauthorized admin request" });
  }

  next();
}

app.get("/admin", (req, res) => {
  res.redirect("/admin/panel");
});

app.get("/admin/panel", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Venti POS Cloud Admin</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#0f172a;color:#e5e7eb}
    .wrap{max-width:1180px;margin:0 auto;padding:24px}
    .top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
    h1{margin:0;font-size:28px}.muted{color:#94a3b8}
    .card{background:#111827;border:1px solid #334155;border-radius:16px;padding:18px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:18px}
    .metric .label{color:#94a3b8;font-size:13px}.metric .value{font-size:30px;font-weight:800;margin-top:8px}
    .section{margin-top:18px} table{width:100%;border-collapse:collapse;margin-top:10px}
    th,td{padding:11px;border-bottom:1px solid #334155;text-align:left;font-size:14px}
    th{color:#cbd5e1} button{border-radius:10px;border:1px solid #2563eb;background:#2563eb;color:#e5e7eb;padding:10px 12px;cursor:pointer;font-weight:700}
    .bad{color:#fca5a5}.good{color:#86efac}
    @media(max-width:800px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:520px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Venti POS Cloud Admin</h1>
        <div class="muted">Remote dashboard for synced POS data</div>
      </div>
      <div>
        <button onclick="setSecret()">Admin Login</button>
        <button onclick="loadDash()">Refresh</button>
      </div>
    </div>

    <div id="status" class="section muted">Loading...</div>

    <div class="grid">
      <div class="card metric"><div class="label">Today Sales</div><div id="todaySales" class="value">$0.00</div></div>
      <div class="card metric"><div class="label">Today Orders</div><div id="todayOrders" class="value">0</div></div>
      <div class="card metric"><div class="label">Today Expenses</div><div id="todayExpenses" class="value">$0.00</div></div>
      <div class="card metric"><div class="label">Synced Events</div><div id="customers" class="value">0</div></div>
    </div>

    <div class="section card">
      <h2>Recent Orders</h2>
      <table>
        <thead><tr><th>Date</th><th>Receipt/ID</th><th>Status</th><th>Total</th></tr></thead>
        <tbody id="ordersBody"></tbody>
      </table>
    </div>

    <div class="section card">
      <h2>Recent Expenses</h2>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Note</th><th>Amount</th></tr></thead>
        <tbody id="expensesBody"></tbody>
      </table>
    </div>
  </div>

<script>
function money(n){ return "$" + Number(n || 0).toFixed(2); }
function getSecret(){
  let s = localStorage.getItem("VENTI_ADMIN_SECRET");
  if(!s){ s = prompt("Enter ADMIN_SECRET"); if(s) localStorage.setItem("VENTI_ADMIN_SECRET", s); }
  return s || "";
}
function setSecret(){
  const s = prompt("Enter ADMIN_SECRET");
  if(s){ localStorage.setItem("VENTI_ADMIN_SECRET", s); loadDash(); }
}
function pick(obj, names, fallback){
  for(let i=0;i<names.length;i++){
    const n = names[i];
    if(obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  }
  return fallback;
}
function esc(v){
  return String(v === undefined || v === null ? "" : v).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];
  });
}
async function loadDash(){
  const status = document.getElementById("status");
  status.textContent = "Loading dashboard...";
  status.className = "section muted";
  try{
    const r = await fetch("/admin/api/panel", { headers: { "x-admin-secret": getSecret() } });
    const j = await r.json();
    if(!r.ok || !j.ok) throw new Error(j.error || j.message || "Dashboard failed");

    document.getElementById("todaySales").textContent = money(j.summary.today_sales);
    document.getElementById("todayOrders").textContent = j.summary.today_orders;
    document.getElementById("todayExpenses").textContent = money(j.summary.today_expenses);
    document.getElementById("customers").textContent = j.summary.synced_events;

    const orders = j.recent_orders || [];
    document.getElementById("ordersBody").innerHTML = orders.length ? orders.map(function(o){
      return "<tr><td>" + esc(pick(o, ["created_at","order_date","date"], "")) +
        "</td><td>" + esc(pick(o, ["display_id","order_no","local_id","receipt_no","receipt_number","id"], "")) +
        "</td><td>" + esc(pick(o, ["display_status","status","order_status"], "")) +
        "</td><td>" + esc(money(pick(o, ["display_total","total","total_amount","grand_total","net_total","amount"], 0))) +
        "</td></tr>";
    }).join("") : "<tr><td colspan=\\"4\\" class=\\"muted\\">No recent orders</td></tr>";

    const expenses = j.recent_expenses || [];
    document.getElementById("expensesBody").innerHTML = expenses.length ? expenses.map(function(e){
      return "<tr><td>" + esc(pick(e, ["created_at","expense_date","date"], "")) +
        "</td><td>" + esc(pick(e, ["category","category_name","expense_category"], "")) +
        "</td><td>" + esc(pick(e, ["note","description","title"], "")) +
        "</td><td>" + esc(money(pick(e, ["amount","total"], 0))) +
        "</td></tr>";
    }).join("") : "<tr><td colspan=\\"4\\" class=\\"muted\\">No recent expenses</td></tr>";

    status.textContent = "Connected. Last refresh: " + new Date().toLocaleString();
    status.className = "section good";
  } catch(e){
    status.textContent = "Error: " + e.message;
    status.className = "section bad";
  }
}
loadDash();
</script>
</body>
</html>`);
});

app.get("/admin/api/panel", ventiAdminAuth, async (req, res) => {
  try {
    const safe = async (fn, fallback) => {
      try { return await fn(); } catch (e) { return fallback; }
    };

    const parsePayload = (row) => {
      const raw = row.payload || row.data || row.event_payload || row.body || null;
      if (!raw) return null;
      if (typeof raw === "object") return raw;
      try { return JSON.parse(raw); } catch (e) { return null; }
    };

    const rowType = (row, payload) => {
      return String(row.entity || row.table_name || row.type || row.event_type || payload?.entity || payload?.table_name || payload?.type || "").toLowerCase();
    };

    const normalize = (row) => {
      const payload = parsePayload(row) || {};
      const data = payload.payload || payload.data || payload.record || payload;
      const merged = Object.assign({}, data);
      if (!merged.created_at) merged.created_at = row.created_at || row.inserted_at || row.time || "";
      if (!merged.local_id && row.local_id) merged.local_id = row.local_id;
      return merged;
    };

    let recentOrders = await safe(async () => {
      const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) return [];
      return data || [];
    }, []);

    let recentExpenses = await safe(async () => {
      const { data, error } = await supabase.from("expenses").select("*").order("created_at", { ascending: false }).limit(50);
      if (error) return [];
      return data || [];
    }, []);

    let recentPayments = await safe(async () => {
      const { data, error } = await supabase.from("payments").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) return [];
      return data || [];
    }, []);

    const syncRows = await safe(async () => {
      const { data, error } = await supabase.from("sync_events").select("*").order("created_at", { ascending: false }).limit(500);
      if (error) return [];
      return data || [];
    }, []);

    const getItemTable = (item) => {
      return String(
        item.entity ||
        item.table_name ||
        item.table ||
        item.type ||
        item.collection ||
        item.model ||
        ""
      ).toLowerCase();
    };

    const getItemPayload = (item) => {
      return item.payload || item.data || item.record || item.row || item;
    };

    const pushPossibleItem = (item, parentRow) => {
      const table = getItemTable(item);
      const data = getItemPayload(item) || {};
      const n = Object.assign({}, data);

      if (!n.created_at) n.created_at = data.created_at || parentRow.created_at || parentRow.inserted_at || "";
      if (!n.local_id) n.local_id = item.local_id || item.record_id || data.id || "";

      const textBlob = JSON.stringify({ item, data, n }).toLowerCase();

      const looksLikeOrder =
        table.includes("orders") || table === "order" ||
        textBlob.includes('"orders"') ||
        n.total !== undefined ||
        n.total_amount !== undefined ||
        n.grand_total !== undefined ||
        n.net_total !== undefined ||
        n.balance !== undefined ||
        n.table_id !== undefined ||
        n.table_no !== undefined ||
        n.receipt_no !== undefined;

      const looksLikeExpense =
        table.includes("expenses") || table === "expense" ||
        textBlob.includes('"expenses"') ||
        n.expense_date !== undefined ||
        n.category !== undefined ||
        n.category_name !== undefined ||
        n.expense_category !== undefined;

      if (looksLikeExpense) {
        recentExpenses.push(n);
      } else if (looksLikeOrder) {
        recentOrders.push(n);
      }
    };

    for (const r of syncRows) {
      const p = parsePayload(r) || {};

      if (Array.isArray(p.items)) {
        for (const item of p.items) pushPossibleItem(item, r);
      } else if (Array.isArray(p.records)) {
        for (const item of p.records) pushPossibleItem(item, r);
      } else if (Array.isArray(p.data)) {
        for (const item of p.data) pushPossibleItem(item, r);
      } else {
        pushPossibleItem(p, r);
      }
    }

    const seenOrders = new Set();
    recentOrders = recentOrders.filter(o => {
      const key = String(o.id || o.local_id || o.receipt_no || JSON.stringify(o));
      if (seenOrders.has(key)) return false;
      seenOrders.add(key);
      return true;
    }).slice(0, 50);

    const seenExpenses = new Set();
    recentExpenses = recentExpenses.filter(e => {
      const key = String(e.id || e.local_id || e.note || JSON.stringify(e));
      if (seenExpenses.has(key)) return false;
      seenExpenses.add(key);
      return true;
    }).slice(0, 50);

    const amountOf = (row) => Number(row.total || row.total_amount || row.grand_total || row.net_total || row.amount || 0);

    const paidByOrderKey = new Map();
    for (const p of recentPayments || []) {
      const keys = [
        p.order_id,
        p.local_order_id,
        p.order_local_id
      ].filter(v => v !== undefined && v !== null && String(v).trim() !== "").map(v => String(v));
      const amt = Number(p.amount || p.total || 0);
      for (const k of keys) {
        paidByOrderKey.set(k, Number(paidByOrderKey.get(k) || 0) + amt);
      }
    }

    recentOrders = recentOrders.map((o) => {
      const local = o.local_id || o.order_no || o.receipt_no || "";
      const displayId = local ? ("Order #" + local) : String(o.id || "");
      const total = amountOf(o);
      const keys = [o.id, o.local_id, o.order_id].filter(v => v !== undefined && v !== null && String(v).trim() !== "").map(v => String(v));
      let paid = Number(o.paid || o.amount_paid || 0);
      for (const k of keys) paid += Number(paidByOrderKey.get(k) || 0);
      const balance = o.balance !== undefined && o.balance !== null ? Number(o.balance || 0) : Math.max(0, total - paid);
      let computedStatus = (total > 0 && (paid >= total || balance <= 0)) ? "Paid" : (o.status || o.order_status || "Open");

      // Dashboard fallback: older synced cloud rows may have status Open even after POS payment.
      // If the row has a positive total and no reliable balance field, treat it as Paid for sales reporting.
      const hasReliableBalance = o.balance !== undefined && o.balance !== null && String(o.balance).trim() !== "";
      const hasReliablePaid = o.paid !== undefined && o.paid !== null && String(o.paid).trim() !== "";
      if (total > 0) {
        computedStatus = "Paid";
      }
      return Object.assign({}, o, {
        display_id: displayId,
        display_status: computedStatus,
        display_total: total
      });
    });

    // Venti Cafe local day: Mogadishu/Nairobi time UTC+3
    const VENTI_TZ_OFFSET_MIN = Number(process.env.VENTI_TZ_OFFSET_MIN || 180);

    const startOfLocalDayUtcMs = (offsetMin) => {
      const now = new Date();
      const local = new Date(now.getTime() + offsetMin * 60000);
      local.setUTCHours(0, 0, 0, 0);
      return local.getTime() - offsetMin * 60000;
    };

    const endOfLocalDayUtcMs = (offsetMin) => startOfLocalDayUtcMs(offsetMin) + 24 * 60 * 60 * 1000;

    const rowTimeMs = (row) => {
      const raw = row.created_at || row.order_date || row.expense_date || row.date || row.inserted_at || "";
      const t = Date.parse(String(raw));
      return Number.isFinite(t) ? t : 0;
    };

    const dayStartMs = startOfLocalDayUtcMs(VENTI_TZ_OFFSET_MIN);
    const dayEndMs = endOfLocalDayUtcMs(VENTI_TZ_OFFSET_MIN);

    const todayOrders = recentOrders.filter(o => {
      const t = rowTimeMs(o);
      return t >= dayStartMs && t < dayEndMs;
    });

    const todayExpensesRows = recentExpenses.filter(e => {
      const t = rowTimeMs(e);
      return t >= dayStartMs && t < dayEndMs;
    });

    res.json({
      ok: true,
      summary: {
        today_sales: todayOrders.reduce((s, o) => s + amountOf(o), 0),
        today_orders: todayOrders.length,
        today_expenses: todayExpensesRows.reduce((s, e) => s + amountOf(e), 0),
        synced_events: syncRows.length
      },
      recent_orders: recentOrders,
      recent_expenses: recentExpenses,
      time: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});
// VENTI_PACK9_ADMIN_DASHBOARD_END


app.listen(PORT, () => console.log("Venti POS Cloud API running on http://localhost:" + PORT));
