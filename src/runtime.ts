import * as core from '@actions/core';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient, FlashDataError, isObject, type FlashDataOptions, type JsonObject } from './client.js';
import * as schemas from './schemas.js';
import { normalizeStorage, normalizeYouTubeDownloadOptions } from './vendor/youtubeDownloadOptions.cjs';

const contracts: Record<string, z.ZodType<JsonObject>> = {
  google_search: schemas.googleSchema, google_news: schemas.googleSchema,
  google_images: schemas.googleSchema, google_shopping: schemas.googleSchema,
  google_videos: schemas.googleSchema, google_places: schemas.googleSchema,
  youtube_search: schemas.youtubeSearchSchema, youtube_search_extended: schemas.youtubeExtendedSearchSchema,
  youtube_metadata: schemas.youtubeMetadataSchema, youtube_transcript: schemas.youtubeTranscriptSchema,
  youtube_captions: schemas.youtubeCaptionsSchema, youtube_trainability: schemas.youtubeLicenseSchema,
  youtube_channel: schemas.youtubeChannelSchema, youtube_suggestions: schemas.youtubeSuggestionsSchema,
  youtube_download: schemas.downloadSchema,
};
const collections: Record<string, string> = {
  google_search: 'organic', google_news: 'news', google_images: 'images',
  google_shopping: 'shopping', google_videos: 'videos', google_places: 'places',
  youtube_search: 'results', youtube_search_extended: 'results',
};

function input(name: string) { return core.getInput(name, { trimWhitespace: false }); }
function parseObject(raw: string, label: string): JsonObject {
  try { const value: unknown = JSON.parse(raw); if (isObject(value)) return value; } catch { /* Do not log raw input. */ }
  throw new FlashDataError('invalid_input', `${label} must be a JSON object.`);
}
function mask(value: unknown): void {
  if (typeof value === 'string' && value) core.setSecret(value);
  else if (isObject(value)) Object.values(value).forEach(mask);
}

export function parseInputs(source: string) {
  const schema = contracts[source];
  if (!schema) throw new FlashDataError('unknown_source', 'Unknown action source.');
  const operation = source === 'youtube_download' ? input('operation') || 'status' : 'query';
  if (!['query', 'submit', 'status', 'result'].includes(operation) || (source === 'youtube_download' && operation === 'query')) {
    throw new FlashDataError('invalid_operation', 'Choose submit, status, or result.');
  }
  if (operation === 'status' || operation === 'result') {
    if (input('storage-json') || input('video-id') || input('options-json')) {
      throw new FlashDataError('invalid_input', 'Read operations accept job-id only, without submission inputs.');
    }
    return { operation, data: schemas.jobSchema.parse({ job_id: input('job-id') }) as JsonObject };
  }
  const options = input('options-json') ? parseObject(input('options-json'), 'options-json') : {};
  if (['query', 'video_id', 'handle', 'source', 'storage'].some(key => key in options)) {
    throw new FlashDataError('invalid_input', 'Use dedicated query, video-id, handle and storage-json inputs. The source is fixed by the action.');
  }
  const raw = { ...options };
  for (const [name, key] of [['query', 'query'], ['video-id', 'video_id'], ['handle', 'handle']]) {
    if (input(name)) raw[key] = input(name);
  }
  const data = schema.parse(raw);
  if (operation === 'submit') {
    if (input('job-id')) throw new FlashDataError('invalid_input', 'Use status/result to resume an existing job; submit cannot accept job-id.');
    if (input('allow-submit') !== 'true') throw new FlashDataError('submission_not_enabled', 'A new paid storage delivery requires allow-submit: true.');
    const storage = parseObject(input('storage-json'), 'storage-json');
    mask(storage);
    try {
      const normalized = normalizeStorage(storage, '');
      if (['s3', 's3_compatible', 'oss', 'bos', 'cos', 'tos'].includes(String(storage.storage_type)) &&
          (![storage.access_key, storage.secret_key].every(v => typeof v === 'string' && v.trim()))) throw new Error();
      if (storage.endpoint_url) {
        const u = new URL(String(storage.endpoint_url));
        if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw new Error();
      }
      if (storage.storage_type === 's3_compatible' && !storage.endpoint_url) throw new Error();
      return { operation, data: { ...normalizeYouTubeDownloadOptions(data), storage: normalized } as JsonObject };
    } catch { throw new FlashDataError('invalid_storage_or_options', 'Check the documented storage fields, media format and clip times.'); }
  }
  return { operation, data };
}

function arrayField(row: JsonObject, key: string, warnings: string[]): unknown[] {
  if (!(key in row)) { warnings.push(`missing_${key}`); return []; }
  if (!Array.isArray(row[key])) throw new FlashDataError('unexpected_result', 'A result collection has an unexpected shape. The raw response is saved; do not repeat the paid query.');
  return row[key];
}

export function recordsFor(source: string, response: JsonObject): { records: unknown[]; warnings: string[] } {
  const warnings: string[] = [];
  const results = response.results as unknown[];
  if (!Array.isArray(results)) throw new FlashDataError('unexpected_result', 'Missing results array.');
  const records = results.flatMap((value): unknown[] => {
    if (source === 'youtube_suggestions') {
      const values = Array.isArray(value) ? value : [value];
      if (!values.every(v => typeof v === 'string')) throw new FlashDataError('unexpected_result', 'Unexpected autocomplete response.');
      return values.map(suggestion => ({ suggestion }));
    }
    if (!isObject(value)) throw new FlashDataError('unexpected_result', 'Expected an object result.');
    if (collections[source]) {
      const rows = arrayField(value, collections[source], warnings);
      if (!rows.every(isObject)) throw new FlashDataError('unexpected_result', 'Expected object records in the result collection.');
      return rows;
    }
    if (source === 'youtube_transcript' || source === 'youtube_captions') {
      return arrayField(value, 'segments', warnings).map(segment => {
        if (!isObject(segment) || typeof segment.text !== 'string' ||
            typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 ||
            typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end < segment.start) {
          throw new FlashDataError('unexpected_result', 'Invalid caption segment. Raw response retained; no timestamps were invented.');
        }
        const id = typeof value.videoId === 'string' && /^[\w-]{11}$/.test(value.videoId) ? value.videoId : undefined;
        return { ...segment, video_id: id, language: value.languageCode, is_auto_generated: value.isAutoGenerated,
          ...(id ? { source_url: `https://www.youtube.com/watch?v=${id}&t=${Math.floor(segment.start)}s` } : {}) };
      });
    }
    return [value];
  });
  return { records, warnings: [...new Set(warnings)] };
}

export async function runAction(source: string, transport: Pick<FlashDataOptions, 'fetch' | 'timeoutMs' | 'maxResponseBytes'> = {}) {
  const apiKey = input('api-key');
  mask(apiKey);
  mask(input('storage-json'));
  let requestStarted = false;
  try {
    const { operation, data } = parseInputs(source);
    const client = createClient({ apiKey, ...transport });
    // Prepare the output directory before any paid request, so simple file errors fail early.
    const directory = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'flashdata-'));
    core.setOutput('artifact-directory', directory);
    const metadata = { source, operation, started_at: new Date().toISOString(), documentation: `https://flashdata.dev/docs/sources/${source}` };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
    requestStarted = true;
    const response = operation === 'status' ? await client.status(String(data.job_id))
      : operation === 'result' ? await client.result(String(data.job_id))
        : await client.query(source, data);
    core.setOutput('source', source);
    if (source === 'youtube_download') {
      const jobId = operation === 'submit' ? response.id : data.job_id;
      const status = isObject(response.job) ? response.job.status : response.status;
      core.setOutput('job-id', String(jobId));
      core.setOutput('job-status', String(status));
      core.info(`Saved job reference: ${String(jobId)}. Read this same job; do not resubmit it to poll.`);
    }
    const resultFile = join(directory, 'response.json');
    await writeFile(resultFile, JSON.stringify(response, null, 2) + '\n', { mode: 0o600 });
    core.setOutput('results-file', resultFile);
    const { records, warnings } = source === 'youtube_download' ? { records: [response], warnings: [] } : recordsFor(source, response);
    const recordsFile = join(directory, 'records.jsonl');
    await writeFile(recordsFile, records.map(row => JSON.stringify(row)).join('\n') + (records.length ? '\n' : ''), { mode: 0o600 });
    core.setOutput('records-file', recordsFile);
    core.setOutput('result-count', records.length);
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...metadata, completed_at: new Date().toISOString(), record_count: records.length, warnings,
      ...(operation === 'query' ? { request: data, usage: response.usage } : { job_id: operation === 'submit' ? response.id : data.job_id }),
    }, null, 2) + '\n', { mode: 0o600 });
    if (process.env.GITHUB_STEP_SUMMARY) await core.summary.addHeading(`FlashData: ${source}`, 3)
      .addRaw(`${records.length} exported record(s). Raw JSON and manifest are in the action outputs.\n\n`)
      .addLink('Inputs, pricing and API setup', `https://flashdata.dev/docs/sources/${source}`).write();
    return { directory, response, records, warnings };
  } catch (error) {
    if (error instanceof FlashDataError) {
      core.setFailed(`${error.code}: ${error.message}${error.requestId ? ` Request: ${error.requestId}.` : ''}`);
    } else if (error instanceof z.ZodError) {
      core.setFailed('invalid_input: Check input types, ranges and allowed option names in the README. No request was sent.');
    } else {
      core.setFailed(requestStarted ? 'The action could not finish saving the response. Check FlashData Jobs before repeating a paid request.'
        : 'The action could not prepare its output files. No request was sent.');
    }
    return undefined;
  }
}
