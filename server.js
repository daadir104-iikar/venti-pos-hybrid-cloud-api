require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 8080;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

const supabaseReady = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
const supabase = supabaseReady ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;

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
    await supabase.from("sync_events").insert({
      branch_id: req.device.branch_id,
      device_id: req.device.id,
      entity: "batch",
      local_id: String(items.length),
      action: "UPLOAD",
      status: "received"
    });
    res.json({ ok:true, received:items.length, message:"Upload endpoint ready. Full table sync comes next pack." });
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
    .card{background:#111827;border:1px solid #334155;border-radius:16px;padding:18px;box-shadow:0 10px 25px rgba(0,0,0,.2)}
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
      <div class="card metric"><div class="label">Today Sales</div><div id="todaySales" class="value">.00</div></div>
      <div class="card metric"><div class="label">Today Orders</div><div id="todayOrders" class="value">0</div></div>
      <div class="card metric"><div class="label">Today Expenses</div><div id="todayExpenses" class="value">.00</div></div>
      <div class="card metric"><div class="label">Customers</div><div id="customers" class="value">0</div></div>
    </div>

    <div class="section card">
      <h2>Recent Orders</h2>
      <table>
        <thead><tr><th>Date</th><th>Receipt</th><th>Status</th><th>Total</th></tr></thead>
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
    if(!r.ok || !j.ok) throw new Error(j.error || "Dashboard failed");

    document.getElementById("todaySales").textContent = money(j.summary.today_sales);
    document.getElementById("todayOrders").textContent = j.summary.today_orders;
    document.getElementById("todayExpenses").textContent = money(j.summary.today_expenses);
    document.getElementById("customers").textContent = j.summary.customers;

    const orders = j.recent_orders || [];
    document.getElementById("ordersBody").innerHTML = orders.length ? orders.map(function(o){
      return "<tr><td>" + esc(pick(o, ["created_at","order_date","date"], "")) +
        "</td><td>" + esc(pick(o, ["receipt_no","receipt_number","id"], "")) +
        "</td><td>" + esc(pick(o, ["status","order_status"], "")) +
        "</td><td>" + esc(money(pick(o, ["total","total_amount","grand_total","net_total"], 0))) +
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const isoToday = todayStart.toISOString();

    const safe = async (fn, fallback) => {
      try { return await fn(); } catch (e) { return fallback; }
    };

    const countRows = async (table) => {
      const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
      if (error) return 0;
      return count || 0;
    };

    const recentOrders = await safe(async () => {
      const { data, error } = await supabase.from("orders").select("*").order("created_at", { ascending: false }).limit(25);
      if (error) return [];
      return data || [];
    }, []);

    const recentExpenses = await safe(async () => {
      const { data, error } = await supabase.from("expenses").select("*").order("created_at", { ascending: false }).limit(25);
      if (error) return [];
      return data || [];
    }, []);

    const todayOrders = recentOrders.filter(o => String(o.created_at || o.order_date || o.date || "") >= isoToday);
    const todayExpensesRows = recentExpenses.filter(e => String(e.created_at || e.expense_date || e.date || "") >= isoToday);
    const amountOf = (row) => Number(row.total || row.total_amount || row.grand_total || row.net_total || row.amount || 0);

    res.json({
      ok: true,
      summary: {
        today_sales: todayOrders.reduce((s, o) => s + amountOf(o), 0),
        today_orders: todayOrders.length,
        today_expenses: todayExpensesRows.reduce((s, e) => s + amountOf(e), 0),
        customers: await countRows("customers")
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