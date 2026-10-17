import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const root = resolve(import.meta.dirname, '..');
const single = existsSync(join(root, 'capability.json'));
const capabilities = JSON.parse(readFileSync(join(root, single ? 'capability.json' : 'capabilities.json'), 'utf8'));
const all = single ? [capabilities] : capabilities;
const storage = { storage_type: 's3', storage_url: 'example-bucket', access_key: 'FAKE-ACCESS-KEY', secret_key: 'FAKE-STORAGE-SECRET' };

function execute(c, extra = {}, mode = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'flashdata-action-test-'));
  const fixture = join(dir, 'fixture.json'); writeFileSync(fixture, JSON.stringify(c));
  const output = join(dir, 'output.txt'); writeFileSync(output, '');
  const summary = join(dir, 'summary.md'); writeFileSync(summary, '');
  const calls = join(dir, 'calls.jsonl'); writeFileSync(calls, '');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('INPUT_')) delete env[key];
  const { query, video_id, handle, ...options } = c.sample;
  const inputs = c.source === 'youtube_download' ? { operation: 'status', 'job-id': 'job_fixture' }
    : { ...(query ? { query } : {}), ...(video_id ? { 'video-id': video_id } : {}), ...(handle ? { handle } : {}), 'options-json': JSON.stringify(options) };
  for (const [name, value] of Object.entries({ 'api-key': 'FAKE-API-KEY', ...inputs, ...extra })) env[`INPUT_${name.toUpperCase()}`] = value;
  Object.assign(env, { RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, FLASHDATA_TEST_FIXTURE: fixture, FLASHDATA_TEST_CALLS: calls, FLASHDATA_TEST_MODE: mode });
  const repoDir = single ? root : join(root, 'repos', `flashdata-${c.source.replaceAll('_', '-')}-action`);
  const result = spawnSync(process.execPath, ['--require', join(root, 'test/mock-fetch.cjs'), join(repoDir, 'dist/index.cjs')], { env, encoding: 'utf8', timeout: 10_000 });
  const out = readFileSync(output, 'utf8');
  const values = {};
  for (const m of out.matchAll(/^([^\n<]+)<<([^\n]+)\n([\s\S]*?)\n\2(?:\n|$)/gm)) values[m[1]] = m[3];
  const logs = result.stdout.split('\n').filter(l => !l.startsWith('::add-mask::')).join('\n') + result.stderr;
  const requests = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const files = values['artifact-directory'] ? Object.fromEntries(readdirSync(values['artifact-directory']).map(name => [name, readFileSync(join(values['artifact-directory'], name), 'utf8')])) : {};
  return { ...result, values, logs, requests, files };
}

for (const c of all) {
  test(`${c.source}: bundled action metadata, concrete docs and manual workflow`, () => {
    const dir = single ? root : join(root, 'repos', `flashdata-${c.source.replaceAll('_','-')}-action`);
    const meta = YAML.parse(readFileSync(join(dir, 'action.yml'),'utf8'));
    assert.equal(meta.runs.using, 'node24'); assert.equal(meta.runs.main, 'dist/index.cjs');
    assert.equal(meta.inputs['api-key'].required, true);
    const workflow = YAML.parse(readFileSync(join(dir,'example.yml'),'utf8'));
    assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
    assert.equal(workflow.permissions.contents, 'read');
    const docs = readFileSync(join(dir,'README.md'),'utf8');
    assert.ok(docs.includes(`https://flashdata.dev/docs/sources/${c.source}`));
    assert.match(docs, /FlashData API calls use paid Credits/);
    assert.match(docs, /## Inputs/); assert.match(docs, /## Outputs/);
  });
  test(`${c.source}: fixture run preserves response, writes usable records, fixed API route`, () => {
    const r = execute(c); assert.equal(r.status, 0, r.logs); assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].headers['X-API-Key'], 'FAKE-API-KEY');
    if (c.source === 'youtube_download') {
      assert.equal(r.requests[0].method,'GET'); assert.equal(r.values['job-id'],'job_fixture');
      assert.equal(r.values['job-status'],'running'); assert.ok(!r.files['response.json'].includes('params'));
    } else {
      assert.equal(r.requests[0].url, 'https://data.flashdata.dev/v1/queries/realtime');
      assert.equal(r.requests[0].body.source, c.source);
      assert.deepEqual(JSON.parse(r.files['response.json']),c.outputExample);
      assert.ok(Number(r.values['result-count']) > 0);
    }
    assert.equal(r.values.source,c.source);
    const visible = r.logs + JSON.stringify(r.files);
    for (const value of ['FAKE-API-KEY','FAKE-STORAGE-SECRET','FAKE-PRIVATE-DETAIL']) assert.ok(!visible.includes(value));
  });
  test(`${c.source}: invalid identity input makes zero requests`, () => {
    const extra = c.source === 'youtube_download' ? { 'job-id':'../../invalid' }
      : c.sample.query ? {query:''} : c.sample.handle ? {handle:''} : {'video-id':'invalid'};
    const r = execute(c,extra); assert.equal(r.status,1); assert.equal(r.requests.length,0);
  });
  for (const mode of ['server-error','network-error','redirect','malformed','oversized']) {
    test(`${c.source}: ${mode} fails without retry or exposing raw errors`, () => {
      const r = execute(c,{},mode); assert.equal(r.status,1); assert.equal(r.requests.length,1);
      assert.ok(!r.logs.includes('FAKE-PRIVATE-DETAIL')); assert.ok(!r.logs.includes('FAKE-API-KEY'));
    });
  }
  if (c.source !== 'youtube_download') {
    test(`${c.source}: empty data is empty, not fabricated`, () => {
      const r = execute(c,{},'empty'); assert.equal(r.status,0,r.logs); assert.equal(r.values['result-count'],'0'); assert.equal(r.files['records.jsonl'],'');
    });
    test(`${c.source}: source mismatch fails; options cannot override source or credentials`, () => {
      const r=execute(c,{},'mismatched-source'); assert.equal(r.status,1); assert.equal(r.requests.length,1);
      for(const options of [{source:'another_source'},{storage},{unexpected:'value'}]) {
        const invalid=execute(c,{'options-json':JSON.stringify(options)});assert.equal(invalid.status,1);assert.equal(invalid.requests.length,0);
      }
    });
  }
}

const download = all.find(c => c.source === 'youtube_download');
if (download) {
  const submit={operation:'submit','job-id':'','video-id':'jNQXAC9IVRw','allow-submit':'true','storage-json':JSON.stringify(storage),'options-json':'{"download_type":"audio","output_format":"m4a"}'};
  test('download submit is one POST, saves a sanitized receipt, never echoes storage',()=>{
    const r=execute(download,submit);assert.equal(r.status,0,r.logs);assert.equal(r.requests.length,1);assert.equal(r.requests[0].method,'POST');
    assert.equal(r.requests[0].url,'https://data.flashdata.dev/v1/queries');assert.deepEqual(r.requests[0].body.params.storage,storage);
    assert.equal(r.values['job-id'],'job_fixture');assert.equal(r.values['job-status'],'pending');
    assert.ok(!(JSON.stringify(r.files)+r.logs).includes('FAKE-STORAGE-SECRET'));
    assert.equal(JSON.parse(r.files['manifest.json']).job_id,'job_fixture');
  });
  test('download refuses missing approval, invalid storage, incompatible format or submit-with-job before dispatch',()=>{
    for(const extra of [{'allow-submit':'false'},{'storage-json':'{}'},{'storage-json':JSON.stringify({...storage,secret_key:''})},{'options-json':'{"download_type":"audio","output_format":"mp4"}'},{'job-id':'job_existing'}]) {
      const r=execute(download,{...submit,...extra});assert.equal(r.status,1);assert.equal(r.requests.length,0);
    }
  });
  test('completed result reads 4 times, never sends key to signed object or resubmits',()=>{
    const r=execute(download,{operation:'result'},'completed');assert.equal(r.status,0,r.logs);assert.equal(r.requests.length,4);
    assert.ok(r.requests.every(q=>q.method==='GET'));assert.equal(r.requests[3].headers['X-API-Key'],undefined);
    assert.ok(JSON.parse(r.files['response.json']).output.files);assert.equal(r.values['job-status'],'completed');
  });
  test('untrusted result origin is rejected before signed data read',()=>{
    const r=execute(download,{operation:'result'},'bad-result-origin');assert.equal(r.status,1);assert.equal(r.requests.length,3);
    assert.ok(r.requests.every(q=>!q.url.startsWith('https://untrusted.example')));
  });
}
const google = all.find(c => c.source === 'google_search');
if (google) test('untrusted query stays data, including quotes and workflow expressions',()=>{
  const query='中文 "quotes"\n${{ secrets.OTHER }} $(touch /tmp/DO_NOT_RUN) ::error::not-a-command';
  const r=execute(google,{query});assert.equal(r.status,0,r.logs);assert.equal(r.requests[0].body.query,query);
  assert.equal(JSON.parse(r.files['manifest.json']).request.query,query);assert.ok(!r.logs.includes('not-a-command'));
});
