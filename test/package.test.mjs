import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
// Pi's loader is internal; resolve it relative to its installed entrypoint.
const { loadExtensions } = await import(new URL('./core/extensions/loader.js', import.meta.resolve('@mariozechner/pi-coding-agent')));

test('npm tarball ships policy and six aligned skills and loads through Pi', async () => {
  const temp = mkdtempSync(resolve('.package-test-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', join(temp, packed[0].filename), '-C', temp]);
    const root = join(temp, 'package');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.pi.extensions, ['./extensions/reqall.ts']);
    assert.equal(readFileSync(join(root, 'extensions/project-policy.ts'), 'utf8'), readFileSync('extensions/project-policy.ts', 'utf8'));
    const skills = readdirSync(join(root, 'skills'));
    assert.equal(skills.length, 6);
    for (const name of skills) {
      const text = readFileSync(join(root, 'skills', name, 'SKILL.md'), 'utf8');
      for (const token of ['supplied', 'REQALL_PROJECT_NAME', 'origin', 'project_name', '.reqall.yml', 'package.json', 'go.mod', 'Cargo.toml', 'REQALL_WORKSPACE_ROOT', '.reqall-workspace', '.machine/', '.user', '64 KiB', 'symlinks', 'UNC']) assert.ok(text.includes(token), `${name}: ${token}`);
      assert.doesNotMatch(text, /then directory basename|falling back to the current directory basename|→ dir basename/);
      for (const token of ['pending selection', 'custom session entries', 'startup/resume/reload/fork', '/skill:reqall-sleep project_name=.user']) assert.ok(text.includes(token), `${name}: lifecycle ${token}`);
    }
    const loaded = await loadExtensions(manifest.pi.extensions.map(p => resolve(root, p)), root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.deepEqual([...extension.tools.keys()].sort(), ['reqall_search', 'reqall_upsert_project', 'reqall_upsert_record', 'reqall_get_record', 'reqall_list_records', 'reqall_list_projects', 'reqall_upsert_link', 'reqall_list_links', 'reqall_impact', 'reqall_delete_record', 'reqall_delete_link', 'reqall_sleep_candidates', 'reqall_sleep_apply', 'reqall_project_context'].sort());
    assert.equal(extension.commands.size, 5);
    assert.ok(extension.handlers.has('input'));
    assert.ok(extension.handlers.has('before_agent_start'));
    const childEnv = { ...process.env, REQALL_TEST_PACKAGE: root };
    delete childEnv.NODE_TEST_CONTEXT; // Otherwise Node silently skips nested --test runs.
    const output = execFileSync(process.execPath, ['--test', 'test/runtime.test.mjs', 'test/lifecycle.test.mjs'], { env: childEnv, encoding: 'utf8' });
    assert.match(output, /(?:pass 5|# pass 5)/);
    console.log('Packaged routing suite:\n' + output);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
