/** Host-side HTTP fixture, reached through native workerd fetch. Never forwards to the network. */
export function createResendHttpFixture() {
  const requests: { url: string; method: string; authorization: string | null; body: unknown }[] = [];
  return async (request: Request): Promise<Response> => {
    if (request.url === 'https://resend-fixture.invalid/reset' && request.method === 'POST') {
      requests.length = 0;
      return new Response(null, { status: 204 });
    }
    if (request.url === 'https://resend-fixture.invalid/requests' && request.method === 'GET') {
      return Response.json(requests);
    }
    if (['api.resend.com', 'redirect-fixture.invalid'].includes(new URL(request.url).hostname)) {
      const authorization = request.headers.get('Authorization');
      // Dummy credentials only; unexpected destinations/requests remain blocked below.
      if (!authorization?.startsWith('Bearer fixture-resend-')) throw new Error('Only fixture Resend credentials are permitted');
      requests.push({ url: request.url, method: request.method, authorization,
        body: request.method === 'POST' ? await request.json() : null });
      if (request.url !== 'https://api.resend.com/emails') return Response.json({ id: 'unexpected-redirect-target' });
      if (request.method !== 'POST' || !request.headers.get('Content-Type')?.includes('application/json')) {
        return Response.json({ message: 'Invalid HTTP contract' }, { status: 400 });
      }
      const mode = authorization.slice('Bearer fixture-resend-'.length);
      const redirect = /^redirect-(301|302|303|307|308)-(same|cross)$/.exec(mode);
      if (redirect) return new Response(null, { status: Number(redirect[1]), headers: {
        Location: redirect[2] === 'same' ? '/redirect-target' : 'https://redirect-fixture.invalid/target',
      } });
      if (/^(401|403|429|500|503)$/.test(mode)) return Response.json({ message: 'Fixture provider rejection' }, { status: Number(mode) });
      if (mode === 'malformed') return Response.json({ id: '' });
      if (mode !== 'accepted') throw new Error('Unknown Resend fixture mode');
      return Response.json({ id: 'fixture-provider-acceptance' });
    }
    throw new Error('External network is disabled in Workers tests; inject a mock upstream.');
  };
}
