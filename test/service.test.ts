import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import YAML from "js-yaml";
import JSZip from "jszip";
import {
  analyzeBriefTool,
  BriefSessionService,
  createLocalBridgeHandlers,
  createMcpSamplingPlannerClient,
  createHeuristicPlannerClient,
  createOpenAiPlannerClient,
  createHostedBridgeHandlers,
  formatBridgeConfigSummary,
  readBridgeConfig,
  scaffoldFromBriefTool,
} from "../src/index.js";
import { InMemoryArtifactStore, InMemorySessionStore, LocalFileArtifactStore } from "../src/storage.js";
import { generateScaffoldZip, validateDerivedConfig } from "../src/template-bridge.js";
import { BriefSessionDurableObject, InMemoryKv, InMemoryR2Bucket, handleWorkerRequest } from "../src/worker.js";
import type { DerivedConfig, PlannerDraft, SessionResult, SessionStartInput, SessionState } from "../src/types.js";
import { analyzePlannerDraft } from "../src/planner-analysis.js";

const structuredBackendBrief = `
# Customer Registration Backend

Build a backend API for customer registration and response handling.

## API Call Parameters
| Field | Mandatory | Type |
| --- | --- | --- |
| customerId | M | uuid |
| email | M | string |
| referralCode | O | string |

## API Response
| Field | Mandatory | Type |
| --- | --- | --- |
| customerId | M | uuid |
| status | M | string |
| message | O | string |
`;

const onboardingBrief = `
User Story: Core Onboarding Backend System (MVP)
Story Title: Secure & Incremental User Onboarding Profile Creation
User Persona: New End-User (End-User), System Administrator (System)
1. The "Why" & "What"
As a new user,
I want to create my account and provide my required personal information in multiple stages,
So that I can join the platform quickly without being overwhelmed by a single, long form, and resume later if needed.
As a system admin/business owner,
I want the backend to validate user input in real-time and secure all data at rest,
So that I can ensure compliance, minimize incomplete applications, and protect user privacy.
2. Value Proposition
Reduced Friction: Allows users to save progress, increasing completion rates.
Data Integrity: Validates inputs before database ingestion.
Scalability: Modular design allows for adding future steps.
3. High-Level Requirements
Registration: Enable user creation using unique identifiers (e.g., email or mobile).
State Management: Track the current status of onboarding (e.g., Draft, Pending Verification, Active).
Data Persistence: Save inputs for personal info, address, and security credentials securely.
Resume Functionality: Allow a user to return and continue from the last completed stage.
Data Validation: Ensure all mandatory fields are present and in the correct format before advancing.
Secure Storage: All personal and identification data must be encrypted.
4. Acceptance Criteria
AC1: Given I am a new user, when I register with an email and password, then I receive a "Draft" account and a unique ID.
AC2: Given I am in a "Draft" state, when I submit partial profile data (e.g., first name, last name), then the system saves this data and enables me to resume.
AC3: Given I am filling out the form, when I skip a mandatory field, then the system rejects the request and indicates which field is required.
AC4: Given I have completed all required fields, when I click finish, then my account status changes to "Pending Verification."
AC5: Given my data is stored, when a data audit is performed, then all personally identifiable information (PII) is encrypted.
5. Potential Follow-up Stories (Future Sprints)
Integrate email verification service.
Integrate third-party KYC/Identity verification API.
Add automated onboarding metrics for admin dashboard.
`;

const onboardingBriefSingleLine = onboardingBrief.replace(/\s+/g, " ").trim();

test("analyze_brief defaults deployment choices and returns topology alternatives for structured backend briefs", async () => {
  const result = await analyzeBriefTool({
    briefText: structuredBackendBrief
  });

  assert.equal(result.status, "ready");
  assert.equal(result.pipelineSummary.transport, "REST");
  assert.equal(result.pipelineSummary.platform, "COMPUTE");
  assert.equal(result.pipelineSummary.selectedRuntimeLayout, "MONOLITH");
  assert.deepEqual(
    result.runtimeLayoutAlternatives.map((item) => item.layout),
    ["MONOLITH", "PIPELINE_RUNTIME", "MODULAR"]
  );
  assert.equal(result.contractQuestions.length, 0);
  assert.equal(result.businessSteps[0].id, "validate-customer-request");
  assert.equal(result.stepContracts[0].inputTypeName, "CustomerRequest");
  assert.equal(result.messageCatalog[0].id, "message.customerrequest");
});

test("start_brief_session returns structured contract questions for onboarding briefs", async () => {
  const { initialDraft } = buildOnboardingPlannerDrafts();
  const handlers = createLocalBridgeHandlers({
    llmEndpoint: "http://localhost:11434/v1",
    llmModel: "gemma4",
    llmToken: "ollama",
    providerFetchImpl: createPlannerProviderFetch([initialDraft])
  });

  const session = await handlers.startBriefSession({
    briefText: onboardingBrief
  });

  assert.equal(session.status, "needs_input");
  assert.ok(session.sessionId);
  assert.equal(session.pipelineSummary.transport, "REST");
  assert.equal(session.pipelineSummary.platform, "COMPUTE");
  assert.equal(session.selectedRuntimeLayout, "MONOLITH");
  assert.deepEqual(
    session.contractQuestions.map((question) => question.id).sort(),
    [
      "contract.address.fields",
      "contract.personal-info.fields",
      "contract.security-credentials.fields"
    ]
  );
  assert.ok(session.couplingFindings.length > 0);
});

test("openai-compatible planner adapter parses structured planner drafts", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  initialDraft.queries = {
    "recent-customer-by-id": {
      connector: "jpa",
      inputType: "CustomerRequest",
      outputType: "CustomerResponse",
      version: "v1",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          customerId: { eq: "input.customerId" },
          status: { in: ["ACTIVE", "PENDING"] },
          createdAt: { gte: "input.createdAfter" },
          deletedAt: { isNull: "true" }
        },
        orderBy: {
          createdAt: "DESC"
        },
        limit: 1,
        result: "single"
      }
    }
  };
  const planner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    fetchImpl: createPlannerProviderFetch([initialDraft])
  });

  const draft = await planner.planInitialBrief({ briefText: structuredBackendBrief });
  assert.equal(draft.title, initialDraft.title);
  assert.equal(draft.pipelineSteps[0]?.name, "Validate Customer Request");
  assert.deepEqual(draft.queries?.["recent-customer-by-id"].jpa.where.status, { in: ["ACTIVE", "PENDING"] });
  assert.deepEqual(draft.queries?.["recent-customer-by-id"].jpa.orderBy, { createdAt: "DESC" });
  assert.equal(draft.queries?.["recent-customer-by-id"].jpa.limit, 1);
});

test("openai-compatible planner adapter rejects invalid JPA predicate drafts", async () => {
  const invalidDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  invalidDraft.queries = {
    "bad-customer-query": {
      connector: "jpa",
      inputType: "CustomerRequest",
      outputType: "CustomerResponse",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          customerId: { in: [] }
        }
      }
    }
  };
  const planner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    fetchImpl: createPlannerProviderFetch([invalidDraft])
  });

  await assert.rejects(
    () => planner.planInitialBrief({ briefText: structuredBackendBrief }),
    /invalid draft/
  );
});

test("openai-compatible planner adapter rejects invalid JPA query identifiers", async () => {
  const invalidDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  invalidDraft.queries = {
    "bad-customer-query": {
      connector: "jpa",
      inputType: "CustomerRequest",
      outputType: "CustomerResponse",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          "bad field": "input.customerId"
        }
      }
    }
  };
  const planner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    fetchImpl: createPlannerProviderFetch([invalidDraft])
  });

  await assert.rejects(
    () => planner.planInitialBrief({ briefText: structuredBackendBrief }),
    /invalid draft/
  );
});

test("planner analysis rejects trimmed duplicate query and object source ids", async () => {
  const duplicateQueryDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  duplicateQueryDraft.queries = {
    "customer-risk": {
      connector: "jpa",
      inputType: "CustomerRequest",
      outputType: "CustomerResponse",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          customerId: "input.customerId"
        }
      }
    },
    " customer-risk ": {
      connector: "jpa",
      inputType: "CustomerRequest",
      outputType: "CustomerResponse",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          customerId: "input.customerId"
        }
      }
    }
  };
  assert.throws(
    () => analyzePlannerDraft({ briefText: structuredBackendBrief }, duplicateQueryDraft),
    /duplicate query 'customer-risk' after trimming ids/
  );

  const duplicateSourceDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  duplicateSourceDraft.sources = {
    documents: {
      kind: "object",
      provider: "filesystem",
      location: {
        root: "/var/tpf/inbox"
      }
    },
    " documents ": {
      kind: "object",
      provider: "filesystem",
      location: {
        root: "/var/tpf/inbox"
      }
    }
  };
  assert.throws(
    () => analyzePlannerDraft({ briefText: structuredBackendBrief }, duplicateSourceDraft),
    /duplicate object source 'documents' after trimming ids/
  );

  const missingQueryInputDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  missingQueryInputDraft.queries = {
    "customer-risk": {
      connector: "jpa",
      outputType: "CustomerResponse",
      jpa: {
        entity: "com.example.registration.common.domain.CustomerEntity",
        where: {
          customerId: "input.customerId"
        }
      }
    }
  };
  assert.throws(
    () => analyzePlannerDraft({ briefText: structuredBackendBrief }, missingQueryInputDraft),
    /must include inputType or input/
  );

  const missingProviderDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  missingProviderDraft.sources = {
    documents: {
      kind: "object",
      provider: "" as never,
      location: {
        root: "/var/tpf/inbox"
      }
    }
  };
  assert.throws(
    () => analyzePlannerDraft({ briefText: structuredBackendBrief }, missingProviderDraft),
    /object source 'documents' must include provider/
  );
});

test("ollama-native planner adapter uses /api/chat structured outputs and parses planner drafts", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  let requestUrl = "";
  let requestHeaders: Record<string, string> = {};
  let requestBody = "";
  const planner = createOpenAiPlannerClient({
    endpoint: "http://192.168.50.201:11434/v1",
    model: "qwen3:4b",
    token: "ollama",
    providerMode: "ollama-native",
    fetchImpl: async (input, init) => {
      const request = new Request(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, init);
      requestUrl = request.url;
      requestHeaders = Object.fromEntries(request.headers.entries());
      requestBody = await request.text();
      return new Response(JSON.stringify({
        model: "qwen3:4b",
        message: {
          role: "assistant",
          content: JSON.stringify(initialDraft)
        },
        done: true
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const draft = await planner.planInitialBrief({ briefText: structuredBackendBrief });
  assert.equal(draft.title, initialDraft.title);
  assert.equal(requestUrl, "http://192.168.50.201:11434/api/chat");
  assert.equal("authorization" in requestHeaders, false);
  const payload = JSON.parse(requestBody) as {
    stream: boolean;
    format: Record<string, unknown>;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(payload.stream, false);
  assert.equal(payload.format.type, "object");
  assert.ok(payload.messages[1]?.content.includes("Return JSON matching this schema exactly:"));
});

test("mcp-sampling planner adapter uses client sampling and parses planner drafts", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  let samplingRequest:
    | {
        systemPrompt?: string;
        maxTokens?: number;
        modelPreferences?: { hints?: Array<{ name?: string }> };
        messages: Array<{ role: string; content: unknown }>;
      }
    | undefined;
  const planner = createMcpSamplingPlannerClient({
    profile: "compact",
    modelHint: "gpt-5",
    host: {
      getClientCapabilities: () => ({ sampling: {} }),
      async createMessage(params) {
        samplingRequest = params as typeof samplingRequest;
        return {
          role: "assistant",
          model: "gpt-5",
          content: {
            type: "text",
            text: JSON.stringify(initialDraft)
          }
        };
      }
    }
  });

  const draft = await planner.planInitialBrief({ briefText: structuredBackendBrief });
  assert.equal(draft.title, initialDraft.title);
  assert.equal(samplingRequest?.modelPreferences?.hints?.[0]?.name, "gpt-5");
  assert.equal(samplingRequest?.maxTokens, 4000);
  assert.match(String(samplingRequest?.systemPrompt || ""), /TPF planning layer/i);
  const userMessage = samplingRequest?.messages[0];
  assert.equal(userMessage?.role, "user");
  assert.match(JSON.stringify(userMessage?.content), /Return JSON matching this schema exactly:/);
});

test("openai-compatible planner prompt encodes TPF semantic guardrails", async () => {
  const requests: string[] = [];
  const planner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    fetchImpl: async (_input, init) => {
      requests.push(String(init?.body || ""));
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief }))
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await planner.planInitialBrief({ briefText: structuredBackendBrief });
  const body = requests[0] || "";
  assert.match(body, /Persistence belongs to aspects\/plugins/i);
  assert.match(body, /step N\+1 input must equal step N output/i);
  assert.match(body, /resume or re-entry as a separate query\/resumption surface/i);
  assert.match(body, /replayability, idempotency, and checkpoint hand-offs/i);
  assert.match(body, /await steps/i);
});

test("compact planner profile uses a materially smaller prompt while preserving await guidance", async () => {
  const requests: string[] = [];
  const fullPlanner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    profile: "full",
    fetchImpl: async (_input, init) => {
      requests.push(String(init?.body || ""));
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief }))
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const compactPlanner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    profile: "compact",
    fetchImpl: async (_input, init) => {
      requests.push(String(init?.body || ""));
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief }))
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await fullPlanner.planInitialBrief({ briefText: onboardingBrief });
  await compactPlanner.planInitialBrief({ briefText: onboardingBrief });

  const fullBody = requests[0] || "";
  const compactBody = requests[1] || "";
  assert.ok(compactBody.length < fullBody.length);
  assert.match(compactBody, /await/i);
  assert.doesNotMatch(compactBody, /checkpoint hand-offs/i);
});

test("openai-compatible planner adapter surfaces provider quota errors clearly", async () => {
  const planner = createOpenAiPlannerClient({
    endpoint: "https://planner.example/v1",
    model: "gpt-5",
    token: "planner-token",
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota"
      }
    }), {
      status: 429,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    () => planner.planInitialBrief({ briefText: structuredBackendBrief }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match((error as Error).message, /quota exceeded/i);
      assert.match((error as Error).message, /insufficient_quota/);
      return true;
    }
  );
});

test("session service supports confirming a proposed contract answer", async () => {
  let revisedFields: string[] = [];
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        title: "Customer Registration Backend",
        primaryGoal: "Capture and validate customer registration data.",
        businessSteps: [
          {
            id: "validate-customer-request",
            name: "Validate Customer Request",
            purpose: "Check the incoming request contract.",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerValidatedRequest",
            inputFields: [
              { number: 1, name: "customerId", type: "uuid" }
            ],
            outputFields: [
              { number: 1, name: "customerId", type: "uuid" }
            ]
          }
        ],
        pipelineSteps: [
          {
            id: "validate-customer-request",
            name: "Validate Customer Request",
            cardinality: "ONE_TO_ONE",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerValidatedRequest",
            parallel: false
          }
        ],
        messageCatalog: [
          {
            id: "message.customerrequest",
            name: "CustomerRequest",
            fields: [
              { number: 1, name: "customerId", type: "uuid" }
            ]
          },
          {
            id: "message.customervalidatedrequest",
            name: "CustomerValidatedRequest",
            fields: [
              { number: 1, name: "customerId", type: "uuid" }
            ]
          }
        ],
        stepContracts: [
          {
            stepId: "validate-customer-request",
            stepName: "Validate Customer Request",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerValidatedRequest",
            inputFields: [{ number: 1, name: "customerId", type: "uuid" }],
            outputFields: [{ number: 1, name: "customerId", type: "uuid" }],
            continuity: "clarification_needed",
            rationale: "Need confirmation for optional fields."
          }
        ],
        contractQuestions: [
          {
            id: "contract.customer.fields",
            key: "stepContracts",
            stepId: "validate-customer-request",
            stepName: "Validate Customer Request",
            kind: "fields",
            messageTypeName: "CustomerRequest",
            prompt: "Confirm the inferred request fields.",
            expectedAnswerShape: {
              type: "fields",
              description: "Confirm or edit the inferred request fields."
            },
            proposedAnswer: {
              questionId: "contract.customer.fields",
              fields: [
                { name: "customerId", type: "uuid", required: true },
                { name: "email", type: "string", required: true }
              ]
            },
            resolutionModes: ["confirm", "edit", "replace"]
          }
        ],
        futureStepCandidates: [],
        assumptions: [],
        transport: "REST",
        platform: "COMPUTE",
        runtimeLayout: "MONOLITH"
      };
    },
    async revisePlanWithAnswers(_input: SessionStartInput, _previousDraft: PlannerDraft | undefined, answers: Record<string, { fields?: Array<{ name: string }> }>): Promise<PlannerDraft> {
      revisedFields = (answers["contract.customer.fields"]?.fields || []).map((field) => field.name);
      return {
        ...(await this.planInitialBrief()),
        contractQuestions: [],
        stepContracts: [
          {
            stepId: "validate-customer-request",
            stepName: "Validate Customer Request",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerValidatedRequest",
            inputFields: [
              { number: 1, name: "customerId", type: "uuid" },
              { number: 2, name: "email", type: "string" }
            ],
            outputFields: [
              { number: 1, name: "customerId", type: "uuid" },
              { number: 2, name: "email", type: "string" }
            ],
            continuity: "coherent",
            rationale: "Confirmed request fields."
          }
        ]
      };
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const started = await service.startSession({ briefText: structuredBackendBrief });
  const answered = await service.answerQuestions({
    sessionId: started.sessionId,
    answers: [
      {
        questionId: "contract.customer.fields",
        resolution: "confirm"
      }
    ]
  });

  assert.equal(answered.status, "ready");
  assert.deepEqual(revisedFields, ["customerId", "email"]);
});

test("analyze_brief extracts a bounded title, appName, and basePackage from single-line onboarding briefs", async () => {
  const result = await analyzeBriefTool({
    briefText: onboardingBriefSingleLine
  });

  assert.equal(result.pipelineSummary.title, "Secure & Incremental User Onboarding Profile Creation");
  assert.equal(result.derivedConfig.appName, "OnboardingCreation");
  assert.equal(result.derivedConfig.basePackage, "com.example.onboarding.creation");
  assert.ok(result.derivedConfig.basePackage.length <= 80);
});

test("answer_contract_questions resolves onboarding contract ambiguity and enables generation", async () => {
  const { initialDraft, revisedDraft } = buildOnboardingPlannerDrafts();
  const handlers = createLocalBridgeHandlers({
    llmEndpoint: "http://localhost:11434/v1",
    llmModel: "gemma4",
    llmToken: "ollama",
    providerFetchImpl: createPlannerProviderFetch([initialDraft, revisedDraft])
  });

  const session = await handlers.startBriefSession({
    briefText: onboardingBrief
  });

  const answered = await handlers.answerContractQuestions({
    sessionId: session.sessionId,
    answers: [
      {
        questionId: "contract.personal-info.fields",
        fields: [
          { name: "firstName", type: "string", required: true },
          { name: "lastName", type: "string", required: true },
          { name: "dateOfBirth", type: "timestamp", required: false }
        ]
      },
      {
        questionId: "contract.address.fields",
        fields: [
          { name: "streetLine1", type: "string", required: true },
          { name: "city", type: "string", required: true },
          { name: "postalCode", type: "string", required: true },
          { name: "countryCode", type: "string", required: true }
        ]
      },
      {
        questionId: "contract.security-credentials.fields",
        fields: [
          { name: "password", type: "string", required: true },
          { name: "passwordSalt", type: "string", required: false },
          { name: "acceptedTermsVersion", type: "string", required: true }
        ]
      }
    ]
  });

  assert.equal(answered.status, "ready");
  assert.equal(answered.contractQuestions.length, 0);
  assert.ok(answered.messageCatalog.some((message) =>
    message.name === "AddressStageState" && message.fields.some((field) => field.name === "postalCode")));

  const generated = await handlers.generateScaffold({
    sessionId: session.sessionId
  });
  assert.equal(generated.status, "generated");
  assert.ok(generated.artifact?.localPath);
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const fileNames = Object.keys(zip.files);
  assert.ok(fileNames.includes("pom.xml"));
  assert.ok(fileNames.includes("config/pipeline.yaml"));
  assert.ok(fileNames.includes("config/pipeline.runtime.yaml"));
  assert.ok(!fileNames.includes("pipeline-config.yaml"));
  assert.ok(!fileNames.some((name) => name.startsWith("config/runtime-mapping/")));
  assert.ok(fileNames.every((name) => name.length < 240));

  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  const runtimeMappingYaml = await zip.file("config/pipeline.runtime.yaml")!.async("string");
  const runtimeMapping = YAML.load(runtimeMappingYaml) as { layout?: string };
  assertNoDuplicateMessageFields(pipelineConfig);
  assert.equal(pipelineConfig.basePackage, "com.example.onboarding.creation");
  assert.equal(runtimeMapping.layout, "monolith");
  assert.ok(pipelineConfig.steps.every((step) => !/^save\b/i.test(step.name)));
});

test("await-step planner drafts survive normalization and scaffold ZIP generation", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        ...buildAwaitPlannerDraft(),
        runtimeLayout: "MODULAR"
      };
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return buildAwaitPlannerDraft();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Approve high-value wire transfers after an external fraud webhook responds.",
    platform: "COMPUTE"
  });
  assert.equal(session.status, "ready");
  assert.equal(session.inferredSteps[1]?.kind, "await");
  assert.equal(session.pipelineSummary.asyncMode, "CALLBACK_CAPABLE");

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  assert.equal(generated.status, "generated");
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  const awaitStep = pipelineConfig.steps.find((step) => step.name === "Await Fraud Decision");
  assert.equal(awaitStep?.kind, "await");
  assert.equal(awaitStep?.timeout, "PT10M");
  assert.deepEqual(awaitStep?.idempotencyKeyFields, ["transferId"]);
  assert.equal(awaitStep?.await?.transport.type, "webhook");
  const fileNames = Object.keys(zip.files);
  assert.ok(fileNames.some((name) => name.startsWith("validate-transfer-request-svc/")));
  assert.ok(fileNames.some((name) => name.startsWith("finalize-transfer-state-svc/")));
  assert.ok(!fileNames.some((name) => name.startsWith("await-fraud-decision-svc/")));
});

test("sqs await drafts generate queue-async scaffold guidance without a fake await module", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return buildSqsAwaitPlannerDraft();
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return buildSqsAwaitPlannerDraft();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Submit a provider request over SQS, await the provider response, then finalize.",
    platform: "COMPUTE"
  });
  assert.equal(session.status, "ready");
  assert.equal(session.inferredSteps[1]?.await?.transport.type, "sqs");

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  assert.equal(pipelineConfig.steps[1].await?.transport.type, "sqs");
  assert.equal(pipelineConfig.steps[1].await?.transport.request?.queueUrl, "https://sqs.example/request");
  assert.equal(pipelineConfig.steps[1].await?.transport.response?.queueUrl, "https://sqs.example/response");
  const fileNames = Object.keys(zip.files);
  assert.ok(!fileNames.some((name) => name.startsWith("await-fraud-decision-svc/")));
  const orchestratorPom = await zip.file("orchestrator-svc/pom.xml")!.async("string");
  assert.match(orchestratorPom, /quarkus-amazon-sqs/);
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /^tpf\.await\.sqs\.poller\.enabled=true$/m);
  assert.match(applicationProperties, /^tpf\.await\.sqs\.request-queue-url=\$\{TPF_AWAIT_SQS_REQUEST_QUEUE_URL\}$/m);
  assert.match(applicationProperties, /^tpf\.await\.sqs\.response-queue-url=\$\{TPF_AWAIT_SQS_RESPONSE_QUEUE_URL\}$/m);
  assert.match(applicationProperties, /^quarkus\.sqs\.aws\.region=\$\{AWS_REGION:us-east-1\}$/m);
});

test("kafka await drafts generate reactive messaging scaffold wiring without a fake await module", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return buildKafkaAwaitPlannerDraft();
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return buildKafkaAwaitPlannerDraft();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Submit a payment request over Kafka, await the provider response, then finalize.",
    platform: "COMPUTE"
  });
  assert.equal(session.status, "ready");
  assert.equal(session.inferredSteps[1]?.await?.transport.type, "kafka");

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  assert.equal(pipelineConfig.steps[1].await?.transport.type, "kafka");
  assert.equal(pipelineConfig.steps[1].await?.transport.request?.topic, "payment.requests");
  assert.equal(pipelineConfig.steps[1].await?.transport.response?.topic, "payment.results");
  const fileNames = Object.keys(zip.files);
  assert.ok(!fileNames.some((name) => name.startsWith("await-fraud-decision-svc/")));
  const orchestratorPom = await zip.file("orchestrator-svc/pom.xml")!.async("string");
  assert.match(orchestratorPom, /quarkus-messaging-kafka/);
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /tpf\.await\.kafka\.reactive-messaging\.enabled=true/);
  assert.match(applicationProperties, /mp\.messaging\.outgoing\.tpf-await-kafka-requests\.topic=payment\.requests/);
  assert.match(applicationProperties, /mp\.messaging\.incoming\.tpf-await-kafka-responses\.topic=payment\.results/);
  assert.ok(applicationProperties.includes("mp.messaging.incoming.tpf-await-kafka-responses.group.id=${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:payment-await-orchestrator}"));
});

test("kafka await scaffold includes kafka messaging dependency in pipeline-runtime-svc pom", async () => {
  const draft = buildKafkaAwaitPlannerDraft();
  draft.runtimeLayout = "PIPELINE_RUNTIME";
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return draft;
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return draft;
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Submit a payment request over Kafka, await the provider response, then finalize.",
    platform: "COMPUTE"
  });

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const runtimePom = await zip.file("pipeline-runtime-svc/pom.xml")?.async("string");
  assert.notEqual(runtimePom, undefined, "expected pipeline-runtime-svc/pom.xml to be generated");
  assert.match(runtimePom!, /quarkus-messaging-kafka/);
  // Confirm the await service module is not generated as a standalone service
  const fileNames = Object.keys(zip.files);
  assert.ok(!fileNames.some((name) => name.startsWith("await-fraud-decision-svc/")));
});

test("kafka await scaffold with no explicit consumer group defaults group id from app name", async () => {
  const draft = buildKafkaAwaitPlannerDraft();
  // Remove consumer group to force default derivation
  for (const step of [...draft.businessSteps, ...draft.pipelineSteps, ...draft.stepContracts]) {
    if (step.kind === "await" && step.await?.transport) {
      delete step.await.transport.consumer;
    }
  }

  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> { return draft; },
    async revisePlanWithAnswers(): Promise<PlannerDraft> { return draft; }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Submit a payment request over Kafka, await the provider response, then finalize.",
    platform: "COMPUTE"
  });

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  // group.id should contain the app-name-derived default wrapped in property expression
  assert.match(applicationProperties, /mp\.messaging\.incoming\.tpf-await-kafka-responses\.group\.id=\$\{TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:/);
});

test("generateScaffoldZip with kafka await DerivedConfig emits kafka wiring without await service module", async () => {
  const config: DerivedConfig = {
    version: 2,
    appName: "KafkaAwaitDirect",
    basePackage: "com.example.kafkaawaitdirect",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      PaymentRequest: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ]
      },
      PaymentResult: {
        fields: [
          { number: 1, name: "paymentId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      }
    },
    steps: [
      {
        name: "Await Payment Provider",
        kind: "await",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PaymentRequest",
        outputTypeName: "PaymentResult",
        timeout: "PT5M",
        idempotencyKeyFields: ["paymentId"],
        await: {
          correlation: { strategy: "interactionId" },
          transport: {
            type: "kafka",
            request: { topic: "direct.payment.requests" },
            response: { topic: "direct.payment.results" },
            consumer: { group: "direct-payment-group" }
          }
        }
      }
    ]
  };

  const zipBuffer = await generateScaffoldZip(config);
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileNames = Object.keys(zip.files);

  // No standalone await service module
  assert.ok(!fileNames.some((name) => name.startsWith("await-payment-provider-svc/")));

  // orchestrator-svc should have kafka dependency
  const orchestratorPom = await zip.file("orchestrator-svc/pom.xml")!.async("string");
  assert.match(orchestratorPom, /quarkus-messaging-kafka/);

  // orchestrator-svc application.properties should have kafka wiring
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /tpf\.await\.kafka\.reactive-messaging\.enabled=true/);
  assert.match(applicationProperties, /mp\.messaging\.outgoing\.tpf-await-kafka-requests\.topic=direct\.payment\.requests/);
  assert.match(applicationProperties, /mp\.messaging\.incoming\.tpf-await-kafka-responses\.topic=direct\.payment\.results/);
  assert.ok(applicationProperties.includes("mp.messaging.incoming.tpf-await-kafka-responses.group.id=${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:direct-payment-group}"));
});

test("query connector DerivedConfig validates query references and rejects mismatched contracts", async () => {
  const config = buildQueryConnectorConfig();
  config.queries!["customer-risk-by-id"].outputType = "CustomerDecision";

  await assert.rejects(
    () => validateDerivedConfig(config),
    /does not match query 'customer-risk-by-id' output 'CustomerDecision'/
  );
});

test("query connector DerivedConfig validates released JPA predicate semantics", async () => {
  await validateDerivedConfig(buildQueryConnectorConfig());

  const emptyWhere = buildQueryConnectorConfig();
  emptyWhere.queries!["customer-risk-by-id"].jpa.where = {};
  await assert.rejects(
    () => validateDerivedConfig(emptyWhere),
    /must declare at least one jpa\.where binding/
  );

  const emptyIn = buildQueryConnectorConfig();
  emptyIn.queries!["customer-risk-by-id"].jpa.where = { riskBand: { in: [] } };
  await assert.rejects(
    () => validateDerivedConfig(emptyIn),
    /riskBand\.in' must not be empty/
  );

  const shortBetween = buildQueryConnectorConfig();
  shortBetween.queries!["customer-risk-by-id"].jpa.where = { score: { between: [1] as unknown as [number, number] } };
  await assert.rejects(
    () => validateDerivedConfig(shortBetween),
    /score\.between' must include exactly two values/
  );

  const unsupported = buildQueryConnectorConfig();
  unsupported.queries!["customer-risk-by-id"].jpa.where = { score: { contains: "HIGH" } as never };
  await assert.rejects(
    () => validateDerivedConfig(unsupported),
    /unsupported predicate operator 'contains'/
  );

  const invalidOrderBy = buildQueryConnectorConfig();
  invalidOrderBy.queries!["customer-risk-by-id"].jpa.orderBy = { score: "sideways" };
  await assert.rejects(
    () => validateDerivedConfig(invalidOrderBy),
    /invalid jpa\.orderBy binding/
  );

  const limitWithoutOrderBy = buildQueryConnectorConfig();
  delete limitWithoutOrderBy.queries!["customer-risk-by-id"].jpa.orderBy;
  limitWithoutOrderBy.queries!["customer-risk-by-id"].jpa.limit = 1;
  await assert.rejects(
    () => validateDerivedConfig(limitWithoutOrderBy),
    /jpa\.limit requires jpa\.orderBy/
  );

  const unsupportedVersion = buildQueryConnectorConfig();
  unsupportedVersion.queries!["customer-risk-by-id"].version = "v2";
  await assert.rejects(
    () => validateDerivedConfig(unsupportedVersion),
    /unsupported version 'v2'/
  );

  const conflictingAliases = buildQueryConnectorConfig();
  conflictingAliases.queries!["customer-risk-by-id"].input = "OtherLookup";
  await assert.rejects(
    () => validateDerivedConfig(conflictingAliases),
    /conflicting input and inputType values/
  );

  const invalidProjection = buildQueryConnectorConfig();
  invalidProjection.queries!["customer-risk-by-id"].jpa.projection = { "bad field": "customerId" };
  await assert.rejects(
    () => validateDerivedConfig(invalidProjection),
    /invalid jpa\.projection binding/
  );

  const queryStepWithForbiddenField = buildQueryConnectorConfig();
  queryStepWithForbiddenField.steps[0].idempotencyKeyFields = [];
  await assert.rejects(
    () => validateDerivedConfig(queryStepWithForbiddenField),
    /must not declare await-step fields/
  );

  const queryStepWithVirtualThreads = buildQueryConnectorConfig();
  queryStepWithVirtualThreads.steps[0].runOnVirtualThreads = false;
  await assert.rejects(
    () => validateDerivedConfig(queryStepWithVirtualThreads),
    /must not declare runOnVirtualThreads/
  );
});

test("generateScaffoldZip with query connector emits query config without query service module", async () => {
  const config = buildQueryConnectorConfig();

  const zipBuffer = await generateScaffoldZip(config);
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileNames = Object.keys(zip.files);

  assert.ok(!fileNames.some((name) => name.startsWith("load-customer-risk-svc/")));
  assert.ok(fileNames.some((name) => name.startsWith("classify-customer-svc/")));

  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  assert.equal(pipelineConfig.steps[0].kind, "query");
  assert.equal(pipelineConfig.steps[0].query, "customer-risk-by-id");
  assert.deepEqual(pipelineConfig.steps[0].capture?.keyFields, ["customerId"]);
  assert.equal(pipelineConfig.queries?.["customer-risk-by-id"].connector, "jpa");
  assert.equal(pipelineConfig.queries?.["customer-risk-by-id"].jpa.entity, "com.example.queryconnector.common.domain.CustomerRiskEntity");
  assert.deepEqual(pipelineConfig.queries?.["customer-risk-by-id"].jpa.where.score, { gte: 0 });
  assert.deepEqual(pipelineConfig.queries?.["customer-risk-by-id"].jpa.where.updatedAt, { between: ["input.windowStart", "input.windowEnd"] });
  assert.deepEqual(pipelineConfig.queries?.["customer-risk-by-id"].jpa.orderBy, { score: "desc" });
  assert.equal(pipelineConfig.queries?.["customer-risk-by-id"].jpa.limit, 1);

  const orchestratorPom = await zip.file("orchestrator-svc/pom.xml")!.async("string");
  assert.match(orchestratorPom, /query-jpa-connector/);
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /quarkus\.datasource\.db-kind=\$\{TPF_QUERY_JPA_DB_KIND:postgresql\}/);
  assert.match(applicationProperties, /#\s*quarkus\.hibernate-orm\.packages=com\.example\.queryconnector\.common\.domain/);
});

test("object ingest DerivedConfig validates source and first step continuity", async () => {
  const config = buildObjectIngestConfig();
  delete config.sources!.documents;

  await assert.rejects(
    () => validateDerivedConfig(config),
    /Input object boundary references unknown source 'documents'/
  );

  const mismatch = buildObjectIngestConfig();
  mismatch.steps[0].inputTypeName = "OtherInput";
  await assert.rejects(
    () => validateDerivedConfig(mismatch),
    /Input object boundary emits 'RawDocument' but first pipeline step 'Parse Document' consumes 'OtherInput'/
  );
});

test("generateScaffoldZip with object ingest emits source boundary, connector dependency, and snapshot mapper", async () => {
  const config = buildObjectIngestConfig();

  const zipBuffer = await generateScaffoldZip(config);
  const zip = await JSZip.loadAsync(zipBuffer);
  const fileNames = Object.keys(zip.files);

  assert.ok(fileNames.some((name) => name.startsWith("parse-document-svc/")));

  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  assert.equal(pipelineConfig.sources?.documents.provider, "filesystem");
  assert.equal(pipelineConfig.input?.object?.source, "documents");
  assert.equal(pipelineConfig.input?.object?.emits.typeName, "RawDocument");
  assert.equal(pipelineConfig.input?.object?.emits.mapper, "com.example.objectingest.common.mapper.RawDocumentObjectSnapshotMapper");
  assert.equal(pipelineConfig.steps[0].inboundMapper, "com.example.objectingest.common.mapper.RawDocumentMapper");

  const orchestratorPom = await zip.file("orchestrator-svc/pom.xml")!.async("string");
  assert.match(orchestratorPom, /object-ingest-connector/);

  const mapper = await zip.file("common/src/main/java/com/example/objectingest/common/mapper/RawDocumentObjectSnapshotMapper.java")!.async("string");
  assert.match(mapper, /implements ObjectSnapshotMapper<RawDocument>/);
  assert.match(mapper, /public RawDocument map\(ObjectSnapshot snapshot\)/);

  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /Object source provider\/location\/polling settings are declared in config\/pipeline\.yaml/);
});

test("checkpoint handoff drafts emit pipeline boundaries and composition sidecar", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return buildCheckpointPlannerDraft();
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return buildCheckpointPlannerDraft();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new LocalFileArtifactStore(), planner);
  const session = await service.startSession({
    briefText: "Finalize a transfer and publish a checkpoint to a downstream settlement pipeline."
  });
  assert.equal(session.status, "ready");
  assert.equal(session.derivedConfig.output?.checkpoint?.publication, "transfer.finalized");
  assert.equal(session.compositionManifest?.name, "transfer-settlement-composition");

  const generated = await service.generateScaffold({ sessionId: session.sessionId });
  const zipBytes = await fs.readFile(generated.artifact!.localPath!);
  const zip = await JSZip.loadAsync(zipBytes);
  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  const pipelineConfig = YAML.load(pipelineYaml) as DerivedConfig;
  assert.equal(pipelineConfig.output?.checkpoint?.publication, "transfer.finalized");
  const compositionYaml = await zip.file("config/pipeline-composition.yaml")!.async("string");
  const composition = YAML.load(compositionYaml) as { version: number; name: string; pipelines: Array<{ id: string; path: string }> };
  assert.equal(composition.version, 1);
  assert.equal(composition.pipelines[0].id, "wire-transfer");
  const applicationProperties = await zip.file("orchestrator-svc/src/main/resources/application.properties")!.async("string");
  assert.match(applicationProperties, /pipeline\.orchestrator\.mode=QUEUE_ASYNC/);
  assert.match(applicationProperties, /checkpoint publishers\/subscribers/i);
});

test("get_brief_session returns persisted session state after answers are merged", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  const handlers = createLocalBridgeHandlers({
    llmEndpoint: "http://localhost:11434/v1",
    llmModel: "gemma4",
    llmToken: "ollama",
    providerFetchImpl: createPlannerProviderFetch([initialDraft])
  });

  const session = await handlers.startBriefSession({
    briefText: structuredBackendBrief
  });

  const reloaded = await handlers.getBriefSession({ sessionId: session.sessionId });
  assert.equal(reloaded.sessionId, session.sessionId);
  assert.equal(reloaded.status, "ready");
  assert.equal(reloaded.businessSteps[0].name, "Validate Customer Request");
});

test("scaffold_from_brief dry-run uses default deployment choices without writing files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-mcp-dry-run-"));
  try {
    const result = await scaffoldFromBriefTool({
      briefText: structuredBackendBrief,
      outputDir: path.join(tempDir, "generated"),
      dryRun: true
    });

    assert.equal(result.status, "ready");
    assert.equal(result.generatedPath, undefined);
    await assert.rejects(fs.stat(path.join(tempDir, "generated")));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("scaffold_from_brief writes a scaffold with REST + COMPUTE + MONOLITH defaults", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-mcp-generate-"));
  const outputDir = path.join(tempDir, "customer-generated");
  try {
    const result = await scaffoldFromBriefTool({
      briefText: structuredBackendBrief,
      outputDir
    });

    assert.equal(result.status, "generated");
    assert.equal(result.generatedPath, outputDir);
    const pipelineYaml = await fs.readFile(path.join(outputDir, "config", "pipeline.yaml"), "utf8");
    assert.match(pipelineYaml, /transport: REST/);
    assert.match(pipelineYaml, /platform: COMPUTE/);
    assert.match(pipelineYaml, /runtimeLayout: monolith/);
    const runtimeMappingYaml = await fs.readFile(path.join(outputDir, "config", "pipeline.runtime.yaml"), "utf8");
    assert.equal((YAML.load(runtimeMappingYaml) as { layout?: string }).layout, "monolith");
    await assert.rejects(fs.stat(path.join(outputDir, "config", "runtime-mapping")));
    await fs.stat(path.join(outputDir, "pom.xml"));
    await fs.stat(path.join(outputDir, "orchestrator-svc"));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("validateDerivedConfig rejects duplicate message fields", async () => {
  await assert.rejects(
    () => validateDerivedConfig({
      version: 2,
      appName: "BrokenFlow",
      basePackage: "com.example.broken",
      messages: {
        BrokenMessage: {
          fields: [
            { number: 1, name: "id", type: "uuid" },
            { number: 2, name: "id", type: "uuid" }
          ]
        }
      },
      steps: [
        {
          name: "Validate Broken Request",
          cardinality: "ONE_TO_ONE",
          inputTypeName: "BrokenMessage",
          outputTypeName: "BrokenMessage",
          parallel: false
        }
      ]
    }),
    /duplicate field 'id'/
  );
});

test("session generation uses the same derived-config validation gate as local generation", async () => {
  const sessionStore = new InMemorySessionStore();
  const artifactStore = new InMemoryArtifactStore();
  const service = new BriefSessionService(sessionStore, artifactStore, createHeuristicPlannerClient());
  const now = new Date().toISOString();
  const invalidDerivedConfig: DerivedConfig = {
    version: 2,
    appName: "BrokenFlow",
    basePackage: "com.example.broken",
    messages: {
      BrokenMessage: {
        fields: [
          { number: 1, name: "id", type: "uuid" },
          { number: 2, name: "id", type: "uuid" }
        ]
      }
    },
    steps: [
      {
        name: "Validate Broken Request",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "BrokenMessage",
        outputTypeName: "BrokenMessage",
        parallel: false
      }
    ]
  };
  const session: SessionState = {
    sessionId: "invalid-session",
    input: { briefText: structuredBackendBrief },
    answers: {},
    analysis: {
      status: "ready",
      questions: [],
      contractQuestions: [],
      assumptions: [],
      pipelineSummary: {
        title: "Broken Flow",
        primaryGoal: "Test validation parity",
        asyncMode: "SIMPLIFIED",
        transport: "REST",
        platform: "COMPUTE",
        runtimeLayout: "MONOLITH",
        selectedRuntimeLayout: "MONOLITH",
        runtimeLayoutAlternatives: []
      },
      businessSteps: [],
      stepBreakdownRationale: [],
      futureStepCandidates: [],
      selectedRuntimeLayout: "MONOLITH",
      runtimeLayoutAlternatives: [],
      messageCatalog: [],
      stepContracts: [],
      couplingFindings: [],
      technicalConcerns: [],
      inferredMessages: [],
      inferredSteps: [],
      aspects: {},
      derivedConfig: invalidDerivedConfig,
      derivedConfigYaml: "version: 2\n"
    },
    createdAt: now,
    updatedAt: now,
    generationCount: 0
  };
  await sessionStore.put(session);

  await assert.rejects(
    () => service.generateScaffold({ sessionId: "invalid-session" }),
    /duplicate field 'id'/
  );
});

test("shared scaffold ZIP includes REST await union DTO and mapper helpers", async () => {
  const config: DerivedConfig = buildRestaurantApprovalUnionConfig();
  const zipBytes = await generateScaffoldZip(config);
  const zip = await JSZip.loadAsync(zipBytes);
  const fileNames = Object.keys(zip.files);
  const commonRoot = "common/src/main/java/com/example/restaurantapproval/common";

  assert.ok(fileNames.includes("config/pipeline.yaml"));
  assert.ok(!fileNames.includes("pipeline-config.yaml"));
  assert.ok(fileNames.includes(`${commonRoot}/dto/RestaurantDecisionDto.java`));
  assert.ok(fileNames.includes(`${commonRoot}/dto/RestaurantDecisionDtoJsonSerializer.java`));
  assert.ok(fileNames.includes(`${commonRoot}/dto/RestaurantDecisionDtoJsonDeserializer.java`));
  assert.ok(fileNames.includes(`${commonRoot}/mapper/RestaurantDecisionMapper.java`));
  assert.ok(fileNames.includes(`${commonRoot}/domain/RestaurantDecision.java`));
  assert.ok(fileNames.includes(`${commonRoot}/domain/RestaurantOrderAccepted.java`));

  const mapper = await zip.file(`${commonRoot}/mapper/RestaurantDecisionMapper.java`)!.async("string");
  const serializer = await zip.file(`${commonRoot}/dto/RestaurantDecisionDtoJsonSerializer.java`)!.async("string");
  const acceptedDomain = await zip.file(`${commonRoot}/domain/RestaurantOrderAccepted.java`)!.async("string");
  const pipelineConfig = YAML.load(await zip.file("config/pipeline.yaml")!.async("string")) as DerivedConfig;

  assert.match(mapper, /implements Mapper<RestaurantDecision, RestaurantDecisionDto>/);
  assert.match(mapper, /external instanceof RestaurantOrderAcceptedDto source/);
  assert.match(mapper, /domain instanceof RestaurantOrderDeclined source/);
  assert.match(serializer, /gen\.writeStringField\("type", "accepted"\)/);
  assert.match(acceptedDomain, /import java\.math\.BigDecimal;/);
  assert.match(acceptedDomain, /import java\.time\.LocalDate;/);
  assert.match(acceptedDomain, /import java\.util\.List;/);
  assert.match(acceptedDomain, /import java\.util\.Map;/);
  assert.equal(pipelineConfig.steps[0].kind, "await");
  assert.ok(!fileNames.some((name) => name.startsWith("await-restaurant-decision-svc/")));
});

test("planner drafts that materialize persistence as business steps are rejected", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        ...(await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief })),
        businessSteps: [
          {
            id: "save-customer-request",
            name: "Save Customer Request",
            purpose: "Persist the customer request before the next stage.",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerRequestSaved",
            inputFields: [{ number: 1, name: "customerId", type: "uuid" }],
            outputFields: [{ number: 1, name: "customerId", type: "uuid" }]
          }
        ],
        pipelineSteps: [
          {
            id: "save-customer-request",
            name: "Save Customer Request",
            cardinality: "ONE_TO_ONE",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerRequestSaved"
          }
        ],
        messageCatalog: [
          { id: "message.customerrequest", name: "CustomerRequest", fields: [{ number: 1, name: "customerId", type: "uuid" }] },
          { id: "message.customerrequestsaved", name: "CustomerRequestSaved", fields: [{ number: 1, name: "customerId", type: "uuid" }] }
        ],
        stepContracts: [
          {
            stepId: "save-customer-request",
            stepName: "Save Customer Request",
            inputTypeName: "CustomerRequest",
            outputTypeName: "CustomerRequestSaved",
            inputFields: [{ number: 1, name: "customerId", type: "uuid" }],
            outputFields: [{ number: 1, name: "customerId", type: "uuid" }],
            continuity: "coherent",
            rationale: "Persist state before continuing."
          }
        ],
        contractQuestions: [],
        futureStepCandidates: [],
        assumptions: [],
        aspects: {
          persistence: { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" }
        }
      };
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: structuredBackendBrief }),
    /materializes persistence as a business step/i
  );
});

test("planner drafts with broken adjacent chaining are rejected", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        title: "Broken Adjacency",
        primaryGoal: "Test chaining validation.",
        businessSteps: [
          {
            id: "validate-request",
            name: "Validate Request",
            purpose: "Validate the request.",
            inputTypeName: "Request",
            outputTypeName: "ValidatedRequest",
            inputFields: [{ number: 1, name: "requestId", type: "uuid" }],
            outputFields: [{ number: 1, name: "requestId", type: "uuid" }]
          },
          {
            id: "build-response",
            name: "Build Response",
            purpose: "Build the response payload.",
            inputTypeName: "DifferentState",
            outputTypeName: "Response",
            inputFields: [{ number: 1, name: "requestId", type: "uuid" }],
            outputFields: [{ number: 1, name: "status", type: "string" }]
          }
        ],
        pipelineSteps: [
          { id: "validate-request", name: "Validate Request", cardinality: "ONE_TO_ONE", inputTypeName: "Request", outputTypeName: "ValidatedRequest" },
          { id: "build-response", name: "Build Response", cardinality: "ONE_TO_ONE", inputTypeName: "DifferentState", outputTypeName: "Response" }
        ],
        messageCatalog: [
          { id: "message.request", name: "Request", fields: [{ number: 1, name: "requestId", type: "uuid" }] },
          { id: "message.validatedrequest", name: "ValidatedRequest", fields: [{ number: 1, name: "requestId", type: "uuid" }] },
          { id: "message.differentstate", name: "DifferentState", fields: [{ number: 1, name: "requestId", type: "uuid" }] },
          { id: "message.response", name: "Response", fields: [{ number: 1, name: "status", type: "string" }] }
        ],
        stepContracts: [
          {
            stepId: "validate-request",
            stepName: "Validate Request",
            inputTypeName: "Request",
            outputTypeName: "ValidatedRequest",
            inputFields: [{ number: 1, name: "requestId", type: "uuid" }],
            outputFields: [{ number: 1, name: "requestId", type: "uuid" }],
            continuity: "coherent",
            rationale: "Validation."
          },
          {
            stepId: "build-response",
            stepName: "Build Response",
            inputTypeName: "DifferentState",
            outputTypeName: "Response",
            inputFields: [{ number: 1, name: "requestId", type: "uuid" }],
            outputFields: [{ number: 1, name: "status", type: "string" }],
            continuity: "coherent",
            rationale: "Response build."
          }
        ],
        contractQuestions: [],
        futureStepCandidates: [],
        assumptions: []
      };
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: structuredBackendBrief }),
    /previous forward step/i
  );
});

test("planner drafts reject await steps missing timeout", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      const draft = buildAwaitPlannerDraft();
      draft.businessSteps[1] = { ...draft.businessSteps[1], timeout: undefined };
      return draft;
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: "Fraud webhook approval flow." }),
    /inconsistent await timeouts|must declare timeout/i
  );
});

test("planner drafts reject await steps on FUNCTION pipelines", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return buildAwaitPlannerDraft();
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return buildAwaitPlannerDraft();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: "Fraud webhook approval flow.", platform: "FUNCTION" }),
    /not supported for FUNCTION pipelines/i
  );
});

test("planner drafts reject await metadata on non-await steps", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      const draft = buildAwaitPlannerDraft();
      draft.businessSteps[1] = { ...draft.businessSteps[1], kind: "internal" };
      return draft;
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: "Fraud webhook approval flow." }),
    /inconsistent step kinds|without kind 'await'/i
  );
});

test("planner drafts that keep resume in the main pipeline are rejected", async () => {
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        title: "Resume In Main Flow",
        primaryGoal: "Test resume semantics.",
        businessSteps: [
          {
            id: "resume-flow",
            name: "Resume Onboarding State",
            purpose: "Reload the current onboarding state.",
            inputTypeName: "OnboardingResumeRequest",
            outputTypeName: "CurrentOnboardingState",
            inputFields: [{ number: 1, name: "userId", type: "uuid" }],
            outputFields: [{ number: 1, name: "completedStage", type: "string" }]
          }
        ],
        pipelineSteps: [
          {
            id: "resume-flow",
            name: "Resume Onboarding State",
            cardinality: "ONE_TO_ONE",
            inputTypeName: "OnboardingResumeRequest",
            outputTypeName: "CurrentOnboardingState",
            flowRole: "resume"
          }
        ],
        messageCatalog: [
          { id: "message.resume", name: "OnboardingResumeRequest", fields: [{ number: 1, name: "userId", type: "uuid" }] },
          { id: "message.current", name: "CurrentOnboardingState", fields: [{ number: 1, name: "completedStage", type: "string" }] }
        ],
        stepContracts: [
          {
            stepId: "resume-flow",
            stepName: "Resume Onboarding State",
            inputTypeName: "OnboardingResumeRequest",
            outputTypeName: "CurrentOnboardingState",
            flowRole: "resume",
            inputFields: [{ number: 1, name: "userId", type: "uuid" }],
            outputFields: [{ number: 1, name: "completedStage", type: "string" }],
            continuity: "coherent",
            rationale: "Resume state."
          }
        ],
        contractQuestions: [],
        futureStepCandidates: [],
        assumptions: []
      };
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  await assert.rejects(
    () => service.startSession({ briefText: onboardingBrief }),
    /must not appear in the main pipeline step sequence/i
  );
});

test("advanced TPF concerns are preserved as recommendations without causing hard failures", async () => {
  const draft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  const planner = {
    async planInitialBrief(): Promise<PlannerDraft> {
      return {
        ...draft,
        aspects: {
          cache: { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" }
        },
        technicalConcerns: [
          { concern: "cache", appliesToSteps: ["process-customer-request"], details: "Cache query-style reads when the brief emphasizes repeated lookups." },
          { concern: "replayability", appliesToSteps: ["process-customer-request"], details: "Repeated submissions should remain idempotent." },
          { concern: "checkpoint-handoff", appliesToSteps: ["process-customer-request"], details: "Checkpoint the final validated state before external hand-off." }
        ],
        questions: [
          {
            id: "question.idempotency",
            key: "stepContracts",
            prompt: "Should repeated submissions for the same customerId be idempotent?",
            stepId: "process-customer-request",
            stepName: "Process Customer Request"
          }
        ]
      };
    },
    async revisePlanWithAnswers(): Promise<PlannerDraft> {
      return this.planInitialBrief();
    }
  };

  const service = new BriefSessionService(new InMemorySessionStore(), new InMemoryArtifactStore(), planner);
  const session = await service.startSession({ briefText: structuredBackendBrief });
  assert.equal(session.status, "needs_input");
  assert.ok(session.aspects.cache?.enabled);
  assert.ok(session.technicalConcerns.some((concern) => concern.concern === "cache"));
  assert.ok(session.technicalConcerns.some((concern) => concern.concern === "replayability"));
  assert.ok(session.technicalConcerns.some((concern) => concern.concern === "checkpoint-handoff"));
  assert.ok(session.questions.some((question) => /idempotent/i.test(question.prompt)));
});

test("durable object session flow persists a planned session and serves a generated ZIP", async () => {
  const { readySession } = await buildPlannedSessionStates(onboardingBrief);
  const durableObject = new BriefSessionDurableObject(
    { storage: new MemoryStorage() },
    {
      TPF_MCP_SESSIONS: {} as never,
      TPF_MCP_SESSION_SNAPSHOTS: new InMemoryKv(),
      TPF_MCP_QUOTAS: new InMemoryKv(),
      TPF_MCP_ARTIFACTS: new InMemoryR2Bucket(),
      TPF_MCP_BASE_URL: "https://tpf.example"
    }
  );

  const stored = await readJson<{ session: SessionState }>(await durableObject.fetch(new Request("https://session.internal/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: readySession })
  })));
  assert.equal(stored.session.sessionId, readySession.sessionId);

  const sessionResult = await readJson<SessionResult>(await durableObject.fetch(new Request(`https://session.internal/session-result?sessionId=${encodeURIComponent(readySession.sessionId)}`)));
  assert.equal(sessionResult.status, "ready");

  const generated = await readJson<SessionResult>(await durableObject.fetch(new Request("https://session.internal/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: readySession.sessionId,
      baseUrl: "https://tpf.example"
    })
  })));
  assert.equal(generated.status, "generated");
  assert.ok(generated.artifact?.downloadUrl);

  const downloadResponse = await durableObject.fetch(new Request(generated.artifact!.downloadUrl!));
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("content-type"), "application/zip");
  const bytes = new Uint8Array(await downloadResponse.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes);
  const pipelineYaml = await zip.file("config/pipeline.yaml")!.async("string");
  assertNoDuplicateMessageFields(YAML.load(pipelineYaml) as DerivedConfig);
});

test("worker JSON API stores bridge-planned sessions and generates hosted artifacts with CORS", async () => {
  const { initialSession, readySession } = await buildPlannedSessionStates(onboardingBrief);
  const env = createWorkerEnv();

  const storeInitial = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.pipelineframework.org"
    },
    body: JSON.stringify({ session: initialSession })
  }), env);
  assert.equal(storeInitial.status, 200);
  assert.equal(storeInitial.headers.get("access-control-allow-origin"), "https://app.pipelineframework.org");

  const started = await readJson<SessionResult>(await handleWorkerRequest(new Request(`https://mcp.pipelineframework.org/api/get-session?sessionId=${encodeURIComponent(initialSession.sessionId)}`, {
    method: "GET",
    headers: { origin: "https://app.pipelineframework.org" }
  }), env));
  assert.equal(started.status, "needs_input");

  const storeReady = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.pipelineframework.org"
    },
    body: JSON.stringify({ session: readySession })
  }), env);
  assert.equal(storeReady.status, 200);

  const generatedResponse = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/generate-scaffold", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.pipelineframework.org"
    },
    body: JSON.stringify({ sessionId: readySession.sessionId })
  }), env);
  const generated = await readJson<SessionResult>(generatedResponse);
  assert.equal(generated.status, "generated");
  assert.ok(generated.artifact?.downloadUrl);
});

test("worker JSON API rejects legacy hosted planner start/answer endpoints", async () => {
  const env = createWorkerEnv();

  const startResponse = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/start-session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.pipelineframework.org"
    },
    body: JSON.stringify({ briefText: structuredBackendBrief })
  }), env);

  assert.equal(startResponse.status, 410);
  const payload = await startResponse.json() as { error: string };
  assert.match(payload.error, /Hosted planner execution has been removed/);
});

test("worker JSON API enforces optional bearer token when configured", async () => {
  const { readySession } = await buildPlannedSessionStates(structuredBackendBrief);
  const env = createWorkerEnv({
    TPF_MCP_API_TOKEN: "secret-token"
  });

  const unauthorized = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ session: readySession })
  }), env);
  assert.equal(unauthorized.status, 401);

  const authorized = await handleWorkerRequest(new Request("https://mcp.pipelineframework.org/api/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer secret-token"
    },
    body: JSON.stringify({ session: readySession })
  }), env);
  assert.equal(authorized.status, 200);
});

test("readBridgeConfig defaults to direct-http and requires provider credentials there", async () => {
  assert.throws(
    () => readBridgeConfig({
      TPF_LLM_ENDPOINT: "https://api.openai.com/v1",
      TPF_LLM_MODEL: "gpt-5"
    }),
    /Missing required environment variable 'TPF_LLM_TOKEN'/
  );

  const samplingOptInConfig = readBridgeConfig({
    TPF_LLM_TRANSPORT_MODE: "auto"
  });
  assert.equal(samplingOptInConfig.plannerTransportMode, "auto");
  assert.equal(samplingOptInConfig.llmToken, undefined);

  const config = readBridgeConfig({
    TPF_LLM_ENDPOINT: "http://localhost:11434/v1",
    TPF_LLM_MODEL: "gemma4",
    TPF_LLM_TOKEN: "ollama",
    TPF_LLM_PROFILE: "compact",
    TPF_LLM_PROVIDER_MODE: "ollama-native",
    TPF_LLM_TRANSPORT_MODE: "direct-http"
  });
  assert.equal(config.apiBaseUrl, undefined);
  assert.equal(config.llmProfile, "compact");
  assert.equal(config.llmProviderMode, "ollama-native");
  assert.equal(config.plannerTransportMode, "direct-http");
});

test("readBridgeConfig falls back to Codex ChatGPT-generated API key for openai-compatible mode", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-codex-auth-"));
  const fakeHome = path.join(tempDir, "home");
  const codexDir = path.join(fakeHome, ".codex");
  await fs.mkdir(codexDir, { recursive: true });
  await fs.writeFile(path.join(codexDir, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: "sk-codex-generated"
  }), "utf8");

  const config = readBridgeConfig({
    HOME: fakeHome,
    TPF_LLM_ENDPOINT: "https://api.openai.com/v1",
    TPF_LLM_MODEL: "gpt-5",
    TPF_LLM_PROVIDER_MODE: "openai-compatible"
  });
  assert.equal(config.llmToken, "sk-codex-generated");

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("bridge config summary exposes non-secret credential-source diagnostics", async () => {
  const config = readBridgeConfig({
    HOME: path.join(os.tmpdir(), "nonexistent-codex-home"),
    TPF_LLM_ENDPOINT: "http://localhost:11434/v1",
    TPF_LLM_MODEL: "gemma4",
    TPF_LLM_TOKEN: "ollama",
    TPF_LLM_PROVIDER_MODE: "ollama-native",
    TPF_LLM_TRANSPORT_MODE: "direct-http",
    TPF_MCP_API_BASE_URL: "https://mcp.pipelineframework.org/api"
  });

  assert.equal(
    formatBridgeConfigSummary(config),
    "plannerTransport=direct-http, providerMode=ollama-native, credentialSource=env, apiBaseUrl=configured"
  );
});

test("readBridgeConfig fails clearly when direct-http mode lacks both env token and Codex auth fallback", async () => {
  await assert.throws(
    () => readBridgeConfig({
      HOME: path.join(os.tmpdir(), "nonexistent-codex-home"),
      TPF_LLM_ENDPOINT: "https://api.openai.com/v1",
      TPF_LLM_MODEL: "gpt-5",
      TPF_LLM_PROVIDER_MODE: "openai-compatible",
      TPF_LLM_TRANSPORT_MODE: "direct-http"
    }),
    /either set TPF_LLM_TOKEN explicitly or sign in to Codex with ChatGPT/i
  );
});

test("hosted bridge plans locally and stores sessions without forwarding planner headers", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const backendFetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const request = new Request(url, init);
    const body = await request.text();
    requests.push({
      url,
      headers: Object.fromEntries(request.headers.entries()),
      body
    });
    if (url.endsWith("/session")) {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`Unexpected backend request ${url}`);
  };

  const handlers = createHostedBridgeHandlers({
    apiBaseUrl: "https://mcp.pipelineframework.org/api",
    apiToken: "bridge-api-token",
    llmEndpoint: "http://localhost:11434/v1",
    llmModel: "gemma4",
    llmToken: "ollama",
    llmProviderMode: "openai-compatible",
    backendFetchImpl,
    providerFetchImpl: createPlannerProviderFetch([initialDraft])
  });

  const result = await handlers.startBriefSession({ briefText: structuredBackendBrief });

  assert.equal(result.status, "ready");
  assert.equal(requests[0]?.url, "https://mcp.pipelineframework.org/api/session");
  assert.equal(requests[0]?.headers.authorization, "Bearer bridge-api-token");
  assert.equal("x-tpf-llm-endpoint" in (requests[0]?.headers || {}), false);
  assert.equal("x-tpf-llm-model" in (requests[0]?.headers || {}), false);
  assert.equal("x-tpf-llm-token" in (requests[0]?.headers || {}), false);
  const payload = JSON.parse(requests[0]!.body) as { session: SessionState };
  assert.equal(payload.session.analysis.status, "ready");
});

test("local bridge auto-selects MCP sampling when the connected client advertises it", async () => {
  const initialDraft = await createHeuristicPlannerClient().planInitialBrief({ briefText: structuredBackendBrief });
  const samplingCalls: Array<{ maxTokens?: number; systemPrompt?: string }> = [];
  const handlers = createLocalBridgeHandlers(
    {
      llmProfile: "compact",
      plannerTransportMode: "auto"
    },
    () => ({
      server: {
        getClientCapabilities: () => ({ sampling: {} }),
        async createMessage(params: { maxTokens?: number; systemPrompt?: string }) {
          samplingCalls.push(params);
          return {
            role: "assistant",
            model: "gpt-5",
            content: {
              type: "text",
              text: JSON.stringify(initialDraft)
            }
          };
        }
      }
    }) as never
  );

  const result = await handlers.startBriefSession({ briefText: structuredBackendBrief });
  assert.equal(result.status, "ready");
  assert.equal(samplingCalls.length, 1);
  assert.equal(samplingCalls[0]?.maxTokens, 4000);
  assert.match(String(samplingCalls[0]?.systemPrompt || ""), /TPF planning layer/i);
});

test("local bridge fails clearly when mcp-sampling is forced but the client lacks sampling support", async () => {
  const handlers = createLocalBridgeHandlers(
    {
      plannerTransportMode: "mcp-sampling"
    },
    () => ({
      server: {
        getClientCapabilities: () => ({})
      }
    }) as never
  );

  assert.throws(
    () => handlers.startBriefSession({ briefText: structuredBackendBrief }),
    /experimental mcp planner transport mcp-sampling is not supported/i
  );
});

test("local bridge surfaces local planner quota failures clearly", async () => {
  const handlers = createLocalBridgeHandlers({
    llmEndpoint: "https://api.openai.com/v1",
    llmModel: "gpt-5",
    llmToken: "provider-token",
    providerFetchImpl: async () => new Response(JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota"
      }
    }), {
      status: 429,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    () => handlers.startBriefSession({ briefText: structuredBackendBrief }),
    /Planner provider quota exceeded/
  );
});

test("bridge build emits the stdio entrypoint used by the published package", async () => {
  const bridgeEntrypoint = await fs.readFile(path.resolve("dist/src/bridge.js"), "utf8");
  assert.match(bridgeEntrypoint, /^#!\/usr\/bin\/env node/);
  assert.match(bridgeEntrypoint, /startBridgeServer/);
  assert.match(bridgeEntrypoint, /process\.exit\(1\)/);
});

test("package metadata advertises the publishable bridge install surface", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.resolve("package.json"), "utf8")
  ) as {
    name: string;
    bin: Record<string, string>;
    scripts: Record<string, string>;
    files: string[];
    publishConfig: { access: string };
    main: string;
    exports: Record<string, string>;
  };

  assert.equal(packageJson.name, "@pipelineframework/tpf-mcp-bridge");
  assert.equal(packageJson.bin["tpf-mcp-bridge"], "./dist/src/bridge.js");
  assert.equal(packageJson.scripts.start, "node dist/src/bridge.js");
  assert.equal(packageJson.main, "dist/src/bridge-runtime.js");
  assert.equal(packageJson.exports["."], "./dist/src/bridge-runtime.js");
  assert.deepEqual(packageJson.files, [
    "dist/src/**/*",
    "template-generator-node/src/**/*",
    "template-generator-node/templates/**/*",
    "template-generator-node/package.json",
    "README.md",
    "LICENSE"
  ]);
  assert.equal(packageJson.publishConfig.access, "public");
});

test("standalone readme documents host installs, provider modes, and schema sync", async () => {
  const readme = await fs.readFile(path.resolve("README.md"), "utf8");
  const developerGuide = await fs.readFile(path.resolve("DEVELOPING.md"), "utf8");
  assert.match(readme, /@pipelineframework\/tpf-mcp-bridge/);
  assert.match(readme, /TPF_LLM_PROFILE/);
  assert.match(readme, /default planner profile/i);
  assert.match(readme, /TPF_LLM_PROVIDER_MODE/);
  assert.match(readme, /TPF_LLM_TRANSPORT_MODE/);
  assert.match(readme, /TPF_MCP_API_BASE_URL/);
  assert.match(readme, /TPF_MCP_API_TOKEN/);
  assert.match(readme, /Cloudflare Worker backend/i);
  assert.match(readme, /What each planner environment variable does/i);
  assert.match(readme, /What each backend environment variable does/i);
  assert.match(readme, /DEVELOPING\.md/);
  assert.match(developerGuide, /sync:pipeline-schema/);
  assert.match(developerGuide, /framework\/deployment/);
  assert.match(developerGuide, /vendored generator snapshot/i);
  assert.match(developerGuide, /npm ci/);
  assert.match(developerGuide, /npm test/);
  assert.match(developerGuide, /npm pack --dry-run/);
  assert.match(developerGuide, /npm run start:worker/);
});

test("release parity audit classifies scaffold-relevant release deltas", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tpf-release-audit-"));
  try {
    const diffFile = path.join(tempDir, "name-status.txt");
    await fs.writeFile(diffFile, [
      "M\tframework/deployment/src/main/resources/META-INF/pipeline/pipeline-template-schema.json",
      "M\tframework/runtime/src/main/java/org/pipelineframework/annotation/PipelineStep.java",
      "M\tframework/runtime/src/main/java/org/pipelineframework/blocking/BlockingExecutions.java",
      "M\tframework/deployment/src/main/java/org/pipelineframework/processor/parser/StepDefinitionParser.java",
      "M\tframework/runtime/src/main/java/org/pipelineframework/awaitable/kafka/KafkaAwaitCompletionConsumer.java",
      "A\tframework/runtime/src/main/java/org/pipelineframework/awaitable/SqsAwaitTransportAdapter.java",
      "A\tframework/runtime/src/main/resources/META-INF/pipeline/pipeline-composition-schema.json",
      "A\tconnectors/object-ingest/pom.xml",
      "A\tconnectors/query-jpa/pom.xml",
      "A\tframework/spring-blocking-smoke-tests/pom.xml",
      "M\texamples/csv-payments/config/pipeline.yaml",
      "A\texamples/restaurant-approval/self-host/start-worker.sh",
      "A\tframework/runtime-spring/src/main/java/org/pipelineframework/runtime/spring/SpringPipelineRunner.java",
      "A\tdocs/guide/getting-started/index.md",
    ].join("\n"), "utf8");

    const report = execFileSync("node", [
      "scripts/audit-release-parity.mjs",
      "--diff-file",
      diffFile,
      "--framework-dir",
      tempDir,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    assert.match(report, /Baseline: `v26\.6\.1\.\.HEAD`/);
    assert.match(report, /## Fix Now/);
    assert.match(report, /Sync the vendored generator schema/i);
    assert.match(report, /generated Java\/templates must compile/i);
    assert.match(report, /virtual-thread authoring/i);
    assert.match(report, /## Defer Issue/);
    assert.match(report, /connectors\/object-ingest\/pom\.xml/);
    assert.match(report, /connectors\/query-jpa\/pom\.xml/);
    assert.match(report, /framework\/spring-blocking-smoke-tests\/pom\.xml/);
    assert.match(report, /## Added File Follow-Up/);
    assert.match(report, /SQS surface changed/i);
    assert.match(report, /Composition\/checkpoint surface changed/i);
    assert.match(report, /Self-host\/coordinator\/worker surface touched/i);
    assert.match(report, /Spring adapter surface touched/i);
    assert.match(report, /## Needs Human Review/);
    assert.match(report, /examples\/csv-payments\/config\/pipeline\.yaml/);
    assert.match(report, /## No Scaffold Impact/);
    assert.match(report, /docs\/guide\/getting-started\/index\.md/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("derived config rejects virtual-thread flags on non-internal steps", async () => {
  const config: DerivedConfig = {
    version: 2,
    appName: "VirtualThreadApp",
    basePackage: "com.example.virtualthread",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      Input: { fields: [{ number: 1, name: "id", type: "uuid" }] },
      Output: { fields: [{ number: 1, name: "id", type: "uuid" }] }
    },
    steps: [
      {
        name: "Remote Call",
        kind: "remote",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "Input",
        outputTypeName: "Output",
        runOnVirtualThreads: true
      }
    ]
  };

  await assert.rejects(
    () => validateDerivedConfig(config),
    /runOnVirtualThreads, which is valid only for internal service steps/
  );
});

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

function createWorkerEnv(overrides: Record<string, unknown> = {}) {
  const durableObjects = new Map<string, BriefSessionDurableObject>();
  const env: any = {
    TPF_MCP_SESSIONS: {
      getByName(name: string) {
        if (!durableObjects.has(name)) {
          durableObjects.set(name, new BriefSessionDurableObject(
            { storage: new MemoryStorage() },
            env
          ));
        }
        const durableObject = durableObjects.get(name)!;
        return {
          fetch(input: RequestInfo | URL, init?: RequestInit) {
            return durableObject.fetch(input instanceof Request ? input : new Request(input, init));
          }
        } as never;
      }
    },
    TPF_MCP_SESSION_SNAPSHOTS: new InMemoryKv(),
    TPF_MCP_QUOTAS: new InMemoryKv(),
    TPF_MCP_ARTIFACTS: new InMemoryR2Bucket(),
    TPF_MCP_BASE_URL: "https://mcp.pipelineframework.org",
    TPF_MCP_ALLOWED_ORIGIN: "https://app.pipelineframework.org",
    ...overrides
  };
  return env;
}

function createPlannerProviderFetch(drafts: PlannerDraft[]): typeof fetch {
  let index = 0;
  return async () => {
    const draft = drafts[Math.min(index, drafts.length - 1)];
    index += 1;
    return new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(draft)
          }
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function buildAwaitPlannerDraft(): PlannerDraft {
  return {
    title: "Wire Transfer Approval",
    primaryGoal: "Validate a wire transfer, await an external fraud decision, then finalize the transfer state.",
    businessSteps: [
      {
        id: "validate-transfer-request",
        name: "Validate Transfer Request",
        purpose: "Validate the incoming transfer request.",
        kind: "internal",
        inputTypeName: "TransferRequest",
        outputTypeName: "TransferValidatedRequest",
        inputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ],
        outputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ]
      },
      {
        id: "await-fraud-decision",
        name: "Await Fraud Decision",
        purpose: "Suspend the pipeline until the external fraud service responds.",
        kind: "await",
        inputTypeName: "TransferValidatedRequest",
        outputTypeName: "FraudDecision",
        timeout: "PT10M",
        idempotencyKeyFields: ["transferId"],
        await: {
          correlation: { strategy: "signedResumeToken" },
          transport: {
            type: "webhook",
            request: { url: "https://fraud.example/check" },
            callback: { baseUrl: "https://orchestrator.example" }
          }
        },
        inputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "amount", type: "decimal" }
        ],
        outputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "approved", type: "bool" }
        ]
      },
      {
        id: "finalize-transfer-state",
        name: "Finalize Transfer State",
        purpose: "Finalize the transfer after the fraud decision is received.",
        kind: "internal",
        inputTypeName: "FraudDecision",
        outputTypeName: "TransferFinalized",
        inputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "approved", type: "bool" }
        ],
        outputFields: [
          { number: 1, name: "transferId", type: "uuid" },
          { number: 2, name: "status", type: "string" }
        ]
      }
    ],
    pipelineSteps: [
      {
        id: "validate-transfer-request",
        name: "Validate Transfer Request",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "TransferRequest",
        outputTypeName: "TransferValidatedRequest"
      },
      {
        id: "await-fraud-decision",
        name: "Await Fraud Decision",
        kind: "await",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "TransferValidatedRequest",
        outputTypeName: "FraudDecision",
        timeout: "PT10M",
        idempotencyKeyFields: ["transferId"],
        await: {
          correlation: { strategy: "signedResumeToken" },
          transport: {
            type: "webhook",
            request: { url: "https://fraud.example/check" },
            callback: { baseUrl: "https://orchestrator.example" }
          }
        }
      },
      {
        id: "finalize-transfer-state",
        name: "Finalize Transfer State",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "FraudDecision",
        outputTypeName: "TransferFinalized"
      }
    ],
    messageCatalog: [
      { id: "message.transferrequest", name: "TransferRequest", fields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "amount", type: "decimal" }] },
      { id: "message.transfervalidatedrequest", name: "TransferValidatedRequest", fields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "amount", type: "decimal" }] },
      { id: "message.frauddecision", name: "FraudDecision", fields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "approved", type: "bool" }] },
      { id: "message.transferfinalized", name: "TransferFinalized", fields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "status", type: "string" }] }
    ],
    stepContracts: [
      {
        stepId: "validate-transfer-request",
        stepName: "Validate Transfer Request",
        kind: "internal",
        inputTypeName: "TransferRequest",
        outputTypeName: "TransferValidatedRequest",
        inputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "amount", type: "decimal" }],
        outputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "amount", type: "decimal" }],
        continuity: "coherent",
        rationale: "Validate request."
      },
      {
        stepId: "await-fraud-decision",
        stepName: "Await Fraud Decision",
        kind: "await",
        inputTypeName: "TransferValidatedRequest",
        outputTypeName: "FraudDecision",
        timeout: "PT10M",
        idempotencyKeyFields: ["transferId"],
        await: {
          correlation: { strategy: "signedResumeToken" },
          transport: {
            type: "webhook",
            request: { url: "https://fraud.example/check" },
            callback: { baseUrl: "https://orchestrator.example" }
          }
        },
        inputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "amount", type: "decimal" }],
        outputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "approved", type: "bool" }],
        continuity: "coherent",
        rationale: "Await external fraud decision before continuing."
      },
      {
        stepId: "finalize-transfer-state",
        stepName: "Finalize Transfer State",
        kind: "internal",
        inputTypeName: "FraudDecision",
        outputTypeName: "TransferFinalized",
        inputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "approved", type: "bool" }],
        outputFields: [{ number: 1, name: "transferId", type: "uuid" }, { number: 2, name: "status", type: "string" }],
        continuity: "coherent",
        rationale: "Finalize transfer."
      }
    ],
    contractQuestions: [],
    futureStepCandidates: ["Publish transfer checkpoint to downstream settlement pipeline."],
    assumptions: ["QUEUE_ASYNC orchestrator mode is available for await execution."],
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    technicalConcerns: [
      {
        concern: "checkpoint-handoff",
        appliesToSteps: ["finalize-transfer-state"],
        details: "Checkpoint publication remains separate from the await boundary."
      }
    ]
  };
}

function buildSqsAwaitPlannerDraft(): PlannerDraft {
  const draft = JSON.parse(JSON.stringify(buildAwaitPlannerDraft())) as PlannerDraft;
  draft.runtimeLayout = "MODULAR";
  for (const step of [...draft.businessSteps, ...draft.pipelineSteps, ...draft.stepContracts]) {
    if (step.kind !== "await" || !step.await) {
      continue;
    }
    step.await.transport = {
      type: "sqs",
      request: { queueUrl: "https://sqs.example/request" },
      response: { queueUrl: "https://sqs.example/response" }
    };
  }
  draft.assumptions = ["QUEUE_ASYNC orchestrator mode is available for SQS await execution."];
  return draft;
}

function buildKafkaAwaitPlannerDraft(): PlannerDraft {
  const draft = JSON.parse(JSON.stringify(buildAwaitPlannerDraft())) as PlannerDraft;
  draft.runtimeLayout = "MODULAR";
  for (const step of [...draft.businessSteps, ...draft.pipelineSteps, ...draft.stepContracts]) {
    if (step.kind !== "await" || !step.await) {
      continue;
    }
    step.await.transport = {
      type: "kafka",
      request: { topic: "payment.requests" },
      response: { topic: "payment.results" },
      consumer: { group: "payment-await-orchestrator" }
    };
  }
  draft.assumptions = ["QUEUE_ASYNC orchestrator mode is available for Kafka await execution."];
  return draft;
}

function buildCheckpointPlannerDraft(): PlannerDraft {
  const draft = JSON.parse(JSON.stringify(buildAwaitPlannerDraft())) as PlannerDraft;
  draft.outputBoundary = {
    checkpoint: {
      publication: "transfer.finalized",
      idempotencyKeyFields: ["transferId"]
    }
  };
  draft.compositionManifest = {
    version: 1,
    name: "transfer-settlement-composition",
    pipelines: [
      { id: "wire-transfer", path: "config/pipeline.yaml" },
      { id: "settlement", path: "../settlement/config/pipeline.yaml" }
    ]
  };
  draft.technicalConcerns = [
    ...(draft.technicalConcerns || []),
    {
      concern: "checkpoint-handoff",
      appliesToSteps: ["finalize-transfer-state"],
      details: "The finalized transfer checkpoint is published for downstream settlement ownership."
    }
  ];
  return draft;
}

async function buildPlannedSessionStates(briefText: string): Promise<{ initialSession: SessionState; readySession: SessionState }> {
  const sessionStore = new InMemorySessionStore();
  const planner = briefText === onboardingBrief
    ? {
        async planInitialBrief() {
          return buildOnboardingPlannerDrafts().initialDraft;
        },
        async revisePlanWithAnswers() {
          return buildOnboardingPlannerDrafts().revisedDraft;
        }
      }
    : createHeuristicPlannerClient();
  const service = new BriefSessionService(sessionStore, new InMemoryArtifactStore(), planner);

  const initialResult = await service.startSession({ briefText });
  const initialSession = await sessionStore.get(initialResult.sessionId);
  assert.ok(initialSession);

  const questionsById = new Map(initialResult.contractQuestions.map((question) => [question.id, question]));
  const answers = initialResult.contractQuestions.map((question) => {
    if (question.proposedAnswer?.fields?.length) {
      return {
        questionId: question.id,
        resolution: "confirm" as const
      };
    }
    if (question.id === "contract.personal-info.fields") {
      return {
        questionId: question.id,
        fields: [
          { name: "firstName", type: "string", required: true },
          { name: "lastName", type: "string", required: true }
        ]
      };
    }
    if (question.id === "contract.address.fields") {
      return {
        questionId: question.id,
        fields: [
          { name: "streetLine1", type: "string", required: true },
          { name: "city", type: "string", required: true },
          { name: "postalCode", type: "string", required: true }
        ]
      };
    }
    if (question.id === "contract.security-credentials.fields") {
      return {
        questionId: question.id,
        fields: [
          { name: "password", type: "string", required: true },
          { name: "acceptedTermsVersion", type: "string", required: true }
        ]
      };
    }
    throw new Error(`Unhandled contract question ${question.id} (${questionsById.get(question.id)?.prompt || "unknown"})`);
  });

  const readyResult = await service.answerQuestions({
    sessionId: initialResult.sessionId,
    answers
  });
  const readySession = await sessionStore.get(readyResult.sessionId);
  assert.ok(readySession);

  return {
    initialSession,
    readySession
  };
}

function buildOnboardingPlannerDrafts(): { initialDraft: PlannerDraft; revisedDraft: PlannerDraft } {
  const registrationRequestFields = [
    { number: 1, name: "email", type: "string" },
    { number: 2, name: "password", type: "string" }
  ];
  const registrationValidatedFields = [
    { number: 1, name: "email", type: "string" },
    { number: 2, name: "password", type: "string" }
  ];
  const onboardingDraftStateFields = [
    { number: 1, name: "userId", type: "uuid" },
    { number: 2, name: "accountStatus", type: "string" }
  ];
  const personalInfoQuestionFields = [
    { name: "firstName", type: "string", required: true },
    { name: "lastName", type: "string", required: true },
    { name: "dateOfBirth", type: "timestamp", required: false }
  ];
  const addressQuestionFields = [
    { name: "streetLine1", type: "string", required: true },
    { name: "city", type: "string", required: true },
    { name: "postalCode", type: "string", required: true },
    { name: "countryCode", type: "string", required: true }
  ];
  const credentialsQuestionFields = [
    { name: "password", type: "string", required: true },
    { name: "passwordSalt", type: "string", required: false },
    { name: "acceptedTermsVersion", type: "string", required: true }
  ];

  const initialDraft: PlannerDraft = {
    title: "Secure & Incremental User Onboarding Profile Creation",
    primaryGoal: "Create a resumable onboarding backend that validates staged profile capture and transitions accounts to pending verification.",
    businessSteps: [
      {
        id: "validate-registration-input",
        name: "Validate Registration Input",
        purpose: "Check that the initial identifier and password are present before creating any draft account.",
        inputTypeName: "RegistrationRequest",
        outputTypeName: "RegistrationValidated",
        inputFields: registrationRequestFields,
        outputFields: registrationValidatedFields
      },
      {
        id: "create-draft-account",
        name: "Create Draft Account",
        purpose: "Create the initial onboarding account and assign a durable user identifier in Draft state.",
        inputTypeName: "RegistrationValidated",
        outputTypeName: "OnboardingDraftState",
        inputFields: registrationValidatedFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "capture-personal-info-stage",
        name: "Capture Personal Info Stage",
        purpose: "Validate the personal-information segment and produce the updated onboarding state.",
        inputTypeName: "OnboardingDraftState",
        outputTypeName: "PersonalInfoStageState",
        inputFields: onboardingDraftStateFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "capture-address-stage",
        name: "Capture Address Stage",
        purpose: "Validate the address segment and produce the updated onboarding state.",
        inputTypeName: "PersonalInfoStageState",
        outputTypeName: "AddressStageState",
        inputFields: onboardingDraftStateFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "capture-security-credentials-stage",
        name: "Capture Security Credentials Stage",
        purpose: "Validate the credentials segment and produce the updated onboarding state.",
        inputTypeName: "AddressStageState",
        outputTypeName: "SecurityCredentialsStageState",
        inputFields: onboardingDraftStateFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "finalize-onboarding",
        name: "Finalize Onboarding",
        purpose: "Perform final completion checks across all captured onboarding segments.",
        inputTypeName: "SecurityCredentialsStageState",
        outputTypeName: "FinalizedOnboardingState",
        inputFields: onboardingDraftStateFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "transition-status-to-pending-verification",
        name: "Transition Status To Pending Verification",
        purpose: "Move the onboarding record from Draft to Pending Verification once required data is complete.",
        inputTypeName: "FinalizedOnboardingState",
        outputTypeName: "PendingVerificationAccount",
        inputFields: onboardingDraftStateFields,
        outputFields: onboardingDraftStateFields
      },
      {
        id: "resume-onboarding-state",
        name: "Resume Onboarding State",
        purpose: "Load the latest persisted draft so the user can continue from the last completed stage.",
        inputTypeName: "OnboardingResumeRequest",
        outputTypeName: "CurrentOnboardingState",
        flowRole: "resume",
        flowBoundaryRationale: "Resume is a separate query/resumption surface, not part of the forward-processing pipeline.",
        inputFields: [{ number: 1, name: "userId", type: "uuid" }],
        outputFields: [{ number: 1, name: "completedStage", type: "string" }]
      }
    ],
    pipelineSteps: [
      { id: "validate-registration-input", name: "Validate Registration Input", cardinality: "ONE_TO_ONE", inputTypeName: "RegistrationRequest", outputTypeName: "RegistrationValidated" },
      { id: "create-draft-account", name: "Create Draft Account", cardinality: "ONE_TO_ONE", inputTypeName: "RegistrationValidated", outputTypeName: "OnboardingDraftState" },
      { id: "capture-personal-info-stage", name: "Capture Personal Info Stage", cardinality: "ONE_TO_ONE", inputTypeName: "OnboardingDraftState", outputTypeName: "PersonalInfoStageState" },
      { id: "capture-address-stage", name: "Capture Address Stage", cardinality: "ONE_TO_ONE", inputTypeName: "PersonalInfoStageState", outputTypeName: "AddressStageState" },
      { id: "capture-security-credentials-stage", name: "Capture Security Credentials Stage", cardinality: "ONE_TO_ONE", inputTypeName: "AddressStageState", outputTypeName: "SecurityCredentialsStageState" },
      { id: "finalize-onboarding", name: "Finalize Onboarding", cardinality: "ONE_TO_ONE", inputTypeName: "SecurityCredentialsStageState", outputTypeName: "FinalizedOnboardingState" },
      { id: "transition-status-to-pending-verification", name: "Transition Status To Pending Verification", cardinality: "ONE_TO_ONE", inputTypeName: "FinalizedOnboardingState", outputTypeName: "PendingVerificationAccount" }
    ],
    messageCatalog: [
      { id: "message.registrationrequest", name: "RegistrationRequest", fields: registrationRequestFields },
      { id: "message.registrationvalidated", name: "RegistrationValidated", fields: registrationValidatedFields },
      { id: "message.onboardingdraftstate", name: "OnboardingDraftState", fields: onboardingDraftStateFields },
      { id: "message.personalinfostagestate", name: "PersonalInfoStageState", fields: onboardingDraftStateFields },
      { id: "message.addressstagestate", name: "AddressStageState", fields: onboardingDraftStateFields },
      { id: "message.securitycredentialsstagestate", name: "SecurityCredentialsStageState", fields: onboardingDraftStateFields },
      { id: "message.finalizedonboardingstate", name: "FinalizedOnboardingState", fields: onboardingDraftStateFields },
      { id: "message.pendingverificationaccount", name: "PendingVerificationAccount", fields: onboardingDraftStateFields },
      { id: "message.onboardingresumerequest", name: "OnboardingResumeRequest", fields: [{ number: 1, name: "userId", type: "uuid" }] },
      { id: "message.currentonboardingstate", name: "CurrentOnboardingState", fields: [{ number: 1, name: "completedStage", type: "string" }] }
    ],
    stepContracts: [
      { stepId: "validate-registration-input", stepName: "Validate Registration Input", inputTypeName: "RegistrationRequest", outputTypeName: "RegistrationValidated", inputFields: registrationRequestFields, outputFields: registrationValidatedFields, continuity: "coherent", rationale: "Validated registration input flows into draft creation." },
      { stepId: "create-draft-account", stepName: "Create Draft Account", inputTypeName: "RegistrationValidated", outputTypeName: "OnboardingDraftState", inputFields: registrationValidatedFields, outputFields: onboardingDraftStateFields, continuity: "coherent", rationale: "Draft creation produces the aggregate state used by staged capture." },
      { stepId: "capture-personal-info-stage", stepName: "Capture Personal Info Stage", inputTypeName: "OnboardingDraftState", outputTypeName: "PersonalInfoStageState", inputFields: onboardingDraftStateFields, outputFields: onboardingDraftStateFields, continuity: "clarification_needed", rationale: "Need confirmation of personal-info fields for the updated aggregate state." },
      { stepId: "capture-address-stage", stepName: "Capture Address Stage", inputTypeName: "PersonalInfoStageState", outputTypeName: "AddressStageState", inputFields: onboardingDraftStateFields, outputFields: onboardingDraftStateFields, continuity: "clarification_needed", rationale: "Need confirmation of address fields for the updated aggregate state." },
      { stepId: "capture-security-credentials-stage", stepName: "Capture Security Credentials Stage", inputTypeName: "AddressStageState", outputTypeName: "SecurityCredentialsStageState", inputFields: onboardingDraftStateFields, outputFields: onboardingDraftStateFields, continuity: "clarification_needed", rationale: "Need confirmation of credential fields for the updated aggregate state." },
      { stepId: "finalize-onboarding", stepName: "Finalize Onboarding", inputTypeName: "SecurityCredentialsStageState", outputTypeName: "FinalizedOnboardingState", inputFields: onboardingDraftStateFields, outputFields: onboardingDraftStateFields, continuity: "coherent", rationale: "Final validation uses the fully captured onboarding aggregate." },
      { stepId: "transition-status-to-pending-verification", stepName: "Transition Status To Pending Verification", inputTypeName: "FinalizedOnboardingState", outputTypeName: "PendingVerificationAccount", inputFields: onboardingDraftStateFields, outputFields: onboardingDraftStateFields, continuity: "coherent", rationale: "Status transition occurs after final validation." },
      { stepId: "resume-onboarding-state", stepName: "Resume Onboarding State", inputTypeName: "OnboardingResumeRequest", outputTypeName: "CurrentOnboardingState", flowRole: "resume", flowBoundaryRationale: "Separate query/resumption surface.", inputFields: [{ number: 1, name: "userId", type: "uuid" }], outputFields: [{ number: 1, name: "completedStage", type: "string" }], continuity: "coherent", rationale: "Resume does not participate in the forward-processing pipeline." }
    ],
    contractQuestions: [
      {
        id: "contract.personal-info.fields",
        key: "stepContracts",
        stepId: "capture-personal-info-stage",
        stepName: "Capture Personal Info Stage",
        kind: "fields",
        messageTypeName: "PersonalInfoStageState",
        prompt: "Confirm the inferred personal-info fields for the staged onboarding aggregate.",
        expectedAnswerShape: { type: "fields", description: "Confirm or edit the personal-info fields carried after this stage." },
        proposedAnswer: { questionId: "contract.personal-info.fields", fields: personalInfoQuestionFields },
        resolutionModes: ["confirm", "edit", "replace"]
      },
      {
        id: "contract.address.fields",
        key: "stepContracts",
        stepId: "capture-address-stage",
        stepName: "Capture Address Stage",
        kind: "fields",
        messageTypeName: "AddressStageState",
        prompt: "Confirm the inferred address fields for the staged onboarding aggregate.",
        expectedAnswerShape: { type: "fields", description: "Confirm or edit the address fields carried after this stage." },
        proposedAnswer: { questionId: "contract.address.fields", fields: addressQuestionFields },
        resolutionModes: ["confirm", "edit", "replace"]
      },
      {
        id: "contract.security-credentials.fields",
        key: "stepContracts",
        stepId: "capture-security-credentials-stage",
        stepName: "Capture Security Credentials Stage",
        kind: "fields",
        messageTypeName: "SecurityCredentialsStageState",
        prompt: "Confirm the inferred credential fields for the staged onboarding aggregate.",
        expectedAnswerShape: { type: "fields", description: "Confirm or edit the credential fields carried after this stage." },
        proposedAnswer: { questionId: "contract.security-credentials.fields", fields: credentialsQuestionFields },
        resolutionModes: ["confirm", "edit", "replace"]
      }
    ],
    futureStepCandidates: [
      "Integrate email verification service.",
      "Integrate third-party KYC/Identity verification API.",
      "Add automated onboarding metrics for admin dashboard."
    ],
    assumptions: [
      "Persistence is handled via an aspect/plugin, not explicit save steps.",
      "Resume is a separate query/resumption surface."
    ],
    questions: [],
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    aspects: {
      persistence: { enabled: true, scope: "GLOBAL", position: "AFTER_STEP" }
    },
    technicalConcerns: [
      { concern: "validation", appliesToSteps: ["validate-registration-input", "capture-personal-info-stage", "capture-address-stage", "capture-security-credentials-stage"], details: "Each stage validates required inputs before the aggregate advances." },
      { concern: "persistence", appliesToSteps: ["create-draft-account", "capture-personal-info-stage", "capture-address-stage", "capture-security-credentials-stage"], details: "Persistence is handled by a configured aspect rather than explicit save steps." },
      { concern: "encryption", appliesToSteps: ["capture-personal-info-stage", "capture-address-stage", "capture-security-credentials-stage"], details: "PII and credential material must be encrypted at rest." },
      { concern: "state-transition", appliesToSteps: ["create-draft-account", "transition-status-to-pending-verification"], details: "The account lifecycle moves from Draft to Pending Verification." },
      { concern: "replayability", appliesToSteps: ["capture-personal-info-stage", "capture-address-stage", "capture-security-credentials-stage"], details: "Stage submissions should support deterministic retry and resume." },
      { concern: "checkpoint-handoff", appliesToSteps: ["capture-personal-info-stage", "capture-address-stage", "capture-security-credentials-stage"], details: "Each stage output is a resumable checkpoint-style hand-off into the next stage." }
    ]
  };

  const revisedMessageCatalog = initialDraft.messageCatalog.map((message) => {
    if (message.name === "PersonalInfoStageState") {
      return {
        ...message,
        fields: [
          ...onboardingDraftStateFields,
          { number: 3, name: "firstName", type: "string" },
          { number: 4, name: "lastName", type: "string" },
          { number: 5, name: "dateOfBirth", type: "timestamp", optional: true }
        ]
      };
    }
    if (message.name === "AddressStageState") {
      return {
        ...message,
        fields: [
          ...onboardingDraftStateFields,
          { number: 3, name: "firstName", type: "string" },
          { number: 4, name: "lastName", type: "string" },
          { number: 5, name: "dateOfBirth", type: "timestamp", optional: true },
          { number: 6, name: "streetLine1", type: "string" },
          { number: 7, name: "city", type: "string" },
          { number: 8, name: "postalCode", type: "string" },
          { number: 9, name: "countryCode", type: "string" }
        ]
      };
    }
    if (message.name === "SecurityCredentialsStageState") {
      return {
        ...message,
        fields: [
          ...onboardingDraftStateFields,
          { number: 3, name: "firstName", type: "string" },
          { number: 4, name: "lastName", type: "string" },
          { number: 5, name: "dateOfBirth", type: "timestamp", optional: true },
          { number: 6, name: "streetLine1", type: "string" },
          { number: 7, name: "city", type: "string" },
          { number: 8, name: "postalCode", type: "string" },
          { number: 9, name: "countryCode", type: "string" },
          { number: 10, name: "password", type: "string" },
          { number: 11, name: "passwordSalt", type: "string", optional: true },
          { number: 12, name: "acceptedTermsVersion", type: "string" }
        ]
      };
    }
    return message;
  });

  const revisedDraft: PlannerDraft = {
    ...initialDraft,
    messageCatalog: revisedMessageCatalog,
    businessSteps: initialDraft.businessSteps.map((step) => {
      if (step.id === "capture-personal-info-stage") {
        return {
          ...step,
          outputFields: revisedMessageCatalog.find((message) => message.name === "PersonalInfoStageState")!.fields
        };
      }
      if (step.id === "capture-address-stage") {
        return {
          ...step,
          inputFields: revisedMessageCatalog.find((message) => message.name === "PersonalInfoStageState")!.fields,
          outputFields: revisedMessageCatalog.find((message) => message.name === "AddressStageState")!.fields
        };
      }
      if (step.id === "capture-security-credentials-stage") {
        return {
          ...step,
          inputFields: revisedMessageCatalog.find((message) => message.name === "AddressStageState")!.fields,
          outputFields: revisedMessageCatalog.find((message) => message.name === "SecurityCredentialsStageState")!.fields
        };
      }
      if (step.id === "finalize-onboarding") {
        return {
          ...step,
          inputFields: revisedMessageCatalog.find((message) => message.name === "SecurityCredentialsStageState")!.fields
        };
      }
      return step;
    }),
    stepContracts: initialDraft.stepContracts.map((contract) => {
      if (contract.stepId === "capture-personal-info-stage") {
        return {
          ...contract,
          outputFields: revisedMessageCatalog.find((message) => message.name === "PersonalInfoStageState")!.fields,
          continuity: "coherent"
        };
      }
      if (contract.stepId === "capture-address-stage") {
        return {
          ...contract,
          inputFields: revisedMessageCatalog.find((message) => message.name === "PersonalInfoStageState")!.fields,
          outputFields: revisedMessageCatalog.find((message) => message.name === "AddressStageState")!.fields,
          continuity: "coherent"
        };
      }
      if (contract.stepId === "capture-security-credentials-stage") {
        return {
          ...contract,
          inputFields: revisedMessageCatalog.find((message) => message.name === "AddressStageState")!.fields,
          outputFields: revisedMessageCatalog.find((message) => message.name === "SecurityCredentialsStageState")!.fields,
          continuity: "coherent"
        };
      }
      if (contract.stepId === "finalize-onboarding") {
        return {
          ...contract,
          inputFields: revisedMessageCatalog.find((message) => message.name === "SecurityCredentialsStageState")!.fields
        };
      }
      return contract;
    }),
    contractQuestions: []
  };

  return { initialDraft, revisedDraft };
}

function assertNoDuplicateMessageFields(config: DerivedConfig): void {
  for (const [messageName, definition] of Object.entries(config.messages)) {
    const seen = new Set<string>();
    for (const field of definition.fields) {
      assert.equal(seen.has(field.name), false, `message ${messageName} should not contain duplicate field ${field.name}`);
      seen.add(field.name);
    }
  }
}

function buildQueryConnectorConfig(): DerivedConfig {
  return {
    version: 2,
    appName: "QueryConnector",
    basePackage: "com.example.queryconnector",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    messages: {
      CustomerRiskLookup: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" }
        ]
      },
      CustomerRiskSnapshot: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" },
          { number: 2, name: "riskBand", type: "string" },
          { number: 3, name: "score", type: "decimal" }
        ]
      },
      CustomerDecision: {
        fields: [
          { number: 1, name: "customerId", type: "uuid" },
          { number: 2, name: "approved", type: "bool" },
          { number: 3, name: "riskBand", type: "string" }
        ]
      }
    },
    queries: {
      "customer-risk-by-id": {
        connector: "jpa",
        inputType: "CustomerRiskLookup",
        outputType: "CustomerRiskSnapshot",
        version: "v1",
        jpa: {
          entity: "com.example.queryconnector.common.domain.CustomerRiskEntity",
          where: {
            customerId: "input.customerId",
            riskBand: {
              in: ["LOW", "MEDIUM", "HIGH"]
            },
            score: {
              gte: 0
            },
            updatedAt: {
              between: ["input.windowStart", "input.windowEnd"]
            },
            deletedAt: {
              isNull: true
            },
            name: {
              like: "input.namePrefix"
            }
          },
          projection: {
            customerId: "customerId",
            riskBand: "riskBand",
            score: "score"
          },
          orderBy: {
            score: "desc"
          },
          limit: 1,
          result: "single"
        }
      }
    },
    steps: [
      {
        name: "Load Customer Risk",
        kind: "query",
        cardinality: "ONE_TO_ONE",
        query: "customer-risk-by-id",
        inputTypeName: "CustomerRiskLookup",
        outputTypeName: "CustomerRiskSnapshot",
        capture: {
          keyFields: ["customerId"]
        }
      },
      {
        name: "Classify Customer",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "CustomerRiskSnapshot",
        outputTypeName: "CustomerDecision"
      }
    ]
  };
}

function buildObjectIngestConfig(): DerivedConfig {
  return {
    version: 2,
    appName: "ObjectIngest",
    basePackage: "com.example.objectingest",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MODULAR",
    sources: {
      documents: {
        kind: "object",
        provider: "filesystem",
        location: {
          root: "/tmp/tpf-object-ingest"
        },
        filter: {
          include: ["**/*.txt", "**/*.md"]
        },
        poll: {
          enabled: true,
          interval: "PT30S",
          batchSize: 25
        },
        payload: {
          mode: "text",
          maxBytes: 1048576,
          charset: "UTF-8"
        }
      }
    },
    input: {
      object: {
        source: "documents",
        emits: {
          type: "com.example.objectingest.common.domain.RawDocument",
          typeName: "RawDocument",
          mapper: "com.example.objectingest.common.mapper.RawDocumentObjectSnapshotMapper"
        }
      }
    },
    messages: {
      RawDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "content", type: "string" }
        ]
      },
      ParsedDocument: {
        fields: [
          { number: 1, name: "documentId", type: "uuid" },
          { number: 2, name: "tokenCount", type: "int32" }
        ]
      }
    },
    steps: [
      {
        name: "Parse Document",
        kind: "internal",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "RawDocument",
        outputTypeName: "ParsedDocument",
        inboundMapper: "com.example.objectingest.common.mapper.RawDocumentMapper"
      }
    ]
  };
}

function buildRestaurantApprovalUnionConfig(): DerivedConfig {
  return {
    version: 2,
    appName: "RestaurantApproval",
    basePackage: "com.example.restaurantapproval",
    transport: "REST",
    platform: "COMPUTE",
    runtimeLayout: "MONOLITH",
    messages: {
      PendingRestaurantApproval: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "restaurantName", type: "string" }
        ]
      },
      RestaurantOrderAccepted: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "decidedAt", type: "timestamp" },
          { number: 3, name: "note", type: "string" },
          { number: 4, name: "adjustments", type: "decimal", repeated: true },
          { number: 5, name: "serviceDates", type: "map", keyType: "string", valueType: "date" }
        ]
      },
      RestaurantOrderDeclined: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "decidedAt", type: "timestamp" },
          { number: 3, name: "note", type: "string" },
          { number: 4, name: "declineReason", type: "string" }
        ]
      },
      TerminalOrderState: {
        fields: [
          { number: 1, name: "orderId", type: "uuid" },
          { number: 2, name: "outcome", type: "string" }
        ]
      }
    },
    unions: {
      RestaurantDecision: {
        variants: {
          accepted: {
            number: 1,
            type: "RestaurantOrderAccepted"
          },
          declined: {
            number: 2,
            type: "RestaurantOrderDeclined"
          }
        }
      }
    },
    steps: [
      {
        name: "Await Restaurant Decision",
        kind: "await",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "PendingRestaurantApproval",
        outputTypeName: "RestaurantDecision",
        timeout: "PT30M",
        idempotencyKeyFields: ["orderId"],
        await: {
          correlation: {
            strategy: "interactionId"
          },
          transport: {
            type: "interaction-api"
          }
        }
      },
      {
        name: "Finalize Restaurant Decision",
        cardinality: "ONE_TO_ONE",
        inputTypeName: "RestaurantDecision",
        outputTypeName: "TerminalOrderState"
      }
    ]
  };
}

async function readJson<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200);
  return response.json() as Promise<T>;
}
