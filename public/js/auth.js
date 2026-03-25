/**
 * TapTots auth.js v4
 * ─────────────────────────────────────────────────────────────────
 * Shared authentication, entitlement, and progress layer.
 * Loaded by: index.html, play.html, and every game file.
 *
 * SETUP — edit the four values in TAPTOTS_CONFIG below:
 *
 *   supabaseUrl        Your Supabase project URL
 *                      e.g. https://abcdefgh.supabase.co
 *
 *   supabaseAnonKey    Your Supabase anon/public key
 *                      Found in: Supabase Dashboard > Settings > API
 *
 *   stripeMonthlyPrice Your Stripe Price ID for $4.99/month
 *                      e.g. price_1ABC123...
 *
 *   (Annual plan is optional and can be added later)
 *
 * That is all. Everything else is automatic.
 * ─────────────────────────────────────────────────────────────────
 */

// =============================================================================
// CONFIG — FILL IN THESE VALUES
// =============================================================================
var TAPTOTS_CONFIG = {
  supabaseUrl:         'YOUR_SUPABASE_URL',
  supabaseAnonKey:     'YOUR_SUPABASE_ANON_KEY',
  stripeMonthlyPrice:  'YOUR_STRIPE_MONTHLY_PRICE_ID',
  stripeAnnualPrice:   '',            // optional — leave blank if not offering annual yet
  trialDays:           7,
  apiBase:             '/api'         // Cloudflare Pages Functions path — do not change
};
// =============================================================================

// ─── Config guard — warns in console when still on placeholders ──────────────
var _ttConfigured = (
  TAPTOTS_CONFIG.supabaseUrl    !== 'YOUR_SUPABASE_URL' &&
  TAPTOTS_CONFIG.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY'
);
if (!_ttConfigured) {
  console.warn(
    '[TapTots] auth.js: Supabase credentials are not set.\n' +
    'Open auth.js and fill in supabaseUrl and supabaseAnonKey.\n' +
    'Auth features will be skipped until configured.'
  );
}

// ─── No-flash: body starts invisible, revealed after auth resolves ────────────
(function() {
  var s = document.createElement('style');
  s.id = 'tt-noflash';
  s.textContent = 'body { opacity: 0 !important; }';
  document.head.appendChild(s);
})();

function _ttReveal() {
  var s = document.getElementById('tt-noflash');
  if (s) { s.remove(); }
  document.body.style.transition = 'opacity 0.15s ease';
  document.body.style.opacity = '1';
}

// ─── Supabase client ──────────────────────────────────────────────────────────
var _sb = null;
function _getSB() {
  if (!_ttConfigured) return null;
  if (!_sb && typeof supabase !== 'undefined') {
    _sb = supabase.createClient(TAPTOTS_CONFIG.supabaseUrl, TAPTOTS_CONFIG.supabaseAnonKey);
  }
  return _sb;
}

// ─── State ────────────────────────────────────────────────────────────────────
var _session     = null;
var _user        = null;    // { id, email }
var _ent         = null;    // entitlement row from DB
var _authReady   = false;
var _entError    = false;   // true only on a real network/DB error (not "no row found")
var _entMissing  = false;   // true when signed in but no entitlement row exists yet

// ─── Init ─────────────────────────────────────────────────────────────────────
function ttAuthInit(onReady) {
  var sb = _getSB();
  if (!sb) {
    _authReady = true;
    _ttReveal();
    if (typeof onReady === 'function') onReady();
    return;
  }

  // Resolve session first, then load entitlement, then reveal
  sb.auth.getSession().then(function(res) {
    var sess = res && res.data && res.data.session;
    if (sess) {
      _session = sess;
      _user    = { id: sess.user.id, email: sess.user.email };
    }
    _authReady = true;
    _loadEnt(function() {
      _ttReveal();
      if (typeof onReady === 'function') onReady();
    });
  }).catch(function(err) {
    console.warn('[TapTots] getSession error:', err.message);
    _authReady = true;
    _ttReveal();
    if (typeof onReady === 'function') onReady();
  });

  // Listen for sign-in / sign-out events (e.g. magic link click)
  sb.auth.onAuthStateChange(function(event, sess) {
    if (event === 'TOKEN_REFRESHED') {
      if (sess) _session = sess;
      return; // silent — don't re-render
    }
    if (event === 'SIGNED_OUT' || !sess) {
      _session = _user = _ent = null;
      _entError = _entMissing = false;
    } else if (event === 'SIGNED_IN') {
      _session = sess;
      _user    = { id: sess.user.id, email: sess.user.email };
    }
    if (_authReady) {
      _loadEnt(function() {
        if (typeof window.ttOnAuthChange === 'function') window.ttOnAuthChange();
      });
    }
  });
}

function _loadEnt(cb) {
  if (!_user) {
    _ent = null; _entError = _entMissing = false;
    if (typeof cb === 'function') cb();
    return;
  }
  var sb = _getSB();
  if (!sb) { if (typeof cb === 'function') cb(); return; }

  sb.from('entitlements')
    .select('*')
    .eq('user_id', _user.id)
    .maybeSingle()
    .then(function(res) {
      if (res.error) {
        console.warn('[TapTots] entitlement load error:', res.error.message);
        _entError = true; _entMissing = false; _ent = null;
      } else if (!res.data) {
        _entMissing = true; _entError = false; _ent = null;
      } else {
        _ent = res.data; _entError = _entMissing = false;
      }
      if (typeof cb === 'function') cb();
    })
    .catch(function(err) {
      console.warn('[TapTots] entitlement fetch exception:', err.message);
      _entError = true; _entMissing = false; _ent = null;
      if (typeof cb === 'function') cb();
    });
}

// ─── Entitlement accessors ────────────────────────────────────────────────────

/** Returns true if user may play (trial active OR paid) */
function ttIsAllowed() {
  if (!_user || _entError || !_ent) return false;
  if (_ent.is_paid) return true;
  if (_ent.trial_end_date) return new Date() < new Date(_ent.trial_end_date);
  return false;
}

/** True if currently in an active free trial */
function ttTrialActive() {
  if (!_ent || _ent.is_paid || !_ent.trial_end_date) return false;
  return new Date() < new Date(_ent.trial_end_date);
}

/** True if trial was started but has now expired */
function ttTrialExpired() {
  if (!_user || !_ent || _ent.is_paid) return false;
  if (!_ent.trial_end_date) return !!_entMissing;
  return new Date() >= new Date(_ent.trial_end_date);
}

/** True if has an active paid subscription */
function ttIsPaid() { return !!(_ent && _ent.is_paid); }

/** Days remaining in trial, 0 if expired or not in trial */
function ttTrialDaysLeft() {
  if (!_ent || !_ent.trial_end_date) return 0;
  return Math.max(0, Math.ceil((new Date(_ent.trial_end_date) - new Date()) / 86400000));
}

function ttCurrentUser()   { return _user; }
function ttEntError()      { return _entError; }
function ttEntMissing()    { return _entMissing; }
function ttIsConfigured()  { return _ttConfigured; }

// ─── Trial signup ─────────────────────────────────────────────────────────────
function ttStartTrial(email, childAge, onSuccess, onError) {
  if (!_ttConfigured) {
    if (typeof onError === 'function') onError('TapTots is not yet connected to a database.');
    return;
  }
  var sb = _getSB();
  if (!sb) { if (typeof onError === 'function') onError('Auth not available.'); return; }

  // 1. Send OTP magic link immediately for fast UX
  sb.auth.signInWithOtp({
    email: email,
    options: { shouldCreateUser: true, data: { child_age: childAge || '' } }
  }).then(function(res) {
    if (res.error) {
      if (typeof onError === 'function') onError(_friendlyErr(res.error.message));
      return;
    }
    // 2. Create trial entitlement in backend (fire-and-forget safe)
    fetch(TAPTOTS_CONFIG.apiBase + '/start-trial', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email: email, child_age: childAge || '' })
    })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      _ttTrack('trial_started', { email: email });
      if (typeof onSuccess === 'function') onSuccess(d || {});
    })
    .catch(function(err) {
      // OTP already sent — treat as success for UX
      console.warn('[TapTots] start-trial backend error:', err.message);
      if (typeof onSuccess === 'function') onSuccess({});
    });
  }).catch(function(err) {
    if (typeof onError === 'function') onError(_friendlyErr(err.message));
  });
}

// ─── Sign out ─────────────────────────────────────────────────────────────────
function ttSignOut(onDone) {
  var sb = _getSB();
  if (!sb) { _session = _user = _ent = null; if (typeof onDone === 'function') onDone(); return; }
  sb.auth.signOut().then(function() {
    _session = _user = _ent = null; _entError = _entMissing = false;
    if (typeof onDone === 'function') onDone();
  });
}

// ─── Stripe checkout ──────────────────────────────────────────────────────────
function ttStartCheckout(plan, onError) {
  if (!_user) { if (typeof onError === 'function') onError('Please sign in first.'); return; }

  var priceId = (plan === 'annual' && TAPTOTS_CONFIG.stripeAnnualPrice)
    ? TAPTOTS_CONFIG.stripeAnnualPrice
    : TAPTOTS_CONFIG.stripeMonthlyPrice;

  if (!priceId || priceId.indexOf('YOUR_') === 0) {
    if (typeof onError === 'function') onError('Payment is not configured yet.');
    return;
  }

  fetch(TAPTOTS_CONFIG.apiBase + '/create-checkout', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ plan: plan, user_id: _user.id, user_email: _user.email })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d.url) {
      _ttTrack('checkout_started', { plan: plan });
      window.location.href = d.url;
    } else {
      if (typeof onError === 'function') onError(d.error || 'Checkout failed. Please try again.');
    }
  })
  .catch(function() {
    if (typeof onError === 'function') onError('Connection error. Please check your internet.');
  });
}

// ─── Progress helpers ─────────────────────────────────────────────────────────
var _PKEY = 'tt_progress_v1';

function ttSaveProgress(gameId, stars, score, level) {
  var p = _readProgress();
  if (!p.games) p.games = {};
  var prev = p.games[gameId] || {};
  // Only upgrade stars — never decrease them
  var newStars = Math.max(prev.stars || 0, stars || 0);
  p.games[gameId] = { stars: newStars, score: score || 0, level: level || 1, ts: Date.now() };
  p.totalStars = 0;
  for (var g in p.games) p.totalStars += (p.games[g].stars || 0);
  p.lastGameId    = gameId;
  p.lastGameTime  = Date.now();
  _writeProgress(p);

  var sb = _getSB();
  if (!_user || !sb) return;
  sb.from('progress').upsert({
    user_id: _user.id, game_id: gameId,
    stars: newStars, score: score || 0, level: level || 1,
    last_played: new Date().toISOString()
  }, { onConflict: 'user_id,game_id' }).catch(function() {});
}

function ttRecordGameLaunch(gameId, title, icon) {
  var p = _readProgress();
  p.lastGameId    = gameId;
  p.lastGameTitle = title || gameId;
  p.lastGameIcon  = icon  || '';
  p.lastGameTime  = Date.now();
  _writeProgress(p);
}

function ttRecordGamePlayed() {
  // Increments a counter used to trigger PWA install prompt after engagement
  var n = parseInt(localStorage.getItem('tt_plays') || '0', 10) + 1;
  localStorage.setItem('tt_plays', String(n));
  if (n >= 1) _maybePwa();
}

function ttGetProgress()  { return _readProgress(); }

function _readProgress() {
  var d;
  try { d = JSON.parse(localStorage.getItem(_PKEY) || '{}'); } catch(e) { d = {}; }
  if (!d.games)     d.games     = {};
  if (!d.stickers)  d.stickers  = {};
  if (!d.totalStars) d.totalStars = 0;
  return d;
}

function _writeProgress(d) {
  try { localStorage.setItem(_PKEY, JSON.stringify(d)); } catch(e) {}
}

// ─── Game entitlement guard ───────────────────────────────────────────────────
/**
 * Call this at the top of any game file after auth.js loads.
 * If the player is not entitled, replaces the page with a friendly upgrade prompt.
 * If entitled, calls onAllowed().
 *
 * Usage in a game file:
 *   ttAuthInit(function() {
 *     ttGuardGame('abc-tappers.html', 'ABC Tappers', function() {
 *       startGame();
 *     });
 *   });
 */
function ttGuardGame(gameId, gameTitle, onAllowed) {
  if (ttIsAllowed()) {
    ttRecordGameLaunch(gameId, gameTitle, '');
    if (typeof onAllowed === 'function') onAllowed();
    return;
  }

  // Not allowed — show inline upgrade screen
  var user = ttCurrentUser();
  var isSignedIn = !!user;
  var expired    = ttTrialExpired();
  var body = document.body;
  body.innerHTML = '';
  body.style.cssText = 'margin:0;padding:0;font-family:sans-serif;background:#16361a;color:#f7f1df;display:flex;align-items:center;justify-content:center;min-height:100vh;';

  var title, msg, btnLabel, btnAction;
  if (!isSignedIn) {
    title     = 'Start your free trial';
    msg       = '7 days free \u2014 no card needed. Then just $4.99/month.';
    btnLabel  = 'Start Free Trial';
    btnAction = function() { window.location.href = '/index.html'; };
  } else if (expired) {
    title     = 'Your free trial has ended';
    msg       = 'Subscribe for $4.99/month to keep playing. Cancel any time.';
    btnLabel  = 'Unlock All Games';
    btnAction = function() { ttStartCheckout('monthly', function(e) { alert(e); }); };
  } else {
    title    = 'Just a moment\u2026';
    msg      = 'Loading your access. If this persists, please go back and sign in again.';
    btnLabel = 'Go Back';
    btnAction = function() { window.location.href = '/play.html'; };
  }

  var card = document.createElement('div');
  card.style.cssText = 'background:linear-gradient(160deg,#fff9f0,#f5e8cb);color:#352919;border-radius:28px;padding:32px 24px;max-width:380px;width:90%;text-align:center;box-shadow:0 20px 48px rgba(0,0,0,.3);';
  card.innerHTML =
    '<div style="font-size:56px;margin-bottom:12px">&#127912;</div>' +
    '<h2 style="font-family:Georgia,serif;font-size:26px;margin:0 0 10px">' + title + '</h2>' +
    '<p style="font-size:16px;color:#5c513e;line-height:1.5;margin:0 0 24px">' + msg + '</p>' +
    '<button id="tt-guard-btn" style="width:100%;padding:16px;background:linear-gradient(135deg,#f3d247,#e8b820);color:#111;border:none;border-radius:16px;font-size:18px;font-weight:800;cursor:pointer;box-shadow:0 5px 0 #c79716;">' + btnLabel + '</button>' +
    '<br><a href="/play.html" style="display:inline-block;margin-top:16px;color:#8a7060;font-size:14px;text-decoration:none;">&#8592; Back to games</a>';
  body.appendChild(card);
  document.getElementById('tt-guard-btn').addEventListener('click', btnAction);
}

// ─── PWA install ──────────────────────────────────────────────────────────────
var _pwaPrompt = null;
window.addEventListener('beforeinstallprompt', function(e) {
  e.preventDefault(); _pwaPrompt = e; _maybePwa();
}, { passive: true });

function _maybePwa() {
  if (!_pwaPrompt) return;
  if (localStorage.getItem('tt_pwa_done')) return;
  var plays = parseInt(localStorage.getItem('tt_plays') || '0', 10);
  if (plays < 1) return;
  var el = document.getElementById('pwaBanner');
  if (!el) return;
  el.style.display = 'flex';
  setTimeout(function() { el.classList.add('pwa-visible'); }, 80);
}

function ttTriggerPwaInstall() {
  if (_pwaPrompt) { _pwaPrompt.prompt(); _pwaPrompt = null; }
  localStorage.setItem('tt_pwa_done', '1');
  _hidePwaBanner();
}

function ttDismissPwa() {
  localStorage.setItem('tt_pwa_done', '1');
  _hidePwaBanner();
}

function _hidePwaBanner() {
  var el = document.getElementById('pwaBanner');
  if (!el) return;
  el.classList.remove('pwa-visible');
  setTimeout(function() { el.style.display = 'none'; }, 320);
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function _ttTrack(name, props) {
  var sb = _getSB();
  if (!sb) return;
  sb.from('events').insert({
    user_id:    _user ? _user.id : null,
    event_name: name,
    properties: props || {}
  }).catch(function() {});
}

// ─── Error messages ───────────────────────────────────────────────────────────
function _friendlyErr(raw) {
  if (!raw) return 'Something went wrong. Please try again.';
  var r = raw.toLowerCase();
  if (r.indexOf('rate') > -1 || r.indexOf('too many') > -1)
    return 'Too many attempts. Please wait a minute and try again.';
  if (r.indexOf('email') > -1)
    return 'Please enter a valid email address.';
  if (r.indexOf('network') > -1 || r.indexOf('fetch') > -1)
    return 'Connection error. Please check your internet.';
  return 'Something went wrong. Please try again.';
}

// ─── ESC closes modals ────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  var open = document.querySelectorAll('.modal.show');
  for (var i = 0; i < open.length; i++) open[i].classList.remove('show');
});

// ─── TT helper namespace (UI utilities) ───────────────────────────────────────
var TT = {
  progress: function() { return _readProgress(); },

  toggleMenu: function() {
    var p = document.getElementById('ttMenuPanel');
    var s = document.getElementById('ttMenuScrim');
    if (!p || !s) return;
    var o = p.classList.contains('open');
    p.classList.toggle('open', !o);
    s.classList.toggle('open', !o);
  },

  closeMenu: function() {
    ['ttMenuPanel','ttMenuScrim'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('open');
    });
  },

  toast: function(msg, type) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'toast show' + (type ? ' toast-' + type : '');
    clearTimeout(window._ttToastTimer);
    window._ttToastTimer = setTimeout(function() { el.classList.remove('show'); }, 3400);
  },

  updateNavUser: function() {
    var u  = ttCurrentUser();
    var ne = document.getElementById('ttNavUser');
    var sl = document.getElementById('ttSignOutLink');
    if (ne) { ne.textContent = u ? u.email : ''; ne.style.display = u ? 'block' : 'none'; }
    if (sl) sl.style.display = u ? 'flex' : 'none';
  }
};
