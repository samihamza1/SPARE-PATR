import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ImportSheetPreview } from '@autoparts/shared';
import { ApiError } from '../../errors';
import type { ReadRequest, ReadResponse, WorkbookSheet } from './workbook';

export { cleanNumericText } from './workbook';
export type { WorkbookSheet } from './workbook';

/**
 * Uploaded files are read in a separate Node process with its own heap limit and a deadline
 * (ADR 0016), so a hostile or simply huge file costs at most that process, never the API:
 * past either limit the file is refused with import.file_too_large.
 *
 * Not a worker thread: a worker's resourceLimits are silently replaced by a process-wide
 * --max-old-space-size (NODE_OPTIONS), and a worker running out of heap can still abort the
 * whole process while it is torn down (seen on Node 22).
 */
export interface ReadLimits {
  timeoutMs: number;
  maxHeapMb: number;
}
export const READ_LIMITS: ReadLimits = { timeoutMs: 20_000, maxHeapMb: 256 };
/** Files read at once; more wait their turn, so memory stays bounded under load. */
const MAX_PARALLEL_READS = 2;
/**
 * The only environment the reader gets: it needs no configuration, and a process parsing
 * untrusted files should not hold the database credentials. NODE_OPTIONS is left out so its
 * heap flags cannot override the reader's own.
 */
const READER_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'];

let running = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running < MAX_PARALLEL_READS) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    // The slot passes straight to the next waiter, if any.
    const next = waiting.shift();
    if (next === undefined) running--;
    else next();
  }
}

function startReader(limits: ReadLimits): ChildProcess {
  const execArgv = [`--max-old-space-size=${String(limits.maxHeapMb)}`];
  // Built (tsup): the reader is its own entry next to this bundle. From source (tsx,
  // vitest): the TypeScript entry is run through tsx's loader.
  const built = !import.meta.url.endsWith('.ts');
  if (!built) {
    const loader = createRequire(import.meta.url).resolve('tsx');
    execArgv.push('--import', pathToFileURL(loader).href);
  }
  const entry = new URL(built ? './read-worker.js' : './read-worker.ts', import.meta.url);
  return fork(fileURLToPath(entry), [], {
    execArgv,
    env: Object.fromEntries(
      READER_ENV.flatMap((k) => (k in process.env ? [[k, process.env[k]]] : [])),
    ),
    // Structured clone: the file's bytes and the rows travel as they are.
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
}

function runReader(request: ReadRequest, limits: ReadLimits): Promise<ReadResponse> {
  return new Promise((resolve) => {
    const reader = startReader(limits);
    let settled = false;
    const finish = (response: ReadResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
      reader.kill('SIGKILL');
    };
    const tooLarge: ReadResponse = { ok: false, code: 'import.file_too_large' };
    const unreadable: ReadResponse = { ok: false, code: 'import.unreadable_file' };
    const timer = setTimeout(() => {
      finish(tooLarge);
    }, limits.timeoutMs);
    reader.once('message', (response: ReadResponse) => {
      finish(response);
    });
    reader.once('error', () => {
      finish(unreadable);
    });
    // 'close' comes after every message has been delivered. Without an answer, an abort is
    // V8 running out of heap (or the system killing the process for its memory).
    reader.once('close', (_code: number | null, signal: NodeJS.Signals | null) => {
      finish(signal === 'SIGABRT' || signal === 'SIGKILL' ? tooLarge : unreadable);
    });
    reader.send(request, (err) => {
      if (err !== null) finish(unreadable);
    });
  });
}

async function read(request: ReadRequest, limits: ReadLimits): Promise<ReadResponse> {
  const response = await withSlot(() => runReader(request, limits));
  if (!response.ok) throw new ApiError(400, response.code);
  return response;
}

/**
 * Reads an .xlsx (all sheets, or only `only`) or a UTF-8 .csv in a reader process; see
 * readWorkbookInThread for what is read. `limits` is for tests.
 */
export async function readWorkbook(
  bytes: Uint8Array,
  fileName: string,
  only?: string,
  limits: ReadLimits = READ_LIMITS,
): Promise<WorkbookSheet[]> {
  const request: ReadRequest = {
    kind: 'sheets',
    bytes,
    fileName,
    ...(only !== undefined && { only }),
  };
  const response = await read(request, limits);
  return 'sheets' in response ? response.sheets : [];
}

/**
 * Every sheet's name, size and first `sampleRows` rows, read in a reader process; a sheet
 * past the limits is listed with `tooLarge` instead of failing the file.
 */
export async function inspectWorkbook(
  bytes: Uint8Array,
  fileName: string,
  sampleRows: number,
  limits: ReadLimits = READ_LIMITS,
): Promise<ImportSheetPreview[]> {
  const response = await read({ kind: 'preview', bytes, fileName, sampleRows }, limits);
  return 'previews' in response ? response.previews : [];
}
