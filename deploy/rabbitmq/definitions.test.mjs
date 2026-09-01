import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const definitions = JSON.parse(
  await readFile(new URL('./definitions.json', import.meta.url), 'utf8'),
);
const bootstrap = await readFile(new URL('./start.sh', import.meta.url), 'utf8');

test('every worker command family is routed to its durable queue', () => {
  const expected = new Map([
    ['nix.worker.import.v1', ['import.#', 'template.#', 'file.#', 'object.#']],
    ['nix.worker.export.v1', ['export.#']],
  ]);

  for (const [queue, routingKeys] of expected) {
    const configured = definitions.bindings
      .filter(
        (binding) =>
          binding.source === 'nix.commands.v1' &&
          binding.destination_type === 'queue' &&
          binding.destination === queue,
      )
      .map((binding) => binding.routing_key);
    assert.deepEqual(configured.sort(), [...routingKeys].sort(), queue);
  }
});

test('the API publisher may emit every command family bound by the topology', () => {
  assert.match(
    bootstrap,
    /\^\(import\|template\|file\|object\|export\)\\\.\.\+\$/,
  );
});

test('worker queues retain commands and dead-letter refused deliveries', () => {
  for (const name of [
    'nix.worker.import.v1',
    'nix.worker.export.v1',
    'nix.worker.index.v1',
    'nix.worker.plugin-events.v1',
    'nix.api.results.v1',
  ]) {
    const queue = definitions.queues.find((candidate) => candidate.name === name);
    assert.ok(queue, `${name} is declared`);
    assert.equal(queue.durable, true, `${name} is durable`);
    assert.equal(queue.arguments['x-queue-type'], 'quorum', `${name} is a quorum queue`);
    assert.equal(
      queue.arguments['x-dead-letter-exchange'],
      'nix.dead.v1',
      `${name} dead-letters refused deliveries`,
    );
  }
});

test('authoritative queues cannot lose work to the quorum default delivery limit', () => {
  const policy = definitions.policies.find(
    (candidate) => candidate.name === 'nix-authoritative-delivery',
  );
  assert.ok(policy, 'the authoritative queue policy is declared');
  assert.equal(policy.vhost, '/nix');
  assert.equal(policy['apply-to'], 'quorum_queues');
  assert.equal(policy.definition['delivery-limit'], -1);
  assert.equal(policy.priority, 100);

  for (const name of [
    'nix.worker.import.v1',
    'nix.worker.export.v1',
    'nix.worker.plugin-events.v1',
  ]) {
    assert.match(name, new RegExp(policy.pattern, 'u'), `${name} is protected`);
  }
  assert.doesNotMatch(
    'nix.worker.index.v1',
    new RegExp(policy.pattern, 'u'),
    'the rebuildable index queue keeps its bounded poison-message policy',
  );
  assert.doesNotMatch(
    'nix.api.results.v1',
    new RegExp(policy.pattern, 'u'),
    'worker results use a bounded poison-message policy',
  );
});

test('rebuildable events and poison results have bounded dead-letter paths', () => {
  for (const name of ['nix.worker.index.v1', 'nix.api.results.v1']) {
    const queue = definitions.queues.find((candidate) => candidate.name === name);
    assert.ok(queue, `${name} is declared`);
    assert.equal(queue.arguments['x-delivery-limit'], 5, `${name} bounds redelivery`);
    assert.equal(queue.arguments['x-dead-letter-exchange'], 'nix.dead.v1');
  }
  assert.ok(
    definitions.bindings.some(
      (binding) =>
        binding.source === 'nix.dead.v1' &&
        binding.destination === 'nix.dead.v1' &&
        binding.routing_key === '#',
    ),
    'dead-letter exchange is retained by a durable queue',
  );
});

test('broker retry delays are not duplicated outside the durable Postgres scheduler', () => {
  assert.equal(
    definitions.exchanges.some((exchange) => exchange.name.startsWith('nix.retry.')),
    false,
  );
  assert.equal(
    definitions.queues.some((queue) => queue.name.startsWith('nix.retry.')),
    false,
  );
  assert.equal(
    definitions.bindings.some((binding) => binding.source.startsWith('nix.retry.')),
    false,
  );
  assert.equal(
    definitions.queues.some((queue) => 'x-message-ttl' in queue.arguments),
    false,
  );
});
