import { openSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as processStdin, stderr as processStderr, stdout as processStdout } from "node:process";
import * as tty from "node:tty";
import { createOpenAiPlannerClient, type PlannerClient } from "./planner-client.js";
import { resolvePlannerToken } from "./credential-resolution.js";
import { LocalFileArtifactStore } from "./storage.js";
import { generateScaffold } from "./template-bridge.js";
import { WorkflowService } from "./workflow-service.js";
import type {
  ContractAnswerInput,
  ContractQuestion,
  DetailLevel,
  DraftContractsResult,
  PlannerProfile,
  PlannerProviderMode,
  Question,
  RuntimeLayout,
  Transport,
  Platform,
  WorkflowBriefInput
} from "./types.js";

interface InitCliOptions {
  provider: PlannerProviderMode;
  model?: string;
  input?: string;
  output?: string;
  appName?: string;
  basePackage?: string;
  transport?: Transport;
  platform?: Platform;
  runtimeLayout?: RuntimeLayout;
  profile: PlannerProfile;
  detail: DetailLevel;
  answersPath?: string;
  nonInteractive: boolean;
}

interface InitCliIo {
  stdinText?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

type AnswerFilePayload = unknown;

export async function runMcpCli(args: string[], io: InitCliIo = {}): Promise<number> {
  const command = args[0];
  if (!command || command === "serve" || command === "stdio") {
    const { startBridgeServer } = await import("./bridge-runtime.js");
    await startBridgeServer(io.env ?? process.env);
    return 0;
  }
  if (command === "init") {
    return runInitCommand(args.slice(1), io);
  }
  if (command === "--help" || command === "-h" || command === "help") {
    write(io.stdout, helpText());
    return 0;
  }
  writeError(io, `Unknown command '${command}'.\n\n${helpText()}`);
  return 1;
}

export async function runInitCommand(args: string[], io: InitCliIo = {}): Promise<number> {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const options = parseInitOptions(args, env);
  const briefText = await readBriefText(options, io.stdinText);
  const workflowInput: WorkflowBriefInput = {
    briefText,
    ...(options.appName ? { appName: options.appName } : {}),
    ...(options.basePackage ? { basePackage: options.basePackage } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.runtimeLayout ? { runtimeLayout: options.runtimeLayout } : {})
  };
  const plannerClient = createPlannerClient(options, env, cwd);
  const workflowService = new WorkflowService(
    new LocalFileArtifactStore(path.join(os.tmpdir(), "tpf-mcp-init-artifacts")),
    plannerClient
  );
  writeError(io, `Planning scaffold with ${options.provider}${options.model ? ` (${options.model})` : ""}...\n`);
  const inspected = await workflowService.inspectBrief({ ...workflowInput, detail: options.detail });
  const protocol = await workflowService.draftProtocol({ workId: inspected.workId, detail: options.detail });
  printProtocolSummary(protocol, io);
  let answersPayload = options.answersPath ? await readAnswersFile(options.answersPath) : undefined;
  let compile = await workflowService.compileScaffoldPlan({ workId: inspected.workId, detail: "full" });

  for (let round = 0; !compile.ready && round < 8; round += 1) {
    const contracts = await workflowService.draftContracts({ workId: inspected.workId, detail: "full" });
    let answers = answersPayload === undefined
      ? []
      : normalizeAnswersPayload(answersPayload, contracts);
    answersPayload = undefined;
    if (answers.length === 0) {
      if (options.nonInteractive) {
        throw new Error(formatUnresolvedQuestionsError(contracts));
      }
      answers = await promptForAnswers(contracts, io);
    }
    if (answers.length === 0) {
      throw new Error(formatUnresolvedQuestionsError(contracts));
    }
    writeError(io, "Resolving answers and updating scaffold plan...\n");
    await workflowService.resolveContracts({
      workId: inspected.workId,
      answers,
      detail: options.detail
    });
    answers = [];
    compile = await workflowService.compileScaffoldPlan({ workId: inspected.workId, detail: "full" });
  }

  if (!compile.ready || !compile.derivedConfig) {
    throw new Error("Unable to compile a scaffold plan after resolving available questions.");
  }

  const outputDir = path.resolve(cwd, options.output ?? sanitizePathSegment(compile.appName));
  writeError(io, `Generating scaffold in ${outputDir}...\n`);
  const generatedPath = await generateScaffold(compile.derivedConfig, outputDir);
  write(io.stdout, JSON.stringify({
    status: "generated",
    workId: inspected.workId,
    provider: options.provider,
    appName: compile.appName,
    basePackage: compile.basePackage,
    protocolKind: protocol.protocolKind,
    generatedPath,
    stepCount: compile.stepCount,
    questionCount: compile.questionCount
  }, null, 2) + "\n");
  return 0;
}

function printProtocolSummary(protocol: Awaited<ReturnType<WorkflowService["draftProtocol"]>>, io: InitCliIo): void {
  writeError(io, [
    "",
    "TPF scaffold plan",
    `Protocol: ${protocol.protocolKind}`,
    `Questions before generation: ${protocol.remainingQuestionsCount}`,
    "",
    "Business steps:"
  ].join("\n") + "\n");

  protocol.businessSteps.forEach((step, index) => {
    writeError(io, [
      `${index + 1}. ${step.name}`,
      `   id: ${step.id}`,
      `   kind: ${step.kind || "internal"}`,
      `   contract: ${step.inputTypeName} -> ${step.outputTypeName}`,
      `   purpose: ${step.purpose}`
    ].join("\n") + "\n");
  });

  if (protocol.boundaries.length > 0) {
    writeError(io, "\nBoundaries:\n");
    protocol.boundaries.forEach((boundary, index) => {
      writeError(io, `${index + 1}. ${boundary.type}: ${boundary.name} (${boundary.status})\n`);
    });
  }
}

function parseInitOptions(args: string[], env: NodeJS.ProcessEnv): InitCliOptions {
  const options: Partial<InitCliOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      throw new CliUsageError(helpText(), 0);
    }
    if (!arg.startsWith("--")) {
      throw new CliUsageError(`Unexpected argument '${arg}'.\n\n${helpText()}`, 1);
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === "non-interactive" && inlineValue === undefined) {
      options.nonInteractive = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined) {
      throw new CliUsageError(`Missing value for --${rawKey}.`, 1);
    }
    switch (rawKey) {
      case "provider":
        options.provider = readPlannerProviderMode(value);
        break;
      case "model":
        options.model = value;
        break;
      case "input":
        options.input = value;
        break;
      case "output":
        options.output = value;
        break;
      case "app-name":
        options.appName = value;
        break;
      case "base-package":
        options.basePackage = value;
        break;
      case "transport":
        options.transport = readTransport(value);
        break;
      case "platform":
        options.platform = readPlatform(value);
        break;
      case "runtime-layout":
        options.runtimeLayout = readRuntimeLayout(value);
        break;
      case "profile":
        options.profile = readPlannerProfile(value);
        break;
      case "detail":
        options.detail = readDetailLevel(value);
        break;
      case "answers":
        options.answersPath = value;
        break;
      case "non-interactive":
        options.nonInteractive = value !== "false";
        break;
      default:
        throw new CliUsageError(`Unknown option --${rawKey}.\n\n${helpText()}`, 1);
    }
  }
  const envModel = env.TPF_LLM_MODEL?.trim();
  return {
    provider: options.provider ?? readPlannerProviderMode(env.TPF_LLM_PROVIDER_MODE || "codex_cli"),
    model: (options.model ?? envModel) || undefined,
    input: options.input,
    output: options.output,
    appName: options.appName,
    basePackage: options.basePackage,
    transport: options.transport,
    platform: options.platform,
    runtimeLayout: options.runtimeLayout,
    profile: options.profile ?? readPlannerProfile(env.TPF_LLM_PROFILE),
    detail: options.detail ?? "summary",
    answersPath: options.answersPath,
    nonInteractive: options.nonInteractive ?? false
  };
}

function createPlannerClient(options: InitCliOptions, env: NodeJS.ProcessEnv, cwd: string): PlannerClient {
  if (options.provider === "mock") {
    return createOpenAiPlannerClient({
      providerMode: "mock",
      model: options.model,
      profile: options.profile,
      workingDirectory: cwd,
      environment: env
    });
  }
  if (options.provider === "codex_cli" || options.provider === "opencode") {
    return createOpenAiPlannerClient({
      providerMode: options.provider,
      model: options.model,
      profile: options.profile,
      workingDirectory: cwd,
      environment: env
    });
  }
  if (options.provider === "ollama-native") {
    return createOpenAiPlannerClient({
      providerMode: options.provider,
      endpoint: env.TPF_LLM_ENDPOINT || "http://localhost:11434",
      model: options.model || "qwen3.5:4b",
      token: env.TPF_LLM_TOKEN,
      profile: options.profile
    });
  }
  return createOpenAiPlannerClient({
    providerMode: "openai-compatible",
    endpoint: env.TPF_LLM_ENDPOINT || "https://api.openai.com/v1",
    model: options.model || env.TPF_LLM_MODEL || "gpt-4.1",
    token: resolvePlannerToken(env, "openai-compatible"),
    profile: options.profile
  });
}

async function readBriefText(options: InitCliOptions, stdinText: string | undefined): Promise<string> {
  const text = options.input
    ? await fs.readFile(options.input, "utf8")
    : stdinText ?? await readAllStdin();
  if (!text.trim()) {
    throw new Error("No brief provided. Pass --input <file> or pipe a brief on stdin.");
  }
  return text;
}

async function readAllStdin(): Promise<string> {
  if (processStdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readAnswersFile(filePath: string): Promise<AnswerFilePayload> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

export function normalizeAnswersPayload(payload: AnswerFilePayload, result: DraftContractsResult): ContractAnswerInput[] {
  if (payload && typeof payload === "object" && Array.isArray((payload as { answers?: unknown }).answers)) {
    return normalizeAnswersPayload((payload as { answers: unknown }).answers, result);
  }

  if (Array.isArray(payload)) {
    if (payload.every(isFieldAnswerLike)) {
      const question = singleContractFieldQuestion(result);
      return [{
        questionId: question.id,
        resolution: "replace",
        fields: payload
      }];
    }

    const answers = payload as Partial<ContractAnswerInput>[];
    const missingQuestionId = answers.find((answer) => !answer.questionId);
    if (missingQuestionId) {
      const question = singleContractFieldQuestion(result);
      if (answers.length === 1) {
        return [{
          ...answers[0],
          questionId: question.id,
          resolution: answers[0].resolution || "replace"
        }];
      }
      throw new Error("--answers contains multiple answer records; each record must include questionId.");
    }
    return answers as ContractAnswerInput[];
  }

  if (payload && typeof payload === "object") {
    const answer = payload as Partial<ContractAnswerInput>;
    if (answer.fields || answer.values || answer.fieldEdits || answer.valueEdits) {
      const questionId = answer.questionId || singleContractFieldQuestion(result).id;
      return [{
        ...answer,
        questionId,
        resolution: answer.resolution || "replace"
      }];
    }
  }

  throw new Error("--answers must be a field array, an answer object, an answer array, or an object with an answers array.");
}

function singleContractFieldQuestion(result: DraftContractsResult): ContractQuestion {
  const questions = result.contractQuestions.filter((question) => question.expectedAnswerShape.type === "fields");
  if (questions.length !== 1) {
    throw new Error(
      `--answers provided a bare field list, but there are ${questions.length} active field questions. ` +
      "Use answer records with questionId for each question."
    );
  }
  return questions[0];
}

function isFieldAnswerLike(value: unknown): value is NonNullable<ContractAnswerInput["fields"]>[number] {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    && typeof (value as { type?: unknown }).type === "string"
    && !("questionId" in value)
  );
}

async function promptForAnswers(result: DraftContractsResult, io: InitCliIo): Promise<ContractAnswerInput[]> {
  const questions = [...(result.semanticQuestions || []), ...result.contractQuestions];
  if (questions.length === 0) {
    return [];
  }
  const ttyPath = process.platform === "win32" ? "CON" : "/dev/tty";
  let input: tty.ReadStream | undefined;
  let output: tty.WriteStream | undefined;
  try {
    input = new tty.ReadStream(openSync(ttyPath, "r"));
    output = new tty.WriteStream(openSync(ttyPath, "w"));
  } catch {
    throw new Error(formatUnresolvedQuestionsError(result));
  }
  const rl = createInterface({ input, output });
  try {
    const answers: ContractAnswerInput[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      answers.push(await promptForAnswer(rl, questions[index], io, {
        index: index + 1,
        total: questions.length,
        result
      }));
    }
    return answers;
  } finally {
    rl.close();
    input.destroy();
    output.destroy();
  }
}

async function promptForAnswer(
  rl: ReturnType<typeof createInterface>,
  question: Question | ContractQuestion,
  io: InitCliIo,
  context: { index: number; total: number; result: DraftContractsResult }
): Promise<ContractAnswerInput> {
  writeError(io, formatQuestionHeader(question, context));
  if (isContractQuestion(question) && question.proposedAnswer) {
    writeError(io, `Proposed answer:\n${JSON.stringify(question.proposedAnswer, null, 2)}\n`);
    const response = (await rl.question("Use proposed answer? [Y/n/json] ")).trim();
    if (!response || /^y(es)?$/i.test(response)) {
      return {
        questionId: question.id,
        resolution: "confirm",
        ...(question.proposedAnswer.fields ? { fields: question.proposedAnswer.fields } : {}),
        ...(question.proposedAnswer.values ? { values: question.proposedAnswer.values } : {})
      };
    }
    if (/^n(o)?$/i.test(response)) {
      const json = await rl.question("Enter answer JSON: ");
      return parseAnswerJson(question.id, json);
    }
    return parseAnswerJson(question.id, response);
  }
  if (isContractQuestion(question)) {
    if (question.expectedAnswerShape.type === "fields") {
      return promptForFieldAnswer(rl, question, io);
    }
    writeError(io, `Expected answer shape: ${question.expectedAnswerShape.description}\n`);
    const response = await rl.question("Enter comma-separated values: ");
    return {
      questionId: question.id,
      resolution: "replace",
      values: response.split(",").map((value) => value.trim()).filter(Boolean)
    };
  }
  const response = await rl.question("Answer: ");
  return { questionId: question.id, values: [response.trim()] };
}

function formatQuestionHeader(
  question: Question | ContractQuestion,
  context: { index: number; total: number; result: DraftContractsResult }
): string {
  const lines = [
    "",
    `Question ${context.index}/${context.total}`,
    question.prompt
  ];

  if (question.stepId || question.stepName) {
    const contract = isContractQuestion(question)
      ? context.result.proposedContracts.find((candidate) => candidate.stepId === question.stepId)
      : undefined;
    const stepIndex = context.result.proposedContracts.findIndex((candidate) => candidate.stepId === question.stepId);
    const role = contract && isContractQuestion(question)
      ? question.messageTypeName === contract.inputTypeName
        ? "input"
        : question.messageTypeName === contract.outputTypeName
          ? "output"
          : "related"
      : "related";

    lines.push(
      `Step: ${stepIndex >= 0 ? `${stepIndex + 1}. ` : ""}${question.stepName || question.stepId}`,
      ...(contract ? [
        `Step purpose: ${contract.rationale}`,
        `Step contract: ${contract.inputTypeName} -> ${contract.outputTypeName}`
      ] : []),
      ...(isContractQuestion(question) ? [
        `You are defining the ${role} message: ${question.messageTypeName}`
      ] : [])
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function promptForFieldAnswer(
  rl: ReturnType<typeof createInterface>,
  question: ContractQuestion,
  io: InitCliIo
): Promise<ContractAnswerInput> {
  writeError(io, [
    `Message type: ${question.messageTypeName}`,
    "Enter one field per prompt. Use blank field name when done.",
    "Supported common types include string, uuid, int32, int64, bool, double, bytes, or another message type."
  ].join("\n") + "\n");

  const fields: NonNullable<ContractAnswerInput["fields"]> = [];
  while (true) {
    const name = (await rl.question("Field name: ")).trim();
    if (!name) {
      break;
    }
    const type = (await rl.question(`Type for ${name} [string]: `)).trim() || "string";
    const requiredAnswer = (await rl.question(`Required? [Y/n]: `)).trim();
    const repeatedAnswer = (await rl.question("Repeated? [y/N]: ")).trim();
    fields.push({
      name,
      type,
      required: !/^n(o)?$/i.test(requiredAnswer),
      repeated: /^y(es)?$/i.test(repeatedAnswer)
    });
  }

  if (fields.length === 0) {
    const rawJson = await rl.question("No fields entered. Paste fields JSON array, or leave blank to fail: ");
    if (!rawJson.trim()) {
      throw new Error(`No fields provided for ${question.messageTypeName}.`);
    }
    return parseContractReplacementAnswer(question.id, rawJson);
  }

  return {
    questionId: question.id,
    resolution: "replace",
    fields
  };
}

function parseAnswerJson(questionId: string, value: string): ContractAnswerInput {
  const parsed = JSON.parse(value) as Partial<ContractAnswerInput>;
  return {
    ...parsed,
    questionId: parsed.questionId || questionId
  };
}

function parseContractReplacementAnswer(questionId: string, value: string): ContractAnswerInput {
  const parsed = JSON.parse(value) as unknown;
  if (Array.isArray(parsed)) {
    return {
      questionId,
      resolution: "replace",
      fields: parsed as ContractAnswerInput["fields"]
    };
  }
  return {
    ...(parsed as Partial<ContractAnswerInput>),
    questionId: (parsed as Partial<ContractAnswerInput>).questionId || questionId,
    resolution: (parsed as Partial<ContractAnswerInput>).resolution || "replace"
  };
}

function formatUnresolvedQuestionsError(result: DraftContractsResult): string {
  return [
    "The scaffold plan needs input before generation.",
    "Provide answers interactively from a terminal or pass --answers <file>.",
    JSON.stringify({
      workId: result.workId,
      semanticQuestions: result.semanticQuestions || [],
      contractQuestions: result.contractQuestions
    }, null, 2)
  ].join("\n");
}

function isContractQuestion(question: Question | ContractQuestion): question is ContractQuestion {
  return question.key === "stepContracts";
}

function readPlannerProviderMode(rawValue: string | undefined): PlannerProviderMode {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "openai-compatible") {
    return "openai-compatible";
  }
  if (normalized === "ollama-native") {
    return "ollama-native";
  }
  if (normalized === "codex_cli" || normalized === "codex-cli") {
    return "codex_cli";
  }
  if (normalized === "opencode") {
    return "opencode";
  }
  if (normalized === "mock") {
    return "mock";
  }
  throw new Error(`Unsupported provider '${rawValue}'. Allowed values: openai-compatible, ollama-native, codex_cli, opencode, mock.`);
}

function readPlannerProfile(rawValue: string | undefined): PlannerProfile {
  const normalized = rawValue?.trim().toLowerCase();
  if (!normalized || normalized === "full") {
    return "full";
  }
  if (normalized === "compact") {
    return "compact";
  }
  throw new Error(`Unsupported profile '${rawValue}'. Allowed values: full, compact.`);
}

function readDetailLevel(rawValue: string): DetailLevel {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "summary" || normalized === "full") {
    return normalized;
  }
  throw new Error(`Unsupported detail '${rawValue}'. Allowed values: summary, full.`);
}

function readTransport(rawValue: string): Transport {
  const normalized = rawValue.trim().toUpperCase();
  if (normalized === "GRPC" || normalized === "REST" || normalized === "LOCAL") {
    return normalized;
  }
  throw new Error(`Unsupported transport '${rawValue}'. Allowed values: GRPC, REST, LOCAL.`);
}

function readPlatform(rawValue: string): Platform {
  const normalized = rawValue.trim().toUpperCase();
  if (normalized === "COMPUTE" || normalized === "FUNCTION") {
    return normalized;
  }
  throw new Error(`Unsupported platform '${rawValue}'. Allowed values: COMPUTE, FUNCTION.`);
}

function readRuntimeLayout(rawValue: string): RuntimeLayout {
  const normalized = rawValue.trim().toUpperCase().replace(/-/g, "_");
  if (normalized === "MODULAR" || normalized === "PIPELINE_RUNTIME" || normalized === "MONOLITH") {
    return normalized;
  }
  throw new Error(`Unsupported runtime layout '${rawValue}'. Allowed values: MODULAR, PIPELINE_RUNTIME, MONOLITH.`);
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tpf-app";
}

function write(stream: Pick<NodeJS.WriteStream, "write"> | undefined, value: string): void {
  (stream ?? processStdout).write(value);
}

function writeError(io: InitCliIo, value: string): void {
  (io.stderr ?? processStderr).write(value);
}

function helpText(): string {
  return `Usage:
  mcp                         Start the stdio MCP bridge
  mcp init [options] < brief.md

Options:
  --provider <name>           codex_cli, opencode, ollama-native, openai-compatible, mock
  --model <model>             Provider model override
  --input <file>              Read brief from file instead of stdin
  --output <dir>              Generated application directory
  --app-name <name>           Application name override
  --base-package <package>    Java base package override
  --transport <value>         GRPC, REST, or LOCAL
  --platform <value>          COMPUTE or FUNCTION
  --runtime-layout <value>    MODULAR, PIPELINE_RUNTIME, or MONOLITH
  --answers <file>            JSON answers for unresolved questions
  --non-interactive=true      Fail with question JSON instead of prompting
`;
}

class CliUsageError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function isCliUsageError(error: unknown): error is CliUsageError {
  return error instanceof CliUsageError;
}
