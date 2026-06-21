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

const fs = require('fs');
const os = require('os');
const path = require('path');
const YAML = require('js-yaml');
const PipelineGenerator = require('../src/pipeline-generator');

describe('PipelineGenerator v2', () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('generateSampleConfig emits v2 semantic messages', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const outputPath = path.join(tempDir, 'sample.yaml');

    await generator.generateSampleConfig(outputPath);

    const config = YAML.load(fs.readFileSync(outputPath, 'utf8'));
    expect(config.version).toBe(2);
    expect(config.platform).toBe('COMPUTE');
    expect(config.messages.CustomerInput.fields[0].type).toBe('uuid');
    expect(config.messages.ValidationOutput.fields[1].type).toBe('bool');
    expect(config.steps[0].inputTypeName).toBe('CustomerInput');
    expect(config.steps[0].outputTypeName).toBe('CustomerOutput');
  });

  test('loadConfig normalizes FUNCTION platform aliases', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'platform-alias.yaml');
    fs.writeFileSync(configPath, `version: 2
appName: FunctionApp
basePackage: com.example.function
transport: REST
platform: lambda
runtimeLayout: modular
messages:
  Request:
    fields:
      - number: 1
        name: id
        type: uuid
  Response:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Handle Request
    cardinality: ONE_TO_ONE
    inputTypeName: Request
    outputTypeName: Response
`);

    const config = generator.loadConfig(configPath);
    expect(config.platform).toBe('FUNCTION');
  });

  test('generateFromConfig preserves platform in the copied config and generated parent pom', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'function-config.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: FunctionApp
basePackage: com.example.function
transport: REST
platform: FUNCTION
runtimeLayout: MODULAR
messages:
  Request:
    fields:
      - number: 1
        name: id
        type: uuid
  Response:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Handle Request
    cardinality: ONE_TO_ONE
    inputTypeName: Request
    outputTypeName: Response
`);

    await generator.generateFromConfig(configPath, outputDir);

    const copiedConfig = fs.readFileSync(path.join(outputDir, 'config', 'pipeline.yaml'), 'utf8');
    const parentPom = fs.readFileSync(path.join(outputDir, 'pom.xml'), 'utf8');
    const commonPom = fs.readFileSync(path.join(outputDir, 'common', 'pom.xml'), 'utf8');
    expect(copiedConfig).toContain('platform: FUNCTION');
    expect(parentPom).toContain('<tpf.build.platform>FUNCTION</tpf.build.platform>');
    expect(parentPom).toContain('-Apipeline.platform=${tpf.build.platform}');
    expect(parentPom).toMatch(/<id>default-compile<\/id>[\s\S]*?<goal>compile<\/goal>/);
    for (const roleExecutionId of [
      'compile-orchestrator-client',
      'compile-pipeline-server',
      'compile-plugin-client',
      'compile-plugin-server',
      'compile-rest-server'
    ]) {
      expect(parentPom).toMatch(new RegExp(`<id>${roleExecutionId}</id>[\\s\\S]*?<goal>testCompile</goal>`));
    }
    expect(commonPom).toContain('<id>default-compile</id>');
    expect(commonPom).toContain('<compilerArgs combine.self="override" />');
    expect(commonPom).toContain('<id>make-index-orchestrator-client</id>');
    expect(commonPom).toContain('<id>make-index-plugin-client</id>');
    expect(commonPom).toContain('<phase>none</phase>');
    expect(parentPom).not.toContain('protobuf.version');
    expect(commonPom).not.toContain('unpack-google-proto');
    expect(commonPom).not.toContain('protobuf-java');
    expect(commonPom).not.toContain('google/protobuf/*.proto');
    expect(commonPom).not.toContain('com/google/protobuf');
  });

  test('generateFromConfig emits generated poms against TPF framework 26.6.2', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'version-config.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: VersionApp
basePackage: com.example.versionapp
transport: GRPC
runtimeLayout: MODULAR
messages:
  Request:
    fields:
      - number: 1
        name: id
        type: uuid
  Response:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Check Version
    cardinality: ONE_TO_ONE
    inputTypeName: Request
    outputTypeName: Response
`);

    await generator.generateFromConfig(configPath, outputDir);

    const pomPaths = [
      path.join(outputDir, 'pom.xml'),
      path.join(outputDir, 'common', 'pom.xml'),
      path.join(outputDir, 'check-version-svc', 'pom.xml'),
      path.join(outputDir, 'orchestrator-svc', 'pom.xml')
    ];

    for (const pomPath of pomPaths) {
      const pom = fs.readFileSync(pomPath, 'utf8');
      expect(pom).toContain('<version>26.6.2</version>');
      expect(pom).not.toContain('<version>26.5.2</version>');
      expect(pom).not.toContain('<version>26.2.2</version>');
    }
  });

  test('generateFromConfig emits protobuf map accessors for map fields', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'map-config.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: MapApp
basePackage: com.example.mapapp
transport: GRPC
runtimeLayout: MODULAR
messages:
  CrawlRequest:
    fields:
      - number: 1
        name: docId
        type: uuid
      - number: 2
        name: fetchHeaders
        type: map
        keyType: string
        valueType: string
  CrawlResult:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Crawl Page
    cardinality: ONE_TO_ONE
    inputTypeName: CrawlRequest
    outputTypeName: CrawlResult
`);

    await generator.generateFromConfig(configPath, outputDir);

    const mapper = fs.readFileSync(
      path.join(outputDir, 'common', 'src', 'main', 'java', 'com', 'example', 'mapapp', 'common', 'mapper', 'CrawlRequestMapper.java'),
      'utf8'
    );
    expect(mapper).toContain('implements Mapper<CrawlRequest, CrawlRequestDto>');
    expect(mapper).toContain('target.fetchHeaders = external.fetchHeaders;');
    expect(mapper).toContain('target.fetchHeaders = domain.fetchHeaders;');
    expect(mapper).not.toContain('getFetchHeaders().putAll');
  });

  test('generateFromConfig emits only the active runtime mapping for monolith scaffolds', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'restaurant-approval.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: RestaurantApproval
basePackage: com.example.restaurant.approval
transport: REST
platform: COMPUTE
runtimeLayout: MONOLITH
messages:
  ApprovalRequest:
    fields:
      - number: 1
        name: restaurantId
        type: uuid
      - number: 2
        name: requestedBy
        type: string
  ApprovalDecision:
    fields:
      - number: 1
        name: restaurantId
        type: uuid
      - number: 2
        name: decision
        type: string
steps:
  - name: Validate Restaurant Request
    cardinality: ONE_TO_ONE
    inputTypeName: ApprovalRequest
    outputTypeName: ApprovalDecision
`);

    await generator.generateFromConfig(configPath, outputDir);

    const activeRuntimeMapping = YAML.load(
      fs.readFileSync(path.join(outputDir, 'config', 'pipeline.runtime.yaml'), 'utf8')
    );
    expect(activeRuntimeMapping.layout).toBe('monolith');
    expect(fs.existsSync(path.join(outputDir, 'config', 'runtime-mapping'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'config', 'runtime-mapping', 'pipeline-runtime-active.yaml'))).toBe(false);
  });

  test('toScaffoldConfig derives legacy field bindings from v2 messages', () => {
    const generator = new PipelineGenerator();
    const config = {
      version: 2,
      appName: 'TestApp',
      basePackage: 'com.example.test',
      transport: 'GRPC',
      runtimeLayout: 'MODULAR',
      messages: {
        ChargeRequest: {
          fields: [
            { number: 1, name: 'orderId', type: 'uuid' },
            { number: 2, name: 'amount', type: 'decimal' }
          ]
        },
        ChargeResult: {
          fields: [
            { number: 1, name: 'paymentId', type: 'uuid' },
            { number: 2, name: 'auditTrail', type: 'string', repeated: true }
          ]
        }
      },
      steps: [
        {
          name: 'Charge Card',
          cardinality: 'ONE_TO_ONE',
          inputTypeName: 'ChargeRequest',
          outputTypeName: 'ChargeResult'
        }
      ]
    };

    const scaffold = generator.toScaffoldConfig(config);
    const step = scaffold.steps[0];

    expect(step.inputTypeName).toBe('ChargeRequest');
    expect(step.outputTypeName).toBe('ChargeResult');
    expect(step.inputFields.map((field) => field.name)).toEqual(['orderId', 'amount']);
    expect(step.inputFields[0].type).toBe('UUID');
    expect(step.inputFields[0].protoType).toBe('string');
    expect(step.inputFields[1].type).toBe('BigDecimal');
    expect(step.outputFields[1].type).toBe('List<String>');
    expect(step.outputFields[1].protoType).toBe('string');
  });

  test('loadConfig accepts remote execution metadata for v2 steps', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'remote-config.yaml');
    fs.writeFileSync(configPath, `version: 2
appName: TestApp
basePackage: com.example.test
transport: REST
runtimeLayout: MODULAR
messages:
  ChargeRequest:
    fields:
      - number: 1
        name: orderId
        type: uuid
  ChargeResult:
    fields:
      - number: 1
        name: paymentId
        type: uuid
steps:
  - name: Charge Card
    cardinality: ONE_TO_ONE
    inputTypeName: ChargeRequest
    outputTypeName: ChargeResult
    execution:
      mode: REMOTE
      operatorId: charge-card
      protocol: PROTOBUF_HTTP_V1
      timeoutMs: 3000
      target:
        urlConfigKey: tpf.remote-operators.charge-card.url
`);

    const config = generator.loadConfig(configPath);
    expect(config.steps[0].execution.mode).toBe('REMOTE');
    expect(config.steps[0].execution.operatorId).toBe('charge-card');
    expect(config.steps[0].execution.protocol).toBe('PROTOBUF_HTTP_V1');
    expect(config.steps[0].execution.timeoutMs).toBe(3000);
    expect(config.steps[0].execution.target.urlConfigKey).toBe('tpf.remote-operators.charge-card.url');
  });

  test('loadConfig accepts structurally valid v2 await step config', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'await-config.yaml');
    fs.writeFileSync(configPath, `version: 2
appName: AwaitApp
basePackage: com.example.awaitapp
transport: REST
runtimeLayout: MODULAR
messages:
  PaymentRequest:
    fields:
      - number: 1
        name: paymentId
        type: uuid
  PaymentResult:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Await Payment Provider
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PaymentRequest
    outputTypeName: PaymentResult
    timeout: PT2M
    idempotencyKeyFields:
      - paymentId
    await:
      correlation:
        strategy: idempotency-key
      transport:
        type: kafka
        config:
          topic: payment-requests
`);

    const config = generator.loadConfig(configPath);

    expect(config.steps[0].kind).toBe('await');
    expect(config.steps[0].await.transport.type).toBe('kafka');
  });

  test('generateFromConfig scaffolds REST await union DTOs and mapper plumbing', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'restaurant-approval.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: RestaurantApproval
basePackage: com.example.restaurantapproval
transport: REST
platform: COMPUTE
runtimeLayout: MONOLITH
messages:
  PendingRestaurantApproval:
    fields:
      - number: 1
        name: orderId
        type: uuid
      - number: 2
        name: restaurantName
        type: string
  RestaurantOrderAccepted:
    fields:
      - number: 1
        name: orderId
        type: uuid
      - number: 2
        name: decidedAt
        type: timestamp
      - number: 3
        name: note
        type: string
  RestaurantOrderDeclined:
    fields:
      - number: 1
        name: orderId
        type: uuid
      - number: 2
        name: decidedAt
        type: timestamp
      - number: 3
        name: note
        type: string
      - number: 4
        name: declineReason
        type: string
  TerminalOrderState:
    fields:
      - number: 1
        name: orderId
        type: uuid
      - number: 2
        name: outcome
        type: string
unions:
  RestaurantDecision:
    variants:
      accepted:
        number: 1
        type: RestaurantOrderAccepted
      declined:
        number: 2
        type: RestaurantOrderDeclined
steps:
  - name: Await Restaurant Decision
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PendingRestaurantApproval
    outputTypeName: RestaurantDecision
    timeout: PT30M
    idempotencyKeyFields:
      - orderId
    await:
      correlation:
        strategy: interactionId
      transport:
        type: interaction-api
  - name: Finalize Restaurant Decision
    cardinality: ONE_TO_ONE
    inputTypeName: RestaurantDecision
    outputTypeName: TerminalOrderState
`);

    await generator.generateFromConfig(configPath, outputDir);

    const javaRoot = path.join(outputDir, 'common', 'src', 'main', 'java', 'com', 'example', 'restaurantapproval', 'common');
    const decisionDto = fs.readFileSync(path.join(javaRoot, 'dto', 'RestaurantDecisionDto.java'), 'utf8');
    const acceptedDto = fs.readFileSync(path.join(javaRoot, 'dto', 'RestaurantOrderAcceptedDto.java'), 'utf8');
    const serializer = fs.readFileSync(path.join(javaRoot, 'dto', 'RestaurantDecisionDtoJsonSerializer.java'), 'utf8');
    const deserializer = fs.readFileSync(path.join(javaRoot, 'dto', 'RestaurantDecisionDtoJsonDeserializer.java'), 'utf8');
    const mapper = fs.readFileSync(path.join(javaRoot, 'mapper', 'RestaurantDecisionMapper.java'), 'utf8');

    expect(decisionDto).toContain('public sealed interface RestaurantDecisionDto');
    expect(decisionDto).toContain('permits RestaurantOrderAcceptedDto, RestaurantOrderDeclinedDto');
    expect(acceptedDto).toContain('implements RestaurantDecisionDto');
    expect(serializer).toContain('gen.writeStringField("type", "accepted")');
    expect(serializer).toContain('gen.writeObjectField("accepted", variant)');
    expect(deserializer).toContain('treeToValue(payload(node, "declined"), RestaurantOrderDeclinedDto.class)');
    expect(mapper).toContain('implements Mapper<RestaurantDecision, RestaurantDecisionDto>');
    expect(mapper).toContain('external instanceof RestaurantOrderAcceptedDto source');
    expect(mapper).toContain('domain instanceof RestaurantOrderDeclined source');
    expect(fs.existsSync(path.join(outputDir, 'await-restaurant-decision-svc'))).toBe(false);
    expect(fs.existsSync(path.join(javaRoot, 'domain', 'RestaurantDecision.java'))).toBe(true);
    expect(fs.existsSync(path.join(javaRoot, 'domain', 'RestaurantOrderAccepted.java'))).toBe(true);
  });

  test('generateFromConfig scaffolds Quarkus Kafka await runtime wiring', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'kafka-await.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: KafkaAwaitApp
basePackage: com.example.kafkaawait
transport: REST
platform: COMPUTE
runtimeLayout: MODULAR
messages:
  PaymentRequest:
    fields:
      - number: 1
        name: paymentId
        type: uuid
  PaymentResult:
    fields:
      - number: 1
        name: paymentId
        type: uuid
      - number: 2
        name: status
        type: string
steps:
  - name: Await Payment Provider
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PaymentRequest
    outputTypeName: PaymentResult
    timeout: PT2M
    idempotencyKeyFields:
      - paymentId
    await:
      correlation:
        strategy: interactionId
      transport:
        type: Kafka
        request:
          topic: payment.requests
        response:
          topic: payment.results
        consumer:
          group: payment-await-orchestrator
`);

    await generator.generateFromConfig(configPath, outputDir);

    const pom = fs.readFileSync(path.join(outputDir, 'orchestrator-svc', 'pom.xml'), 'utf8');
    const applicationProperties = fs.readFileSync(
      path.join(outputDir, 'orchestrator-svc', 'src', 'main', 'resources', 'application.properties'),
      'utf8'
    );

    expect(pom).toContain('<artifactId>quarkus-messaging-kafka</artifactId>');
    expect(applicationProperties).toContain('pipeline.orchestrator.mode=QUEUE_ASYNC');
    expect(applicationProperties).toContain('pipeline.orchestrator.resume-token-secret=${TPF_RESUME_TOKEN_SECRET}');
    expect(applicationProperties).toContain('tpf.await.kafka.reactive-messaging.enabled=true');
    expect(applicationProperties).toContain('mp.messaging.outgoing.tpf-await-kafka-requests.topic=payment.requests');
    expect(applicationProperties).toContain('mp.messaging.incoming.tpf-await-kafka-responses.topic=payment.results');
    expect(applicationProperties).toContain('mp.messaging.incoming.tpf-await-kafka-responses.group.id=${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:payment-await-orchestrator}');
  });

  test('generateFromConfig rejects Kafka await scaffolds with multiple topics per runtime module', async () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'multi-kafka-await.yaml');
    const outputDir = path.join(tempDir, 'generated-app');
    fs.writeFileSync(configPath, `version: 2
appName: KafkaAwaitApp
basePackage: com.example.kafkaawait
transport: REST
platform: COMPUTE
runtimeLayout: MODULAR
messages:
  PaymentRequest:
    fields:
      - number: 1
        name: paymentId
        type: uuid
  PaymentResult:
    fields:
      - number: 1
        name: paymentId
        type: uuid
  SettlementResult:
    fields:
      - number: 1
        name: paymentId
        type: uuid
steps:
  - name: Await Payment Provider
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PaymentRequest
    outputTypeName: PaymentResult
    timeout: PT2M
    idempotencyKeyFields:
      - paymentId
    await:
      correlation:
        strategy: interactionId
      transport:
        type: kafka
        request:
          topic: payment.requests
        response:
          topic: payment.results
  - name: Await Settlement Provider
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PaymentResult
    outputTypeName: SettlementResult
    timeout: PT2M
    idempotencyKeyFields:
      - paymentId
    await:
      correlation:
        strategy: interactionId
      transport:
        type: kafka
        request:
          topic: settlement.requests
        response:
          topic: settlement.results
`);

    await expect(generator.generateFromConfig(configPath, outputDir))
      .rejects
      .toThrow('one request topic per generated runtime module');
  });

  test('loadConfig rejects await config missing required structural fields', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'invalid-await-config.yaml');
    fs.writeFileSync(configPath, `version: 2
appName: AwaitApp
basePackage: com.example.awaitapp
transport: REST
runtimeLayout: MODULAR
messages:
  PaymentRequest:
    fields:
      - number: 1
        name: paymentId
        type: uuid
  PaymentResult:
    fields:
      - number: 1
        name: status
        type: string
steps:
  - name: Await Payment Provider
    kind: await
    cardinality: ONE_TO_ONE
    inputTypeName: PaymentRequest
    outputTypeName: PaymentResult
    timeout: PT2M
    await:
      correlation:
        strategy: idempotency-key
      transport:
        config:
          topic: payment-requests
`);

    expect(() => generator.loadConfig(configPath)).toThrow('Configuration validation failed');
  });

  test('loadConfig rejects non-integer version values', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'invalid-version.yaml');
    fs.writeFileSync(configPath, `version: "2"
appName: TestApp
basePackage: com.example.test
transport: GRPC
runtimeLayout: MODULAR
steps: []
`);

    expect(() => generator.loadConfig(configPath)).toThrow(
      'Configuration version must be a positive integer'
    );
  });

  test('toScaffoldConfig rejects missing top-level message definitions', () => {
    const generator = new PipelineGenerator();
    const config = {
      version: 2,
      appName: 'TestApp',
      basePackage: 'com.example.test',
      transport: 'GRPC',
      runtimeLayout: 'MODULAR',
      messages: {},
      steps: [
        {
          name: 'Charge Card',
          cardinality: 'ONE_TO_ONE',
          inputTypeName: 'ChargeRequest',
          outputTypeName: 'ChargeResult'
        }
      ]
    };

    expect(() => generator.toScaffoldConfig(config)).toThrow("Missing message definition for 'ChargeRequest'");
  });

  test('toScaffoldConfig rejects conflicting inline and top-level fields', () => {
    const generator = new PipelineGenerator();
    const config = {
      version: 2,
      appName: 'TestApp',
      basePackage: 'com.example.test',
      transport: 'GRPC',
      runtimeLayout: 'MODULAR',
      messages: {
        ChargeRequest: {
          fields: [{ number: 1, name: 'orderId', type: 'uuid' }]
        },
        ChargeResult: {
          fields: [{ number: 1, name: 'paymentId', type: 'uuid' }]
        }
      },
      steps: [
        {
          name: 'Charge Card',
          cardinality: 'ONE_TO_ONE',
          inputTypeName: 'ChargeRequest',
          inputFields: [{ number: 1, name: 'orderId', type: 'string' }],
          outputTypeName: 'ChargeResult'
        }
      ]
    };

    expect(() => generator.toScaffoldConfig(config)).toThrow('Conflicting inline vs top-level field definitions');
  });

  test('toScaffoldConfig accepts equivalent inline and top-level fields in different orders', () => {
    const generator = new PipelineGenerator();
    const config = {
      version: 2,
      appName: 'TestApp',
      basePackage: 'com.example.test',
      transport: 'GRPC',
      runtimeLayout: 'MODULAR',
      messages: {
        ChargeRequest: {
          fields: [
            { number: 2, name: 'amount', type: 'decimal' },
            { number: 1, name: 'orderId', type: 'uuid' }
          ]
        },
        ChargeResult: {
          fields: [{ number: 1, name: 'paymentId', type: 'uuid' }]
        }
      },
      steps: [
        {
          name: 'Charge Card',
          cardinality: 'ONE_TO_ONE',
          inputTypeName: 'ChargeRequest',
          inputFields: [
            { number: 1, name: 'orderId', type: 'uuid' },
            { number: 2, name: 'amount', type: 'decimal' }
          ],
          outputTypeName: 'ChargeResult'
        }
      ]
    };

    expect(() => generator.toScaffoldConfig(config)).not.toThrow();
  });

  test('loadConfig rejects LOCAL execution with remote-only fields', () => {
    const generator = new PipelineGenerator();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-generator-'));
    const configPath = path.join(tempDir, 'local-execution-config.yaml');
    fs.writeFileSync(configPath, `version: 2
appName: TestApp
basePackage: com.example.test
transport: REST
runtimeLayout: MODULAR
messages:
  ChargeRequest:
    fields:
      - number: 1
        name: orderId
        type: uuid
  ChargeResult:
    fields:
      - number: 1
        name: paymentId
        type: uuid
steps:
  - name: Charge Card
    cardinality: ONE_TO_ONE
    inputTypeName: ChargeRequest
    outputTypeName: ChargeResult
    execution:
      mode: LOCAL
      operatorId: charge-card
`);

    expect(() => generator.loadConfig(configPath)).toThrow('Configuration validation failed');
  });

  test('toScaffoldField preserves message references for repeated and map fields', () => {
    const generator = new PipelineGenerator();

    const repeatedMessage = generator.toScaffoldField({
      number: 1,
      name: 'customers',
      type: 'Customer',
      repeated: true
    });
    const mapWithMessageValue = generator.toScaffoldField({
      number: 2,
      name: 'customerById',
      type: 'map',
      keyType: 'string',
      valueType: 'Customer'
    });

    expect(repeatedMessage.type).toBe('List<Customer>');
    expect(repeatedMessage.protoType).toBe('Customer');
    expect(mapWithMessageValue.type).toBe('Map<String, Customer>');
    expect(mapWithMessageValue.protoType).toBe('map<string, Customer>');
  });
});
