// SansadSaar on www.indiavotes.com/sansadsaar/ (routes in wrangler.jsonc).
// The app's paths are relative, so /sansadsaar must become /sansadsaar/
// before anything loads; everything else is a static asset under
// public/sansadsaar/. Staging adds X-Robots-Tag: noindex.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/sansadsaar') {
      url.pathname = '/sansadsaar/';
      return Response.redirect(url.toString(), 301);
    }
    const res = await env.ASSETS.fetch(request);
    if (!env.NOINDEX) return res;
    const headers = new Headers(res.headers);
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
