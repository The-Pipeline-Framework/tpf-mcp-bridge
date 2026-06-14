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

// Import Handlebars (this would be included via a script tag in the browser)
// For Node.js compatibility, we'll handle both cases
let Handlebars;
if (typeof window !== 'undefined' && window.Handlebars) {
    // Browser environment
    Handlebars = window.Handlebars;
} else {
    // Node.js environment
    Handlebars = require('handlebars');
}
let buildRuntimeMappingCore = null;
if (typeof globalThis !== 'undefined' && globalThis.__TPF_RUNTIME_MAPPING_BUILDER__) {
    buildRuntimeMappingCore = globalThis.__TPF_RUNTIME_MAPPING_BUILDER__.buildRuntimeMappingCore;
}
if (!buildRuntimeMappingCore && typeof require === 'function') {
    try {
        ({ buildRuntimeMappingCore } = require('./runtime-mapping-builder'));
    } catch (_error) {
        buildRuntimeMappingCore = null;
    }
}

// Register helper for replacing characters in strings
Handlebars.registerHelper('replace', function(str, find, repl) {
  if (typeof str !== 'string') return str;
  if (typeof find !== 'string') return str;
  if (typeof str.replaceAll === 'function') return str.replaceAll(find, repl);
  return str.split(find).join(repl);
});

Handlebars.registerHelper('add', function(a, b) {
    const left = Number(a);
    const right = Number(b);
    if (Number.isNaN(left) || Number.isNaN(right)) {
        return 0;
    }
    return left + right;
});
// Register helper for converting to lowercase
Handlebars.registerHelper('lowercase', function(str) {
    return typeof str === 'string' ? str.toLowerCase() : str;
});

// Register helper for checking if a step is the first one
Handlebars.registerHelper('isFirstStep', function(index) {
    return index === 0;
});

// Register helper for checking cardinality types
Handlebars.registerHelper('isExpansion', function(cardinality) {
    return cardinality === 'EXPANSION';
});

Handlebars.registerHelper('isReduction', function(cardinality) {
    return cardinality === 'REDUCTION';
});

Handlebars.registerHelper('isSideEffect', function(cardinality) {
    return cardinality === 'SIDE_EFFECT';
});

// Register helper for checking if a type is a list
Handlebars.registerHelper('isListType', function(type) {
    if (!type || typeof type !== 'string') return false;
    
    // Simple list check (for basic List)
    if (type === 'List') return true;
    
    // Pattern check for generic List (e.g. List<String>, List<MyCustomType>)
    return type.startsWith('List<');
});

// Register helper for extracting list inner type
Handlebars.registerHelper('listInnerType', function(type) {
    if (!type || !type.startsWith('List<') || !type.endsWith('>')) {
        return type;
    }
    return type.substring(5, type.length - 1).trim();
});

// Register helper for checking if a type is a map
Handlebars.registerHelper('isMapType', function(type) {
    if (!type || typeof type !== 'string') return false;
    
    // Simple map check (for basic Map)
    if (type === 'Map') return true;
    
    // Pattern check for generic Map (e.g. Map<String,Integer>, Map<MyKey,MyValue>)
    return type.startsWith('Map<');
});

// Register helper for checking various import flags
Handlebars.registerHelper('hasDateFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => 
        ['LocalDate', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Duration', 'Period'].includes(field.type)
    );
});

Handlebars.registerHelper('hasBigIntegerFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'BigInteger');
});

Handlebars.registerHelper('hasBigDecimalFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'BigDecimal');
});

Handlebars.registerHelper('hasCurrencyFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'Currency');
});

Handlebars.registerHelper('hasPathFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'Path');
});

Handlebars.registerHelper('hasNetFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => ['URI', 'URL'].includes(field.type));
});

Handlebars.registerHelper('hasIoFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'File');
});

Handlebars.registerHelper('hasAtomicFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => ['AtomicInteger', 'AtomicLong'].includes(field.type));
});

Handlebars.registerHelper('hasUtilFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.type === 'List<String>');
});

Handlebars.registerHelper('hasMapFields', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => {
        return field && typeof field.type === 'string' && field.type.startsWith('Map<');
    });
});

Handlebars.registerHelper('hasIdField', function(fields) {
    if (!Array.isArray(fields)) return false;
    return fields.some(field => field.name === 'id');
});

// Register helper to convert base package to path format
Handlebars.registerHelper('toPath', function(basePackage) {
    return basePackage.replace(/\./g, '/');
});

// Register helper to format service name for proto classes
Handlebars.registerHelper('formatForProtoClassName', function(serviceName) {
    // Convert service names like "process-customer-svc" to "ProcessCustomerSvc"
    if (!serviceName) return '';
    const parts = serviceName.split('-');
    return parts.map(part => {
        if (!part) return '';
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('');
});

// Register helper to check if a field is an ID field
Handlebars.registerHelper('isIdField', function(fieldName) {
    return fieldName === 'id';
});

Handlebars.registerHelper('sanitizeJavaIdentifier', function(fieldName) {
    if (typeof fieldName !== 'string' || fieldName.trim() === '') {
        return 'field';
    }
    let sanitized = fieldName.replace(/[^a-zA-Z0-9_$]/g, '_');
    if (/^[0-9]/.test(sanitized)) {
        sanitized = '_' + sanitized;
    }
    const reservedWords = [
        'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
        'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
        'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
        'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
        'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
        'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'
    ];
    if (reservedWords.includes(sanitized.toLowerCase())) {
        sanitized = sanitized + '_';
    }
    return sanitized || 'field';
});

class BrowserTemplateEngine {
    constructor(templates) {
        this.templates = templates || {};
        this.compiledTemplates = new Map();
        this.validateTemplateHelpers();
        this.loadTemplates();
    }

    validateTemplateHelpers() {
        const builtInHelpers = new Set(['if', 'unless', 'each', 'with', 'lookup', 'log']);
        const missing = new Map();
        const visit = (node, acc) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                for (const child of node) visit(child, acc);
                return;
            }
            if (node.type === 'MustacheStatement') {
                if (node.path && node.path.type === 'PathExpression' && node.params && node.params.length > 0) {
                    acc.add(node.path.original);
                }
            } else if (node.type === 'BlockStatement') {
                if (
                    node.path
                    && node.path.type === 'PathExpression'
                    && (
                        (node.params && node.params.length > 0)
                        || (node.hash && node.hash.pairs && node.hash.pairs.length > 0)
                    )
                ) {
                    acc.add(node.path.original);
                }
                visit(node.program, acc);
                visit(node.inverse, acc);
            } else if (node.type === 'SubExpression') {
                if (node.path && node.path.type === 'PathExpression') {
                    acc.add(node.path.original);
                }
            }
            for (const [key, value] of Object.entries(node)) {
                if (node.type === 'BlockStatement' && (key === 'program' || key === 'inverse')) {
                    continue;
                }
                visit(value, acc);
            }
        };

        for (const [name, templateStr] of Object.entries(this.templates)) {
            if (typeof templateStr !== 'string') {
                continue;
            }
            const ast = Handlebars.parse(templateStr);
            const usedHelpers = new Set();
            visit(ast, usedHelpers);
            for (const helperName of usedHelpers) {
                if (builtInHelpers.has(helperName)) continue;
                if (Handlebars.helpers[helperName]) continue;
                if (!missing.has(helperName)) {
                    missing.set(helperName, []);
                }
                missing.get(helperName).push(name);
            }
        }

        if (missing.size > 0) {
            const detail = Array.from(missing.entries())
                .map(([helper, templates]) => `${helper} (templates: ${templates.join(', ')})`)
                .join('; ');
            throw new Error(`Missing Handlebars helper registration(s): ${detail}`);
        }
    }

    loadTemplates() {
        // In browser environment, templates are passed in as an object
        // Each template can be either a raw string or a precompiled Handlebars spec.
        for (const [name, templateSource] of Object.entries(this.templates)) {
            if (templateSource && typeof templateSource === 'object' && templateSource.compiler) {
                this.compiledTemplates.set(name, Handlebars.template(templateSource));
                continue;
            }
            this.compiledTemplates.set(name, Handlebars.compile(templateSource));
        }
    }

    render(templateName, context) {
        const template = this.compiledTemplates.get(templateName);
        if (!template) {
            throw new Error(`Template ${templateName} not found`);
        }
        return template(context);
    }

    async generateApplication(appName, basePackage, steps, aspects, transport, platform, runtimeLayout, fileCallback) {
        let options;
        if (arguments.length === 1 && appName && typeof appName === 'object') {
            options = { ...appName };
        } else if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
            options = { appName, basePackage, ...steps };
        } else {
            console.warn(
                'generateApplication positional arguments are deprecated. Pass a single options object instead.'
            );
            const legacyPositionalCall = fileCallback === undefined
                && this.isRuntimeLayout(platform)
                && typeof runtimeLayout === 'function';
            options = {
                appName,
                basePackage,
                steps,
                aspects,
                transport,
                platform: legacyPositionalCall ? undefined : platform,
                runtimeLayout: legacyPositionalCall ? platform : runtimeLayout,
                fileCallback: legacyPositionalCall ? runtimeLayout : fileCallback
            };
        }
        const normalizedOptions = {
            appName: options.appName,
            basePackage: options.basePackage,
            steps: Array.isArray(options.steps) ? options.steps : [],
            aspects: options.aspects && typeof options.aspects === 'object' ? options.aspects : {},
            unionDefinitions: Array.isArray(options.unionDefinitions) ? options.unionDefinitions : [],
            runtimeLayout: this.normalizeRuntimeLayout(options.runtimeLayout),
            fileCallback: options.fileCallback
        };
        normalizedOptions.transport = this.normalizeTransport(
            options.transport,
            normalizedOptions.runtimeLayout
        );
        normalizedOptions.platform = this.normalizePlatform(options.platform);

        if (typeof normalizedOptions.fileCallback !== 'function') {
            throw new Error('fileCallback must be provided as a function.');
        }
        if (!normalizedOptions.appName || !normalizedOptions.basePackage) {
            throw new Error('appName and basePackage are required.');
        }

        const appNameValue = normalizedOptions.appName;
        const basePackageValue = normalizedOptions.basePackage;
        const stepsValue = normalizedOptions.steps;
        const normalizedRuntimeLayout = normalizedOptions.runtimeLayout;
        const transportMode = normalizedOptions.transport;
        const aspectConfig = normalizedOptions.aspects;
        const kafkaAwait = this.createKafkaAwaitContext(stepsValue, appNameValue);
        const includePersistenceModule = this.isAspectEnabled(aspectConfig, 'persistence');
        const includeCacheInvalidationModule = this.isAspectEnabled(aspectConfig, 'cache')
            || this.isAspectEnabled(aspectConfig, 'cache-invalidate')
            || this.isAspectEnabled(aspectConfig, 'cache-invalidate-all');
        // For sequential pipeline, update input types of steps after the first one
        // to match the output type of the previous step
        for (let i = 1; i < stepsValue.length; i++) {
            const currentStep = stepsValue[i];
            const previousStep = stepsValue[i - 1];
            // Set the input type of the current step to the output type of the previous step
            currentStep.inputTypeName = previousStep.outputTypeName;
            currentStep.inputFields = Array.isArray(previousStep.outputFields)
              ? previousStep.outputFields.slice()
              : previousStep.outputFields; // Shallow copy input fields from previous step's outputs
        }

        // Generate parent POM
        await this.generateParentPom(
            appNameValue,
            basePackageValue,
            stepsValue,
            includePersistenceModule,
            includeCacheInvalidationModule,
            transportMode,
            normalizedOptions.platform,
            normalizedRuntimeLayout,
            normalizedOptions.fileCallback);

        // Generate common module
        await this.generateCommonModule(appNameValue, basePackageValue, stepsValue, transportMode, normalizedOptions.unionDefinitions, normalizedOptions.fileCallback);

        // Generate each step service
        for (let i = 0; i < stepsValue.length; i++) {
            await this.generateStepService(appNameValue, basePackageValue, stepsValue[i], i, stepsValue, transportMode, normalizedOptions.fileCallback);
        }

        if (includePersistenceModule) {
            await this.generatePersistenceModule(appNameValue, basePackageValue, stepsValue, normalizedOptions.fileCallback);
        }

        if (includeCacheInvalidationModule) {
            await this.generateCacheInvalidationModule(appNameValue, basePackageValue, normalizedOptions.fileCallback);
        }

        // Generate orchestrator
        await this.generateOrchestrator(
            appNameValue,
            basePackageValue,
            stepsValue,
            includePersistenceModule,
            includeCacheInvalidationModule,
            aspectConfig,
            transportMode,
            kafkaAwait,
            normalizedOptions.fileCallback);

        if (normalizedRuntimeLayout === 'pipeline-runtime') {
            await this.generatePipelineRuntimeModule(
                appNameValue,
                basePackageValue,
                stepsValue,
                kafkaAwait,
                normalizedOptions.fileCallback
            );
        } else if (normalizedRuntimeLayout === 'monolith') {
            await this.generateMonolithModule(
                appNameValue,
                basePackageValue,
                stepsValue,
                includePersistenceModule,
                includeCacheInvalidationModule,
                kafkaAwait,
                normalizedOptions.fileCallback
            );
        }

        await this.generateRuntimeMappingFiles(
            stepsValue,
            includePersistenceModule,
            includeCacheInvalidationModule,
            normalizedRuntimeLayout,
            normalizedOptions.fileCallback
        );

        // Generate mvnw files
        await this.generateMvNWFiles(normalizedOptions.fileCallback);

        // Generate Maven wrapper files
        await this.generateMavenWrapperFiles(normalizedOptions.fileCallback);

        // Generate other files
        await this.generateOtherFiles(
            appNameValue,
            stepsValue,
            includePersistenceModule,
            includeCacheInvalidationModule,
            normalizedOptions.fileCallback);
    }

    createKafkaAwaitContext(steps, appName) {
        const kafkaSteps = (steps || [])
            .filter(step => step && step.kind === 'await')
            .filter(step => step.await && step.await.transport && step.await.transport.type === 'kafka');
        if (kafkaSteps.length === 0) {
            return null;
        }
        const rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        const requestTopics = this.uniqueNonBlank(kafkaSteps.map(step => this.awaitTransportString(step, 'request', 'topic')
            || this.awaitTransportString(step, 'config', 'topic')));
        const responseTopics = this.uniqueNonBlank(kafkaSteps.map(step => this.awaitTransportString(step, 'response', 'topic')));
        if (requestTopics.length === 0) {
            throw new Error('Kafka await scaffold requires await.transport.request.topic.');
        }
        if (responseTopics.length === 0) {
            throw new Error('Kafka await scaffold requires await.transport.response.topic.');
        }
        if (responseTopics.length > 1) {
            throw new Error('Kafka await scaffold currently supports one response topic per generated runtime module.');
        }
        const explicitGroup = this.uniqueNonBlank(kafkaSteps.map(step => this.awaitTransportString(step, 'consumer', 'group')))[0];
        const consumerGroup = explicitGroup || `${rootProjectName}-orchestrator`;
        return {
            requestTopic: requestTopics[0],
            responseTopic: responseTopics[0],
            consumerGroup,
            consumerGroupProperty: '${TPF_AWAIT_KAFKA_RESPONSES_GROUP_ID:' + consumerGroup + '}'
        };
    }

    awaitTransportString(step, section, key) {
        const value = step?.await?.transport?.[section]?.[key];
        return typeof value === 'string' && value.trim() ? value.trim() : null;
    }

    uniqueNonBlank(values) {
        return Array.from(new Set((values || []).filter(value => typeof value === 'string' && value.trim())));
    }

    async generateParentPom(
        appName,
        basePackage,
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        transport,
        platform,
        runtimeLayout,
        fileCallback) {
        const normalizedLayout = this.normalizeRuntimeLayout(runtimeLayout);
        const context = {
            basePackage,
            artifactId: appName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, ''),
            name: appName,
            steps,
            transport,
            platform,
            includePersistenceModule,
            includeCacheInvalidationModule,
            isModularLayout: normalizedLayout === 'modular',
            isPipelineRuntimeLayout: normalizedLayout === 'pipeline-runtime',
            isMonolithLayout: normalizedLayout === 'monolith'
        };

        const rendered = this.render('parent-pom', context);
        await fileCallback('pom.xml', rendered);
    }

    async generateCommonModule(appName, basePackage, steps, transport, unionDefinitions, fileCallback) {
        // Generate common POM
        await this.generateCommonPom(appName, basePackage, transport, fileCallback);

        // Generate entities, DTOs, and mappers for each step
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            await this.generateDomainClasses(step, basePackage, i, fileCallback);
            await this.generateDtoClasses(step, basePackage, i, fileCallback);
            await this.generateMapperClasses(step, basePackage, i, fileCallback);
        }

        await this.generateUnionClasses(unionDefinitions, basePackage, fileCallback);

        // Generate base entity
        await this.generateBaseEntity(basePackage, fileCallback);

        // Generate common converters
        await this.generateCommonConverters(basePackage, fileCallback);
    }

    async generatePipelineRuntimeModule(appName, basePackage, steps, kafkaAwait, fileCallback) {
        const rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        const context = {
            basePackage,
            rootProjectName,
            kafkaAwait,
            sourceDirs: (steps || []).map((step, index) => {
                const key = `s${index}`;
                return {
                    moduleName: step.serviceName,
                    propertyName: `pipeline.runtime.source.dir.${key}`,
                    propertyRef: '${pipeline.runtime.source.dir.' + key + '}'
                };
            })
        };
        const pomContent = this.render('pipeline-runtime-svc-pom', context);
        await fileCallback('pipeline-runtime-svc/pom.xml', pomContent);

        const appPropsContent = this.render('application-properties', {
            serviceName: 'pipeline-runtime-svc',
            rootProjectName,
            portOffset: 1,
            kafkaAwait
        });
        await fileCallback('pipeline-runtime-svc/src/main/resources/application.properties', appPropsContent);
        const appDevProps = this.render('module-application-dev-properties', {});
        await fileCallback('pipeline-runtime-svc/src/main/resources/application-dev.properties', appDevProps);
        const beansXml = this.render('module-beans-xml', {}).trimEnd();
        await fileCallback('pipeline-runtime-svc/src/main/resources/META-INF/beans.xml', beansXml);
    }

    async generateMonolithModule(
        appName,
        basePackage,
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        kafkaAwait,
        fileCallback
    ) {
        const rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        const sourceDirs = (steps || []).map((step, index) => {
            const key = `s${index}`;
            return {
                moduleName: step.serviceName,
                propertyName: `monolith.source.dir.${key}`,
                propertyRef: '${monolith.source.dir.' + key + '}'
            };
        });
        sourceDirs.push({
            moduleName: 'orchestrator-svc',
            propertyName: 'monolith.source.dir.orchestrator',
            propertyRef: '${monolith.source.dir.orchestrator}'
        });
        if (includePersistenceModule) {
            sourceDirs.push({
                moduleName: 'persistence-svc',
                propertyName: 'monolith.source.dir.persistence',
                propertyRef: '${monolith.source.dir.persistence}'
            });
        }
        if (includeCacheInvalidationModule) {
            sourceDirs.push({
                moduleName: 'cache-invalidation-svc',
                propertyName: 'monolith.source.dir.cache',
                propertyRef: '${monolith.source.dir.cache}'
            });
        }

        const context = {
            basePackage,
            rootProjectName,
            includePersistenceModule,
            includeCacheInvalidationModule,
            kafkaAwait,
            sourceDirs
        };
        const pomContent = this.render('monolith-svc-pom', context);
        await fileCallback('monolith-svc/pom.xml', pomContent);

        const appPropsContent = this.render('application-properties', {
            serviceName: 'monolith-svc',
            rootProjectName,
            portOffset: 0,
            kafkaAwait
        });
        await fileCallback('monolith-svc/src/main/resources/application.properties', appPropsContent);
        const appDevProps = this.render('module-application-dev-properties', {});
        await fileCallback('monolith-svc/src/main/resources/application-dev.properties', appDevProps);
        const beansXml = this.render('module-beans-xml', {}).trimEnd();
        await fileCallback('monolith-svc/src/main/resources/META-INF/beans.xml', beansXml);
    }

    async generatePersistenceModule(appName, basePackage, steps, fileCallback) {
        const packagePath = this.toPath(basePackage + '.persistence');
        const rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        const pomContent = this.render('persistence-svc-pom', { basePackage, rootProjectName });
        await fileCallback('persistence-svc/pom.xml', pomContent);

        const hostContent = this.render('persistence-plugin-host', { basePackage });
        await fileCallback(`persistence-svc/src/main/java/${packagePath}/PersistencePluginHost.java`, hostContent);

        const appPropsContent = this.render('persistence-application-properties', {
            basePackage,
            rootProjectName,
            portOffset: steps.length + 1,
            serviceName: 'persistence-svc'
        });
        await fileCallback('persistence-svc/src/main/resources/application.properties', appPropsContent);
    }

    async generateCacheInvalidationModule(appName, basePackage, fileCallback) {
        const packagePath = this.toPath(basePackage + '.cache');
        const rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');
        const pomContent = this.render('cache-invalidation-svc-pom', { basePackage, rootProjectName });
        await fileCallback('cache-invalidation-svc/pom.xml', pomContent);

        const hostContent = this.render('cache-invalidation-plugin-host', { basePackage });
        await fileCallback(`cache-invalidation-svc/src/main/java/${packagePath}/CacheInvalidationPluginHost.java`, hostContent);

        const hostAllContent = this.render('cache-invalidation-all-plugin-host', { basePackage });
        await fileCallback(`cache-invalidation-svc/src/main/java/${packagePath}/CacheInvalidationAllPluginHost.java`, hostAllContent);

        const cacheHostContent = this.render('cache-plugin-host', { basePackage });
        await fileCallback(`cache-invalidation-svc/src/main/java/${packagePath}/CachePluginHost.java`, cacheHostContent);
    }

    async generateCommonPom(appName, basePackage, transport, fileCallback) {
        const transportMode = this.normalizeTransport(transport);
        const context = {
            basePackage,
            rootProjectName: appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-'),
            isRestTransport: transportMode === 'REST',
            isGrpcTransport: transportMode === 'GRPC'
        };

        const rendered = this.render('common-pom', context);
        await fileCallback('common/pom.xml', rendered);
    }

    async generateDomainClasses(step, basePackage, stepIndex, fileCallback) {
        // Process input domain class only for first step
        if (stepIndex === 0 && !step.inputIsUnion && step.inputFields && step.inputTypeName) {
            const inputContext = {
                ...step,
                basePackage,
                className: step.inputTypeName,
                fields: step.inputFields,
                hasDateFields: this.hasImportFlag(step.inputFields, ['LocalDate', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Duration', 'Period']),
                hasBigIntegerFields: this.hasImportFlag(step.inputFields, ['BigInteger']),
                hasBigDecimalFields: this.hasImportFlag(step.inputFields, ['BigDecimal']),
                hasCurrencyFields: this.hasImportFlag(step.inputFields, ['Currency']),
                hasPathFields: this.hasImportFlag(step.inputFields, ['Path']),
                hasNetFields: this.hasImportFlag(step.inputFields, ['URI', 'URL']),
                hasIoFields: this.hasImportFlag(step.inputFields, ['File']),
                hasAtomicFields: this.hasImportFlag(step.inputFields, ['AtomicInteger', 'AtomicLong']),
                hasUtilFields: this.hasImportFlag(step.inputFields, ['List<String>']),
                hasIdField: step.inputFields.some(field => field.name === 'id')
            };

            const rendered = this.render('domain', inputContext);
            const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.domain')}/${step.inputTypeName}.java`;
            await fileCallback(filePath, rendered);
        }

        // Process output domain class for all steps
        if (!step.outputIsUnion && step.outputFields && step.outputTypeName) {
            const outputContext = {
                ...step,
                basePackage,
                className: step.outputTypeName,
                fields: step.outputFields,
                hasDateFields: this.hasImportFlag(step.outputFields, ['LocalDate', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Duration', 'Period']),
                hasBigIntegerFields: this.hasImportFlag(step.outputFields, ['BigInteger']),
                hasBigDecimalFields: this.hasImportFlag(step.outputFields, ['BigDecimal']),
                hasCurrencyFields: this.hasImportFlag(step.outputFields, ['Currency']),
                hasPathFields: this.hasImportFlag(step.outputFields, ['Path']),
                hasNetFields: this.hasImportFlag(step.outputFields, ['URI', 'URL']),
                hasIoFields: this.hasImportFlag(step.outputFields, ['File']),
                hasAtomicFields: this.hasImportFlag(step.outputFields, ['AtomicInteger', 'AtomicLong']),
                hasUtilFields: this.hasImportFlag(step.outputFields, ['List<String>']),
                hasIdField: step.outputFields.some(field => field.name === 'id')
            };

            const rendered = this.render('domain', outputContext);
            const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.domain')}/${step.outputTypeName}.java`;
            await fileCallback(filePath, rendered);
        }
    }

    async generateBaseEntity(basePackage, fileCallback) {
        const context = { basePackage };
        const rendered = this.render('base-entity', context);
        const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.domain')}/BaseEntity.java`;
        await fileCallback(filePath, rendered);
    }

    async generateDtoClasses(step, basePackage, stepIndex, fileCallback) {
        // Process input DTO class only for first step
        if (stepIndex === 0 && !step.inputIsUnion && step.inputFields && step.inputTypeName) {
            const inputContext = {
                ...step,
                basePackage,
                className: step.inputTypeName + 'Dto',
                fields: step.inputFields,
                hasDateFields: this.hasImportFlag(step.inputFields, ['LocalDate', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Duration', 'Period']),
                hasBigIntegerFields: this.hasImportFlag(step.inputFields, ['BigInteger']),
                hasBigDecimalFields: this.hasImportFlag(step.inputFields, ['BigDecimal']),
                hasCurrencyFields: this.hasImportFlag(step.inputFields, ['Currency']),
                hasPathFields: this.hasImportFlag(step.inputFields, ['Path']),
                hasNetFields: this.hasImportFlag(step.inputFields, ['URI', 'URL']),
                hasIoFields: this.hasImportFlag(step.inputFields, ['File']),
                hasAtomicFields: this.hasImportFlag(step.inputFields, ['AtomicInteger', 'AtomicLong']),
                hasUtilFields: this.hasImportFlag(step.inputFields, ['List<String>']),
                hasIdField: step.inputFields.some(field => field.name === 'id')
            };

            const rendered = this.render('dto', inputContext);
            const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.dto')}/${step.inputTypeName}Dto.java`;
            await fileCallback(filePath, rendered);
        }

        // Process output DTO class for all steps
        if (!step.outputIsUnion && step.outputFields && step.outputTypeName) {
            const outputContext = {
                ...step,
                basePackage,
                className: step.outputTypeName + 'Dto',
                fields: step.outputFields,
                hasDateFields: this.hasImportFlag(step.outputFields, ['LocalDate', 'LocalDateTime', 'OffsetDateTime', 'ZonedDateTime', 'Instant', 'Duration', 'Period']),
                hasBigIntegerFields: this.hasImportFlag(step.outputFields, ['BigInteger']),
                hasBigDecimalFields: this.hasImportFlag(step.outputFields, ['BigDecimal']),
                hasCurrencyFields: this.hasImportFlag(step.outputFields, ['Currency']),
                hasPathFields: this.hasImportFlag(step.outputFields, ['Path']),
                hasNetFields: this.hasImportFlag(step.outputFields, ['URI', 'URL']),
                hasIoFields: this.hasImportFlag(step.outputFields, ['File']),
                hasAtomicFields: this.hasImportFlag(step.outputFields, ['AtomicInteger', 'AtomicLong']),
                hasUtilFields: this.hasImportFlag(step.outputFields, ['List<String>']),
                hasIdField: step.outputFields.some(field => field.name === 'id')
            };

            const rendered = this.render('dto', outputContext);
            const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.dto')}/${step.outputTypeName}Dto.java`;
            await fileCallback(filePath, rendered);
        }
    }

    async generateMapperClasses(step, basePackage, stepIndex, fileCallback) {
        // Generate input mapper class only for first step (since other steps reference previous step's output)
        if (stepIndex === 0 && !step.inputIsUnion && step.inputTypeName) {
            await this.generateMapperClass(step.inputTypeName, step, basePackage, fileCallback);
        }

        // Generate output mapper class for all steps
        if (!step.outputIsUnion && step.outputTypeName) {
            await this.generateMapperClass(step.outputTypeName, step, basePackage, fileCallback);
        }
    }

    async generateUnionClasses(unionDefinitions, basePackage, fileCallback) {
        if (!Array.isArray(unionDefinitions)) {
            return;
        }
        for (const union of unionDefinitions) {
            const context = { ...union, basePackage };
            const domainPath = `common/src/main/java/${this.toPath(basePackage + '.common.domain')}`;
            const dtoPath = `common/src/main/java/${this.toPath(basePackage + '.common.dto')}`;
            const mapperPath = `common/src/main/java/${this.toPath(basePackage + '.common.mapper')}`;

            await fileCallback(`${domainPath}/${union.name}.java`, this.render('union-domain-interface', context));
            await fileCallback(`${domainPath}/${union.name}JsonSerializer.java`, this.render('union-domain-json-serializer', context));
            await fileCallback(`${domainPath}/${union.name}JsonDeserializer.java`, this.render('union-domain-json-deserializer', context));
            await fileCallback(`${dtoPath}/${union.dtoName}.java`, this.render('union-dto-interface', context));
            await fileCallback(`${dtoPath}/${union.dtoName}JsonSerializer.java`, this.render('union-dto-json-serializer', context));
            await fileCallback(`${dtoPath}/${union.dtoName}JsonDeserializer.java`, this.render('union-dto-json-deserializer', context));
            await fileCallback(`${mapperPath}/${union.name}Mapper.java`, this.render('union-mapper', context));

            for (const variant of union.variants) {
                const variantContext = { ...context, ...variant, unionName: union.name, unionDtoName: union.dtoName };
                await fileCallback(`${domainPath}/${variant.typeName}.java`, this.render('union-domain-variant', variantContext));
                await fileCallback(`${dtoPath}/${variant.dtoTypeName}.java`, this.render('union-dto-variant', variantContext));
            }
        }
    }

    async generateMapperClass(className, step, basePackage, fileCallback) {
        const mapperFields = this.mapperFieldsForClass(className, step)
            .map(field => ({
                ...field,
                javaName: this.sanitizeJavaIdentifier(field.name),
                accessorSuffix: this.javaAccessorSuffix(this.sanitizeJavaIdentifier(field.name))
            }));
        const grpcMapFields = mapperFields
            .filter(field => field && typeof field.type === 'string' && field.type.startsWith('Map<'))
            .map(field => {
                const javaName = field.javaName;
                return {
                    ...field,
                    javaName,
                    dtoAccessorSuffix: this.javaAccessorSuffix(javaName),
                    protoAccessorSuffix: this.protoAccessorSuffix(field.name)
                };
            });
        const context = {
            ...step,
            basePackage,
            className,
            domainClass: className.replace('Dto', ''),
            dtoClass: className + 'Dto',
            fields: mapperFields,
            grpcClass: basePackage + '.grpc.' + this.formatForProtoClassName(step.serviceName),
            grpcMapFields,
            hasGrpcMapFields: grpcMapFields.length > 0
        };

        const rendered = this.render('mapper', context);
        const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.mapper')}/${className}Mapper.java`;
        await fileCallback(filePath, rendered);
    }

    async generateCommonConverters(basePackage, fileCallback) {
        const context = { basePackage };
        const rendered = this.render('common-converters', context);
        const filePath = `common/src/main/java/${this.toPath(basePackage + '.common.mapper')}/CommonConverters.java`;
        await fileCallback(filePath, rendered);
    }

    async generateStepService(appName, basePackage, step, stepIndex, allSteps, transport, fileCallback) {
        // noinspection JSUnusedLocalSymbols
        const serviceNameForPackage = step.serviceName.replace('-svc', '').replace(/-/g, '_');

        // Add rootProjectName to step map
        step.rootProjectName = appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-');

        // Generate step POM
        await this.generateStepPom(step, basePackage, transport, fileCallback);

        // Generate the service class
        await this.generateStepServiceClass(appName, basePackage, step, stepIndex, allSteps, fileCallback);

    }

    async generateStepPom(step, basePackage, transport, fileCallback) {
        const transportMode = this.normalizeTransport(transport);
        const context = {
            ...step,
            basePackage,
            isRestTransport: transportMode === 'REST',
            isGrpcTransport: transportMode === 'GRPC'
        };
        const rendered = this.render('step-pom', context);
        const filePath = `${step.serviceName}/pom.xml`;
        await fileCallback(filePath, rendered);
    }

    async generateStepServiceClass(appName, basePackage, step, stepIndex, allSteps, fileCallback) {
        const context = { ...step };
        context.basePackage = basePackage;
        context.serviceName = step.serviceName.replace('-svc', '');
        // Convert hyphens to underscores for valid Java package names
        context.serviceNameForPackage = step.serviceName.replace('-svc', '').replace(/-/g, '_');

        // Format service name for proto-generated class names
        const protoClassName = this.formatForProtoClassName(step.serviceName);
        context.protoClassName = protoClassName;

        // Use the serviceNameCamel field from the configuration to form the gRPC class names
        const serviceNameCamel = step.serviceNameCamel ?? (step.serviceName || '').replace(/-svc$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        // Convert camelCase to PascalCase
        const serviceNamePascal = serviceNameCamel
          ? serviceNameCamel.charAt(0).toUpperCase() + serviceNameCamel.slice(1)
          : this.formatForProtoClassName(step.serviceName);

        // Extract the entity name from the PascalCase service name to match proto service names
        const entityName = this.extractEntityName(serviceNamePascal);

        context.serviceNamePascal = serviceNamePascal;
        context.serviceNameFormatted = step.name;

        let reactiveServiceInterface = 'ReactiveService';
        let grpcAdapter = 'GrpcReactiveServiceAdapter';
        let processMethodReturnType = `Uni<${step.outputTypeName}>`;
        let processMethodParamType = step.inputTypeName;
        let returnStatement = 'Uni.createFrom().item(output)';

        if (step.cardinality === 'EXPANSION') {
            reactiveServiceInterface = 'ReactiveStreamingService';
            grpcAdapter = 'GrpcServiceStreamingAdapter';
            processMethodReturnType = `Multi<${step.outputTypeName}>`;
            returnStatement = 'Multi.createFrom().item(output)';
        } else if (step.cardinality === 'REDUCTION') {
            reactiveServiceInterface = 'ReactiveStreamingClientService';
            grpcAdapter = 'GrpcServiceClientStreamingAdapter';
            processMethodParamType = `Multi<${step.inputTypeName}>`;
            returnStatement = 'Uni.createFrom().item(output)';
        } else if (step.cardinality === 'SIDE_EFFECT') {
            reactiveServiceInterface = 'ReactiveService';
            grpcAdapter = 'GrpcReactiveServiceAdapter';
            returnStatement = 'Uni.createFrom().item(input)';
        }

        context.reactiveServiceInterface = reactiveServiceInterface;
        context.grpcAdapter = grpcAdapter;
        context.processMethodReturnType = processMethodReturnType;
        context.processMethodParamType = processMethodParamType;
        context.returnStatement = returnStatement;

        const rendered = this.render('step-service', context);
        const filePath = `${step.serviceName}/src/main/java/${this.toPath(basePackage + '.' + context.serviceNameForPackage + '.service')}/Process${serviceNamePascal}Service.java`;
        await fileCallback(filePath, rendered);
    }

    async generateOrchestrator(
        appName,
        basePackage,
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        aspectDefinitions,
        transport,
        kafkaAwait,
        fileCallback) {
        await this.generateOrchestratorApplication(appName, basePackage, fileCallback);

        // Generate orchestrator POM
        await this.generateOrchestratorPom(
            appName,
            basePackage,
            includePersistenceModule,
            includeCacheInvalidationModule,
            transport,
            kafkaAwait,
            fileCallback);

        await this.generateOrchestratorApplicationProperties(
            appName,
            basePackage,
            steps,
            includePersistenceModule,
            includeCacheInvalidationModule,
            aspectDefinitions,
            transport,
            kafkaAwait,
            fileCallback);
        await this.generateOrchestratorApplicationDevProperties(basePackage, steps, fileCallback);
        await this.generateOrchestratorApplicationTestProperties(fileCallback);
    }

    async generateOrchestratorApplication(appName, basePackage, fileCallback) {
        const rendered = this.render('orchestrator-application', { appName, basePackage });
        await fileCallback(
            `orchestrator-svc/src/main/java/${this.toPath(basePackage + '.orchestrator.service')}/OrchestratorHost.java`,
            rendered
        );
    }

    async generateOrchestratorPom(
        appName,
        basePackage,
        includePersistenceModule,
        includeCacheInvalidationModule,
        transport,
        kafkaAwait,
        fileCallback) {
        const transportMode = this.normalizeTransport(transport);
        const context = {
            basePackage,
            artifactId: 'orchestrator-svc',
            rootProjectName: appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-'),
            includePersistenceModule,
            includeCacheInvalidationModule,
            kafkaAwait,
            isRestTransport: transportMode === 'REST',
            isGrpcTransport: transportMode === 'GRPC'
        };

        const rendered = this.render('orchestrator-pom', context);
        await fileCallback('orchestrator-svc/pom.xml', rendered);
    }

    async generateOrchestratorApplicationProperties(
        appName,
        basePackage,
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        aspectDefinitions,
        transport,
        kafkaAwait,
        fileCallback) {
        const transportMode = this.normalizeTransport(transport);
        const aspects = this.normalizeAspectDefinitions(aspectDefinitions);
        const context = {
            appName,
            basePackage,
            transport,
            kafkaAwait,
            isRestTransport: transportMode === 'REST',
            isGrpcTransport: transportMode !== 'REST',
            serviceName: 'orchestrator-svc',
            clientStepSuffix: transportMode === 'REST' ? 'RestClientStep' : 'GrpcClientStep',
            rootProjectName: appName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '-'),
            includePersistenceModule,
            includeCacheInvalidationModule,
            hasCacheAspect: aspects.some(aspect => aspect.name === 'cache')
        };
        if (includePersistenceModule) {
            context.persistencePortOffset = steps.length + 1;
            const outputTypes = new Set();
            steps.forEach(step => {
                if (step.outputTypeName) {
                    outputTypes.add(step.outputTypeName);
                }
            });
            context.persistenceSideEffectTypes = Array.from(outputTypes);
            context.persistenceAspectNames = aspects
                .filter(aspect => aspect.name === 'persistence')
                .filter(aspect => {
                    const targets = aspect.enabledTargets || [];
                    return targets.includes('CLIENT_STEP') || targets.includes('GRPC_SERVICE');
                })
                .map(aspect => aspect.name);
        }
        if (includeCacheInvalidationModule) {
            const baseOffset = steps.length + (includePersistenceModule ? 2 : 1);
            context.cacheInvalidationPortOffset = baseOffset;
            const inputTypes = new Set();
            const outputTypes = new Set();
            steps.forEach(step => {
                if (step.inputTypeName) {
                    inputTypes.add(step.inputTypeName);
                }
                if (step.outputTypeName) {
                    outputTypes.add(step.outputTypeName);
                }
            });
            context.cacheInvalidationSideEffectTypes = Array.from(inputTypes);
            context.cacheInvalidationAspectNames = aspects
                .filter(aspect => aspect.name.startsWith('cache-invalidate'))
                .filter(aspect => {
                    const targets = aspect.enabledTargets || [];
                    return targets.includes('CLIENT_STEP') || targets.includes('GRPC_SERVICE');
                })
                .map(aspect => aspect.name);
            context.cacheSideEffectTypes = Array.from(outputTypes);
            context.cacheAspectNames = aspects
                .filter(aspect => aspect.name === 'cache')
                .filter(aspect => {
                    const targets = aspect.enabledTargets || [];
                    return targets.includes('CLIENT_STEP') || targets.includes('GRPC_SERVICE');
                })
                .map(aspect => aspect.name);
        }
        context.steps = steps.map((step, index) => ({
            ...step,
            portOffset: index + 1,
            serviceNameForPackage: step.serviceName.replace('-svc', '').replace(/-/g, '_'),
            serviceNameFormatted: this.formatForProtoClassName(step.serviceName),
            serviceNameCamel: step.serviceNameCamel
        }));
        await fileCallback(
            'orchestrator-svc/src/main/resources/application.properties',
            this.render('orchestrator-application-properties', context)
        );
    }

    normalizeAspectDefinitions(aspectDefinitions) {
        if (Array.isArray(aspectDefinitions)) {
            return aspectDefinitions;
        }
        if (aspectDefinitions && typeof aspectDefinitions === 'object') {
            return Object.entries(aspectDefinitions).map(([name, value]) => ({
                name,
                ...(value && typeof value === 'object' ? value : {})
            }));
        }
        return [];
    }

    async generateOrchestratorApplicationDevProperties(basePackage, steps, fileCallback) {
        const rendered = this.render('orchestrator-application-dev-properties', { basePackage, steps });
        await fileCallback('orchestrator-svc/src/main/resources/application-dev.properties', rendered);
    }

    async generateOrchestratorApplicationTestProperties(fileCallback) {
        const rendered = this.render('orchestrator-application-test-properties', {});
        await fileCallback('orchestrator-svc/src/test/resources/application.properties', rendered);
    }

    async generateMvNWFiles(fileCallback) {
        // Create mvnw (Unix)
        const context = {};
        const mvnwContent = this.render('mvnw', context);
        await fileCallback('mvnw', mvnwContent);

        // Create mvnw.cmd (Windows)
        const mvnwCmdContent = this.render('mvnw-cmd', context);
        await fileCallback('mvnw.cmd', mvnwCmdContent);
    }

    async generateMavenWrapperFiles(fileCallback) {
        // Create .mvn/wrapper directory and maven-wrapper.properties
        // This is a simple content for the maven wrapper properties
        const mavenWrapperProperties = `# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
wrapperVersion=3.3.4
distributionType=only-script
distributionUrl=https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.zip
wrapperUrl=https://repo.maven.apache.org/maven2/org/apache/maven/wrapper/maven-wrapper/3.3.4/maven-wrapper-3.3.4.jar
`;
        await fileCallback('.mvn/wrapper/maven-wrapper.properties', mavenWrapperProperties);
    }

    async generateOtherFiles(
        appName,
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        fileCallback) {
        // Create README
        const readmeContext = { appName };
        const readmeContent = this.render('readme', readmeContext);
        await fileCallback('README.md', readmeContent);

        // Create .gitignore
        const gitignoreContent = this.render('gitignore', {});
        await fileCallback('.gitignore', gitignoreContent);

        // Create formatter config
        const formatterContent = this.render('quarkus-formatter', {});
        await fileCallback('ide-config/quarkus-formatter.xml', formatterContent);

        const certScriptContext = {
            appName,
            steps,
            includePersistenceModule,
            includeCacheInvalidationModule
        };
        const certScriptContent = this.render('generate-dev-certs.sh', certScriptContext);
        await fileCallback('generate-dev-certs.sh', certScriptContent);

        const duplicateScript = this.render('check-duplicate-sources.sh', {});
        await fileCallback('build-tools/check-duplicate-sources.sh', duplicateScript);
    }

    async generateRuntimeMappingFiles(
        steps,
        includePersistenceModule,
        includeCacheInvalidationModule,
        runtimeLayout,
        fileCallback
    ) {
        const active = this.buildRuntimeMapping(
            runtimeLayout,
            steps,
            includePersistenceModule,
            includeCacheInvalidationModule
        );
        await fileCallback('config/pipeline.runtime.yaml', this.toYaml(active));
    }

    buildRuntimeMapping(layout, steps, includePersistenceModule, includeCacheInvalidationModule) {
        if (!buildRuntimeMappingCore) {
            throw new Error('buildRuntimeMappingCore is not available in this environment.');
        }
        return buildRuntimeMappingCore({
            layout,
            steps,
            includePersistenceModule,
            includeCacheInvalidationModule,
            isRuntimeLayout: this.isRuntimeLayout.bind(this),
            normalizeRuntimeLayout: this.normalizeRuntimeLayout.bind(this),
            stepId: this.stepId.bind(this)
        });
    }

    toYaml(value, indent = 0) {
        const prefix = ' '.repeat(indent);
        if (value === null || value === undefined) {
            return `${prefix}null`;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) {
                return `${prefix}[]`;
            }
            return value.map(item => {
                if (item && typeof item === 'object') {
                    const itemYaml = this.toYaml(item, indent + 2);
                    const lines = itemYaml.split('\n');
                    const firstLine = lines[0].trimStart();
                    if (lines.length === 1) {
                        return `${prefix}- ${firstLine}`;
                    }
                    const rest = lines.slice(1).join('\n');
                    return `${prefix}- ${firstLine}\n${rest}`;
                }
                return `${prefix}- ${this.toYamlScalar(item)}`;
            }).join('\n');
        }
        if (typeof value === 'object') {
            const entries = Object.entries(value);
            if (entries.length === 0) {
                return `${prefix}{}`;
            }
            return entries.map(([key, val]) => {
                if (val && typeof val === 'object') {
                    return `${prefix}${key}:\n${this.toYaml(val, indent + 2)}`;
                }
                return `${prefix}${key}: ${this.toYamlScalar(val)}`;
            }).join('\n');
        }
        return `${prefix}${this.toYamlScalar(value)}`;
    }

    /**
     * Convert a JavaScript value into a YAML scalar token.
     *
     * Nullish values become the literal `null`. Number and boolean values are emitted
     * as plain scalars. String-like values are emitted unquoted only when they match
     * the safe scalar pattern and are not YAML reserved words or numeric-looking text;
     * otherwise they are double-quoted with embedded quotes escaped.
     *
     * @param {any} value Value to convert.
     * @returns {string} YAML scalar representation of the input value.
     */
    toYamlScalar(value) {
        if (value === null || value === undefined) {
            return 'null';
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        const text = String(value);
        const textLower = text.toLowerCase();
        const reservedWords = new Set(['null', '~', 'true', 'false', 'yes', 'no', 'on', 'off']);
        const numericPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
        if (/^[A-Za-z0-9_.-]+$/.test(text) && !reservedWords.has(textLower) && !numericPattern.test(text)) {
            return text;
        }
        const escaped = text.replace(/[\u0000-\u001F\\"]/g, (char) => {
            switch (char) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\b':
                    return '\\b';
                case '\f':
                    return '\\f';
                case '\\':
                    return '\\\\';
                case '"':
                    return '\\"';
                default: {
                    const code = char.charCodeAt(0);
                    if (code <= 0xff) {
                        return `\\x${code.toString(16).padStart(2, '0')}`;
                    }
                    return `\\u${code.toString(16).padStart(4, '0')}`;
                }
            }
        });
        return `"${escaped}"`;
    }

    // Utility methods
    toPath(packageName) {
        return packageName.replace(/\./g, '/');
    }

    hasImportFlag(fields, types) {
        if (!Array.isArray(fields)) return false;
        return fields.some(field => types.includes(field.type));
    }

    mapperFieldsForClass(className, step) {
        if (!step || !className) return [];
        if (className === step.inputTypeName && Array.isArray(step.inputFields)) {
            return step.inputFields;
        }
        if (className === step.outputTypeName && Array.isArray(step.outputFields)) {
            return step.outputFields;
        }
        return [];
    }

    sanitizeJavaIdentifier(fieldName) {
        if (typeof fieldName !== 'string' || fieldName.trim() === '') {
            return 'field';
        }
        const reservedWords = [
            'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
            'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
            'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
            'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
            'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
            'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false', 'null'
        ];
        let sanitized = fieldName.replace(/[^a-zA-Z0-9_$]/g, '_');
        if (sanitized.length > 0 && /\d/.test(sanitized[0])) {
            sanitized = '_' + sanitized;
        }
        if (sanitized === '') {
            sanitized = 'field';
        }
        if (reservedWords.includes(sanitized.toLowerCase())) {
            return sanitized + '_';
        }
        return sanitized;
    }

    javaAccessorSuffix(fieldName) {
        if (typeof fieldName !== 'string' || fieldName.trim() === '') {
            return 'Field';
        }
        return fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
    }

    protoAccessorSuffix(fieldName) {
        if (typeof fieldName !== 'string' || fieldName.trim() === '') {
            return 'Field';
        }
        return fieldName
            .split(/[_-]+/)
            .filter(Boolean)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
    }

    formatForClassName(input) {
        if (!input) return '';
        // Split by spaces and capitalize each word
        const parts = input.split(' ');
        return parts
            .filter(part => part)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join('');
    }

    formatForProtoClassName(input) {
        if (!input) return '';
        // Convert service names like "process-customer-svc" to "ProcessCustomerSvc"
        const parts = input.split('-');
        return parts
            .filter(part => part)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join('');
    }

    extractEntityName(serviceNamePascal) {
        // If it starts with "Process", return everything after "Process"
        if (serviceNamePascal.startsWith('Process')) {
            return serviceNamePascal.substring('Process'.length);
        }
        // For other cases, we'll default to the whole string
        return serviceNamePascal;
    }

    stepId(step) {
        if (!step || typeof step.serviceName !== 'string') {
            return '';
        }
        return step.serviceName.replace(/-svc$/, '');
    }

    isTransport(value) {
        if (typeof value !== 'string') {
            return false;
        }
        const normalized = value.trim().toUpperCase();
        return normalized === 'GRPC' || normalized === 'REST' || normalized === 'LOCAL';
    }

    normalizeTransport(transport, runtimeLayout) {
        if (this.isTransport(transport)) {
            return transport.trim().toUpperCase();
        }
        return this.normalizeRuntimeLayout(runtimeLayout) === 'monolith' ? 'LOCAL' : 'GRPC';
    }

    normalizePlatform(platform) {
        if (typeof platform === 'string') {
            const normalized = platform.trim().toUpperCase();
            if (normalized === 'FUNCTION' || normalized === 'LAMBDA') {
                return 'FUNCTION';
            }
            if (normalized === 'COMPUTE' || normalized === 'STANDARD') {
                return 'COMPUTE';
            }
        }
        return 'COMPUTE';
    }

    isRuntimeLayout(value) {
        if (typeof value !== 'string') {
            return false;
        }
        const normalized = value.trim().toLowerCase().replace(/_/g, '-');
        return normalized === 'modular' || normalized === 'pipeline-runtime' || normalized === 'monolith';
    }

    normalizeRuntimeLayout(runtimeLayout) {
        if (!this.isRuntimeLayout(runtimeLayout)) {
            return 'modular';
        }
        return runtimeLayout.trim().toLowerCase().replace(/_/g, '-');
    }

    isAspectEnabled(aspects, aspectName) {
        if (!aspects || !Object.prototype.hasOwnProperty.call(aspects, aspectName)) {
            return false;
        }
        const config = aspects[aspectName];
        return config == null || config.enabled !== false;
    }
}

// Export for both Node.js and browser environments
if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment
    module.exports = BrowserTemplateEngine;
} else {
    // Browser environment
    window.BrowserTemplateEngine = BrowserTemplateEngine;
}
