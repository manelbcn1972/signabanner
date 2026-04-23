// netlify/functions/api.js
// API REST para el panel de gestión
// Rutas: /api/clients, /api/campaigns, /api/analytics/*

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (data, status = 200) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  // Extraer ruta relativa: /api/clients, /api/campaigns, etc.
  const path = event.path.replace('/.netlify/functions/api', '') || '/';
  const method = event.httpMethod;
  const params = event.queryStringParameters || {};
  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); } catch {}
  }

  // ── GET /clients ──────────────────────────────
  if (path === '/clients' && method === 'GET') {
    const { data, error } = await supabase.schema('signabanner')
      .from('clients').select('*, departments(*)');
    return error ? json({ error }, 500) : json(data);
  }

  // ── POST /clients ─────────────────────────────
  if (path === '/clients' && method === 'POST') {
    const { name, domain, slug, departments: depts } = body;
    const { data: client, error } = await supabase.schema('signabanner')
      .from('clients').insert({ name, domain, slug }).select().single();
    if (error) return json({ error }, 400);
    if (depts?.length) {
      await supabase.schema('signabanner').from('departments').insert(
        depts.map(d => ({
          client_id: client.id,
          name: d,
          slug: d.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-')
        }))
      );
    }
    // Devolver cliente con departamentos
    const { data: full } = await supabase.schema('signabanner')
      .from('clients').select('*, departments(*)').eq('id', client.id).single();
    return json(full);
  }

  // ── GET /campaigns ────────────────────────────
  if (path === '/campaigns' && method === 'GET') {
    let q = supabase.schema('signabanner').from('campaigns')
      .select('*, clients(name), departments(name)')
      .order('created_at', { ascending: false });
    if (params.client_id) q = q.eq('client_id', params.client_id);
    const { data, error } = await q;
    return error ? json({ error }, 500) : json(data);
  }

  // ── POST /campaigns ───────────────────────────
  if (path === '/campaigns' && method === 'POST') {
    const { data, error } = await supabase.schema('signabanner')
      .from('campaigns').insert(body).select().single();
    return error ? json({ error }, 400) : json(data);
  }

  // ── PATCH /campaigns/:id ──────────────────────
  const patchMatch = path.match(/^\/campaigns\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    const { data, error } = await supabase.schema('signabanner')
      .from('campaigns').update(body).eq('id', patchMatch[1]).select().single();
    return error ? json({ error }, 400) : json(data);
  }

  // ── GET /analytics/summary ────────────────────
  if (path === '/analytics/summary' && method === 'GET') {
    const days = parseInt(params.days || '30');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    let q = supabase.schema('signabanner').from('events')
      .select('event_type, employee_id').gte('created_at', since);
    if (params.client_id) q = q.eq('client_id', params.client_id);
    const { data } = await q;
    const loads  = data?.filter(e => e.event_type === 'load').length  || 0;
    const clicks = data?.filter(e => e.event_type === 'click').length || 0;
    const unique = new Set(data?.filter(e => e.employee_id).map(e => e.employee_id)).size;
    return json({ loads, clicks, ctr: loads ? ((clicks / loads) * 100).toFixed(1) : '0.0', unique_employees: unique });
  }

  // ── GET /analytics/events ─────────────────────
  if (path === '/analytics/events' && method === 'GET') {
    const limit = parseInt(params.limit || '50');
    let q = supabase.schema('signabanner').from('events')
      .select('*, campaigns(name), employees(name)')
      .order('created_at', { ascending: false }).limit(limit);
    if (params.client_id) q = q.eq('client_id', params.client_id);
    const { data, error } = await q;
    return error ? json({ error }, 500) : json(data);
  }

  // ── GET /analytics/campaigns ──────────────────
  if (path === '/analytics/campaigns' && method === 'GET') {
    const { data, error } = await supabase.schema('signabanner')
      .from('v_campaign_stats').select('*');
    return error ? json({ error }, 500) : json(data);
  }

  // ── GET /analytics/employees ──────────────────
  if (path === '/analytics/employees' && method === 'GET') {
    let q = supabase.schema('signabanner').from('v_employee_stats')
      .select('*').order('clicks', { ascending: false });
    if (params.client_id) q = q.eq('client_id', params.client_id);
    const { data, error } = await q;
    return error ? json({ error }, 500) : json(data);
  }

  return json({ error: 'Not found' }, 404);
};
