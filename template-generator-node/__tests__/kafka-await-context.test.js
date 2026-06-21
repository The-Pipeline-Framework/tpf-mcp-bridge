/*
 * Copyright (c) 2023-2025 Mariano Barcia
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const path = require('path');
const HandlebarsTemplateEngine = require('../src/handlebars-template-engine');
const BrowserTemplateEngine = require('../src/browser-template-engine');

// Helpers for constructing test step data
function makeKafkaAwaitStep(requestTopic, responseTopic, consumerGroup) {
  return {
    name: 'Await Something',
    kind: 'await',
    cardinality: 'ONE_TO_ONE',
    inputTypeName: 'Input',
    outputTypeName: 'Output',
    await: {
      correlation: { strategy: 'interactionId' },
      transport: {
        type: 'kafka',
        request: requestTopic != null ? { topic: requestTopic } : undefined,
        response: responseTopic != null ? { topic: responseTopic } : undefined,
        consumer: consumerGroup != null ? { group: consumerGroup } : undefined
      }
    }
  };
}

function makeNonKafkaAwaitStep(transportType) {
  return {
    name: 'Await Something',
    kind: 'await',
    cardinality: 'ONE_TO_ONE',
    inputTypeName: 'Input',
    outputTypeName: 'Output',
    await: {
      correlation: { strategy: 'interactionId' },
      transport: { type: transportType }
    }
  };
}

function makeRegularStep() {
  return {
    name: 'Process Something',
    cardinality: 'ONE_TO_ONE',
    inputTypeName: 'Input',
    outputTypeName: 'Output'
  };
}

describe('createKafkaAwaitContext – HandlebarsTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    engine = new HandlebarsTemplateEngine(path.join(__dirname, '../templates'));
  });

  test('returns null when steps array is empty', () => {
    expect(engine.createKafkaAwaitContext([], 'MyApp')).toBeNull();
  });

  test('returns null when steps is undefined', () => {
    expect(engine.createKafkaAwaitContext(undefined, 'MyApp')).toBeNull();
  });

  test('returns null when steps is null', () => {
    expect(engine.createKafkaAwaitContext(null, 'MyApp')).toBeNull();
  });

  test('returns null when no step has kind=await', () => {
    expect(engine.createKafkaAwaitContext([makeRegularStep()], 'MyApp')).toBeNull();
  });

  test('returns null when await steps use non-kafka transport types', () => {
    const steps = [
      makeNonKafkaAwaitStep('sqs'),
      makeNonKafkaAwaitStep('webhook'),
      makeNonKafkaAwaitStep('interaction-api')
    ];
    expect(engine.createKafkaAwaitContext(steps, 'MyApp')).toBeNull();
  });

  test('returns null when await step transport type is missing', () => {
    const step = {
      kind: 'await',
      await: { transport: {} }
    };
    expect(engine.createKafkaAwaitContext([step], 'MyApp')).toBeNull();
  });

  test('returns context object for single kafka await step', () => {
    const steps = [makeKafkaAwaitStep('payment.requests', 'payment.results', 'payment-group')];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('payment.requests');
    expect(ctx.responseTopic).toBe('payment.results');
    expect(ctx.consumerGroup).toBe('payment-group');
    expect(ctx.consumerGroupProperty).toBe('${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:payment-group}');
  });

  test('matches kafka transport type case-insensitively (Kafka)', () => {
    const step = makeKafkaAwaitStep('req.topic', 'res.topic', 'my-group');
    step.await.transport.type = 'Kafka';
    const ctx = engine.createKafkaAwaitContext([step], 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('req.topic');
  });

  test('matches kafka transport type case-insensitively (KAFKA)', () => {
    const step = makeKafkaAwaitStep('req.topic', 'res.topic', 'my-group');
    step.await.transport.type = 'KAFKA';
    const ctx = engine.createKafkaAwaitContext([step], 'MyApp');
    expect(ctx).not.toBeNull();
  });

  test('defaults consumerGroup to appName-derived value when not specified', () => {
    const steps = [makeKafkaAwaitStep('req.topic', 'res.topic', null)];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx.consumerGroup).toBe('myapp-orchestrator');
    expect(ctx.consumerGroupProperty).toBe('${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:myapp-orchestrator}');
  });

  test('derives consumerGroup from appName with special characters replaced', () => {
    const steps = [makeKafkaAwaitStep('req.topic', 'res.topic', null)];
    const ctx = engine.createKafkaAwaitContext(steps, 'My_App');
    expect(ctx.consumerGroup).toBe('my-app-orchestrator');
  });

  test('derives consumerGroup from multi-word appName', () => {
    const steps = [makeKafkaAwaitStep('req.topic', 'res.topic', null)];
    const ctx = engine.createKafkaAwaitContext(steps, 'KafkaAwaitApp');
    expect(ctx.consumerGroup).toBe('kafkaawaitapp-orchestrator');
  });

  test('throws when request topic is missing', () => {
    const steps = [makeKafkaAwaitStep(null, 'payment.results', 'group')];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('Kafka await scaffold requires await.transport.request.topic.');
  });

  test('throws when response topic is missing', () => {
    const steps = [makeKafkaAwaitStep('payment.requests', null, 'group')];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('Kafka await scaffold requires await.transport.response.topic.');
  });

  test('throws when multiple distinct request topics are present', () => {
    const steps = [
      makeKafkaAwaitStep('payment.requests', 'payment.results', null),
      makeKafkaAwaitStep('settlement.requests', 'settlement.results', null)
    ];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('one request topic per generated runtime module');
  });

  test('throws when multiple distinct response topics are present', () => {
    const steps = [
      makeKafkaAwaitStep('payment.requests', 'payment.results', null),
      makeKafkaAwaitStep('payment.requests', 'settlement.results', null)
    ];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('one response topic per generated runtime module');
  });

  test('deduplicates identical request topics from multiple kafka steps', () => {
    const steps = [
      makeKafkaAwaitStep('payment.requests', 'payment.results', 'my-group'),
      makeKafkaAwaitStep('payment.requests', 'payment.results', 'my-group')
    ];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('payment.requests');
    expect(ctx.responseTopic).toBe('payment.results');
  });

  test('ignores non-kafka await steps when computing topics', () => {
    const steps = [
      makeNonKafkaAwaitStep('sqs'),
      makeKafkaAwaitStep('payment.requests', 'payment.results', 'my-group')
    ];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('payment.requests');
  });

  test('ignores regular (non-await) steps when computing topics', () => {
    const steps = [
      makeRegularStep(),
      makeKafkaAwaitStep('req.topic', 'res.topic', 'grp')
    ];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('req.topic');
  });

  test('uses config.topic as fallback when request section is absent', () => {
    const step = {
      kind: 'await',
      await: {
        transport: {
          type: 'kafka',
          config: { topic: 'fallback.requests' },
          response: { topic: 'payment.results' }
        }
      }
    };
    const ctx = engine.createKafkaAwaitContext([step], 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('fallback.requests');
  });

  test('consumerGroupProperty embeds consumerGroup in property expression', () => {
    const steps = [makeKafkaAwaitStep('req.topic', 'res.topic', 'explicit-group')];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx.consumerGroupProperty).toBe('${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:explicit-group}');
  });
});

describe('awaitTransportString – HandlebarsTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    engine = new HandlebarsTemplateEngine(path.join(__dirname, '../templates'));
  });

  test('extracts string value from nested transport section', () => {
    const step = makeKafkaAwaitStep('my.topic', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBe('my.topic');
  });

  test('returns null when step is null', () => {
    expect(engine.awaitTransportString(null, 'request', 'topic')).toBeNull();
  });

  test('returns null when step is undefined', () => {
    expect(engine.awaitTransportString(undefined, 'request', 'topic')).toBeNull();
  });

  test('returns null when await property is missing', () => {
    expect(engine.awaitTransportString({ kind: 'await' }, 'request', 'topic')).toBeNull();
  });

  test('returns null when transport is missing', () => {
    expect(engine.awaitTransportString({ await: {} }, 'request', 'topic')).toBeNull();
  });

  test('returns null when section key is missing', () => {
    const step = makeKafkaAwaitStep('my.topic', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'config', 'topic')).toBeNull();
  });

  test('returns null when value is empty string', () => {
    const step = makeKafkaAwaitStep('', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBeNull();
  });

  test('returns null when value is whitespace only', () => {
    const step = makeKafkaAwaitStep('   ', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBeNull();
  });

  test('returns null when value is not a string (number)', () => {
    const step = { await: { transport: { request: { topic: 42 } } } };
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBeNull();
  });

  test('trims leading and trailing whitespace', () => {
    const step = { await: { transport: { request: { topic: '  my.topic  ' } } } };
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBe('my.topic');
  });
});

describe('uniqueNonBlank – HandlebarsTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    engine = new HandlebarsTemplateEngine(path.join(__dirname, '../templates'));
  });

  test('returns unique non-blank values', () => {
    expect(engine.uniqueNonBlank(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('deduplicates repeated values', () => {
    expect(engine.uniqueNonBlank(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  test('filters out empty strings', () => {
    expect(engine.uniqueNonBlank(['a', '', 'b'])).toEqual(['a', 'b']);
  });

  test('filters out whitespace-only strings', () => {
    expect(engine.uniqueNonBlank(['a', '   ', 'b'])).toEqual(['a', 'b']);
  });

  test('filters out null values', () => {
    expect(engine.uniqueNonBlank(['a', null, 'b'])).toEqual(['a', 'b']);
  });

  test('filters out undefined values', () => {
    expect(engine.uniqueNonBlank(['a', undefined, 'b'])).toEqual(['a', 'b']);
  });

  test('filters out non-string values', () => {
    expect(engine.uniqueNonBlank(['a', 42, 'b'])).toEqual(['a', 'b']);
  });

  test('returns empty array for empty input', () => {
    expect(engine.uniqueNonBlank([])).toEqual([]);
  });

  test('returns empty array for null input', () => {
    expect(engine.uniqueNonBlank(null)).toEqual([]);
  });

  test('returns empty array for undefined input', () => {
    expect(engine.uniqueNonBlank(undefined)).toEqual([]);
  });

  test('returns empty array when all values are blank', () => {
    expect(engine.uniqueNonBlank(['', '   ', null, undefined])).toEqual([]);
  });
});

describe('createKafkaAwaitContext – BrowserTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    // BrowserTemplateEngine accepts a templates object; empty object avoids disk I/O
    engine = new BrowserTemplateEngine({});
  });

  test('returns null when steps array is empty', () => {
    expect(engine.createKafkaAwaitContext([], 'MyApp')).toBeNull();
  });

  test('returns null when steps is undefined', () => {
    expect(engine.createKafkaAwaitContext(undefined, 'MyApp')).toBeNull();
  });

  test('returns null for non-kafka await steps', () => {
    const steps = [makeNonKafkaAwaitStep('sqs')];
    expect(engine.createKafkaAwaitContext(steps, 'MyApp')).toBeNull();
  });

  test('returns context object for single kafka await step', () => {
    const steps = [makeKafkaAwaitStep('payment.requests', 'payment.results', 'payment-group')];
    const ctx = engine.createKafkaAwaitContext(steps, 'MyApp');
    expect(ctx).not.toBeNull();
    expect(ctx.requestTopic).toBe('payment.requests');
    expect(ctx.responseTopic).toBe('payment.results');
    expect(ctx.consumerGroup).toBe('payment-group');
    expect(ctx.consumerGroupProperty).toBe('${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:payment-group}');
  });

  test('matches kafka transport type case-insensitively', () => {
    const step = makeKafkaAwaitStep('req.topic', 'res.topic', 'grp');
    step.await.transport.type = 'Kafka';
    const ctx = engine.createKafkaAwaitContext([step], 'MyApp');
    expect(ctx).not.toBeNull();
  });

  test('defaults consumerGroup to appName-derived value when not specified', () => {
    const steps = [makeKafkaAwaitStep('req.topic', 'res.topic', null)];
    const ctx = engine.createKafkaAwaitContext(steps, 'PaymentApp');
    expect(ctx.consumerGroup).toBe('paymentapp-orchestrator');
  });

  test('throws when request topic is missing', () => {
    const steps = [makeKafkaAwaitStep(null, 'payment.results', 'group')];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('Kafka await scaffold requires await.transport.request.topic.');
  });

  test('throws when response topic is missing', () => {
    const steps = [makeKafkaAwaitStep('payment.requests', null, 'group')];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('Kafka await scaffold requires await.transport.response.topic.');
  });

  test('throws when multiple distinct request topics are present', () => {
    const steps = [
      makeKafkaAwaitStep('payment.requests', 'payment.results', null),
      makeKafkaAwaitStep('settlement.requests', 'settlement.results', null)
    ];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('one request topic per generated runtime module');
  });

  test('throws when multiple distinct response topics are present', () => {
    const steps = [
      makeKafkaAwaitStep('payment.requests', 'payment.results', null),
      makeKafkaAwaitStep('payment.requests', 'settlement.results', null)
    ];
    expect(() => engine.createKafkaAwaitContext(steps, 'MyApp'))
      .toThrow('one response topic per generated runtime module');
  });
});

describe('awaitTransportString – BrowserTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    engine = new BrowserTemplateEngine({});
  });

  test('extracts string value from nested transport section', () => {
    const step = makeKafkaAwaitStep('my.topic', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBe('my.topic');
  });

  test('returns null when step is null', () => {
    expect(engine.awaitTransportString(null, 'request', 'topic')).toBeNull();
  });

  test('returns null when value is empty string', () => {
    const step = makeKafkaAwaitStep('', 'res.topic', null);
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBeNull();
  });

  test('trims leading and trailing whitespace', () => {
    const step = { await: { transport: { request: { topic: '  my.topic  ' } } } };
    expect(engine.awaitTransportString(step, 'request', 'topic')).toBe('my.topic');
  });
});

describe('uniqueNonBlank – BrowserTemplateEngine', () => {
  let engine;

  beforeAll(() => {
    engine = new BrowserTemplateEngine({});
  });

  test('returns unique non-blank values', () => {
    expect(engine.uniqueNonBlank(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('deduplicates repeated values', () => {
    expect(engine.uniqueNonBlank(['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  test('filters out empty strings and null values', () => {
    expect(engine.uniqueNonBlank(['a', '', null, 'b'])).toEqual(['a', 'b']);
  });

  test('returns empty array for null input', () => {
    expect(engine.uniqueNonBlank(null)).toEqual([]);
  });
});