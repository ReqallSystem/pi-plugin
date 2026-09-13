import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const source = resolve(process.env.REQALL_TEST_PACKAGE || '.');
const compiled = mkdtempSync(resolve('.runtime-test-'));
for (const name of ['reqall', 'project-policy', 'capabilities']) {
  const text = readFileSync(join(source, 'extensions', `${name}.ts`), 'utf8');
  writeFileSync(join(compiled, `${name}.js`), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
}
const { default: plugin } = await import(pathToFileURL(join(compiled, 'reqall.js')));
process.on('exit', () => rmSync(compiled, { recursive: true, force: true }));

test('actual Pi handlers retain labelled selection across context and workflows', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-routing-'));
  const oldEnv = { ...process.env }; const oldFetch = globalThis.fetch;
  const calls = [], messages = [], events = new Map(), tools = new Map(), commands = new Map();
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith('REQALL_')) delete process.env[key];
    Object.assign(process.env, { REQALL_API_KEY: 'fixture-only', REQALL_URL: 'http://fixture.invalid', REQALL_AUTO_PERSIST: 'followup' });
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://fixture.invalid/mcp');
      const rpc = JSON.parse(options.body);
      if (rpc.method === 'tools/list') return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [] } }));
      calls.push(rpc.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: rpc.params.name === 'upsert_project' ? 'Project #42' : '[]' }] } }));
    };
    const entries = [];
    plugin({ appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), on: (name, fn) => events.set(name, fn), registerTool: t => tools.set(t.name, t), registerCommand: (name, c) => commands.set(name, c), sendMessage: m => messages.push(m.content), sendUserMessage: m => messages.push(m) });
    const ctx = { cwd, hasUI: false, sessionManager: { getBranch: () => entries, getSessionId: () => 'fixture-session' } };
    await events.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx);
    // Existing host must actually register a supported user-input hook.
    assert.equal(typeof events.get('input'), 'function');
    const input = async (text, source = 'interactive') => events.get('input')({ type: 'input', text, source }, ctx);
    const turn = async prompt => events.get('before_agent_start')({ type: 'before_agent_start', prompt, systemPrompt: 'base' }, ctx);
    await input('Use project_name="acme/selected"');
    assert.match((await turn('do work')).systemPrompt, /acme\/selected/);
    assert.equal(calls.findLast(c => c.name === 'search').arguments.project_name, 'acme/selected');
    await input('continue work on arbitrary/path');
    await input('project_name="wrong/extension"', 'extension');
    await turn('[reqall] project_name="wrong/generated"');
    await tools.get('reqall_project_context').execute('id', { query: 'context' }, undefined, undefined, ctx);
    assert.equal(calls.findLast(c => c.name === 'search').arguments.project_name, 'acme/selected');
    for (const command of ['reqall-context', 'reqall-persist', 'reqall-review', 'reqall-triage', 'reqall-sleep']) {
      await commands.get(command).handler('', ctx);
      assert.match(messages.at(-1), /acme\/selected/);
    }
    await events.get('agent_end')({ messages: [{ toolName: 'write' }] }, ctx);
    assert.match(messages.at(-1), /acme\/selected/);
    await tools.get('reqall_project_context').execute('id', { query: 'other', project_name: '.user' }, undefined, undefined, ctx);
    assert.equal(calls.findLast(c => c.name === 'search').arguments.project_name, '.user');
    await commands.get('reqall-persist').handler('', ctx);
    assert.match(messages.at(-1), /acme\/selected/);
    await tools.get('reqall_search').execute('id', { query: 'default scope' }, undefined, undefined, ctx);
    assert.equal(calls.at(-1).arguments.project_name, 'acme/selected');
    await tools.get('reqall_search').execute('id', { query: 'other scope', project_name: '.user' }, undefined, undefined, ctx);
    assert.equal(calls.at(-1).arguments.project_name, '.user');
    await commands.get('reqall-sleep').handler('.user', ctx);
    assert.match(messages.at(-1), /project_name="\.user"/);
    assert.doesNotMatch(messages.at(-1), /acme\/selected/);
    await commands.get('reqall-sleep').handler('123', ctx);
    assert.match(messages.at(-1), /project_id=123/);
    await commands.get('reqall-persist').handler('', ctx);
    assert.match(messages.at(-1), /acme\/selected/);
    process.env.REQALL_PROJECT_NAME = '  explicit/env  ';
    assert.match((await turn('continue')).systemPrompt, /explicit\/env/);
    delete process.env.REQALL_PROJECT_NAME;
    execFileSync('git', ['init', '-q', cwd]);
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', 'https://github.com/acme/git.git']);
    assert.match((await turn('continue')).systemPrompt, /acme\/git/);
    execFileSync('git', ['-C', cwd, 'remote', 'remove', 'origin']);
    await input('project: next/selection.');
    assert.match((await turn('continue')).systemPrompt, /next\/selection/);
    await input("project='legacy/manual name'", 'rpc');
    assert.match((await turn('continue')).systemPrompt, /legacy\/manual name/);
    await input('project_name=`backtick/project`');
    assert.match((await turn('continue')).systemPrompt, /backtick\/project/);
    await tools.get('reqall_upsert_record').execute('id', { project_id: 99, kind: 'todo', title: 'Fixture' }, undefined, undefined, ctx);
    assert.equal(calls.at(-1).arguments.project_id, 99);
    await tools.get('reqall_sleep_apply').execute('id', { project_id: 98, operations: [] }, undefined, undefined, ctx);
    assert.equal(calls.at(-1).arguments.project_id, 98);
    await events.get('session_start')({ type: 'session_start', reason: 'new' }, ctx);
    assert.match((await turn('plain folder')).systemPrompt, /\.machine\//);
    writeFileSync(join(cwd, '.reqall.yml'), 'project: portable/metadata\n');
    assert.match((await turn('metadata')).systemPrompt, /portable\/metadata/);
    // Exercise canonical portable fallback through the actual registered hook.
    rmSync(join(cwd, '.reqall.yml'));
    writeFileSync(join(cwd, 'package.json'), '{"name":"@portable/package"}');
    assert.match((await turn('package')).systemPrompt, /portable\/package/);
    execFileSync('git', ['-C', cwd, 'remote', 'add', 'origin', '/local/nonportable.git']);
    assert.match((await turn('local git falls through')).systemPrompt, /portable\/package/);
    writeFileSync(join(cwd, '.reqall.yml'), 'project: /invalid/absolute\n');
    assert.match((await turn('invalid metadata')).systemPrompt, /portable\/package/);
    rmSync(join(cwd, 'package.json'));
    writeFileSync(join(cwd, 'go.mod'), '// leading comment\nmodule example.com/team/component/v2\n');
    assert.match((await turn('go')).systemPrompt, /example.com\/team\/component\/v2/);
    rmSync(join(cwd, 'go.mod'));
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "cargo-project"\n[[bin]]\nname = "wrong-bin"\n');
    assert.match((await turn('cargo')).systemPrompt, /cargo-project/);
    rmSync(join(cwd, 'Cargo.toml'));
    const nested = join(cwd, 'src', 'work');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(cwd, '.reqall-workspace'), '');
    ctx.cwd = nested;
    assert.match((await turn('workspace')).systemPrompt, /src\/work/);
    ctx.cwd = cwd;
    assert.match((await turn('root has no relative name')).systemPrompt, /\.machine\//);
    const outside = mkdtempSync(join(tmpdir(), 'pi-outside-'));
    try {
      symlinkSync(outside, join(cwd, 'escape'));
      ctx.cwd = join(cwd, 'escape');
      process.env.REQALL_WORKSPACE_ROOT = cwd;
      assert.match((await turn('symlink escape')).systemPrompt, /\.machine\//);
    } finally { rmSync(outside, { recursive: true, force: true }); }
    ctx.cwd = nested;
    process.env.REQALL_WORKSPACE_ROOT = join(cwd, 'missing-root');
    assert.match((await turn('invalid root cannot use marker')).systemPrompt, /\.machine\//);
  } finally {
    globalThis.fetch = oldFetch;
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(cwd, { recursive: true, force: true });
  }
});
