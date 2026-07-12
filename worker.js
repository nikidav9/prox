export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return new Response(
      `<h1>prox OK</h1><p>path=${url.pathname}</p>`,
      { status: 200, headers: { 'content-type': 'text/html' } }
    );
  }
};
