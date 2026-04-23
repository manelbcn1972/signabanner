// netlify/functions/click.js
// Registra clic y redirige a la URL de destino
// URL: /.netlify/functions/click?c=client-slug&d=dept-slug&u=empleado-slug

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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
      .select('id, destination_url, ends_at, client_id')
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
  const { c: clientSlug, d: deptSlug, u: empSlug } = event.queryStringParameters || {};
  if (!clientSlug) return { statusCode: 400, body: 'Missing client slug' };

  const campaign = await getActiveCampaign(clientSlug, deptSlug || null);
  if (!campaign) return { statusCode: 404, body: 'No active campaign' };

  // Log clic
  const ip = event.headers['x-forwarded-for']?.split(',')[0].trim() || '0.0.0.0';
  const employeeId = await resolveEmp(campaign.client_id, empSlug || null);
  const geo = await geolocate(ip);
  await supabase.schema('signabanner').from('events').insert({
    campaign_id: campaign.id, client_id: campaign.client_id,
    employee_id: employeeId, event_type: 'click',
    ip, user_agent: event.headers['user-agent'] || null,
    referer: event.headers['referer'] || null, ...geo,
    created_at: new Date().toISOString()
  });

  // Redirigir con UTMs
  const dest = new URL(campaign.destination_url);
  dest.searchParams.set('utm_source', 'firma_email');
  dest.searchParams.set('utm_medium', 'email');
  dest.searchParams.set('utm_campaign', clientSlug);
  if (deptSlug) dest.searchParams.set('utm_content', deptSlug);

  return { statusCode: 302, headers: { Location: dest.toString() }, body: '' };
};
