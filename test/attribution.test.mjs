import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import ts from 'typescript';
const { loadExtensions } = await import(new URL('./core/extensions/loader.js', import.meta.resolve('@mariozechner/pi-coding-agent')));
const source = resolve(process.env.REQALL_TEST_PACKAGE || '.');
const compiled = mkdtempSync(resolve('.attribution-test-'));
writeFileSync(join(compiled, 'capabilities.mjs'), ts.transpileModule(readFileSync(join(source, 'extensions/capabilities.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
const { Capabilities, originatingSession, isOwnEvent } = await import(pathToFileURL(join(compiled, 'capabilities.mjs')));
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));
const writes = ['upsert_project', 'upsert_record', 'upsert_link', 'delete_record', 'delete_link', 'sleep_apply', 'merge_projects'];
const schema = name => ({ name, inputSchema: { properties: { ...(writes.includes(name) ? { session_id: { type: 'string' } } : {}), kind: { enum: ['todo', 'work', 'info'] }, links: { type: 'array' }, project_only: { type: 'boolean' } } } });

async function fixture(run, { legacy = false, failDiscovery = false } = {}) {
  const env = { ...process.env }, fetch = globalThis.fetch;
  const cwd = mkdtempSync(resolve('.attribution-host-'));
  const calls = [], hosts = [];
  let denied = false, jsonOnly = false, partial = false, large = false;
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('REQALL_')) delete process.env[key];
    Object.assign(process.env, { REQALL_API_KEY: 'fixture-only', REQALL_URL: 'http://fixture.invalid', REQALL_PROJECT_NAME: 'fixture/project' });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/mcp');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal);
      options.signal.throwIfAborted();
      const rpc = JSON.parse(options.body);
      const reply = result => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
      if (rpc.method === 'tools/list') {
        if (failDiscovery) throw new Error('fixture discovery unavailable');
        return reply({ tools: legacy ? writes.map(name => ({ name, inputSchema: { properties: {} } })) : [...writes, 'search', 'list_records', 'get_record'].map(schema) });
      }
      calls.push(rpc.params);
      await new Promise(resolve => setTimeout(resolve, rpc.params.arguments.project_id === 1 ? 5 : 0));
      const payload = denied ? { ok: false, error: { code: 'write_gate' } } : { ok: true, data: rpc.params.name === 'upsert_project' ? { project: { id: 42, name: 'fixture/project' } } : { record: { id: 7, project_id: 42, ...(large ? { body: 'x'.repeat(20_000) } : {}) }, ...(partial ? { links: [{ action: 'error', target_id: 9, error: 'denied' }] } : {}) } };
      return reply(jsonOnly ? { content: [{ type: 'text', text: JSON.stringify(payload) }] } : { structuredContent: payload, content: [{ type: 'text', text: 'Fixture response' }] });
    };
    async function load(manager = SessionManager.inMemory(cwd)) {
      const loaded = await loadExtensions([join(source, 'extensions/reqall.ts')], cwd);
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.appendEntry = (type, data) => manager.appendCustomEntry(type, data);
      loaded.runtime.sendMessage = () => {};
      const extension = loaded.extensions[0];
      const ctx = { cwd, hasUI: false, sessionManager: manager };
      const host = { manager, ctx,
        tool: (name, args = {}, signal) => extension.tools.get(`reqall_${name}`).definition.execute('fixture', args, signal, undefined, ctx),
        emit: async (name, event = {}) => { for (const fn of extension.handlers.get(name) || []) await fn({ type: name, ...event }, ctx); },
        command: name => extension.commands.get(name).handler('fixture query', ctx),
      };
      hosts.push(host);
      return host;
    }
    await run({ load, calls, cwd, setDenied: v => { denied = v; }, setJson: v => { jsonOnly = v; }, setPartial: v => { partial = v; }, setLarge: v => { large = v; } });
  } finally {
    for (const host of hosts) await host.emit('session_shutdown', { reason: 'quit' });
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('every exposed write, context upsert and command carries invocation-local origin', async () => fixture(async ({ load, calls }) => {
  const a = await load(), b = await load();
  const expectedA = originatingSession(a.manager.getSessionId()), expectedB = originatingSession(b.manager.getSessionId());
  assert.notEqual(expectedA, expectedB);
  for (const name of writes) {
    await Promise.all([a.tool(name, { id: 7, project_id: 1, session_id: 'claude:forged' }), b.tool(name, { id: 7, project_id: 2 })]);
    const pair = calls.slice(-2);
    assert.equal(pair.find(c => c.arguments.project_id === 1).arguments.session_id, expectedA);
    assert.equal(pair.find(c => c.arguments.project_id === 2).arguments.session_id, expectedB);
  }
  const originalManager = a.ctx.sessionManager;
  const first = a.tool('upsert_record', { id: 7, project_id: 1 });
  a.ctx.sessionManager = b.manager;
  const second = a.tool('upsert_record', { id: 7, project_id: 2 });
  a.ctx.sessionManager = originalManager;
  await Promise.all([first, second]);
  assert.equal(calls.slice(-2).find(c => c.arguments.project_id === 1).arguments.session_id, expectedA);
  assert.equal(calls.slice(-2).find(c => c.arguments.project_id === 2).arguments.session_id, expectedB);
  await a.tool('upsert_record', { id: 7, kind: 'work', links: [{ target_id: 9, relationship: 'implements' }] });
  assert.equal(calls.at(-1).arguments.session_id, expectedA);
  assert.equal(calls.at(-1).arguments.links[0].target_id, 9);
  for (const action of [() => a.tool('project_context', { query: 'task' }), () => a.command('reqall-context'), () => a.emit('before_agent_start', { prompt: 'task', systemPrompt: 'base' })]) {
    calls.length = 0;
    await action();
    assert.equal(calls.find(c => c.name === 'upsert_project').arguments.session_id, expectedA);
    assert.equal(calls.find(c => c.name === 'list_records').arguments.project_id, 42, 'structured project ID is recognized');
    for (const read of calls.filter(c => ['search', 'list_records'].includes(c.name))) assert.equal(read.arguments.session_id, undefined);
  }
}));

test('origin continues through reload/resume/compaction/project switches but renews for new/fork sessions', async () => fixture(async ({ load, calls, cwd }) => {
  let host = await load(SessionManager.create(cwd, join(cwd, 'sessions')));
  host.manager.appendMessage({ role: 'assistant', content: [], timestamp: 0 });
  const id = host.manager.getSessionId();
  const expected = originatingSession(id);
  for (const reason of ['startup', 'reload', 'resume']) {
    host = await load(SessionManager.open(host.manager.getSessionFile(), host.manager.getSessionDir()));
    await host.emit('session_start', { reason });
    await host.tool('upsert_record', { id: 7 });
    assert.equal(calls.at(-1).arguments.session_id, expected);
  }
  host.manager.appendCustomEntry('fixture-before-compact', {});
  host.manager.appendCompaction('fixture summary', host.manager.getLeafId(), 123);
  await host.emit('session_compact');
  process.env.REQALL_PROJECT_NAME = 'another/project';
  await host.emit('before_agent_start', { prompt: 'switch project', systemPrompt: 'base' });
  await host.tool('upsert_record', { id: 7 });
  assert.equal(calls.at(-1).arguments.session_id, expected);
  const parentFile = host.manager.getSessionFile();
  for (const reason of ['new', 'fork']) {
    if (reason === 'fork') host = await load(SessionManager.forkFrom(parentFile, cwd, join(cwd, 'forks')));
    else host.manager.newSession();
    await host.emit('session_start', { reason });
    await host.tool('upsert_record', { id: 7 });
    assert.notEqual(calls.at(-1).arguments.session_id, expected);
  }
}));

for (const mode of [{ legacy: true }, { failDiscovery: true }]) {
  test(`legacy/failure omits attribution, never sends unadvertised additive features: ${JSON.stringify(mode)}`, async () => fixture(async ({ load, calls }) => {
    const host = await load();
    await host.tool('upsert_record', { id: 7, kind: 'todo', session_id: 'forged' });
    assert.equal(calls.at(-1).arguments.session_id, undefined);
    const count = calls.length;
    for (const args of [{ kind: 'work' }, { kind: 'info' }, { links: [] }]) await assert.rejects(host.tool('upsert_record', args), /advertis/);
    await assert.rejects(host.tool('search', { query: 'x', project_only: true }), /advertis/);
    assert.equal(calls.length, count);
  }, mode));
}

test('denied writes and JSON-text error envelopes fail; partial link results stay observable; abort prevents write', async () => fixture(async ({ load, calls, setDenied, setJson, setPartial, setLarge }) => {
  const host = await load();
  setDenied(true);
  await assert.rejects(host.tool('upsert_record', { id: 7 }), /Fixture/);
  setJson(true);
  await assert.rejects(host.tool('upsert_record', { id: 7 }), /write_gate/);
  setDenied(false);
  setJson(false);
  setPartial(true);
  const partialResult = await host.tool('upsert_record', { id: 7, links: [{ target_id: 9, relationship: 'implements' }] });
  assert.equal(partialResult.details.structuredContent.data.links[0].action, 'error');
  assert.match(partialResult.content[0].text, /"action":"error"/);
  setLarge(true);
  const largeResult = await host.tool('get_record', { id: 7 });
  const path = largeResult.content[0].text.match(/full result: (.+)\. Read it/)[1];
  try {
    assert.ok(readFileSync(path, 'utf8').includes('x'.repeat(20_000)));
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally { rmSync(dirname(path), { recursive: true, force: true }); }
  setLarge(false);
  setJson(true);
  await host.tool('project_context', { query: 'json-only project' });
  assert.equal(calls.findLast(c => c.name === 'list_records').arguments.project_id, 42);
  const controller = new AbortController(); controller.abort();
  const count = calls.length;
  await assert.rejects(host.tool('upsert_record', { id: 7 }, controller.signal));
  assert.equal(calls.length, count);
}));

test('capabilities paginate, isolate credentials/endpoints, recover from failure and do not mutate arguments', async () => {
  const calls = [];
  const cap = new Capabilities(async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { tools: [schema('upsert_record')] } : { tools: [schema('search')], nextCursor: 'page-2' };
  });
  const args = { id: 7, session_id: 'forged' };
  const result = await cap.arguments('server/account-a', 'upsert_record', args, 'pi:own');
  assert.equal(result.session_id, 'pi:own');
  assert.equal(args.session_id, 'forged');
  await cap.discover('server/account-a'); assert.equal(calls.length, 2);
  await cap.discover('server/account-b'); assert.equal(calls.length, 4);
  const now = Date.now;
  try {
    Date.now = () => now() + 61_000;
    await cap.discover('server/account-b'); assert.equal(calls.length, 6);
  } finally { Date.now = now; }
  let failures = 0;
  const retry = new Capabilities(async () => { if (!failures++) throw new Error('offline'); return { tools: [schema('upsert_record')] }; });
  assert.equal((await retry.arguments('a', 'upsert_record', {}, 'pi:own')).session_id, undefined);
  assert.equal((await retry.arguments('a', 'upsert_record', {}, 'pi:own')).session_id, 'pi:own');
  const loop = new Capabilities(async () => ({ tools: [], nextCursor: 'loop' }));
  await assert.rejects(loop.discover('a'), /cursor/);
});

test('cancelling either concurrent discovery waiter preserves the other write attribution', async () => {
  for (const cancelledIndex of [0, 1]) {
    let release, transportSignal, requests = 0;
    const cap = new Capabilities(async (_method, _params, signal) => {
      requests++;
      transportSignal = signal;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        release = () => {
          signal.removeEventListener('abort', onAbort);
          resolve({ tools: [schema('upsert_record')] });
        };
      });
    });
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller, i) => cap.arguments('same/account', 'upsert_record', { id: 7 }, `pi:session-${i}`, controller.signal));
    const rejected = assert.rejects(pending[cancelledIndex], /cancelled caller/);
    controllers[cancelledIndex].abort(new Error('cancelled caller'));
    await rejected; // Cancellation must settle before discovery completes.
    assert.equal(transportSignal.aborted, false);
    assert.equal(requests, 1);
    release();
    assert.equal((await pending[1 - cancelledIndex]).session_id, `pi:session-${1 - cancelledIndex}`);
    await cap.discover('same/account');
    assert.equal(requests, 1, 'one cancelled waiter must not evict successful discovery');
    await assert.rejects(cap.discover('same/account', controllers[cancelledIndex].signal), /cancelled caller/);
  }
});

test('large-result files survive readback, are instance-isolated and cleaned on every shutdown reason', async () => fixture(async ({ load, setLarge }) => {
  const baselineListeners = process.listenerCount('exit');
  const a = await load(), b = await load();
  assert.equal(process.listenerCount('exit'), baselineListeners, 'loading alone registers no process resources');
  setLarge(true);
  const outputPath = result => result.content[0].text.match(/full result: (.+)\. Read it/)[1];
  const otherPath = outputPath(await b.tool('get_record', { id: 8 }));
  for (const reason of ['reload', 'new', 'resume', 'fork', 'quit']) {
    const paths = [];
    for (let i = 0; i < 2; i++) paths.push(outputPath(await a.tool('get_record', { id: 7 })));
    assert.equal(process.listenerCount('exit'), baselineListeners + 2, 'one exit listener per owning instance');
    for (const path of paths) assert.ok(readFileSync(path, 'utf8').includes('x'.repeat(20_000)));
    await a.emit('session_shutdown', { reason });
    await a.emit('session_shutdown', { reason }); // Idempotent.
    for (const path of paths) assert.equal(existsSync(dirname(path)), false);
    assert.equal(process.listenerCount('exit'), baselineListeners + 1);
    assert.equal(existsSync(otherPath), true, 'other sessions still need their readback');
  }
  await b.emit('session_shutdown', { reason: 'quit' });
  assert.equal(existsSync(dirname(otherPath)), false);
  assert.equal(process.listenerCount('exit'), baselineListeners);

  // Normal process exit must also clean files if no host shutdown event fired.
  const loaderUrl = new URL('./core/extensions/loader.js', import.meta.resolve('@mariozechner/pi-coding-agent')).href;
  const childPath = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { loadExtensions } = await import(${JSON.stringify(loaderUrl)});
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/mcp');
      const rpc = JSON.parse(options.body);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result:
        rpc.method === 'tools/list' ? { tools: [] } : { content: [{ type: 'text', text: 'x'.repeat(20000) }] }
      }));
    };
    const loaded = await loadExtensions([${JSON.stringify(join(source, 'extensions/reqall.ts'))}], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const result = await loaded.extensions[0].tools.get('reqall_get_record').definition.execute(
      'fixture', { id: 7 }, undefined, undefined,
      { cwd: process.cwd(), sessionManager: { getSessionId: () => 'fixture-exit' } }
    );
    const path = result.content[0].text.split('full result: ')[1].split('. Read it')[0];
    console.log(JSON.stringify(path));
  `], { encoding: 'utf8', timeout: 15_000 }));
  assert.equal(existsSync(dirname(childPath)), false, 'process exit removes both file and directory');
}));

test('event suppression retains legacy, unknown, other-account and other-session same-record edits', () => {
  const own = originatingSession('host-session');
  assert.match(own, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  assert.ok(!own.includes('host-session'));
  const events = [
    { actor: 'self', session_id: own },
    { actor: 'self', session_id: originatingSession('second-session') },
    { actor: 'self', session_id: 'claude:other' },
    { actor: 'self', session_id: null },
    { actor: 'self' },
    { actor: 'other', session_id: own },
    { session_id: own },
  ].map(e => ({ ...e, record_id: 7 }));
  assert.deepEqual(events.map(e => isOwnEvent(e, own)), [true, false, false, false, false, false, false]);
});
