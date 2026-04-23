import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const EMPTY_PNG = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
), c => c.charCodeAt(0));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function cors(body, init = {}) {
  return new Response(body, { ...init, headers: { ...CORS, ...(init.headers || {}) } });
}
function json(data, status = 200) {
  return cors(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function geolocate(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168')) return {};
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,org`, { signal: AbortSignal.timeout(800) });
    const d = await res.json();
    return { country: d.country || null, city: d.city || null, company_name: d.org || null };
  } catch { return {}; }
}

async function getActiveCampaign(clientSlug, deptSlug) {
  const now = new Date().toISOString();
  const { data: client } = await supabase.schema('signabanner').from('clients').select('id').eq('slug', clientSlug).single();
  if (!client) return null;
  let deptId = null;
  if (deptSlug) {
    const { data: dept } = await supabase.schema('signabanner').from('departments').select('id').eq('client_id', client.id).eq('slug', deptSlug).single();
    if (dept) deptId = dept.id;
  }
  for (const targetDept of (deptId ? [deptId, null] : [null])) {
    let q = supabase.schema('signabanner').from('campaigns')
      .select('id, image_url, destination_url, ends_at, client_id, department_id')
      .eq('client_id', client.id).eq('active', true).lte('starts_at', now)
      .order('starts_at', { ascending: false }).limit(1);
    q = targetDept === null ? q.is('department_id', null) : q.eq('department_id', targetDept);
    const { data } = await q;
    if (data && data.length > 0) {
      const c = data[0];
      if (!c.ends_at || new Date(c.ends_at) > new Date()) return { ...c, client_id: client.id, dept_id: deptId };
    }
  }
  return null;
}

async function resolveEmployeeId(clientId, slug) {
  if (!slug) return null;
  const { data } = await supabase.schema('signabanner').from('employees').select('id').eq('client_id', clientId).eq('slug', slug).single();
  return data?.id || null;
}

async function logEvent(payload) {
  const geo = await geolocate(payload.ip);
  await supabase.schema('signabanner').from('events').insert({ ...payload, ...geo, created_at: new Date().toISOString() });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(null, { status: 200 });
  const url = new URL(req.url);
  const path = url.pathname.replace('/signabanner', '');
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || '0.0.0.0';
  const userAgent = req.headers.get('user-agent') || null;
  const referer = req.headers.get('referer') || null;

  const bannerMatch = path.match(/^\/b\/([^/]+?)(?:\/([^/]+?))?\.png$/);
  if (bannerMatch) {
    const [, clientSlug, deptSlug] = bannerMatch;
    const campaign = await getActiveCampaign(clientSlug, deptSlug || null);
    const imgHeaders = { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...CORS };
    if (!campaign) return new Response(EMPTY_PNG, { headers: imgHeaders });
    const empSlug = url.searchParams.get('u');
    logEvent({ campaign_id: campaign.id, client_id: campaign.client_id, employee_id: await resolveEmployeeId(campaign.client_id, empSlug), event_type: 'load', ip, user_agent: userAgent, referer });
    try {
      const imgRes = await fetch(campaign.image_url, { signal: AbortSignal.timeout(3000) });
      return new Response(await imgRes.arrayBuffer(), { headers: imgHeaders });
    } catch { return new Response(EMPTY_PNG, { headers: imgHeaders }); }
  }

  const clickMatch = path.match(/^\/click\/([^/]+?)(?:\/([^/?]+))?$/);
  if (clickMatch) {
    const [, clientSlug, deptSlug] = clickMatch;
    const campaign = await getActiveCampaign(clientSlug, deptSlug || null);
    if (!campaign) return cors('Not found', { status: 404 });
    logEvent({ campaign_id: campaign.id, client_id: campaign.client_id, employee_id: await resolveEmployeeId(campaign.client_id, url.searchParams.get('u')), event_type: 'click', ip, user_agent: userAgent, referer });
    const dest = new URL(campaign.destination_url);
    dest.searchParams.set('utm_source', 'firma_email');
    dest.searchParams.set('utm_medium', 'email');
    dest.searchParams.set('utm_campaign', clientSlug);
    if (deptSlug) dest.searchParams.set('utm_content', deptSlug);
    return Response.redirect(dest.toString(), 302);
  }

  if (path === '/api/clients') {
    if (req.method === 'GET') {
      const { data, error } = await supabase.schema('signabanner').from('clients').select('*, departments(*)');
      return error ? json({ error }, 500) : json(data);
    }
    if (req.method === 'POST') {
      const { name, domain, slug, departments: depts } = await req.json();
      const { data: client, error } = await supabase.schema('signabanner').from('clients').insert({ name, domain, slug }).select().single();
      if (error) return json({ error }, 400);
      if (depts?.length) {
        await supabase.schema('signabanner').from('departments').insert(
          depts.map((d) => ({ client_id: client.id, name: d, slug: d.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g, '-') }))
        );
      }
      return json(client);
    }
  }

  if (path === '/api/campaigns') {
    if (req.method === 'GET') {
      const clientId = url.searchParams.get('client_id');
      let q = supabase.schema('signabanner').from('campaigns').select('*, clients(name), departments(name)').order('created_at', { ascending: false });
      if (clientId) q = q.eq('client_id', clientId);
      const { data, error } = await q;
      return error ? json({ error }, 500) : json(data);
    }
    if (req.method === 'POST') {
      const body = await req.json();
      const { data, error } = await supabase.schema('signabanner').from('campaigns').insert(body).select().single();
      return error ? json({ error }, 400) : json(data);
    }
  }

  const patchMatch = path.match(/^\/api\/campaigns\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const body = await req.json();
    const { data, error } = await supabase.schema('signabanner').from('campaigns').update(body).eq('id', patchMatch[1]).select().single();
    return error ? json({ error }, 400) : json(data);
  }

  if (path === '/api/analytics/summary') {
    const clientId = url.searchParams.get('client_id');
    const days = parseInt(url.searchParams.get('days') || '30');
    const since = new Date(Date.now() - days * 86400000).toISOString();
    let q = supabase.schema('signabanner').from('events').select('event_type, employee_id').gte('created_at', since);
    if (clientId) q = q.eq('client_id', clientId);
    const { data } = await q;
    const loads  = data?.filter((e) => e.event_type === 'load').length  || 0;
    const clicks = data?.filter((e) => e.event_type === 'click').length || 0;
    const unique = new Set(data?.filter((e) => e.employee_id).map((e) => e.employee_id)).size;
    return json({ loads, clicks, ctr: loads ? ((clicks / loads) * 100).toFixed(1) : '0.0', unique_employees: unique });
  }

  if (path === '/api/analytics/events') {
    const clientId = url.searchParams.get('client_id');
    const limit = parseInt(url.searchParams.get('limit') || '50');
    let q = supabase.schema('signabanner').from('events').select('*, campaigns(name), employees(name)').order('created_at', { ascending: false }).limit(limit);
    if (clientId) q = q.eq('client_id', clientId);
    const { data, error } = await q;
    return error ? json({ error }, 500) : json(data);
  }

  if (path === '/api/analytics/campaigns') {
    const { data, error } = await supabase.schema('signabanner').from('v_campaign_stats').select('*');
    return error ? json({ error }, 500) : json(data);
  }

  if (path === '/api/analytics/employees') {
    const clientId = url.searchParams.get('client_id');
    let q = supabase.schema('signabanner').from('v_employee_stats').select('*').order('clicks', { ascending: false });
    if (clientId) q = q.eq('client_id', clientId);
    const { data, error } = await q;
    return error ? json({ error }, 500) : json(data);
  }

  return cors('Not found', { status: 404 });
});
