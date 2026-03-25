/**
 * Cloudflare Pages Function: POST /api/stripe-webhook
 *
 * Handles Stripe webhook events and keeps Supabase entitlements in sync.
 *
 * Register in Stripe Dashboard > Developers > Webhooks:
 *   URL:    https://playtaptots.com/api/stripe-webhook
 *   Events: checkout.session.completed
 *           customer.subscription.updated
 *           customer.subscription.deleted
 *           invoice.payment_failed
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET   (whsec_xxx from Stripe Dashboard)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * IMPORTANT: Cloudflare Workers must read raw bytes for Stripe signature
 * verification. We use Web Crypto (crypto.subtle) — no Node.js crypto module.
 */

export async function onRequestPost(context) {
  const { request, env } = context;

  // ── Read raw bytes — required for Stripe signature verification ────────────
  const rawBytes = await request.arrayBuffer();
  const rawBody  = new TextDecoder().decode(rawBytes);
  const sigHeader = request.headers.get('stripe-signature') || '';

  if (!sigHeader) {
    return new Response('Missing Stripe-Signature header', { status: 400 });
  }

  // ── Verify signature ───────────────────────────────────────────────────────
  let event;
  try {
    event = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err.message);
    return new Response('Signature verification failed', { status: 401 });
  }

  const sbUrl = (env.SUPABASE_URL               || '').trim();
  const sbKey = (env.SUPABASE_SERVICE_ROLE_KEY   || '').trim();

  try {
    switch (event.type) {

      // ── New subscription purchased ──────────────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;

        const userId = session.metadata && session.metadata.supabase_user_id;
        if (!userId) { console.warn('[webhook] No supabase_user_id in session metadata'); break; }

        // Determine plan interval (monthly vs annual)
        let planLabel = (session.metadata && session.metadata.plan) || 'monthly';
        if (session.subscription) {
          try {
            const sub = await stripeGet(env.STRIPE_SECRET_KEY, '/v1/subscriptions/' + session.subscription);
            const interval = sub.items && sub.items.data[0] && sub.items.data[0].price.recurring.interval;
            planLabel = interval === 'year' ? 'annual' : 'monthly';
          } catch (e) { /* keep metadata plan */ }
        }

        await sbRest(sbUrl, sbKey, 'PATCH',
          '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(userId), {
            is_paid:                true,
            stripe_customer_id:     session.customer,
            stripe_subscription_id: session.subscription,
            plan:                   planLabel
          }
        );

        context.waitUntil(trackEvent(sbUrl, sbKey, userId, 'subscription_started', { plan: planLabel }).catch(function(){}));

        // Upgrade confirmation email
        if (env.SENDGRID_API_KEY) {
          const email = session.customer_details && session.customer_details.email;
          if (email) context.waitUntil(sendUpgradeEmail(env, email, planLabel).catch(function(){}));
        }
        break;
      }

      // ── Subscription changed (renewal, plan change, etc.) ───────────────────
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const userId = await userIdFromCustomer(sbUrl, sbKey, sub.customer);
        if (!userId) break;

        const isActive = sub.status === 'active' || sub.status === 'trialing';
        const interval = sub.items && sub.items.data[0] && sub.items.data[0].price.recurring.interval;
        const plan     = isActive ? (interval === 'year' ? 'annual' : 'monthly') : 'free';

        await sbRest(sbUrl, sbKey, 'PATCH',
          '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(userId), {
            is_paid:                isActive,
            stripe_subscription_id: sub.id,
            plan
          }
        );

        context.waitUntil(
          trackEvent(sbUrl, sbKey, userId, 'subscription_updated', { status: sub.status, plan }).catch(function(){})
        );

        // past_due = payment failing — send failure email
        if (sub.status === 'past_due' && env.SENDGRID_API_KEY) {
          const cust = await stripeGet(env.STRIPE_SECRET_KEY, '/v1/customers/' + sub.customer).catch(function(){return {};});
          if (cust.email) context.waitUntil(sendPaymentFailedEmail(env, cust.email).catch(function(){}));
        }
        break;
      }

      // ── Subscription cancelled ──────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const userId = await userIdFromCustomer(sbUrl, sbKey, sub.customer);
        if (!userId) break;

        await sbRest(sbUrl, sbKey, 'PATCH',
          '/rest/v1/entitlements?user_id=eq.' + encodeURIComponent(userId), {
            is_paid: false, plan: 'free'
          }
        );

        context.waitUntil(
          trackEvent(sbUrl, sbKey, userId, 'subscription_cancelled',
            { reason: sub.cancellation_details && sub.cancellation_details.reason }
          ).catch(function(){})
        );
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const userId  = await userIdFromCustomer(sbUrl, sbKey, invoice.customer);

        context.waitUntil(
          trackEvent(sbUrl, sbKey, userId || null, 'payment_failed', {
            invoice_id:    invoice.id,
            attempt_count: invoice.attempt_count
          }).catch(function(){})
        );

        if (env.SENDGRID_API_KEY && invoice.customer_email) {
          context.waitUntil(sendPaymentFailedEmail(env, invoice.customer_email).catch(function(){}));
        }
        break;
      }

      default:
        // Unhandled events are fine — just acknowledge
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[stripe-webhook] Handler error:', err.message);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// =============================================================================
// Stripe signature verification — Web Crypto HMAC-SHA256 (no Node crypto)
// =============================================================================
async function verifyStripeSignature(payload, sigHeader, secret) {
  // Parse header: t=timestamp,v1=sig1,v1=sig2,...
  const parts = {};
  sigHeader.split(',').forEach(function(part) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx);
      const v = part.slice(idx + 1);
      if (!parts[k]) parts[k] = [];
      parts[k].push(v);
    }
  });

  const timestamp  = parts.t && parts.t[0];
  const signatures = parts.v1 || [];

  if (!timestamp || !signatures.length) throw new Error('Invalid signature header');

  // Reject events older than 5 minutes
  const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (age > 300) throw new Error('Timestamp too old: ' + age + 's');

  const signedPayload = timestamp + '.' + payload;
  const enc = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuf))
    .map(function(b) { return b.toString(16).padStart(2, '0'); })
    .join('');

  const valid = signatures.some(function(sig) { return sig === expected; });
  if (!valid) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}

// =============================================================================
// Helpers
// =============================================================================

async function userIdFromCustomer(sbUrl, sbKey, customerId) {
  if (!sbUrl || !sbKey || !customerId) return null;
  const res = await sbRest(sbUrl, sbKey, 'GET',
    '/rest/v1/entitlements?select=user_id&stripe_customer_id=eq.' + encodeURIComponent(customerId) + '&limit=1'
  ).catch(function() { return null; });
  return Array.isArray(res) && res[0] ? res[0].user_id : null;
}

async function trackEvent(sbUrl, sbKey, userId, name, props) {
  if (!sbUrl || !sbKey) return;
  return sbRest(sbUrl, sbKey, 'POST', '/rest/v1/events', {
    user_id:    userId || null,
    event_name: name,
    properties: props || {}
  });
}

async function sbRest(url, key, method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: {
      'apikey':        key,
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text().catch(function() { return ''; });
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

async function stripeGet(key, path) {
  const res = await fetch('https://api.stripe.com' + path, {
    headers: { 'Authorization': 'Bearer ' + key }
  });
  return res.json().catch(function() { return {}; });
}

async function sendUpgradeEmail(env, toEmail, plan) {
  const siteUrl = env.SITE_URL || 'https://playtaptots.com';
  const planText = plan === 'annual' ? '$39/year' : '$4.99/month';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from:    { email: env.SENDGRID_FROM || 'hello@playtaptots.com', name: 'TapTots' },
      subject: 'All Access is active — welcome to TapTots',
      content: [{ type: 'text/html', value:
        '<div style="font-family:sans-serif;max-width:480px;margin:0 auto">' +
        '<div style="background:#16361a;padding:24px;text-align:center"><h1 style="color:#f3d247;margin:0">TapTots</h1></div>' +
        '<div style="padding:24px"><h2>All Access is active (' + planText + ')</h2>' +
        '<p>Every game, every level, and every new game we add is now unlocked for your child.</p>' +
        '<a href="' + siteUrl + '/play.html" style="display:block;text-align:center;background:#f3d247;color:#111;font-weight:900;padding:14px;border-radius:12px;text-decoration:none">Open the Games</a>' +
        '<p style="color:#999;font-size:12px;margin-top:16px">To cancel, reply to this email.</p></div></div>'
      }]
    })
  });
}

async function sendPaymentFailedEmail(env, toEmail) {
  const siteUrl = env.SITE_URL || 'https://playtaptots.com';
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.SENDGRID_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from:    { email: env.SENDGRID_FROM || 'hello@playtaptots.com', name: 'TapTots' },
      subject: 'Action needed: TapTots payment failed',
      content: [{ type: 'text/html', value:
        '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
        '<h2>We could not process your payment</h2>' +
        '<p>There was an issue charging your card for TapTots. Please update your payment method to keep your child playing.</p>' +
        '<a href="' + siteUrl + '" style="display:inline-block;background:#f3d247;color:#111;font-weight:900;padding:12px 22px;border-radius:12px;text-decoration:none">Update Payment</a>' +
        '<p style="color:#999;font-size:12px;margin-top:16px">Reply to this email if you need help.</p></div>'
      }]
    })
  });
}
