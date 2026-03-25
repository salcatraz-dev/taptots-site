/**
 * Cloudflare Pages Function: POST /api/start-trial
 *
 * Creates or finds a Supabase user and sets up a 7-day trial entitlement.
 * Called by auth.js ttStartTrial() after the magic-link OTP is already sent.
 *
 * Required env vars (Cloudflare Dashboard > Settings > Environment Variables):
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  service_role key (NOT anon)
 *   SITE_URL                   https://playtaptots.com
 *
 * Optional:
 *   SENDGRID_API_KEY
 *   SENDGRID_FROM
 */

const TRIAL_DAYS  = 7;
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms
const RATE_MAX    = 8;               // max signup attempts per IP per hour

export async function onRequestPost(context) {
  const { request, env } = context;

  const cors = makeCors(env.SITE_URL);

  // ── Parse request ──────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return jsonResp(400, { error: 'Invalid JSON body.' }, cors); }

  const email     = ((body.email     || '') + '').trim().toLowerCase();
  const child_age = ((body.child_age || '') + '').trim().slice(0, 20);

  if (!isValidEmail(email)) {
    return jsonResp(400, { error: 'A valid email address is required.' }, cors);
  }

  const sbUrl = (env.SUPABASE_URL     || '').trim();
  const sbKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!sbUrl || !sbKey) {
    return jsonResp(500, { error: 'Server configuration error.' }, cors);
  }

  // ── IP-based rate limit ────────────────────────────────────────────────────
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').split(',')[0].trim();
  try {
    const since = new Date(Date.now() - RATE_WINDOW).toISOString();
    const rateRes = await sbRest(sbUrl, sbKey, 'GET',
      `/rest/v1/events?select=id&event_name=eq.trial_signup_attempt&properties->>ip=eq.${encodeURIComponent(ip)}&created_at=gte.${encodeURIComponent(since)}`
    );
    if (Array.isArray(rateRes) && rateRes.length >= RATE_MAX) {
      return jsonResp(429, { error: 'Too many requests. Please try again in an hour.' }, cors);
    }
  } catch (e) { /* rate limit check failed — allow through */ }

  // Log attempt (non-blocking — don't await)
  context.waitUntil(
    sbRest(sbUrl, sbKey, 'POST', '/rest/v1/events', {
      user_id:    null,
      event_name: 'trial_signup_attempt',
      properties: { ip, email_domain: email.split('@')[1] || '' }
    }).catch(function() {})
  );

  try {
    // ── Find or create auth user ───────────────────────────────────────────
    let userId;

    // Search existing users (page 1, up to 1000 — Supabase admin)
    const listRes = await supabaseAdmin(sbUrl, sbKey, 'GET', '/auth/v1/admin/users?page=1&per_page=1000');
    const users   = (listRes && listRes.users) ? listRes.users : [];
    const match   = users.find(function(u) { return u.email === email; });

    if (match) {
      userId = match.id;
    } else {
      const created = await supabaseAdmin(sbUrl, sbKey, 'POST', '/auth/v1/admin/users', {
        email,
        email_confirm: true,
        user_metadata: { child_age }
      });
      if (!created || !created.id) {
        throw new Error('Failed to create user: ' + JSON.stringify(created));
      }
      userId = created.id;
    }

    // ── Upsert public.users row ────────────────────────────────────────────
    await sbRest(sbUrl, sbKey, 'POST', '/rest/v1/users',
      { id: userId, email, child_age },
      { 'Prefer': 'resolution=merge-duplicates,return=minimal' }
    );

    // ── Check for existing entitlement ─────────────────────────────────────
    const entList = await sbRest(sbUrl, sbKey, 'GET',
      `/rest/v1/entitlements?select=*&user_id=eq.${userId}&limit=1`
    );
    const existing = Array.isArray(entList) ? entList[0] : null;

    let trialEnd, isNew = false;

    if (existing) {
      // Never reset a trial that was already granted
      trialEnd = existing.trial_end_date;
    } else {
      isNew    = true;
      trialEnd = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString();
      await sbRest(sbUrl, sbKey, 'POST', '/rest/v1/entitlements', {
        user_id:        userId,
        trial_end_date: trialEnd,
        is_paid:        false,
        plan:           'trial'
      });
      // Welcome email (non-blocking)
      if (env.SENDGRID_API_KEY) {
        context.waitUntil(sendWelcomeEmail(env, email).catch(function() {}));
      }
    }

    // Analytics (non-blocking)
    context.waitUntil(
      sbRest(sbUrl, sbKey, 'POST', '/rest/v1/events', {
        user_id:    userId,
        event_name: isNew ? 'trial_started' : 'trial_resumed',
        properties: { child_age, source: 'web' }
      }).catch(function() {})
    );

    return jsonResp(200, {
      ok:          true,
      user_id:     userId,
      trial_end:   trialEnd,
      is_new:      isNew,
      is_paid:     existing ? !!existing.is_paid : false
    }, cors);

  } catch (err) {
    console.error('[start-trial] Unhandled error:', err);
    return jsonResp(500, { error: 'Something went wrong. Please try again.' }, cors);
  }
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: makeCors(context.env.SITE_URL) });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(e) {
  return typeof e === 'string' && e.length > 3 && e.length < 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

function makeCors(siteUrl) {
  return {
    'Access-Control-Allow-Origin':  siteUrl || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json'
  };
}

function jsonResp(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers: headers || { 'Content-Type': 'application/json' } });
}

// Supabase REST API (for tables)
async function sbRest(url, key, method, path, body, extraHeaders) {
  const headers = Object.assign({
    'apikey':        key,
    'Authorization': 'Bearer ' + key,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation'
  }, extraHeaders || {});

  const res = await fetch(url + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok && res.status !== 409) {
    const t = await res.text().catch(function() { return ''; });
    throw new Error('Supabase REST ' + method + ' ' + path + ' → ' + res.status + ': ' + t);
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Supabase Auth Admin API (for auth.users)
async function supabaseAdmin(url, key, method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: {
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function sendWelcomeEmail(env, toEmail) {
  const siteUrl = env.SITE_URL || 'https://playtaptots.com';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.SENDGRID_API_KEY,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from:    { email: env.SENDGRID_FROM || 'hello@playtaptots.com', name: 'TapTots' },
      subject: 'Your TapTots free trial is ready',
      content: [{ type: 'text/html', value: welcomeHtml(siteUrl) }]
    })
  });
}

function welcomeHtml(siteUrl) {
  return '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden">' +
    '<div style="background:#16361a;padding:28px 24px;text-align:center">' +
    '<h1 style="color:#f3d247;font-size:26px;margin:0">TapTots</h1>' +
    '<p style="color:rgba(255,255,255,.7);font-size:14px;margin:6px 0 0">Safe learning games for kids</p></div>' +
    '<div style="padding:28px 24px">' +
    '<h2 style="color:#1a1a1a;font-size:20px;margin:0 0 10px">Your 7-day free trial is ready!</h2>' +
    '<p style="color:#555;line-height:1.6;margin:0 0 20px">No ads. No junk content. Just safe, joyful learning games your child will love.</p>' +
    '<a href="' + siteUrl + '/play.html" style="display:block;text-align:center;background:#f3d247;color:#111;font-weight:900;padding:16px;border-radius:12px;text-decoration:none;font-size:17px">Open the Games</a>' +
    '<p style="color:#999;font-size:12px;margin-top:20px">After 7 days, continue for $4.99/month. Cancel any time before then.</p>' +
    '</div></div>';
}
