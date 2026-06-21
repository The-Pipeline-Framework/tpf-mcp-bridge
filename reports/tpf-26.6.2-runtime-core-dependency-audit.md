# TPF 26.6.2 Runtime-Core Dependency Audit

Issue: #28
Baseline: TPF `main` at `45d79f33` after PR #423 merged.

## Result

No generator POM change is required for the 26.6.2 runtime-core split.

Generated Quarkus scaffolds still depend on `org.pipelineframework:pipelineframework` through the generated `common` module. In 26.6.2, that runtime artifact brings in:

- `org.pipelineframework:pipelineframework-api`
- `org.pipelineframework:pipelineframework-runtime-core`

That keeps existing generated module POMs valid without adding a direct `pipelineframework-runtime-core` dependency to generated applications.

## Generated POM Surface Reviewed

- `parent-pom.hbs`: inherits `org.pipelineframework:pipeline-framework-root` and imports `org.pipelineframework:framework-parent`.
- `common-pom.hbs`: depends on `org.pipelineframework:pipelineframework`.
- `step-pom.hbs`: depends on generated `common`.
- `orchestrator-pom.hbs`: depends on generated `common`; adds Kafka/SQS dependencies only when await transports require them.
- `pipeline-runtime-svc-pom.hbs`: depends on generated `common`; adds Kafka only when required.
- `monolith-svc-pom.hbs`: depends on generated `common`; adds plugin artifacts only when persistence/cache aspects require them.
- `persistence-svc-pom.hbs` and `cache-invalidation-svc-pom.hbs`: depend on generated `common` plus the corresponding plugin artifact.

## Maven Verification

The generated dependency trees resolve runtime-core through `pipelineframework`:

```text
com.example.checkpointcomposition:common:jar:26.6.2
\- org.pipelineframework:pipelineframework:jar:26.6.2:compile
   +- org.pipelineframework:pipelineframework-api:jar:26.6.2:compile
   \- org.pipelineframework:pipelineframework-runtime-core:jar:26.6.2:compile
```

The same dependency path was confirmed through generated reactor trees for:

- checkpoint/composition monolith scaffold
- Kafka await modular scaffold
- SQS await modular scaffold

## Regression Coverage

The current Template Generator Smoke workflow compiles generated scaffolds against the 26.6.2 candidate framework artifacts:

- REST await union scaffold
- Kafka await scaffold
- SQS await scaffold
- checkpoint/composition scaffold

Those smokes install the candidate framework artifacts locally first, so missing or stale generated dependencies fail at compile time.

## Deferred Scope

Spring runtime adapter scaffolding is not covered by this audit. It remains a product-scope decision tracked separately by #26.
