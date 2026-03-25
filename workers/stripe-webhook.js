// Placeholder worker kept out of public so it doesn't break the site.
export default { async fetch(){ return new Response('Stripe webhook placeholder', {status:200}); } };
