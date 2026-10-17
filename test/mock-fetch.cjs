const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.FLASHDATA_TEST_FIXTURE, 'utf8'));
let count = 0;
globalThis.fetch = async (url, options = {}) => {
  count += 1;
  fs.appendFileSync(process.env.FLASHDATA_TEST_CALLS, JSON.stringify({ url, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined }) + '\n');
  const mode = process.env.FLASHDATA_TEST_MODE || 'ok';
  if (mode === 'network-error') throw new Error('FAKE-PRIVATE-DETAIL');
  if (mode === 'server-error') return new Response('FAKE-PRIVATE-DETAIL', { status: 500 });
  if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } });
  if (mode === 'malformed') return new Response('not-json');
  if (mode === 'oversized') return new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } });
  if (fixture.source !== 'youtube_download') {
    const result = structuredClone(fixture.outputExample);
    if (mode === 'empty') result.results = [];
    if (mode === 'mismatched-source') result.source = 'not_this_source';
    return Response.json(result);
  }
  if (options.method === 'POST') return Response.json({ id: 'job_fixture', status: 'pending', storage: { secret_key: 'FAKE-STORAGE-SECRET' } });
  if (String(url).endsWith('/api-access')) return Response.json({ result_origin: 'https://results.example/' });
  if (String(url).endsWith('/results')) return new Response(null, { status: 302, headers: { location: mode === 'bad-result-origin' ? 'https://untrusted.example/result?signature=fake' : 'https://results.example/result?signature=fake' } });
  if (String(url).startsWith('https://results.example/')) return Response.json({ files: [{ url: 'https://customer.example/delivered.mp4', bytes: 42 }] });
  return Response.json({ job: { id: 'job_fixture', source: 'youtube_download', status: mode === 'completed' || mode === 'bad-result-origin' ? 'completed' : 'running', params: { storage: { secret_key: 'FAKE-STORAGE-SECRET' } } } });
};
