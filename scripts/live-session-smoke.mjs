import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = "https://mcp.pipelineframework.org/mcp";
const outDir = "/private/tmp/tpf-mcp-live-smoke";

const brief = `User Story: Core Onboarding Backend System (MVP)
Story Title: Secure & Incremental User Onboarding Profile Creation
User Persona: New End-User (End-User), System Administrator (System)

1. The Why & What
As a new user,
I want to create my account and provide my required personal information in multiple stages,
So that I can join the platform quickly without being overwhelmed by a single, long form, and resume later if needed.

As a system admin/business owner,
I want the backend to validate user input in real-time and secure all data at rest,
So that I can ensure compliance, minimize incomplete applications, and protect user privacy.

2. Value Proposition
Reduced Friction: Allows users to save progress, increasing completion rates.
Data Integrity: Validates inputs before database ingestion.
Scalability: Modular design allows for adding future steps (e.g., KYC, KYC check).

3. High-Level Requirements (No Implementation Details)
Registration: Enable user creation using unique identifiers (e.g., email or mobile).
State Management: Track the current status of onboarding (e.g., Draft, Pending Verification, Active).
Data Persistence: Save inputs for personal info, address, and security credentials (e.g., password) securely.
Resume Functionality: Allow a user to return and continue from the last completed stage.
Data Validation: Ensure all mandatory fields are present and in the correct format before advancing.
Secure Storage: All personal and identification data must be encrypted.

4. Acceptance Criteria
AC1: Given I am a new user, when I register with an email and password, then I receive a Draft account and a unique ID.
AC2: Given I am in a Draft state, when I submit partial profile data (e.g., first name, last name), then the system saves this data and enables me to resume.
AC3: Given I am filling out the form, when I skip a mandatory field, then the system rejects the request and indicates which field is required.
AC4: Given I have completed all required fields, when I click finish, then my account status changes to Pending Verification.
AC5: Given my data is stored, when a data audit is performed, then all personally identifiable information (PII) is encrypted.

5. Potential Follow-up Stories (Future Sprints)
Integrate email verification service.
Integrate third-party KYC/Identity verification API.
Add automated onboarding metrics for admin dashboard.`;

const answerCatalog = {
  address_stage_fields: [
    { name: "streetLine1", type: "string", required: true, source: "payload" },
    { name: "streetLine2", type: "string", required: false, source: "payload" },
    { name: "city", type: "string", required: true, source: "payload" },
    { name: "stateProvince", type: "string", required: true, source: "payload" },
    { name: "postalCode", type: "string", required: true, source: "payload" },
    { name: "countryCode", type: "string", required: true, source: "payload" }
  ],
  security_credentials_fields: [
    { name: "password", type: "string", required: true, source: "payload" },
    { name: "passwordConfirmation", type: "string", required: true, source: "payload" }
  ],
  personal_info_fields: [
    { name: "firstName", type: "string", required: true, source: "payload" },
    { name: "lastName", type: "string", required: true, source: "payload" },
    { name: "dateOfBirth", type: "date", required: false, source: "payload" }
  ]
};

function normalizeQuestionPrompt(prompt = "") {
  return String(prompt).toLowerCase();
}

function resolveAnswer(question) {
  const prompt = normalizeQuestionPrompt(question.prompt);
  if (prompt.includes("address")) {
    return { questionId: question.id, fields: answerCatalog.address_stage_fields };
  }
  if (prompt.includes("credential") || prompt.includes("password") || prompt.includes("security")) {
    return { questionId: question.id, fields: answerCatalog.security_credentials_fields };
  }
  if (prompt.includes("personal info") || prompt.includes("first name") || prompt.includes("last name")) {
    return { questionId: question.id, fields: answerCatalog.personal_info_fields };
  }
  throw new Error(`No canned answer for question '${question.id}': ${question.prompt}`);
}

function structured(result) {
  if (result.structuredContent) {
    return result.structuredContent;
  }
  const text = result.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { _rawText: text, _rawResult: result };
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: "codex-live-smoke", version: "1.0.0" });
  await client.connect(transport);

  const startResult = structured(await client.callTool({
    name: "start_brief_session",
    arguments: {
      briefText: brief,
      appName: "onboarding-backend",
      basePackage: "org.pipelineframework.demo.onboarding"
    }
  }));

  const sessionId = startResult.sessionId;
  let current = startResult;

  if (current.status === "needs_input") {
    const answers = current.contractQuestions.map(resolveAnswer);
    current = structured(await client.callTool({
      name: "answer_contract_questions",
      arguments: { sessionId, answers }
    }));
  }

  const generatedCall = await client.callTool({
    name: "generate_scaffold",
    arguments: { sessionId }
  });
  const generated = structured(generatedCall);

  if (!generated.artifact?.downloadUrl) {
    throw new Error(`No download URL returned: ${JSON.stringify(generated, null, 2)}`);
  }

  const response = await fetch(generated.artifact.downloadUrl);
  if (!response.ok) {
    throw new Error(`Artifact download failed: ${response.status} ${response.statusText}`);
  }
  const zipBytes = new Uint8Array(await response.arrayBuffer());
  const zipPath = join(outDir, "onboarding-generated.zip");
  await writeFile(zipPath, zipBytes);

  const zip = await JSZip.loadAsync(zipBytes);
  const entries = Object.keys(zip.files).sort();
  const pipelineYaml = await zip.file("config/pipeline.yaml")?.async("string");
  if (!pipelineYaml) {
    throw new Error("Generated artifact is missing config/pipeline.yaml");
  }
  await writeFile(join(outDir, "pipeline.yaml"), pipelineYaml, "utf8");

  const summary = {
    endpoint,
    sessionId,
    initialStatus: startResult.status,
    postAnswerStatus: current.status,
    finalStatus: generated.status,
    assumptions: current.assumptions,
    businessSteps: current.businessSteps?.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      inputTypeName: step.inputTypeName,
      outputTypeName: step.outputTypeName
    })),
    contractQuestions: startResult.contractQuestions,
    answeredQuestions: startResult.contractQuestions?.map((question) => ({
      id: question.id,
      prompt: question.prompt
    })),
    artifact: generated.artifact,
    zipPath,
    pipelineYamlPath: join(outDir, "pipeline.yaml"),
    zipEntries: entries.slice(0, 80)
  };

  console.log(JSON.stringify(summary, null, 2));
  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
