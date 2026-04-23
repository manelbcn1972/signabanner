// netlify/functions/b.js
// Sirve el banner activo para un cliente/departamento
// URL: /.netlify/functions/b?c=client-slug&d=dept-slug&u=empleado-slug

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const EMPTY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function geolocate(ip) {
  if (!ip || ip === '127.0.0.1' || ip.startsWith('192.168')) return {};
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=country,city,org`);
    const d = await res.json();
    return { country: d.country || null, city: d.city || null, company_name: d.org || null };
  } catch { return {}; }
}

async function getActiveCampaign(clientSlug, deptSlug) {
  const now = new Date().toISOString();
  const { data: client } = await supabase.schema('signabanner').from('clients')
    .select('id').eq('slug', clientSlug).single();
  if (!client) return null;

  let deptId = null;
  if (deptSlug) {
    const { data: dept } = await supabase.schema('signabanner').from('departments')
      .select('id').eq('client_id', client.id).eq('slug', deptSlug).single();
    if (dept) deptId = dept.id;
  }

  for (const td of (deptId ? [deptId, null] : [null])) {
    let q = supabase.schema('signabanner').from('campaigns')
      .select('id, image_url, destination_url, ends_at, client_id')
      .eq('client_id', client.id).eq('active', true).lte('starts_at', now)
      .order('starts_at', { ascending: false }).limit(1);
    q = td === null ? q.is('department_id', null) : q.eq('department_id', td);
    const { data } = await q;
    if (data?.length > 0) {
      const c = data[0];
      if (!c.ends_at || new Date(c.ends_at) > new Date())
        return { ...c, client_id: client.id, dept_id: deptId };
    }
  }
  return null;
}

async function resolveEmp(clientId, slug) {
  if (!slug) return null;
  const { data } = await supabase.schema('signabanner').from('employees')
    .select('id').eq('client_id', clientId).eq('slug', slug).single();
  return data?.id || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };

  const { c: clientSlug, d: deptSlug, u: empSlug } = event.queryStringParameters || {};
  if (!clientSlug) return { statusCode: 400, headers: CORS, body: 'Missing client slug' };

  const campaign = await getActiveCampaign(clientSlug, deptSlug || null);
  const imgHeaders = { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache, no-store, must-revalidate', ...CORS };

  if (!campaign) {
    // Buscar imagen de fallback del cliente
    const { data: clientData } = await supabase.schema('signabanner')
      .from('clients').select('fallback_image_url').eq('slug', clientSlug).single();
    
    if (clientData?.fallback_image_url) {
      try {
        const fallbackRes = await fetch(clientData.fallback_image_url, { signal: AbortSignal.timeout(3000) });
        const fallbackBuf = Buffer.from(await fallbackRes.arrayBuffer());
        return { statusCode: 200, headers: imgHeaders, body: fallbackBuf.toString('base64'), isBase64Encoded: true };
      } catch {
        // Si falla el fallback, pixel transparente
      }
    }
    return { statusCode: 200, headers: imgHeaders, body: EMPTY_PNG.toString('base64'), isBase64Encoded: true };
  }

  // Log evento (async, no bloqueante)
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || '0.0.0.0';
  resolveEmp(campaign.client_id, empSlug || null).then(employeeId => {
    geolocate(ip).then(geo => {
      supabase.schema('signabanner').from('events').insert({
        campaign_id: campaign.id, client_id: campaign.client_id,
        employee_id: employeeId, event_type: 'load',
        ip, user_agent: event.headers['user-agent'] || null,
        referer: event.headers['referer'] || null, ...geo,
        created_at: new Date().toISOString()
      });
    });
  });

  try {
    const imgRes = await fetch(campaign.image_url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { statusCode: 200, headers: imgHeaders, body: buf.toString('base64'), isBase64Encoded: true };
  } catch {
    return { statusCode: 200, headers: imgHeaders, body: EMPTY_PNG.toString('base64'), isBase64Encoded: true };
  }
};
