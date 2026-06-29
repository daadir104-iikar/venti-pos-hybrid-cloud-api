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

app.listen(PORT, () => console.log("Venti POS Cloud API running on http://localhost:" + PORT));