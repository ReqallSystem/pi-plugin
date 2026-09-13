import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionManager, AgentSession } from '@mariozechner/pi-coding-agent';
const { loadExtensions } = await import(new URL('./core/extensions/loader.js', import.meta.resolve('@mariozechner/pi-coding-agent')));
const source = resolve(process.env.REQALL_TEST_PACKAGE || '.');

async function fixture(run, { inMemory = false } = {}) {
  const cwd = mkdtempSync(resolve('.lifecycle-test-'));
  const env = { ...process.env }, fetch = globalThis.fetch;
  const calls = [], messages = [];
  try {
    execFileSync('git', ['init', '-q', cwd]);
    for (const key of Object.keys(process.env)) if (key.startsWith('REQALL_')) delete process.env[key];
    Object.assign(process.env, { REQALL_API_KEY: 'fixture-only', REQALL_URL: 'http://fixture.invalid', REQALL_AUTO_PERSIST: 'followup' });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/mcp');
      const rpc = JSON.parse(options.body); calls.push(rpc.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: rpc.params.name === 'upsert_project' ? 'Project #42' : '[]' }] } }));
    };
    const manager = inMemory ? SessionManager.inMemory(cwd) : SessionManager.create(cwd, join(cwd, 'sessions'));
    const ctx = { cwd, hasUI: false, sessionManager: manager };
    const load = async () => {
      const loaded = await loadExtensions([join(source, 'extensions/reqall.ts')], cwd);
      assert.deepEqual(loaded.errors, []);
      loaded.runtime.appendEntry = (type, data) => ctx.sessionManager.appendCustomEntry(type, data);
      loaded.runtime.sendUserMessage = text => messages.push(text);
      loaded.runtime.sendMessage = message => messages.push(message.content);
      const extension = loaded.extensions[0];
      const emit = async (name, event = {}) => {
        let result;
        for (const handler of extension.handlers.get(name) || []) result = await handler({ type: name, ...event }, ctx);
        return result;
      };
      return {
        emit,
        input: (text, source = 'interactive') => emit('input', { text, source }),
        start: prompt => emit('before_agent_start', { prompt, systemPrompt: 'base' }),
        search: async (project_name) => {
          await extension.tools.get('reqall_search').definition.execute('fixture', { query: 'work', ...(project_name ? { project_name } : {}) }, undefined, undefined, ctx);
          return calls.at(-1).arguments.project_name;
        },
        command: (name, args = '') => extension.commands.get(name).handler(args, ctx),
      };
    };
    await run({ host: await load(), load, manager, calls, messages, ctx });
  } finally {
    globalThis.fetch = fetch;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env);
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('actual loader: session selections survive reload/resume and follow branch history', async () => fixture(async ({ host, load, manager, ctx }) => {
  // Pi flushes its session file only after an assistant message exists.
  manager.appendMessage({ role: 'assistant', content: [], timestamp: 0 });
  await host.emit('session_start', { reason: 'startup' });
  await host.input('project_name=acme/original');
  await host.start('work');
  const originalLeaf = manager.getLeafId();
  // A fresh extension closure must recover its binding from supported session storage.
  for (const reason of ['reload', 'resume', 'startup']) {
    ctx.sessionManager = SessionManager.open(manager.getSessionFile(), manager.getSessionDir());
    host = await load();
    await host.emit('session_start', { reason });
    assert.match((await host.start('continue without a label')).systemPrompt, /acme\/original/, reason);
    assert.equal(await host.search(), 'acme/original');
  }
  await host.input('project_name=acme/changed');
  await host.start('change');
  ctx.sessionManager.branch(originalLeaf);
  host = await load();
  await host.emit('session_start', { reason: 'fork' });
  assert.match((await host.start('fork continuation')).systemPrompt, /acme\/original/);
  ctx.sessionManager.newSession();
  await host.emit('session_start', { reason: 'new' });
  assert.doesNotMatch((await host.start('new session')).systemPrompt, /acme\/(original|changed)/);
}));

test('actual loader: same-instance tree navigation restores selection and clears abandoned run state', async () => fixture(async ({ host, manager, messages }) => {
  await host.emit('session_start', { reason: 'startup' });
  const root = manager.appendCustomEntry('fixture-root', {});
  const fallbackProject = await host.search();
  await host.input('project_name=acme/original');
  await host.start('work');
  const originalLeaf = manager.getLeafId();
  await host.input('project_name=acme/changed');
  await host.start('change');
  const changedLeaf = manager.getLeafId();
  assert.equal(await host.search(), 'acme/changed');
  await host.emit('agent_end', { messages: [{ toolName: 'write' }] });
  await host.input('project_name=acme/queued');

  const emitted = [];
  let cancel = true;
  const session = {
    sessionManager: manager,
    agent: { state: { messages: [] } },
    _extensionRunner: {
      hasHandlers: name => name === 'session_before_tree',
      emit: async event => {
        emitted.push(event.type);
        if (event.type === 'session_before_tree' && cancel) return { cancel: true };
        return host.emit(event.type, event);
      },
    },
  };
  const navigate = id => AgentSession.prototype.navigateTree.call(session, id);
  assert.equal((await navigate(originalLeaf)).cancelled, true);
  assert.equal(manager.getLeafId(), changedLeaf);
  assert.equal(await host.search(), 'acme/changed');
  cancel = false;
  assert.equal((await navigate(originalLeaf)).cancelled, false);
  assert.deepEqual(emitted, ['session_before_tree', 'session_before_tree', 'session_tree']);
  assert.equal(manager.getBranch().at(-1).data.projectName, 'acme/original');
  // No reload/session_start: tools and commands must immediately use this branch.
  assert.equal(await host.search(), 'acme/original');
  await host.command('reqall-persist');
  assert.match(messages.at(-1), /project_name="acme\/original"/);
  assert.match((await host.start('continue without a label')).systemPrompt, /acme\/original/);
  assert.equal(manager.getLeafId(), originalLeaf, 'abandoned pending input must not be committed');
  const count = messages.length;
  await host.emit('agent_end', { messages: [{ toolName: 'write' }] });
  assert.equal(messages.length, count + 1, 'abandoned persistence guard must be cleared');
  assert.match(messages.at(-1), /project_name="acme\/original"/);

  await navigate(changedLeaf);
  assert.equal(await host.search(), 'acme/changed');
  await navigate(root);
  assert.equal(await host.search(), fallbackProject, 'a branch without a selection must clear the old binding');
  assert.doesNotMatch((await host.start('unlabelled root')).systemPrompt, /acme\/(original|changed|queued)/);
}, { inMemory: true }));

test('actual loader: skill operation targets never replace the session selection', async () => fixture(async ({ host, messages }) => {
  await host.emit('session_start', { reason: 'startup' });
  await host.input('project_name=acme/original');
  await host.start('work');
  for (const skill of ['sleep', 'context', 'persist', 'document', 'review', 'triage']) {
    const input = `/skill:reqall-${skill} project_name=.user`;
    await host.input(input);
    const baseDir = join(source, 'skills', `reqall-${skill}`);
    const expanded = AgentSession.prototype._expandSkillCommand.call({
      resourceLoader: { getSkills: () => ({ skills: [{ name: `reqall-${skill}`, baseDir, filePath: join(baseDir, 'SKILL.md') }] }) },
    }, input);
    assert.match(expanded, /<skill name=/);
    assert.ok(expanded.endsWith('project_name=.user'));
    await host.start(expanded);
    assert.equal(await host.search(), 'acme/original', skill);
    await host.command('reqall-persist');
    assert.match(messages.at(-1), /project_name="acme\/original"/);
  }
  await host.input('project_name=acme/next');
  await host.start('ordinary user selection');
  assert.equal(await host.search(), 'acme/next');
}));

test('actual loader: streaming input cannot redirect active tools or persistence', async () => fixture(async ({ host, messages }) => {
  await host.emit('session_start', { reason: 'startup' });
  await host.input('project_name=acme/original');
  assert.match((await host.start('work')).systemPrompt, /acme\/original/);
  // Exercise the installed host's real input-before-queue path, without a model/network.
  const queued = [];
  await AgentSession.prototype.prompt.call({
    _tryExecuteExtensionCommand: async () => false,
    _extensionRunner: { hasHandlers: () => true, emitInput: text => host.input(text) },
    _expandSkillCommand: text => text, promptTemplates: [], isStreaming: true,
    _queueFollowUp: async text => queued.push(text),
  }, 'project_name=acme/queued', { streamingBehavior: 'followUp' });
  assert.deepEqual(queued, ['project_name=acme/queued']);
  assert.equal(await host.search(), 'acme/original');
  for (const command of ['reqall-context', 'reqall-persist', 'reqall-review', 'reqall-triage', 'reqall-sleep']) {
    await host.command(command);
    assert.match(messages.at(-1), /acme\/original/);
  }
  assert.equal(await host.search('.user'), '.user');
  assert.equal(await host.search(), 'acme/original');
  await host.emit('agent_end', { messages: [{ toolName: 'write' }] });
  assert.match(messages.at(-1), /project_name="acme\/original"/);
  await host.input(messages.at(-1), 'extension');
  assert.match((await host.start(messages.at(-1))).systemPrompt, /acme\/original/);
  assert.equal(await host.search(), 'acme/original');
  await host.emit('agent_end', { messages: [] });
  assert.match((await host.start(queued[0])).systemPrompt, /acme\/queued/);
  assert.equal(await host.search(), 'acme/queued');
}));
