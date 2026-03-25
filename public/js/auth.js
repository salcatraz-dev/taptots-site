
(function(){
  const KEY = 'taptots_progress_v1';
  const defaultState = {
    stars: 0,
    stickers: 0,
    gamesPlayed: 0,
    lastGame: '/abc-tappers/',
    trialStarted: false,
    trialEmail: '',
    unlocked: true,
    games: { abc: { highScore: 0, wins: 0, lastAnimal: 'Lion' } }
  };

  function load(){
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
      return Object.assign({}, defaultState, parsed || {});
    } catch(e){
      return structuredClone ? structuredClone(defaultState) : JSON.parse(JSON.stringify(defaultState));
    }
  }
  function save(state){ localStorage.setItem(KEY, JSON.stringify(state)); }
  function state(){ return load(); }
  function update(patch){ const next = Object.assign({}, load(), patch || {}); save(next); sync(); return next; }
  function addReward(stars, stickers){
    const s = load();
    s.stars += stars || 0;
    s.stickers += stickers || 0;
    s.gamesPlayed += 1;
    save(s); sync(); return s;
  }
  function setLastGame(path){ const s = load(); s.lastGame = path; save(s); sync(); }
  function setTrial(email){ const s = load(); s.trialStarted = true; s.trialEmail = email || s.trialEmail || ''; save(s); sync(); }
  function sync(){
    const s = load();
    document.querySelectorAll('[data-stars]').forEach(el => el.textContent = s.stars);
    document.querySelectorAll('[data-stickers]').forEach(el => el.textContent = s.stickers);
    document.querySelectorAll('[data-games-played]').forEach(el => el.textContent = s.gamesPlayed);
    document.querySelectorAll('[data-last-game]').forEach(el => el.setAttribute('href', s.lastGame || '/abc-tappers/'));
    document.querySelectorAll('[data-trial-state]').forEach(el => {
      el.textContent = s.trialStarted ? ('Trial ready' + (s.trialEmail ? ' for ' + s.trialEmail : '')) : 'Start free trial';
    });
    document.querySelectorAll('[data-trial-email]').forEach(el => { el.textContent = s.trialEmail || 'your email'; });
    const hs = (((s.games||{}).abc)||{}).highScore || 0;
    document.querySelectorAll('[data-abc-high]').forEach(el => el.textContent = hs);
  }

  function bindTrialForms(){
    document.querySelectorAll('[data-trial-form]').forEach(form => {
      form.addEventListener('submit', function(e){
        e.preventDefault();
        const emailInput = form.querySelector('input[type="email"]');
        const email = (emailInput?.value || '').trim();
        if(!email || !email.includes('@')){
          alert('Please enter a valid parent email address.');
          emailInput?.focus();
          return;
        }
        setTrial(email);
        const msg = form.querySelector('[data-form-message]');
        if (msg) msg.textContent = 'Great — this demo saved your email locally on this device. When your real backend is ready, this form can send the sign-in link automatically.';
        form.reset();
      });
    });
  }

  function bindDemoButtons(){
    document.querySelectorAll('[data-demo-action="checkout"]').forEach(btn => {
      btn.addEventListener('click', function(){
        alert('Checkout is not wired yet in this repaired static build. The site is now functional, and you can connect Stripe later.');
      });
    });
    document.querySelectorAll('[data-demo-action="notify"]').forEach(btn => {
      btn.addEventListener('click', function(){
        alert('This game is marked coming soon.');
      });
    });
  }

  window.TapTots = { state, update, addReward, setLastGame, setTrial, sync };
  document.addEventListener('DOMContentLoaded', function(){
    sync();
    bindTrialForms();
    bindDemoButtons();
  });
})();
