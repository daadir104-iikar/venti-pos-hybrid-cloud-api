# Venti POS Cloud API - Render Deploy

## Render settings

Service type:
Web Service

Runtime:
Node

Root Directory:
cloud-api

Build Command:
npm install

Start Command:
npm start

## Environment Variables

PORT=8080
SUPABASE_URL=your Supabase Project URL
SUPABASE_SERVICE_ROLE_KEY=your Supabase secret/service role key
ADMIN_SECRET=change_this_secret

## Test after deploy

Open:
https://YOUR-RENDER-URL.onrender.com/health

Expected:
supabase_configured: true
db_ok: true
db_message: Connected