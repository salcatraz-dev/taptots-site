/**
 * Cloudflare Pages Function: POST /api/create-checkout
 *
 * Creates a Stripe Checkout Session for monthly subscription.
 * Returns { url } which the client redirects to.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_MONTHLY_PRICE_ID   (set here server-side — client never passes price_id)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SITE_URL
 *
 * Client sends: { plan, user_id, user_email }
 * plan can be "monthly" (only option for now; extend for annual later)
 *
 * Key fix vs v3: Stripe form-encoding is done correctly with URLSearchParams
 * for flat values and proper bracket notation for nested structures.
 * Arrays (line_items) are encoded as line_items[0][price] etc.
 */

export async function onRequestPost(context) {
  const { request, env } = context;
  const cors = makeCors(env.SITE_URL);

  let body;
  try { body = await request.json(); }
  catch { return jsonResp(400, { error: 'Invalid request body.' }, cors); }

  const { plan, user_id, user_email } = body;

  // Server-side validation — never trust client for price ID
  if (!user_id || !user_email) {
    return jsonResp(400, { error: 'user_id and user_email are required.' }, cors);
  }
  if (typeof user_email !== 'string' || !user_email.includes('@')) {
    return jsonResp(400, { error: 'Invalid user_email.' }, cors);
  }

  const stripeKey = (env.STRIPE_SECRET_KEY || '').trim();
  const priceId   = (env.STRIPE_MONTHLY_PRICE_ID || '').trim();
  const sbUrl     = (env.SUPABASE_URL || '').trim();
  const sbKey     = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const siteUrl   = (env.SITE_URL || 'https://playtaptots.com').trim();

  if (!stripeKey || !priceId) {
    return jsonResp(500, { error: 'Payment system is not configured.' }, cors);
  }
  if (!priceId.startsWith('price_')) {
    return jsonResp(500, { error: 'Invalid price configuration.' }, cors);
  }

  try {
    // ── Find or create Stripe customer ─────────────────────────────────────
    let customerId = null;

    if (sbUrl && sbKey) {
      const entList = await sbRest(sbUrl, sbKey, 'GET',
        '/rest/v1/entitlements?select=stripe_customer_id&user_id=eq.' + encodeURIComponent(user_id) + '&limit=1'
      );
      const ent = Array.isArray(entList) ? entList[0] : null;
      customerId = ent ? (ent.stripe_customer_id || null) : null;
    }

    if (!customerId) {
      // Search Stripe for existing customer with this email
      const searchRes = await stripeGet(stripeKey,
        '/v1/customers/search?query=' + encodeURIComponent('email:"' + user_email + '"') + '&limit=1'
      );
      if (searchRes.data && searchRes.data.length > 0) {
        customerId = searchRes.data[0].id;
      } else {
        // Create new customer
        const custRes = await stripePost(stripeKey, '/v1/customers', {
          email: user_email,
          'metadata[supabase_user_id]': user_id
        });
        if (!custRes.id) throw new Error('Stripe customer creation failed: ' + JSON.stringify(custRes));
        customerId = custRes.id;
      }

      // Persist to Supabase (non-critical — non-blocking)
      if (sbUrl && sbKey) {
        context.waitUntil(
          sbRest(sbUrl, sbKey, 'PATCH',
            '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(user_id),
            { stripe_customer_id: customerId }
          ).catch(function() {})
        );
      }
    }

    // ── Build Checkout session params ──────────────────────────────────────
    // Stripe form encoding for Checkout.Sessions.create
    // Arrays must use bracket notation: line_items[0][price], line_items[0][quantity]
    // Nested objects: subscription_data[metadata][key]
    const params = new URLSearchParams();
    params.append('customer',                              customerId);
    params.append('mode',                                  'subscription');
    params.append('line_items[0][price]',                  priceId);
    params.append('line_items[0][quantity]',               '1');
    params.append('success_url',                           siteUrl + '/play.html?upgraded=1&session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url',                            siteUrl + '/play.html');
    params.append('allow_promotion_codes',                 'true');
    params.append('billing_address_collection',            'auto');
    params.append('metadata[supabase_user_id]',            user_id);
    params.append('metadata[plan]',                        plan || 'monthly');
    params.append('subscription_data[metadata][supabase_user_id]', user_id);
    params.append('subscription_data[metadata][plan]',     plan || 'monthly');
    params.append('custom_text[submit][message]',
      'Your child gets instant, ad-free access to all TapTots learning games.');

    const sessionRes = await stripePostRaw(stripeKey, '/v1/checkout/sessions', params);

    if (sessionRes.error) {
      throw new Error('Stripe error: ' + sessionRes.error.message);
    }
    if (!sessionRes.url) {
      throw new Error('No URL in Stripe response: ' + JSON.stringify(sessionRes));
    }

    // Analytics (non-blocking)
    if (sbUrl && sbKey) {
      context.waitUntil(
        sbRest(sbUrl, sbKey, 'POST', '/rest/v1/events', {
          user_id,
          event_name: 'checkout_started',
          properties: { plan: plan || 'monthly', session_id: sessionRes.id }
        }).catch(function() {})
      );
    }

    return jsonResp(200, { url: sessionRes.url }, cors);

  } catch (err) {
    console.error('[create-checkout] Error:', err.message);
    return jsonResp(500, { error: 'Could not start checkout. Please try again.' }, cors);
  }
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: makeCors(context.env.SITE_URL) });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// GET request to Stripe
async function stripeGet(key, path) {
  const res = await fetch('https://api.stripe.com' + path, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + key }
  });
  return res.json();
}

// POST to Stripe with a plain flat object (auto-serialised with URLSearchParams)
async function stripePost(key, path, flatObj) {
  const p = new URLSearchParams();
  for (const k in flatObj) {
    if (Object.prototype.hasOwnProperty.call(flatObj, k)) {
      p.append(k, String(flatObj[k]));
    }
  }
  return stripePostRaw(key, path, p);
}

// POST to Stripe with a pre-built URLSearchParams
async function stripePostRaw(key, path, params) {
  const res = await fetch('https://api.stripe.com' + path, {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });
  return res.json();
}

// Supabase REST
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
  const text = await res.text().catch(function() { return ''; });
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
