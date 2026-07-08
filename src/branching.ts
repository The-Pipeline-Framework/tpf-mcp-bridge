import type {
  DerivedConfig,
  PipelineBranchingMetadata,
  PipelineStep,
  StepContract,
  UnionDefinition,
  WorkflowBranchingTopology
} from "./types.js";
import { simpleTypeName } from "./type-name-utils.js";

type BranchStepLike = Pick<PipelineStep, "name" | "cardinality" | "inputTypeName" | "outputTypeName" | "accepts" | "terminal">
  | Pick<StepContract, "stepName" | "inputTypeName" | "outputTypeName" | "accepts" | "terminal">;

export interface BranchingPlanStep {
  index: number;
  step: string;
  inputTypeName: string;
  outputTypeName: string;
  acceptedContracts: string[];
  acceptedLeafTypes: string[];
  producedContracts: string[];
  terminal: boolean;
}

export interface BranchingPlan {
  terminalStepIndex: number;
  steps: BranchingPlanStep[];
}

export function expandLeafTypes(typeName: string, unions: Record<string, UnionDefinition> = {}): string[] {
  const normalizedType = normalizeContractType(typeName);
  const union = unions[normalizedType];
  if (!union) {
    return normalizedType ? [normalizedType] : [];
  }
  return Object.values(union.variants || {})
    .map((variant) => normalizeContractType(variant.type))
    .filter(Boolean);
}

export function isBranchAwareConfig(config: Pick<DerivedConfig, "steps" | "unions">): boolean {
  return isBranchAwareSteps(config.steps || [], config.unions || {});
}

export function isBranchAwareSteps(
  steps: Array<Pick<PipelineStep, "inputTypeName" | "outputTypeName" | "accepts" | "terminal">>,
  _unions: Record<string, UnionDefinition> = {}
): boolean {
  return steps.some((step) => Boolean(step.terminal) || (step.accepts?.length ?? 0) > 0);
}

export function buildBranchingPlan(
  steps: Array<BranchStepLike>,
  unions: Record<string, UnionDefinition> = {}
): BranchingPlan | undefined {
  const normalizedSteps = steps.map((step, index) => normalizeStep(step, index));
  if (!isBranchAwareSteps(normalizedSteps, unions)) {
    return undefined;
  }

  const terminalSteps = normalizedSteps.filter((step) => step.terminal);
  if (terminalSteps.length !== 1) {
    throw new Error("Branch-aware pipelines require exactly one step with terminal: true.");
  }

  const terminalStepIndex = normalizedSteps.findIndex((step) => step.terminal);
  if (terminalStepIndex !== normalizedSteps.length - 1) {
    throw new Error("The terminal: true step must be the last authored step in a branch-aware pipeline.");
  }

  const planSteps = normalizedSteps.map((step, index) => {
    const inputLeafTypes = expandLeafTypes(step.inputTypeName, unions);
    const outputLeafTypes = expandLeafTypes(step.outputTypeName, unions);
    if (inputLeafTypes.length === 0) {
      throw new Error(`Step '${step.name}' must declare inputTypeName.`);
    }
    if (outputLeafTypes.length === 0) {
      throw new Error(`Step '${step.name}' must declare outputTypeName.`);
    }

    const branchShapeEnabled = step.terminal || (step.accepts?.length ?? 0) > 0 || inputLeafTypes.length > 1 || outputLeafTypes.length > 1;
    if (branchShapeEnabled && step.cardinality !== "ONE_TO_ONE") {
      throw new Error(
        `Branch-aware routing currently supports ONE_TO_ONE steps once type-based routing is in play. Step '${step.name}' declares cardinality '${step.cardinality}'.`
      );
    }

    const acceptedContracts = normalizeAcceptedContracts(step, unions, inputLeafTypes);
    if (step.terminal && outputLeafTypes.length !== 1) {
      throw new Error(
        `Terminal step '${step.name}' must declare one concrete terminal output type. outputTypeName '${step.outputTypeName}' resolves to ${formatList(outputLeafTypes)}.`
      );
    }

    return {
      index,
      step: step.name,
      inputTypeName: step.inputTypeName,
      outputTypeName: step.outputTypeName,
      acceptedContracts,
      acceptedLeafTypes: acceptedContracts.map((value) => normalizeContractType(value)),
      producedContracts: outputLeafTypes,
      terminal: step.terminal
    } satisfies BranchingPlanStep;
  });

  validateBranchReachability(planSteps, unions);
  return {
    terminalStepIndex,
    steps: planSteps
  };
}

export function buildBranchingMetadata(config: DerivedConfig): PipelineBranchingMetadata | undefined {
  const plan = buildBranchingPlan(config.steps || [], config.unions || {});
  if (!plan) {
    return undefined;
  }
  return {
    terminalStepIndex: plan.terminalStepIndex,
    steps: plan.steps.map((step) => ({
      index: step.index,
      step: step.step,
      inputTypeName: step.inputTypeName,
      outputTypeName: step.outputTypeName,
      acceptedContracts: [...step.acceptedContracts],
      producedContracts: [...step.producedContracts],
      terminal: step.terminal
    }))
  };
}

export function buildWorkflowBranchingTopology(
  steps: Array<Pick<PipelineStep, "id" | "name" | "cardinality" | "inputTypeName" | "outputTypeName" | "accepts" | "terminal">>,
  unions: Record<string, UnionDefinition> = {}
): WorkflowBranchingTopology | undefined {
  const plan = buildBranchingPlan(steps, unions);
  if (!plan) {
    return undefined;
  }

  const variants = Object.entries(unions || {}).map(([name, union]) => ({
    name,
    variants: Object.entries(union.variants || {})
      .sort((left, right) => Number(left[1]?.number || 0) - Number(right[1]?.number || 0))
      .map(([variantName, variant]) => ({
        name: variantName,
        type: variant.type,
        number: variant.number
      }))
  }));
  const terminalStep = steps[plan.terminalStepIndex];

  return {
    enabled: true,
    terminalStepId: terminalStep?.id,
    terminalStepName: terminalStep?.name,
    unions: variants,
    routes: plan.steps.map((step) => {
      const source = steps[step.index];
      return {
        stepId: source?.id || `step.${step.index + 1}`,
        stepName: step.step,
        inputTypeName: step.inputTypeName,
        outputTypeName: step.outputTypeName,
        accepts: [...step.acceptedContracts],
        producedContracts: [...step.producedContracts],
        terminal: step.terminal
      };
    })
  };
}

function normalizeStep(step: BranchStepLike, index: number): Required<Pick<PipelineStep, "name" | "cardinality" | "inputTypeName" | "outputTypeName" | "accepts" | "terminal">> {
  const name = "name" in step ? step.name : step.stepName;
  return {
    name,
    cardinality: "cardinality" in step ? step.cardinality : "ONE_TO_ONE",
    inputTypeName: normalizeContractType(step.inputTypeName),
    outputTypeName: normalizeContractType(step.outputTypeName),
    accepts: (step.accepts || []).map((value) => normalizeContractType(value)).filter(Boolean),
    terminal: Boolean(step.terminal)
  };
}

function normalizeAcceptedContracts(
  step: Required<Pick<PipelineStep, "name" | "cardinality" | "inputTypeName" | "outputTypeName" | "accepts" | "terminal">>,
  unions: Record<string, UnionDefinition>,
  inputLeafTypes: string[]
): string[] {
  if (!step.accepts.length) {
    if (inputLeafTypes.length !== 1) {
      throw new Error(
        `Step '${step.name}' resolves inputTypeName '${step.inputTypeName}' to multiple alternatives ${formatList(inputLeafTypes)}. Explicit accepts is required.`
      );
    }
    return [...inputLeafTypes];
  }

  const acceptedLeafTypes = new Set<string>();
  for (const accepted of step.accepts) {
    if (unions[accepted]) {
      throw new Error(
        `Step '${step.name}' accepts '${accepted}', but accepts may reference only concrete contract types, not unions.`
      );
    }
    const acceptedLeaf = expandLeafTypes(accepted, unions);
    if (acceptedLeaf.length === 0) {
      throw new Error(`Step '${step.name}' accepts '${accepted}', which does not resolve to a known contract type.`);
    }
    for (const leaf of acceptedLeaf) {
      acceptedLeafTypes.add(leaf);
    }
  }

  const inputLeafSet = new Set(inputLeafTypes);
  for (const accepted of acceptedLeafTypes) {
    if (!inputLeafSet.has(accepted)) {
      throw new Error(
        `Step '${step.name}' accepts ${formatList([...acceptedLeafTypes])} but inputTypeName '${step.inputTypeName}' resolves to ${formatList(inputLeafTypes)}.`
      );
    }
  }

  return [...acceptedLeafTypes];
}

function validateBranchReachability(planSteps: BranchingPlanStep[], unions: Record<string, UnionDefinition>): void {
  let reachable = new Set(expandLeafTypes(planSteps[0]?.inputTypeName || "", unions));

  for (const step of planSteps) {
    const acceptedLeafTypes = new Set(step.acceptedLeafTypes);
    if (step.terminal) {
      for (const reachableType of reachable) {
        if (!acceptedLeafTypes.has(reachableType)) {
          throw new Error(
            `Terminal step '${step.step}' must accept every reachable branch-end alternative. Reachable alternatives are ${formatList([...reachable])}.`
          );
        }
      }
    }

    const nextReachable = new Set<string>();
    for (const reachableType of reachable) {
      if (acceptedLeafTypes.has(reachableType)) {
        for (const produced of step.producedContracts) {
          nextReachable.add(produced);
        }
      } else {
        nextReachable.add(reachableType);
      }
    }
    reachable = nextReachable;
  }
}

function normalizeContractType(value: string): string {
  return simpleTypeName(String(value || "").trim());
}

function formatList(values: string[]): string {
  return `[${values.join(", ")}]`;
}
