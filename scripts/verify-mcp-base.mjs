#!/usr/bin/env node
import assert from 'node:assert/strict';

const baseUrl = (process.env.REQALL_URL || process.env.REQALL_API_URL || 'https://www.reqall.net').replace(/\/+$/, '');
const apiKey = process.env.REQALL_API_KEY;
const docsUrl = process.env.REQALL_MCP_DOCS_URL || `${baseUrl}/docs/mcp.md`;
const projectName = process.env.REQALL_VERIFY_PROJECT_NAME || 'ReqallSystem/pi-plugin-mcp-verify';
const protocolVersion = '2025-06-18';

if (!apiKey) {
  console.error('REQALL_API_KEY is required to verify Reqall MCP base functionality.');
  process.exit(2);
}

let requestId = 1;

function contentToText(result) {
  return (result?.content || [])
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('\n');
}

function parseSseResponse(text, id) {
  const responses = [];
  let data = [];
  const flush = () => {
    if (data.length === 0) return;
    const payload = data.join('\n').trim();
    data = [];
    if (!payload || payload === '[DONE]') return;
    responses.push(JSON.parse(payload));
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();

  return responses.find((response) => response.id === id) || responses.find((response) => response.result || response.error);
}

function parseRpcResponse(text, id) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Empty MCP response');
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) return parseSseResponse(trimmed, id);
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed.find((response) => response.id === id) || parsed[0] : parsed;
}

async function callMcp(name, args = {}) {
  const id = requestId++;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}: ${text}`);
  const rpc = parseRpcResponse(text, id);
  if (!rpc) throw new Error(`${name}: no JSON-RPC response`);
  if (rpc.error) throw new Error(`${name}: JSON-RPC error ${rpc.error.code ?? ''} ${rpc.error.message ?? ''}`.trim());
  if (rpc.result?.isError) throw new Error(`${name}: ${contentToText(rpc.result)}`);
  return { result: rpc.result, text: contentToText(rpc.result) };
}

function parseFirstId(text, label) {
  const match = text.match(/#(\d+)/);
  assert(match, `${label}: expected an id in output, got:\n${text}`);
  return Number(match[1]);
}

function extractDocTools(markdown) {
  return [...markdown.matchAll(/^###\s+([a-z_]+)\s*$/gm)].map((match) => match[1]);
}

const createdRecordIds = [];
let createdLinkId;

async function cleanup() {
  if (createdLinkId !== undefined) {
    try {
      await callMcp('delete_link', { id: createdLinkId });
      console.log(`cleanup: deleted link #${createdLinkId}`);
    } catch (error) {
      console.warn(`cleanup warning: could not delete link #${createdLinkId}: ${error.message}`);
    }
  }

  for (const id of createdRecordIds.reverse()) {
    try {
      await callMcp('delete_record', { id });
      console.log(`cleanup: deleted record #${id}`);
    } catch (error) {
      console.warn(`cleanup warning: could not delete record #${id}: ${error.message}`);
    }
  }
}

async function main() {
  const docsResponse = await fetch(docsUrl);
  assert.equal(docsResponse.ok, true, `docs fetch failed: ${docsResponse.status}`);
  const docs = await docsResponse.text();
  const docTools = extractDocTools(docs);
  const expectedTools = [
    'search',
    'get_record',
    'list_records',
    'list_projects',
    'upsert_project',
    'upsert_record',
    'delete_record',
    'upsert_link',
    'delete_link',
    'list_links',
    'impact',
  ];
  assert.deepEqual(docTools, expectedTools, 'deployed MCP docs tool list changed; update the Pi wrapper/test');
  console.log(`PASS docs tool list (${docTools.length} tools)`);

  const head = await fetch(`${baseUrl}/mcp`, { method: 'HEAD' });
  assert.equal(head.ok, true, `HEAD /mcp failed: ${head.status}`);
  assert.equal(head.headers.get('MCP-Protocol-Version'), protocolVersion, 'unexpected MCP protocol version');
  console.log(`PASS HEAD /mcp protocol version ${protocolVersion}`);

  const runId = `pi-plugin-mcp-base-${Date.now().toString(36)}`;
  const phrase = 'Purple narwhal verifies semantic retrieval for temporary smoke testing';

  const projects = await callMcp('list_projects');
  assert.match(projects.text, /#\d+\s+/, 'list_projects should return project summaries');
  console.log('PASS list_projects');

  const project = await callMcp('upsert_project', { name: projectName });
  const projectId = parseFirstId(project.text, 'upsert_project');
  console.log(`PASS upsert_project -> #${projectId}`);

  const recordA = await callMcp('upsert_record', {
    project_id: projectId,
    kind: 'spec',
    title: `TEST TEMP: ${phrase} source ${runId}`,
    body: `${phrase}. Temporary source record ${runId}. This record should be deleted by the verifier cleanup. ${phrase}.`,
    status: 'open',
  });
  assert(!recordA.text.includes('embedding skipped'), `upsert_record A was flagged and not embedded:\n${recordA.text}`);
  const recordAId = parseFirstId(recordA.text, 'upsert_record A');
  createdRecordIds.push(recordAId);
  console.log(`PASS upsert_record A -> #${recordAId}`);

  const recordB = await callMcp('upsert_record', {
    project_id: projectId,
    kind: 'todo',
    title: `TEST TEMP: ${phrase} target ${runId}`,
    body: `${phrase}. Temporary target record ${runId}. This record should be deleted by the verifier cleanup. ${phrase}.`,
    status: 'open',
  });
  assert(!recordB.text.includes('embedding skipped'), `upsert_record B was flagged and not embedded:\n${recordB.text}`);
  const recordBId = parseFirstId(recordB.text, 'upsert_record B');
  createdRecordIds.push(recordBId);
  console.log(`PASS upsert_record B -> #${recordBId}`);

  const fullRecord = await callMcp('get_record', { id: recordAId });
  assert(fullRecord.text.includes(runId), 'get_record should include the temporary run id');
  console.log('PASS get_record');

  const listed = await callMcp('list_records', { project_id: projectId, status: 'open', limit: 100 });
  assert(listed.text.includes(`#${recordAId}`), 'list_records should include record A');
  assert(listed.text.includes(`#${recordBId}`), 'list_records should include record B');
  console.log('PASS list_records');

  const searched = await callMcp('search', { query: phrase, project_name: projectName, limit: 10 });
  assert(
    searched.text.includes(`#${recordAId}`) || searched.text.includes(`#${recordBId}`),
    `search should find at least one temporary record, got:\n${searched.text}`,
  );
  console.log('PASS search');

  const link = await callMcp('upsert_link', {
    source_id: recordAId,
    source_table: 'records',
    target_id: recordBId,
    target_table: 'records',
    relationship: 'related',
  });
  createdLinkId = parseFirstId(link.text, 'upsert_link');
  console.log(`PASS upsert_link -> #${createdLinkId}`);

  const links = await callMcp('list_links', { entity_id: recordAId, entity_type: 'records', direction: 'outgoing' });
  assert(links.text.includes(`#${createdLinkId}`), 'list_links should include the created link');
  console.log('PASS list_links');

  const impact = await callMcp('impact', { entity_id: recordAId, entity_type: 'records', max_depth: 3 });
  assert(impact.text.includes(`#${recordBId}`), 'impact should include downstream target record');
  console.log('PASS impact');

  await callMcp('delete_link', { id: createdLinkId });
  console.log(`PASS delete_link #${createdLinkId}`);
  createdLinkId = undefined;

  await callMcp('delete_record', { id: recordBId });
  console.log(`PASS delete_record #${recordBId}`);
  createdRecordIds.splice(createdRecordIds.indexOf(recordBId), 1);

  await callMcp('delete_record', { id: recordAId });
  console.log(`PASS delete_record #${recordAId}`);
  createdRecordIds.splice(createdRecordIds.indexOf(recordAId), 1);

  console.log(`PASS Reqall MCP base verification against ${docsUrl}`);
}

main()
  .catch(async (error) => {
    console.error(`FAIL ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(cleanup);
